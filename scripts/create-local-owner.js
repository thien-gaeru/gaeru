'use strict';
const path = require('node:path');
const bcrypt = require(path.join(__dirname, '..', 'node_modules', 'bcryptjs'));
const crypto = require('node:crypto');
const fs = require('node:fs');

async function setup() {
  const password = 'GaeruSecret2026!';
  const hash = await bcrypt.hash(password, 10);
  const secret = crypto.randomBytes(32).toString('hex');
  const target = path.join(__dirname, '..', '.env.local-owner');
  const content = `ADMIN_USERNAME="gaeru"\nADMIN_PASSWORD_HASH="${hash}"\nSESSION_SECRET="${secret}"\n`;
  fs.writeFileSync(target, content, 'utf8');
  console.log('Created .env.local-owner successfully with user: gaeru / pass: GaeruSecret2026!');
}
setup().catch(console.error);
