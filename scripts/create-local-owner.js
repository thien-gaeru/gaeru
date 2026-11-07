'use strict';
const path = require('node:path');
const bcrypt = require(path.join(__dirname, '..', 'node_modules', 'bcryptjs'));
const crypto = require('node:crypto');
const fs = require('node:fs');

function assertLocalOwnerEnvironment(env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to generate .env.local-owner in production mode.');
  }
  if (env.CI === 'true' || env.GITHUB_ACTIONS === 'true') {
    throw new Error('Refusing to generate .env.local-owner inside CI/CD runners.');
  }
  if (env.DATABASE_URL) {
    let parsedDb;
    try {
      parsedDb = new URL(env.DATABASE_URL);
    } catch {
      throw new Error('Invalid DATABASE_URL in environment.');
    }
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedDb.hostname.toLowerCase())) {
      throw new Error('Refusing to generate local owner credentials when DATABASE_URL points to a non-loopback host.');
    }
  }
}

async function setup(env = process.env) {
  assertLocalOwnerEnvironment(env);
  const username = (env.GAERU_LOCAL_OWNER_USER || 'gaeru').trim();
  const generated = env.GAERU_LOCAL_OWNER_PASSWORD || (crypto.randomBytes(18).toString('base64url') + 'A1!');
  const hash = await bcrypt.hash(generated, 10);
  const secret = crypto.randomBytes(32).toString('hex');
  const rootDir = path.join(__dirname, '..');
  const target = path.join(rootDir, '.env.local-owner');
  const content = `ADMIN_USERNAME=${JSON.stringify(username)}\nADMIN_PASSWORD_HASH="${hash}"\nSESSION_SECRET="${secret}"\n`;
  fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
  if (!env.GAERU_LOCAL_OWNER_PASSWORD) {
    const localDir = path.join(rootDir, '.local-data');
    fs.mkdirSync(localDir, { recursive: true });
    const secretFile = path.join(localDir, '.local-owner-credentials');
    fs.writeFileSync(secretFile, `username=${username}\ncredential=${generated}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log('Created .env.local-owner and wrote restricted local credentials to .local-data/.local-owner-credentials (0600).');
  } else {
    console.log('Created .env.local-owner successfully for local development.');
  }
}

if (require.main === module) {
  setup().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { setup, assertLocalOwnerEnvironment };
