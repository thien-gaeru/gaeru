const { Pool } = require("pg");

function createPool(config) {
  return new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.PGSSL === "require" ? { rejectUnauthorized: true } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
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

module.exports = { createPool, withTransaction };
