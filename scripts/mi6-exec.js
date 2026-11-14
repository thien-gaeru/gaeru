'use strict';

const { execCmd } = require('./mi6-common');

async function main() {
  const command = process.argv.slice(2).join(' ').trim();
  if (!command) {
    console.error('Usage: node scripts/mi6-exec.js "<command>"');
    process.exitCode = 1;
    return;
  }
  const timeoutMs = Number.parseInt(process.env.MI6_EXEC_TIMEOUT_MS || '25000', 10) || 25000;
  const result = await execCmd(command, timeoutMs);
  console.log(result);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exitCode = 1;
});
