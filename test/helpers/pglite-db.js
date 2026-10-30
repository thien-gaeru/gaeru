'use strict';

const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../../src/migrate');

/**
 * Tạo một instance cơ sở dữ liệu PGlite dùng trong integration tests.
 * Hỗ trợ xếp hàng lệnh query tuần tự (queue lock) để tránh race condition trong PGlite in-memory.
 */
async function createTestDb({ migrate = true } = {}) {
  const db = await PGlite.create();
  let queue = Promise.resolve();

  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise(r => { release = r; });
    await previous;
    return release;
  }

  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }

  const pool = {
    async query(sql, values) {
      const release = await lock();
      try {
        return await query(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    },
    async end() {
      return db.close();
    }
  };

  if (migrate) {
    await migrateDatabase(pool);
  }

  return {
    db,
    pool,
    async close() {
      await db.close();
    }
  };
}

module.exports = {
  createTestDb
};
