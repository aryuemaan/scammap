// npm run db:copy -- --from "<source postgres url>" --to "<target postgres url>" [--datasets-only] [--replace]
//
// Copies ScamMap's data from one PostgreSQL database to another, for example from your laptop to Supabase. Needs no
// pg_dump/psql and no version match: the target gets ScamMap's own migrations, then every table is copied row by row
// as JSON (types, arrays, timestamps and binary values come back exactly), in batches, and the id counters are moved on.
//
//   --datasets-only   copy only the imported datasets and their models (clean start for judging, no reports)
//   --replace         empty those tables in the target first (for example after an earlier import-data or copy)
//
// The source is only read (plus its own pending migrations). Passwords are never printed.
import { createPool, migrate, type Pool } from "../src/db/db.js";
import { wantsTls } from "../src/lib/dburl.js";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const FROM = arg("from");
const TO = arg("to");
const DATASETS_ONLY = argv.includes("--datasets-only");
const REPLACE = argv.includes("--replace");
const DATASET_TABLES = ["dataset_sources", "dataset_messages", "dataset_models", "card_transactions"];
const BATCH = 2000;
const C = { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", x: "\x1b[0m" };

if (!FROM || !TO) {
  console.error('usage: npm run db:copy -- --from "<local url>" --to "<supabase url>" [--datasets-only] [--replace]');
  process.exit(1);
}
const mask = (u: string): string => {
  try {
    const x = new URL(u);
    return `${decodeURIComponent(x.username)}@${x.hostname}:${x.port || 5432}${x.pathname}`;
  } catch {
    return "(unreadable url)";
  }
};
if (mask(FROM) === mask(TO)) {
  console.error("--from and --to are the same database.");
  process.exit(1);
}
const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;

async function tables(pool: Pool): Promise<string[]> {
  return (await pool.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  )).rows.map((r) => r.t);
}
async function count(pool: Pool, t: string): Promise<number> {
  return Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM public.${q(t)}`)).rows[0]!.n);
}

const src = createPool(FROM, wantsTls(FROM, undefined));
const dst = createPool(TO, wantsTls(TO, undefined));
let failed = false;
try {
  console.log(`${C.b}Copy ScamMap data${C.x}  ${mask(FROM)}  →  ${mask(TO)}${DATASETS_ONLY ? "  (datasets only)" : ""}`);
  await src.query("SELECT 1");
  await dst.query("SELECT 1");
  console.log(`${C.d}Bringing both databases to the same schema (ScamMap migrations)…${C.x}`);
  await migrate(src);
  await migrate(dst);

  const targetTables = new Set(await tables(dst));
  let list = (await tables(src)).filter((t) => t !== "schema_migrations" && targetTables.has(t));
  if (DATASETS_ONLY) list = list.filter((t) => DATASET_TABLES.includes(t));

  const busy: string[] = [];
  for (const t of list) if ((await count(dst, t)) > 0) busy.push(t);
  if (busy.length && !REPLACE) {
    console.error(`${C.r}The target already has rows in: ${busy.join(", ")}.${C.x}`);
    console.error("Run again with --replace to empty those tables in the target first (the source is never changed).");
    process.exit(1);
  }
  if (REPLACE && busy.length) {
    await dst.query(`TRUNCATE ${list.map((t) => `public.${q(t)}`).join(", ")} RESTART IDENTITY`);
    console.log(`${C.y}Emptied ${busy.length} target tables first (--replace).${C.x}`);
  }

  const started = Date.now();
  const summary: Array<{ table: string; source: number; target: number }> = [];
  for (const t of list) {
    const total = await count(src, t);
    if (total === 0) {
      summary.push({ table: t, source: 0, target: 0 });
      continue;
    }
    const t0 = Date.now();
    const reader = await src.connect();
    const writer = await dst.connect();
    let done = 0;
    try {
      await reader.query("BEGIN READ ONLY");
      await reader.query(`DECLARE scammap_copy NO SCROLL CURSOR FOR SELECT row_to_json(x)::text AS j FROM public.${q(t)} x`);
      await writer.query("BEGIN");
      for (;;) {
        const rows = (await reader.query<{ j: string }>(`FETCH ${BATCH} FROM scammap_copy`)).rows;
        if (!rows.length) break;
        await writer.query(
          `INSERT INTO public.${q(t)} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::public.${q(t)}, $1::json)`,
          [`[${rows.map((r) => r.j).join(",")}]`],
        );
        done += rows.length;
        if (total > BATCH) process.stdout.write(`\r  ${t}: ${done.toLocaleString("en-IN")} / ${total.toLocaleString("en-IN")}`);
      }
      await writer.query("COMMIT");
      await reader.query("COMMIT");
    } catch (e) {
      await writer.query("ROLLBACK").catch(() => undefined);
      await reader.query("ROLLBACK").catch(() => undefined);
      throw new Error(`copying ${t}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      reader.release();
      writer.release();
    }
    if (total > BATCH) process.stdout.write("\r");
    console.log(`  ${C.g}✓${C.x} ${t.padEnd(22)} ${String(done).padStart(8)} rows  ${C.d}${((Date.now() - t0) / 1000).toFixed(1)} s${C.x}`);
    summary.push({ table: t, source: total, target: await count(dst, t) });
  }

  // Move every id counter past the copied ids, so new rows don't collide.
  const serials = (await dst.query<{ t: string; c: string }>(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`,
  )).rows.filter((r) => list.includes(r.t));
  for (const s of serials) {
    await dst.query(
      `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(max(${q(s.c)}), 0) FROM public.${q(s.t)}), 1),
              (SELECT count(*) > 0 FROM public.${q(s.t)}))`,
      [`public.${q(s.t)}`, s.c],
    );
  }

  const bad = summary.filter((s) => s.source !== s.target);
  const rows = summary.reduce((n, s) => n + s.target, 0);
  if (bad.length) {
    failed = true;
    console.error(`${C.r}Row counts differ: ${bad.map((b) => `${b.table} ${b.source}→${b.target}`).join(", ")}${C.x}`);
  } else {
    console.log(`${C.g}${C.b}Done:${C.x} ${list.length} tables, ${rows.toLocaleString("en-IN")} rows, counts match (${((Date.now() - started) / 1000).toFixed(0)} s).`);
  }
} catch (e) {
  failed = true;
  const m = e instanceof Error ? e.message : String(e);
  console.error(`${C.r}Copy stopped: ${m.slice(0, 300)}${C.x}`);
  if (/tenant\/user|Tenant or user/i.test(m)) console.error("The Supabase address is wrong for this project: npm run supabase:host, or copy it from Connect > Session pooler.");
  if (/password authentication/i.test(m)) console.error("Wrong password in one of the two addresses.");
  console.error("Nothing in the source was changed. Fix the cause and run again with --replace.");
} finally {
  await src.end();
  await dst.end();
}
process.exit(failed ? 1 : 0);
