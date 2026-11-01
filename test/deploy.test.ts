// Every server route must sit under one of API_PREFIXES, or a proxy in front of the server (Vercel rewrites, the Vite
// dev proxy) would answer it with the web app instead of forwarding it.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_PREFIXES } from "../shared/apiPaths.js";
import { prefixOf } from "../src/routes/reports.js";

describe("deployment: API paths", () => {
  it("covers every route the server registers", () => {
    const dir = path.resolve("src/routes");
    const routes = readdirSync(dir).filter((f) => f.endsWith(".ts")).flatMap((f) =>
      [...readFileSync(path.join(dir, f), "utf8").matchAll(/app\.(?:get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => m[1]!),
    );
    expect(routes.length).toBeGreaterThan(30);
    const uncovered = routes.filter((r) => r !== "/" && !r.startsWith("/.well-known") && !API_PREFIXES.some((p) => r === p || r.startsWith(`${p}/`)));
    expect(uncovered).toEqual([]);
  });
});

describe("deployment: client network behind proxies", () => {
  it("reads the network with or without a port (Azure App Service adds one)", () => {
    expect(prefixOf("49.36.12.7")).toBe("49.36.12");
    expect(prefixOf("49.36.12.7:51234")).toBe("49.36.12");
    expect(prefixOf(" 49.36.12.7:443 ")).toBe("49.36.12");
    expect(prefixOf("::ffff:49.36.12.7")).toBe("49.36.12");
    expect(prefixOf("2401:4900:1c2a:5b::1")).toBe("2401:4900:1c2a");
    expect(prefixOf("[2401:4900:1c2a:5b::1]:443")).toBe("2401:4900:1c2a");
    expect(prefixOf("unknown")).toBeNull();
  });
});

describe("deployment: database URLs", () => {
  it("takes TLS from DB_SSL or sslmode, and removes ssl parameters node-postgres would misread", async () => {
    const { poolConfig, isHostedPostgres } = await import("../src/lib/dburl.js");
    const sb = "postgres://postgres.abcdefgh:p%40ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres";
    expect(poolConfig(sb, true)).toEqual({ connectionString: sb, ssl: { rejectUnauthorized: false } });
    expect(poolConfig(`${sb}?sslmode=require`, false)).toEqual({ connectionString: sb, ssl: { rejectUnauthorized: false } });
    expect(poolConfig("postgres://u:p@localhost:5432/db?sslmode=disable", true)).toEqual({ connectionString: "postgres://u:p@localhost:5432/db" });
    expect(poolConfig("postgres://u:p@localhost:5432/db", false)).toEqual({ connectionString: "postgres://u:p@localhost:5432/db" });
    expect(isHostedPostgres(sb)).toBe(true);
    expect(isHostedPostgres("postgres://u:p@db.abcdefgh.supabase.co:5432/postgres")).toBe(true);
    expect(isHostedPostgres("postgres://a:b@scammap-db.postgres.database.azure.com:5432/scammap")).toBe(true);
    expect(isHostedPostgres("postgres://postgres:postgres@localhost:5432/scammap")).toBe(false);
    expect(isHostedPostgres("postgres://u:p@dpg-abc123-a:5432/scammap")).toBe(false);
    const { wantsTls } = await import("../src/lib/dburl.js");
    expect(wantsTls(sb, "false")).toBe(true); // an old .env must not turn TLS off for Supabase
    expect(wantsTls(sb, "disable")).toBe(false);
    expect(wantsTls("postgres://postgres:postgres@localhost:5432/scammap", undefined)).toBe(false);
    expect(wantsTls("postgres://postgres:postgres@localhost:5432/scammap", "true")).toBe(true);
    expect(wantsTls("postgres://u:p@10.0.0.5:5432/db?sslmode=require", undefined)).toBe(true);
  });
});
