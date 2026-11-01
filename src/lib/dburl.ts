// DATABASE_URL helpers shared by the server, the scripts and the settings reader.

/**
 * Connection settings from a DATABASE_URL. TLS is decided here (DB_SSL, or an sslmode in the URL), and the ssl*
 * parameters are taken out of the URL: node-postgres would otherwise read "sslmode=require" as full certificate
 * checking, which fails against the private certificate authorities of Supabase, Azure and Render.
 * Connections are always encrypted when TLS is on.
 */
export function poolConfig(url: string, ssl: boolean): { connectionString: string; ssl?: { rejectUnauthorized: false } } {
  let connectionString = url;
  let useSsl = ssl;
  try {
    const u = new URL(url);
    const mode = (u.searchParams.get("sslmode") ?? u.searchParams.get("ssl") ?? "").toLowerCase();
    if (mode && !["disable", "false", "0", "allow", "prefer"].includes(mode)) useSsl = true;
    if (mode === "disable" || mode === "false" || mode === "0") useSsl = false;
    for (const k of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) u.searchParams.delete(k);
    connectionString = u.toString();
  } catch {
    /* not a URL we can read: hand it to node-postgres unchanged */
  }
  return { connectionString, ...(useSsl ? { ssl: { rejectUnauthorized: false } as const } : {}) };
}

/** Hosted Postgres services that only accept encrypted connections from outside. */
export function isHostedPostgres(url: string): boolean {
  try {
    return /(supabase\.(co|com)|postgres\.database\.azure\.com|neon\.tech|\.render\.com|aivencloud\.com)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether to use TLS for this URL. Hosted databases always get it (an old ".env" with DB_SSL=false must not send a
 * Supabase password unencrypted); only DB_SSL=disable turns it off there. Elsewhere DB_SSL decides, then sslmode.
 */
export function wantsTls(url: string, flag: string | undefined): boolean {
  const f = (flag ?? "").trim().toLowerCase();
  if (isHostedPostgres(url)) return f !== "disable";
  if (f) return ["1", "true", "yes", "on", "require"].includes(f);
  return /sslmode=(require|verify)/.test(url);
}
