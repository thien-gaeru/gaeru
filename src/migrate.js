require("dotenv").config();
const fs = require("node:fs/promises");
const path = require("node:path");
const { loadConfig } = require("./config");
const { createPool } = require("./db");

async function main() {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const schema = await fs.readFile(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
    await pool.query(schema);
    console.log("Database schema is up to date.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Database migration failed:", error.message);
  process.exitCode = 1;
});
