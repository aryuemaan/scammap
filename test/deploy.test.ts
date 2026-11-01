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
