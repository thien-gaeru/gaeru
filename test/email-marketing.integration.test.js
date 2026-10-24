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


const {processEmailQueue,audience}=require('../src/email-marketing');
test('scheduled marketing mail deduplicates sources, requires confirmation and respects cancellation and opt-out',{timeout:60000},async t=>{
 const pool=await database();await migrateDatabase(pool);const messages=[];const mailer={sendMail:async message=>{messages.push(message);return {accepted:[message.to],rejected:[]};}};
 const config={NODE_ENV:'test',SESSION_SECRET:randomBytes(48).toString('hex'),ADMIN_USERNAME:'email-owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync('Email-owner-password',4),PUBLIC_BASE_URL:'https://example.test',smtp:{host:'smtp.invalid',port:465,secure:true,user:'test',password:'not-real',from:'store@example.test',publicBaseUrl:'https://example.test'}};
 const app=createApp({config,pool,customerMailer:mailer,sessionStore:new session.MemoryStore()});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='';
 async function api(path,method='GET',body,withCsrf=true){const r=await fetch(base+path,{method,headers:{Cookie:cookie,...(withCsrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const data=r.status===204?{}:await r.json();if(data.csrfToken)csrf=data.csrfToken;return {status:r.status,data};}
 assert.equal((await api('/api/gaeru_ceo/marketing/emails')).status,401);await api('/api/csrf');assert.equal((await api('/api/auth/login','POST',{username:'email-owner',password:'Email-owner-password'})).status,200);
 const passwordHash=bcrypt.hashSync('Fixture-password',4);await pool.query('INSERT INTO customers(full_name,email,phone,password_hash) VALUES($1,$2,$3,$4)',['Buyer','Buyer@example.test','0900000000',passwordHash]);await pool.query('INSERT INTO customers(full_name,email,phone,password_hash,active) VALUES($1,$2,$3,$4,false)',['Blocked','blocked@example.test','0900000001',passwordHash]);
 for(const [code,email] of [['SUP1',' buyer@example.test '],['SUP2','supplier@example.test'],['SUP3','blocked@example.test'],['SUP4','invalid']])await pool.query('INSERT INTO suppliers(code,name,email) VALUES($1,$2,$3)',[code,code,email]);
 assert.equal((await audience(pool,['customers','suppliers'])).length,2);
 const draft={title:'Weekend email',subject:'GAERU promotion',body:'Hello <script>alert(1)</script> fixture.',sources:['customers','orders','suppliers'],scheduledAt:new Date(Date.now()+3600000).toISOString(),ratePerMinute:6};
 assert.equal((await api('/api/gaeru_ceo/marketing/emails','POST',{data:draft},false)).status,403);
 const created=await api('/api/gaeru_ceo/marketing/emails','POST',{data:draft});assert.equal(created.status,201);const id=created.data.item.id;
 assert.equal((await api('/api/gaeru_ceo/marketing/emails/'+id+'/schedule','POST',{version:1,expectedCount:2})).status,400);
 assert.equal((await api('/api/gaeru_ceo/marketing/emails/'+id+'/schedule','POST',{version:1,confirmation:'SCHEDULE_EMAILS',expectedCount:3})).status,409);
 assert.equal(messages.length,0);assert.equal((await api('/api/gaeru_ceo/marketing/emails/'+id+'/schedule','POST',{version:1,confirmation:'SCHEDULE_EMAILS',expectedCount:2})).status,200);
 assert.equal((await api('/api/gaeru_ceo/marketing/emails/'+id+'/schedule','POST',{version:1,confirmation:'SCHEDULE_EMAILS',expectedCount:2})).status,409);
 assert.equal((await api('/api/gaeru_ceo/marketing/emails/'+id,'PUT',{data:draft,version:2})).status,409);
 assert.equal(await processEmailQueue(pool,config,mailer),false);assert.equal(messages.length,0);
 await pool.query("UPDATE marketing_email_campaigns SET scheduled_at=now()-interval '1 second' WHERE id=$1",[id]);
 await Promise.all([processEmailQueue(pool,config,mailer),processEmailQueue(pool,config,mailer)]);assert.equal(messages.length,1);assert.ok(messages[0].html.includes('&lt;script&gt;'));assert.ok(!messages[0].html.includes('<script>'));assert.ok(!messages[0].bcc);assert.ok(messages[0].headers['List-Unsubscribe']);
 const link=messages[0].text.match(/https:\/\/[^\s]+/)[0],pathname=new URL(link).pathname;assert.equal((await fetch(base+pathname)).status,200);assert.equal((await pool.query('SELECT count(*)::int AS n FROM marketing_email_suppressions')).rows[0].n,0);assert.equal((await fetch(base+pathname,{method:'POST'})).status,200);assert.equal((await audience(pool,['customers','suppliers'])).length,1);
 assert.equal((await api('/api/gaeru_ceo/marketing/emails/'+id+'/cancel','POST',{version:2})).status,200);await processEmailQueue(pool,config,mailer);assert.equal(messages.length,1);
 const listing=await api('/api/gaeru_ceo/marketing/emails');assert.equal(listing.data.campaigns[0].sent,1);assert.equal(listing.data.campaigns[0].skipped,1);
 // A timeout may occur after acceptance. Never retry this uncertain recipient.
 const second=(await api('/api/gaeru_ceo/marketing/emails','POST',{data:{...draft,title:'Unknown result'}})).data.item;assert.equal((await api('/api/gaeru_ceo/marketing/emails/'+second.id+'/schedule','POST',{version:1,confirmation:'SCHEDULE_EMAILS',expectedCount:1})).status,200);await pool.query("UPDATE marketing_email_campaigns SET scheduled_at=now()-interval '1 second' WHERE id=$1",[second.id]);let attempts=0;const timeoutMailer={sendMail:async()=>{attempts++;throw Error('timeout');}};await processEmailQueue(pool,config,timeoutMailer);await processEmailQueue(pool,config,timeoutMailer);assert.equal(attempts,1);assert.equal((await pool.query('SELECT status FROM marketing_email_recipients WHERE campaign_id=$1',[second.id])).rows[0].status,'unknown');
 assert.equal((await api('/api/gaeru_ceo/marketing/emails','POST',{data:{...draft,body:'ạ'.repeat(12000)}})).status,201);
 await api('/api/gaeru_ceo/staff','POST',{username:'email-viewer',fullName:'Viewer',password:'Viewer-password-2026',role:'viewer'});await api('/api/auth/logout','POST',{});await api('/api/csrf');await api('/api/auth/login','POST',{username:'email-viewer',password:'Viewer-password-2026'});assert.equal((await api('/api/gaeru_ceo/marketing/emails','POST',{data:draft})).status,403);
});
