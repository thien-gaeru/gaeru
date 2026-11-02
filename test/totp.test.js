const test=require('node:test'),assert=require('node:assert/strict');
const {base32,totp,verify,seal,open}=require('../src/totp');
test('TOTP matches RFC 6238 SHA1 vectors including times beyond 2038',()=>{
 const secret=base32(Buffer.from('12345678901234567890'));
 for(const [seconds,expected] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])assert.equal(totp(secret,Math.floor(seconds/30),8),expected);
 const code=totp(secret,100);assert.equal(verify(secret,code,-1,3000000),100);assert.equal(verify(secret,code,100,3000000),null);assert.equal(verify(secret,'wrong',-1,3000000),null);
});
test('encrypted authenticator secret rejects tampering and wrong keys',()=>{const value=seal('PRIVATE-SEED','fixture-key');assert.ok(!value.includes('PRIVATE-SEED'));assert.equal(open(value,'fixture-key'),'PRIVATE-SEED');assert.throws(()=>open(value,'wrong-key'));const parts=value.split('.');parts[1]=Buffer.alloc(16).toString('base64url');assert.throws(()=>open(parts.join('.'),'fixture-key'));});
