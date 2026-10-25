const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { createApp } = require("../src/app");
const { migrateDatabase } = require("../src/migrate");

// Runs real PostgreSQL statements in one embedded connection. Multi-connection
// locking and production integrations still require a separate staging run.
async function database() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  async function query(sql, values) {
    const result = !values && sql.includes(";") ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  }
  return {
    async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } },
    async connect() { const release = await lock(); return { query, release }; },
    end: () => db.close()
  };
}

test('private configuration is owner-only, encrypted, versioned, reauthenticated and applied to payments', {timeout:60000},async t=>{
 const pool=await database();await migrateDatabase(pool);const secret=randomBytes(48).toString('hex');const app=createApp({config:{NODE_ENV:'test',SESSION_SECRET:secret,ADMIN_USERNAME:'settings-owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync('Owner-settings-password',4),PUBLIC_BASE_URL:'https://example.invalid',STORE_ORDERS_ENABLED:true},pool,sessionStore:new session.MemoryStore()});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='';
 async function api(path,method='GET',body,token=true){const r=await fetch(base+path,{method,headers:{Cookie:cookie,...(token?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=r.status===204?null:await r.json();if(data?.csrfToken)csrf=data.csrfToken;return {status:r.status,data};}
 assert.equal((await api('/api/gaeru_ceo/owner/configuration')).status,401);await api('/api/csrf');assert.equal((await api('/api/auth/login','POST',{username:'settings-owner',password:'Owner-settings-password'})).status,200);
 let r=await api('/api/gaeru_ceo/owner/configuration');assert.equal(r.status,200);assert.equal(r.data.records.profile.version,0);
 const profile={fullName:'Owner Test',company:'GAERU Test',position:'Director',taxCode:'TEST',address:'Fixture'};
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/profile','PUT',{version:0,data:profile},false)).status,403);
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/profile','PUT',{version:0,data:profile})).status,200);
 const overview=await api('/api/gaeru_ceo/owner');assert.equal(overview.status,200);assert.equal(overview.data.owner.fullName,profile.fullName);assert.equal(overview.data.owner.company,profile.company);assert.ok(Number.isFinite(overview.data.runtime.uptimeSeconds));assert.ok(overview.data.runtime.memoryRssBytes>0);assert.ok(!JSON.stringify(overview.data).includes(profile.taxCode));
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/profile','PUT',{version:0,data:profile})).status,409);
 const row=(await pool.query("SELECT setting_value FROM store_settings WHERE setting_key='private_admin:profile'")).rows[0];assert.ok(!JSON.stringify(row).includes('Owner Test'));
 const payment={tmnCode:'TEST1234',hashSecret:'private-vnpay-test-secret',environment:'sandbox',enabled:true};
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/vnpay','PUT',{version:0,data:payment,password:'wrong'})).status,403);
 r=await api('/api/gaeru_ceo/owner/configuration/vnpay','PUT',{version:0,data:payment,password:'Owner-settings-password'});assert.equal(r.status,200);assert.equal(r.data.data.secretConfigured,true);assert.ok(!JSON.stringify(r.data).includes(payment.hashSecret));
 r=await api('/api/settings/public');assert.equal(r.status,200);assert.ok(r.data.paymentMethods.includes('vnpay'));assert.ok(!JSON.stringify(r.data).includes(payment.hashSecret));
 r=await api('/api/gaeru_ceo/owner/configuration');assert.equal(r.data.records.profile.data.fullName,'Owner Test');assert.ok(!JSON.stringify(r.data).includes(payment.hashSecret));
 const audits=(await pool.query('SELECT * FROM audit_events')).rows;assert.ok(!JSON.stringify(audits).includes(payment.hashSecret));
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/security','PUT',{version:0,data:{idleMinutes:5,absoluteHours:2},password:'Owner-settings-password'})).status,200);
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/security','PUT',{version:1,data:{idleMinutes:1,absoluteHours:2},password:'Owner-settings-password'})).status,400);
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/operations','PUT',{version:0,data:{ordersEnabled:false},password:'wrong'})).status,403);
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/operations','PUT',{version:0,data:{ordersEnabled:false},password:'Owner-settings-password'})).status,200);
 assert.equal((await api('/api/settings/public')).data.ordersEnabled,false);
 assert.equal((await api('/api/orders','POST',{})).status,503);
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/operations','PUT',{version:1,data:{ordersEnabled:true},password:'Owner-settings-password'})).status,400);
 await api('/api/gaeru_ceo/settings','PUT',{shippingNote:'Test rates',shippingRates:{'Toàn quốc':0}});
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/operations','PUT',{version:1,data:{ordersEnabled:true},password:'Owner-settings-password'})).status,200);
 assert.equal((await api('/api/settings/public')).data.ordersEnabled,true);
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/operations','PUT',{version:1,data:{ordersEnabled:false},password:'Owner-settings-password'})).status,409);

 const aiPath='/api/gaeru_ceo/owner/configuration/chat_ai',ai={enabled:true,provider:'gemini',profiles:{openai:{model:'fixture-gpt',apiKey:'private-openai-fixture'},gemini:{model:'fixture-gemini',apiKey:'private-gemini-fixture'},claude:{model:'fixture-claude',apiKey:'private-claude-fixture'}}};
 assert.equal((await api(aiPath,'PUT',{version:0,data:ai,password:'wrong'})).status,403);
 assert.equal((await api(aiPath,'PUT',{version:0,data:ai,password:'Owner-settings-password'},false)).status,403);
 r=await api(aiPath,'PUT',{version:0,data:ai,password:'Owner-settings-password'});assert.equal(r.status,200);assert.equal(r.data.data.profiles.gemini.secretConfigured,true);assert.ok(!JSON.stringify(r.data).includes('private-gemini-fixture'));
 const encryptedAI=(await pool.query("SELECT setting_value FROM store_settings WHERE setting_key='private_admin:chat_ai'")).rows[0];assert.ok(!JSON.stringify(encryptedAI).includes('private-gemini-fixture'));
 const {getChatAIConfig}=require('../src/chat-ai-provider');assert.equal((await getChatAIConfig(pool,{SESSION_SECRET:secret})).apiKey,'private-gemini-fixture');
 assert.equal((await api('/api/shopping-chat/capabilities')).data.provider,'gemini');
 const nextAI={...ai,provider:'claude',profiles:Object.fromEntries(Object.entries(ai.profiles).map(([id,p])=>[id,{model:p.model}]))};
 assert.equal((await api(aiPath,'PUT',{version:1,data:nextAI,password:'Owner-settings-password'})).status,200);assert.equal((await getChatAIConfig(pool,{SESSION_SECRET:secret})).apiKey,'private-claude-fixture');
 assert.equal((await api(aiPath,'PUT',{version:1,data:ai,password:'Owner-settings-password'})).status,409);
 assert.equal((await api(aiPath+'/test','POST',{version:2,password:'wrong'})).status,403);
 const provider=require('../src/chat-ai-provider');const probe=t.mock.method(provider,'generate',async ({settings,question,product})=>{assert.equal(settings.provider,'claude');assert.equal(settings.apiKey,'private-claude-fixture');assert.equal(question,'Chào GAERU');assert.ok(!JSON.stringify(product).includes('Owner Test'));return {answer:'Chào bạn.',handoff:false};});
 r=await api(aiPath+'/test','POST',{version:2,expectedProvider:'claude',expectedModel:'fixture-claude',password:'Owner-settings-password'});assert.equal(r.status,200);assert.equal(r.data.compatible,true);assert.ok(!JSON.stringify(r.data).includes('private-claude-fixture'));
 const callsBeforeMismatch=probe.mock.callCount();for(const expected of [{expectedProvider:'gemini',expectedModel:'fixture-gemini'},{expectedProvider:'claude',expectedModel:'unsaved-model'}]){const mismatch=await api(aiPath+'/test','POST',{version:2,...expected,password:'Owner-settings-password'});assert.equal(mismatch.status,409);assert.equal(mismatch.data.stage,'configuration');}assert.equal(probe.mock.callCount(),callsBeforeMismatch);
 probe.mock.mockImplementation(async()=>{throw require('../src/ai-diagnostics').aiError({provider:'claude',model:'fixture-claude',apiKey:'private-claude-fixture'},'KEY_INVALID',{upstreamStatus:401,requestId:'req_fixture'});});const failure=await api(aiPath+'/test','POST',{version:2,password:'Owner-settings-password'});assert.equal(failure.status,503);assert.equal(failure.data.stage,'provider');assert.equal(failure.data.diagnostic.code,'KEY_INVALID');assert.equal(failure.data.diagnostic.provider,'claude');assert.equal(failure.data.diagnostic.model,'fixture-claude');assert.equal(failure.data.diagnostic.upstreamStatus,401);assert.ok(!JSON.stringify(failure.data).includes('private-claude-fixture'));probe.mock.restore();
 assert.equal((await api(aiPath,'PUT',{version:2,data:{...nextAI,enabled:false},password:'Owner-settings-password'})).status,200);assert.equal((await api('/api/shopping-chat/capabilities')).data.aiConfigured,false);
 assert.ok(!JSON.stringify((await pool.query('SELECT * FROM audit_events')).rows).includes('private-claude-fixture'));
 await api('/api/gaeru_ceo/staff','POST',{username:'config-staff',fullName:'Staff Test',password:'Staff-settings-password',role:'admin'});await api('/api/auth/logout','POST',{});await api('/api/csrf');await api('/api/auth/login','POST',{username:'config-staff',password:'Staff-settings-password'});assert.equal((await api('/api/gaeru_ceo/owner/configuration')).status,403);assert.equal((await api(aiPath+'/test','POST',{version:3,password:'Staff-settings-password'})).status,403);
});
