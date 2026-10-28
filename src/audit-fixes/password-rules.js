'use strict';
// bcrypt hashes at most 72 UTF-8 bytes. Count bytes, not JavaScript characters.
function withinBcryptLimit(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 72;
}
module.exports = { withinBcryptLimit };
