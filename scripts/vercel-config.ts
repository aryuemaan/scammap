// npm run vercel-config -- https://<your-server>.onrender.com
//
// Writes vercel.json for hosting the WEBSITE on Vercel while the server (Fastify + PostgreSQL, always on) runs
// elsewhere, for example on Render. Vercel serves the built app from its CDN and forwards every API path to your
// server, so everything works on one address (https://<project>.vercel.app) with no CORS set-up.
//
// Why not the server itself on Vercel: it keeps state in memory and runs background work (clock guard tick, live
// stream fan-out, threat feed polling, Telegram long polling), which serverless functions don't keep running.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { API_PREFIXES } from "../shared/apiPaths.js";

const raw = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!raw) {
  console.error("usage: npm run vercel-config -- https://<your-server>.onrender.com");
  process.exit(1);
}
let origin: string;
try {
  const u = new URL(raw.trim());
  if (u.protocol !== "https:") throw new Error("must start with https://");
  if (/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) throw new Error("must be a public address (Vercel can't reach your laptop)");
  if (u.hostname.endsWith(".vercel.app")) throw new Error("that is the Vercel site itself: use your SERVER's address (for example the onrender.com one)");
  origin = u.origin;
} catch (e) {
  console.error(`Not a usable server address: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// Each prefix twice: "/lookup" itself and anything under it. Query strings are passed on by Vercel.
const rewrites = API_PREFIXES.flatMap((p) => [
  { source: p, destination: `${origin}${p}` },
  { source: `${p}/:path*`, destination: `${origin}${p}/:path*` },
]);
// API answers must never be cached on Vercel's CDN (verdicts, licence state and alerts change from second to second).
// The OCR engine files are static and may be cached as the server says.
const noCache = API_PREFIXES.filter((p) => p !== "/ocr").flatMap((p) => [p, `${p}/:path*`]).map((source) => ({
  source,
  headers: [{ key: "x-vercel-enable-rewrite-caching", value: "0" }],
}));

const config = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  framework: null, // "Other": only the app is built here, the server is NOT deployed as a Vercel Function
  installCommand: "npm ci",
  buildCommand: "npm run build:client",
  outputDirectory: "dist/public",
  rewrites,
  headers: [
    ...noCache,
    { source: "/sw.js", headers: [{ key: "cache-control", value: "no-cache" }] },
    { source: "/assets/:path*", headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }] },
  ],
};
const file = path.resolve("vercel.json");
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote vercel.json: the website on Vercel, ${API_PREFIXES.length} API paths forwarded to ${origin}`);

// A quick look at the server, so a typo shows up now rather than after the deploy.
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 70_000);
  const res = await fetch(`${origin}/health`, { signal: ctrl.signal });
  clearTimeout(t);
  const body = await res.text();
  if (res.ok && body.includes('"ok":true')) console.log(`Server check: ${origin}/health answers ${body.trim()}`);
  else console.log(`Server check: ${origin}/health answered HTTP ${res.status}. Is the server deployed and running?`);
} catch (e) {
  console.log(`Server check: could not reach ${origin}/health (${e instanceof Error ? e.message : String(e)}). Check the address; a sleeping free Render instance can take a minute to wake.`);
}
console.log("Next: git add vercel.json && git commit -m \"Vercel config\" && git push   (Vercel redeploys by itself)");
