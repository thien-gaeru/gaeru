const test = require("node:test");
const assert = require("node:assert/strict");
const { withTransaction } = require("../src/db");

function fakePool() {
  const calls = [];
  const client = {
    async query(query) { calls.push(query); },
    release() { calls.push("RELEASE"); }
  };
  return { calls, connect: async () => client };
}

test("commits successful transactions and always releases the connection", async () => {
  const pool = fakePool();
  const result = await withTransaction(pool, async () => "ok");
  assert.equal(result, "ok");
  assert.deepEqual(pool.calls, ["BEGIN", "COMMIT", "RELEASE"]);
});

test("rolls back failed transactions and always releases the connection", async () => {
  const pool = fakePool();
  await assert.rejects(withTransaction(pool, async () => { throw new Error("failure"); }), /failure/);
  assert.deepEqual(pool.calls, ["BEGIN", "ROLLBACK", "RELEASE"]);
});
