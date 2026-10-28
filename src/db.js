const { Pool } = require("pg");

function isLocalDatabaseHost(hostname) {
  const h = String(hostname || "").trim().toLowerCase();
  return !h || h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function poolOptions(config) {
  let connectionString = config.DATABASE_URL;
  const parsed = URL.canParse(connectionString) ? new URL(connectionString) : null;
  const sslMode = parsed?.searchParams.get("sslmode")?.toLowerCase() || "";
  const sslParam = parsed?.searchParams.get("ssl")?.toLowerCase() || "";
  const remoteHost = parsed ? !isLocalDatabaseHost(parsed.hostname) : false;
  const explicitDisable = config.PGSSL === "disable" && config.NODE_ENV !== "production";
  const requireTls = config.NODE_ENV === "production"
    || config.PGSSL === "require"
    || (!explicitDisable && (remoteHost || ["require", "verify-ca", "verify-full"].includes(sslMode) || sslParam === "true" || sslParam === "1"));
  if (requireTls && parsed) {
    for (const name of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) {
      parsed.searchParams.delete(name);
    }
    connectionString = parsed.toString();
  }
  return {
    connectionString,
    ssl: requireTls
      ? {
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          ...(config.PGSSL_CA ? { ca: config.PGSSL_CA } : {})
        }
      : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  };
}

function createPool(config) {
  return new Pool(poolOptions(config));
}

async function inspectDatabaseTls(pool, config = {}) {
  const connection = await pool.connect();
  let latencyMs = null;
  let databaseTls = null;
  let databaseCertificateVerified = null;
  let databaseBackendTls = null;
  let databaseDirectBackendSsl = null;
  let databaseServerSslSetting = null;
  let databaseTlsProtocol = null;
  let databaseTlsCipher = null;
  let databaseTlsBits = null;
  try {
    const started = performance.now();
    await connection.query("SELECT 1");
    latencyMs = Math.round((performance.now() - started) * 10) / 10;
    const stream = connection.connection?.stream || connection.stream || null;
    if (stream) {
      databaseTls = stream.encrypted === true;
      databaseCertificateVerified = stream.encrypted === true && stream.authorized === true;
      if (typeof stream.getProtocol === "function") databaseTlsProtocol = stream.getProtocol() || null;
      if (typeof stream.getCipher === "function") {
        const cipherInfo = stream.getCipher();
        databaseTlsCipher = cipherInfo?.name || null;
        if (cipherInfo?.bits) databaseTlsBits = Number(cipherInfo.bits);
      }
    }
    try {
      const statRow = (await connection.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0];
      if (statRow && typeof statRow.ssl === "boolean") {
        databaseDirectBackendSsl = statRow.ssl;
      }
      try {
        const detailRow = (await connection.query("SELECT ssl, version, cipher, bits FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0];
        if (detailRow) {
          if (typeof detailRow.ssl === "boolean") databaseDirectBackendSsl = detailRow.ssl;
          if (detailRow.version) databaseTlsProtocol = detailRow.version;
          if (detailRow.cipher) databaseTlsCipher = detailRow.cipher;
          if (detailRow.bits) databaseTlsBits = Number(detailRow.bits);
        }
      } catch {}
    } catch {}
    try {
      const settingRow = (await connection.query("SELECT current_setting('ssl', true) AS ssl")).rows[0];
      if (settingRow?.ssl) databaseServerSslSetting = String(settingRow.ssl).toLowerCase();
    } catch {}
    // Report the observed database session separately from the application socket.
    // ssl=on describes server capability; a verified socket may terminate at a
    // pooler, so neither establishes encryption on the pooler's database leg.
    databaseBackendTls = databaseDirectBackendSsl;
  } finally {
    connection.release();
  }
  return {
    healthy: true,
    latencyMs,
    databaseTls,
    databaseCertificateVerified,
    databaseBackendTls,
    databaseDirectBackendSsl,
    databaseServerSslSetting,
    databaseTlsProtocol,
    databaseTlsCipher,
    databaseTlsBits
  };
}

async function withTransaction(pool, handler) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createPool, poolOptions, inspectDatabaseTls, withTransaction };
