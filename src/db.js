const { Pool } = require("pg");
const tls = require("node:tls");

if (tls.DEFAULT_MIN_VERSION !== "TLSv1.3") {
  tls.DEFAULT_MIN_VERSION = "TLSv1.2";
}
tls.DEFAULT_MAX_VERSION = "TLSv1.3";

const SECURE_TLS13_CIPHERSUITES = [
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_GCM_SHA256"
].join(":");

const SECURE_TLS12_CIPHERS = [
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256"
].join(":");

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
  const minVersion = config.PGSSL_MIN_VERSION === "TLSv1.3" ? "TLSv1.3" : "TLSv1.2";
  return {
    connectionString,
    ssl: requireTls
      ? {
          rejectUnauthorized: true,
          minVersion,
          maxVersion: "TLSv1.3",
          ciphersuites: SECURE_TLS13_CIPHERSUITES,
          ciphers: SECURE_TLS12_CIPHERS,
          honorCipherOrder: true,
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
  let databaseServerSslMinProtocol = null;
  let databaseServerSslMaxProtocol = null;
  let databaseServerSslCiphers = null;
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
    try {
      const protoMinRow = (await connection.query("SELECT current_setting('ssl_min_protocol_version', true) AS val")).rows[0];
      if (protoMinRow?.val) databaseServerSslMinProtocol = protoMinRow.val;
    } catch {}
    try {
      const protoMaxRow = (await connection.query("SELECT current_setting('ssl_max_protocol_version', true) AS val")).rows[0];
      if (protoMaxRow?.val) databaseServerSslMaxProtocol = protoMaxRow.val;
    } catch {}
    try {
      const ciphersRow = (await connection.query("SELECT current_setting('ssl_ciphers', true) AS val")).rows[0];
      if (ciphersRow?.val) databaseServerSslCiphers = ciphersRow.val;
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
    databaseServerSslMinProtocol,
    databaseServerSslMaxProtocol,
    databaseServerSslCiphers,
    databaseTlsProtocol,
    databaseTlsCipher,
    databaseTlsBits,
    databaseTlsLatest: databaseTlsProtocol === "TLSv1.3"
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
    // Preserve the business error if a lost connection also prevents rollback.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createPriorityPoolController(pool, { maxLowPriorityOps = 2 } = {}) {
  const cap = Math.max(1, Number.parseInt(maxLowPriorityOps, 10) || 2);
  let activeHighOps = 0;
  let activeLowOps = 0;
  let peakHighOps = 0;
  let peakLowOps = 0;
  const lowWaitQueue = [];

  const pumpLowQueue = () => {
    while (activeHighOps === 0 && activeLowOps < cap && lowWaitQueue.length > 0) {
      activeLowOps++;
      if (activeLowOps > peakLowOps) peakLowOps = activeLowOps;
      const resume = lowWaitQueue.shift();
      resume();
    }
  };

  const acquireSlot = async (priority) => {
    if (priority === "high") {
      activeHighOps++;
      if (activeHighOps > peakHighOps) peakHighOps = activeHighOps;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeHighOps = Math.max(0, activeHighOps - 1);
        pumpLowQueue();
      };
    }
    if (activeHighOps > 0 || activeLowOps >= cap) {
      await new Promise((resolve) => lowWaitQueue.push(resolve));
    } else {
      activeLowOps++;
      if (activeLowOps > peakLowOps) peakLowOps = activeLowOps;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeLowOps = Math.max(0, activeLowOps - 1);
      pumpLowQueue();
    };
  };

  const wrapPool = (priority) => {
    if (!pool || (typeof pool.query !== "function" && typeof pool.connect !== "function")) {
      return pool;
    }
    return new Proxy(pool, {
      get(target, prop) {
        if (prop === "query" && typeof target.query === "function") {
          return async (...args) => {
            const releaseSlot = await acquireSlot(priority);
            try {
              return await target.query(...args);
            } finally {
              releaseSlot();
            }
          };
        }
        if (prop === "connect" && typeof target.connect === "function") {
          return (...args) => {
            if (typeof args[0] === "function") {
              const callback = args[0];
              acquireSlot(priority)
                .then((releaseSlot) => {
                  target.connect((err, client, done) => {
                    if (err || !client) {
                      releaseSlot();
                      return callback(err, client, done);
                    }
                    const origRelease = typeof client.release === "function" ? client.release.bind(client) : done;
                    const wrappedDone = (...relArgs) => {
                      try {
                        return origRelease ? origRelease(...relArgs) : undefined;
                      } finally {
                        releaseSlot();
                      }
                    };
                    const clientProxy = new Proxy(client, {
                      get(cTarget, cProp) {
                        if (cProp === "release") return wrappedDone;
                        const val = Reflect.get(cTarget, cProp, cTarget);
                        return typeof val === "function" ? val.bind(cTarget) : val;
                      }
                    });
                    return callback(null, clientProxy, wrappedDone);
                  });
                })
                .catch((err) => callback(err));
              return undefined;
            }
            return (async () => {
              const releaseSlot = await acquireSlot(priority);
              let client;
              try {
                client = await target.connect(...args);
              } catch (err) {
                releaseSlot();
                throw err;
              }
              if (!client || typeof client !== "object") {
                releaseSlot();
                return client;
              }
              const origRelease = typeof client.release === "function" ? client.release.bind(client) : () => {};
              return new Proxy(client, {
                get(cTarget, cProp) {
                  if (cProp === "release") {
                    return (...relArgs) => {
                      try {
                        return origRelease(...relArgs);
                      } finally {
                        releaseSlot();
                      }
                    };
                  }
                  const val = Reflect.get(cTarget, cProp, cTarget);
                  return typeof val === "function" ? val.bind(cTarget) : val;
                }
              });
            })();
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  };

  return {
    highPriorityPool: wrapPool("high"),
    lowPriorityPool: wrapPool("low"),
    getStats: () => ({
      activeHighOps,
      activeLowOps,
      peakHighOps,
      peakLowOps,
      queuedLowOps: lowWaitQueue.length,
      maxLowPriorityOps: cap
    })
  };
}

module.exports = { createPool, poolOptions, inspectDatabaseTls, withTransaction, createPriorityPoolController };
