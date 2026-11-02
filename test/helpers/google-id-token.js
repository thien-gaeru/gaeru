'use strict';

const crypto = require('node:crypto');

const { privateKey: TEST_GOOGLE_PRIVATE_KEY, publicKey: TEST_GOOGLE_PUBLIC_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048
});

const { privateKey: ATTACKER_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048
});

function signJwtWithKey(payload, privateKey, header = { alg: 'RS256', typ: 'JWT', kid: 'test-google-kid-1' }) {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    iat: now,
    exp: now + 3600,
    ...payload
  };
  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signingInput = `${encHeader}.${encPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function signTestGoogleIdToken(payload, options = {}) {
  return signJwtWithKey(
    payload,
    options.privateKey || TEST_GOOGLE_PRIVATE_KEY,
    options.header || { alg: 'RS256', typ: 'JWT', kid: 'test-google-kid-1' }
  );
}

function signAttackerSelfSignedJwt(payload, options = {}) {
  return signJwtWithKey(
    payload,
    ATTACKER_PRIVATE_KEY,
    options.header || { alg: 'RS256', typ: 'JWT', kid: 'attacker-self-signed-kid' }
  );
}

function createTestGoogleOAuthClient({ publicKey = TEST_GOOGLE_PUBLIC_KEY } = {}) {
  return {
    async verifyIdToken({ idToken, audience } = {}) {
      if (!idToken || typeof idToken !== 'string') {
        throw new Error('Invalid ID token');
      }
      const parts = idToken.split('.');
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        throw new Error('Wrong number of segments in token');
      }
      let header;
      let payload;
      try {
        header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {
        throw new Error('Can not parse envelope or payload');
      }
      if (!header || header.alg !== 'RS256') {
        throw new Error('Invalid token algorithm');
      }
      const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
      const sigBuffer = Buffer.from(parts[2], 'base64url');
      const verified = crypto.verify('RSA-SHA256', signingInput, publicKey, sigBuffer);
      if (!verified) {
        throw new Error('Invalid token signature');
      }
      const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
      if (!payload || !validIssuers.includes(payload.iss)) {
        throw new Error('Wrong issuer');
      }
      const now = Math.floor(Date.now() / 1000);
      if (!payload.exp || payload.exp < now - 300) {
        throw new Error('Token used too late');
      }
      const allowedAudiences = Array.isArray(audience) ? audience : (audience ? [audience] : []);
      if (allowedAudiences.length > 0 && !allowedAudiences.includes(payload.aud)) {
        throw new Error('Wrong recipient, payload audience != requiredAudience');
      }
      const verifiedPayload = { ...payload };
      return {
        getPayload() {
          return verifiedPayload;
        }
      };
    }
  };
}

module.exports = {
  TEST_GOOGLE_PUBLIC_KEY,
  signTestGoogleIdToken,
  signAttackerSelfSignedJwt,
  createTestGoogleOAuthClient
};
