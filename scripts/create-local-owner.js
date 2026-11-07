'use strict';
const path = require('node:path');
const bcrypt = require(path.join(__dirname, '..', 'node_modules', 'bcryptjs'));
const crypto = require('node:crypto');
const fs = require('node:fs');

async function setup() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to generate .env.local-owner in production mode.');
  }
  const username = (process.env.GAERU_LOCAL_OWNER_USER || 'gaeru').trim();
  const password = process.env.GAERU_LOCAL_OWNER_PASSWORD || (crypto.randomBytes(18).toString('base64url') + 'A1!');
  const hash = await bcrypt.hash(password, 10);
  const secret = crypto.randomBytes(32).toString('hex');
  const target = path.join(__dirname, '..', '.env.local-owner');
  const content = `ADMIN_USERNAME=${JSON.stringify(username)}\nADMIN_PASSWORD_HASH="${hash}"\nSESSION_SECRET="${secret}"\n`;
  fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
  console.log('Created .env.local-owner successfully for local development.');
  if (!process.env.GAERU_LOCAL_OWNER_PASSWORD) {
    console.log(`Generated one-time local owner credentials -> username: ${username} | password: ${password}`);
  }
}

if (require.main === module) {
  setup().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { setup };
