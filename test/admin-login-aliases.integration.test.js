const { createTestDb } = require('./helpers/pglite-db');
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { createApp } = require("../src/app");
const { migrateDatabase } = require("../src/migrate");

// Runs real PostgreSQL statements in one embedded connection. Multi-connection
// locking and production integrations still require a separate staging run.


test('admin verified contact login preserves canonical identity, MFA and collision rejection',{timeout:60000},async t=>{
const { pool, close: closeDb } = await createTestDb();
  const password='Alias-owner-password',messages=[];const app=createApp({pool,sessionStore:new session.MemoryStore(),customerMailer:{async sendMail(message){messages.push(message);}},config:{NODE_ENV:'test',SESSION_SECRET:randomBytes(48).toString('hex'),ADMIN_USERNAME:'alias-owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync(password,4),smtp:{from:'fixture@example.test',publicBaseUrl:'https://example.test'}}});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));await closeDb();});const base='http://127.0.0.1:'+server.address().port;
function client(){let cookie='',csrf='';return {async api(url,method='GET',body){const r=await fetch(base+url,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=r.status===204?{}:await r.json();if(data.csrfToken)csrf=data.csrfToken;return {status:r.status,data};},async login(username,pw=password){await this.api('/api/csrf');return this.api('/api/auth/login','POST',{username,password:pw});}};}
const code=()=>messages.at(-1).text.match(/Mã xác thực GAERU: (\d{6})/)[1];const owner=client();assert.equal((await owner.login('alias-owner')).status,200);
let challenge=await owner.api('/api/account-security/contacts/request','POST',{password,email:'owner-alias@example.test',phone:'0901234567'});assert.equal(challenge.status,200);assert.equal((await client().login('owner-alias@example.test')).status,401);assert.equal((await owner.api('/api/account-security/contacts/confirm','POST',{challengeId:challenge.data.challengeId,code:code()})).status,200);
// Upgrade an existing installation: only its verified audit trail authorizes the backfill.
await pool.query('ALTER TABLE account_security DROP COLUMN contacts_verified_at');await pool.query("DELETE FROM schema_migrations WHERE name='admin-login-aliases.sql'");await migrateDatabase(pool);assert.ok((await pool.query("SELECT contacts_verified_at FROM account_security WHERE account_key='owner'")).rows[0].contacts_verified_at);
const email=await client().login('  OWNER-ALIAS@EXAMPLE.TEST  ');assert.equal(email.status,200);assert.equal(email.data.username,'alias-owner');assert.equal(email.data.source,'bootstrap');assert.equal((await client().login('+84 901 234 567')).status,200);
const setup=await owner.api('/api/account-security/setup','POST',{password,method:'email'});assert.equal(setup.status,200);assert.equal((await owner.api('/api/account-security/confirm','POST',{method:'email',challengeId:setup.data.challengeId,code:code()})).status,200);
const mfa=client(),pending=await mfa.login('0901.234.567');assert.equal(pending.status,200);assert.equal(pending.data.mfaRequired,true);assert.equal((await mfa.api('/api/gaeru_ceo/owner')).status,401);assert.equal((await mfa.api('/api/account-security/login/complete','POST',{code:code()})).status,200);assert.equal((await mfa.api('/api/auth/me')).data.username,'alias-owner');
const staffPassword='Alias-staff-password';const employee=await owner.api('/api/gaeru_ceo/staff','POST',{username:'alias-staff',fullName:'Alias Staff',password:staffPassword,role:'admin'});assert.equal(employee.status,201);const staff=client();assert.equal((await staff.login('alias-staff',staffPassword)).status,200);
challenge=await staff.api('/api/account-security/contacts/request','POST',{password:staffPassword,email:'staff-alias@example.test',phone:'0901234567'});assert.equal(challenge.status,200);assert.equal((await staff.api('/api/account-security/contacts/confirm','POST',{challengeId:challenge.data.challengeId,code:code()})).status,200);
const staffEmail=await client().login('STAFF-ALIAS@example.test',staffPassword);assert.equal(staffEmail.status,200);assert.equal(staffEmail.data.username,'alias-staff');assert.equal(staffEmail.data.source,'staff');assert.equal((await client().login('0901234567')).status,401);
await pool.query("UPDATE staff_accounts SET active=false WHERE username='alias-staff'");assert.equal((await client().login('staff-alias@example.test',staffPassword)).status,401);
await pool.query('INSERT INTO customers(full_name,email,phone,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())',['Customer','customer-alias@example.test','0981111111',bcrypt.hashSync(password,4)]);assert.equal((await client().login('customer-alias@example.test')).status,401);
const {resolveLogin}=require('../src/admin-login-identity');
await pool.query("UPDATE staff_accounts SET active=true WHERE username='alias-staff'");await pool.query("UPDATE account_security SET contacts_verified_at=NULL WHERE account_key LIKE 'staff:%'");assert.equal(await resolveLogin(pool,{ADMIN_USERNAME:'alias-owner'},'staff-alias@example.test'),null);
assert.equal(await resolveLogin(pool,{ADMIN_USERNAME:'alias-owner'},'customer-alias@example.test'),null);
});
