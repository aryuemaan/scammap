// PW=<database password> npx tsx scripts/supabase-host.ts <project-ref>
//
// Finds which Supabase session-pooler host serves your project (it depends on the region and cluster: aws-0-…,
// aws-1-…), by trying them in parallel. Prints only the host name on stdout, so a shell can capture it:
//   HOST=$(npx tsx scripts/supabase-host.ts hlaisxgvwpsszlemmakl)
// The password is read from the PW environment variable (never from the command line) and never printed.
import pg from "pg";

const ref = (process.argv[2] ?? "").trim().replace(/^postgres\./, "");
const password = process.env.PW ?? process.env.SUPABASE_DB_PASSWORD ?? "";
if (!/^[a-z0-9]{15,30}$/.test(ref)) {
  console.error("usage: PW=<database password> npx tsx scripts/supabase-host.ts <project-ref>   (the ref is in your Supabase URL)");
  process.exit(1);
}
if (!password) {
  console.error('Set the password first, without it showing on screen:  read -s -p "Supabase database password: " PW; echo; export PW');
  process.exit(1);
}

const REGIONS = [
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2",
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1",
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
];
const hosts = ["aws-0", "aws-1", "aws-2"].flatMap((c) => REGIONS.map((r) => `${c}-${r}.pooler.supabase.com`));

type Outcome = { host: string; kind: "ok" | "password" | "other"; message: string };
async function attempt(host: string): Promise<Outcome> {
  const client = new pg.Client({ host, port: 5432, user: `postgres.${ref}`, password, database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12_000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.end().catch(() => undefined);
    return { host, kind: "ok", message: "" };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/password authentication failed/i.test(m)) return { host, kind: "password", message: m };
    return { host, kind: "other", message: m };
  }
}

console.error(`Looking for project ${ref} on ${hosts.length} Supabase pooler hosts…`);
const results = await Promise.all(hosts.map(attempt));
const found = results.find((r) => r.kind === "ok");
if (found) {
  console.error(`Found: ${found.host}`);
  console.log(found.host);
  process.exit(0);
}
const wrongPassword = results.find((r) => r.kind === "password");
if (wrongPassword) {
  console.error(`Your project is on ${wrongPassword.host}, but the password was refused. Reset it in Supabase >`);
  console.error("Project Settings > Database > Reset database password, then set PW again.");
  console.log(wrongPassword.host);
  process.exit(2);
}
const other = results.filter((r) => !/tenant|not found|ENOTFOUND|EAI_AGAIN/i.test(r.message));
console.error("No pooler host knows this project. Check the project ref (Supabase URL: supabase.com/dashboard/project/<ref>),");
console.error("that the project is not paused, or copy the URI from Supabase > Connect > Session pooler.");
for (const r of other.slice(0, 3)) console.error(`  ${r.host}: ${r.message.slice(0, 120)}`);
process.exit(1);
