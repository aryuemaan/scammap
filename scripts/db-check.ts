// npm run db:check [-- --url "<postgres url>"]
//
// Checks the database in DATABASE_URL (or --url) before you deploy: can this machine reach it, is TLS on, how slow is a
// round trip, are ScamMap's tables there, and are they closed to Supabase's public HTTP API. Changes nothing.
// The password is never printed.
import { loadDotEnv } from "../src/lib/dotenv.js";
import { wantsTls } from "../src/lib/dburl.js";
import { createPool } from "../src/db/db.js";

loadDotEnv();
const argv = process.argv.slice(2);
const i = argv.indexOf("--url");
const url = (i !== -1 ? argv[i + 1] : process.env.DATABASE_URL) ?? "postgres://postgres:postgres@localhost:5432/scammap";
const C = { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", x: "\x1b[0m" };
const ok = (s: string): void => console.log(`  ${C.g}✓${C.x} ${s}`);
const bad = (s: string): void => console.log(`  ${C.r}✗${C.x} ${s}`);
const warn = (s: string): void => console.log(`  ${C.y}!${C.x} ${s}`);
const tip = (s: string): void => console.log(`    ${C.d}${s}${C.x}`);

let u: URL;
try {
  u = new URL(url);
} catch {
  bad("DATABASE_URL is not a URL. It looks like postgres://USER:PASSWORD@HOST:5432/DATABASE");
  process.exit(1);
}
const host = u.hostname;
const port = u.port || "5432";
const user = decodeURIComponent(u.username);
const ssl = wantsTls(url, process.env.DB_SSL);
console.log(`${C.b}Database check${C.x}  ${user}@${host}:${port}${u.pathname}  ${C.d}(password hidden, TLS ${ssl ? "on" : "off"})${C.x}`);

// Supabase-specific advice before connecting.
if (/\.supabase\.co$/.test(host) && host.startsWith("db.")) {
  warn("this is Supabase's DIRECT address: IPv6 only on the free plan, so Render, Azure and most home networks can't reach it");
  tip("Supabase > Connect > Session pooler, and copy that URI instead (host ...pooler.supabase.com, port 5432)");
}
if (/pooler\.supabase\.com$/.test(host)) {
  if (port === "6543") {
    warn("port 6543 is the TRANSACTION pooler: ScamMap keeps session-level locks, so use the SESSION pooler (port 5432)");
  } else ok("Supabase session pooler (IPv4, keeps sessions): the right choice for ScamMap");
  if (!user.includes(".")) {
    bad(`pooler user must be postgres.<project-ref>, not "${user}": copy the URI from Supabase > Connect > Session pooler`);
  }
}
if (u.searchParams.has("sslmode")) tip("sslmode in the URL is fine: ScamMap removes it and uses TLS itself");

const pool = createPool(url, ssl);
try {
  const t0 = Date.now();
  const v = (await pool.query<{ version: string; who: string; db: string }>("SELECT version() AS version, current_user AS who, current_database() AS db")).rows[0]!;
  ok(`connected in ${Date.now() - t0} ms as ${v.who} to "${v.db}": ${v.version.split(" on ")[0]}`);
  const times: number[] = [];
  for (let k = 0; k < 5; k++) {
    const s = Date.now();
    await pool.query("SELECT 1");
    times.push(Date.now() - s);
  }
  const median = times.sort((a, b) => a - b)[2]!;
  (median <= 40 ? ok : warn)(`round trip ${median} ms (median of 5)${median > 40 ? ": put the server in the same region as the database (for example Render Singapore + Supabase Singapore)" : ""}`);

  const tables = (await pool.query<{ n: number; rls: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE c.relrowsecurity)::int AS rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  )).rows[0]!;
  if (!tables.n) {
    warn("no tables yet: they are created when the server first starts (or by npm run import-data)");
  } else {
    const mig = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations").catch(() => ({ rows: [{ n: 0 }] }))).rows[0]!.n;
    const size = (await pool.query<{ s: string }>("SELECT pg_size_pretty(pg_database_size(current_database())) AS s")).rows[0]!.s;
    ok(`${tables.n} tables, ${mig} migrations applied, ${size} used`);
    const reports = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM reports").catch(() => ({ rows: [{ n: -1 }] }))).rows[0]!.n;
    const data = (await pool.query<{ s: string }>("SELECT string_agg(source || ' (' || rows || ')', ', ') AS s FROM dataset_sources").catch(() => ({ rows: [{ s: null }] }))).rows[0]!.s;
    if (reports >= 0) ok(`${reports} reports; datasets: ${data ?? "none (npm run import-data)"}`);
    const anon = (await pool.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS exists")).rows[0]!.exists;
    if (anon) {
      const open = (await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND has_table_privilege('anon', c.oid, 'SELECT') AND NOT c.relrowsecurity`,
      )).rows[0]!.n;
      if (open) {
        bad(`${open} tables are readable through Supabase's public HTTP API`);
        tip("start the server once (it closes them by itself), and turn off Supabase > Integrations > Data API");
      } else ok("closed to Supabase's public HTTP API (row level security on, no grants for anon/authenticated)");
    } else if (tables.rls === tables.n) ok("row level security is on for every table");
  }
} catch (e) {
  const m = e instanceof Error ? e.message : String(e);
  bad(`could not use the database: ${m.slice(0, 200)}`);
  const tenant = /tenant\/user .* not found|tenant or user not found/i.test(m);
  if (tenant) {
    tip("Supabase's pooler doesn't know this project at THIS host. The host depends on your project's region and cluster");
    tip("(aws-0-… or aws-1-…, ap-south-1 = Mumbai, ap-southeast-1 = Singapore): copy the whole URI from");
    tip("Supabase > your project > Connect > Session pooler, and only replace [YOUR-PASSWORD].");
  } else if (/ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|timeout/i.test(m)) {
    tip("unreachable: wrong host, an IPv6-only address (use Supabase's Session pooler), or a firewall (Azure: add your IP)");
  }
  if (/password authentication failed/i.test(m)) tip("wrong password: reset it (Supabase > Settings > Database) and URL-encode @ : / # % in it");
  if (/self.signed|certificate/i.test(m)) tip("certificate check: remove sslmode=verify-full from the URL; ScamMap encrypts with DB_SSL=true");
  if (/no pg_hba|SSL off|encryption/i.test(m)) tip("the server wants TLS: set DB_SSL=true");
  if (/does not exist/i.test(m)) tip("the database name at the end of the URL doesn't exist (Supabase's is postgres)");
  process.exitCode = 1;
} finally {
  await pool.end();
}
