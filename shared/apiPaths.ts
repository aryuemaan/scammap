// Every path prefix the server answers. The app calls these on its own origin; anything that sits in front of the
// server (the Vite dev proxy, Vercel rewrites) forwards exactly these to it. Screens use the URL hash (#map), so they
// never collide with these paths.
export const API_PREFIXES = [
  "/reports", "/lookup", "/map", "/alerts", "/admin", "/challenges", "/license", "/health", "/analyze", "/stats",
  "/insights", "/datasets", "/live", "/campaigns", "/network", "/push", "/partner", "/rollups", "/system",
  "/connectors", "/transparency", "/privacy", "/ocr", "/safety", "/demo", "/threats",
] as const;
