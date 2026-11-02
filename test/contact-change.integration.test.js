const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const bcrypt=require('bcryptjs');
const session=require('express-session');
const {createApp}=require('../src/app');
const {migrateDatabase}=require('../src/migrate');

test('contact changes require password and email proofs, preserve old contacts, and reject replay or bypass', {timeout:60000},async t=>{
 const db=await PGlite.create();let queue=Promise.resolve();
 async function lock(){const previous=queue;let release;queue=new Promise(r=>release=r);await previous;return release;}
 async function query(sql,values){const r=!values&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,values);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
 const pool={async query(sql,values){const release=await lock();try{return await query(sql,values);}finally{release();}},async connect(){const release=await lock();return {query,release};}};
 await migrateDatabase(pool);
 const password='Contact-test-2026';
 const customer=(await pool.query('INSERT INTO customers(full_name,email,phone,password_hash) VALUES($1,$2,$3,$4) RETURNING id',['Test Owner','old@example.invalid','0900000000',bcrypt.hashSync(password,4)])).rows[0];
 await pool.query('INSERT INTO customers(full_name,email,phone,password_hash) VALUES($1,$2,$3,$4)',['Other Owner','other@example.invalid','0900000001',bcrypt.hashSync(password,4)]);
 const messages=[];let mailFailure=false;
 const app=createApp({pool,sessionStore:new session.MemoryStore(),config:{NODE_ENV:'test',SESSION_SECRET:'test-contact-change-secret-long-enough',ADMIN_USERNAME:'owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync(password,4),smtp:{from:'support@example.invalid',publicBaseUrl:'https://example.invalid'}},customerMailer:{async sendMail(message){if(mailFailure)throw Object.assign(Error('fixture SMTP failure'),{code:'EAUTH'});messages.push(message);return {accepted:[message.to]};}}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 function client(){let cookie='',csrf='';return {async request(path,method='GET',body){const r=await fetch(base+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();if(data.csrfToken)csrf=data.csrfToken;return {status:r.status,data};}};}
 const owner=client(),other=client(),guest=client();
 for(const [api,email] of [[owner,'old@example.invalid'],[other,'other@example.invalid']]){await api.request('/api/csrf');assert.equal((await api.request('/api/customer-auth/login','POST',{email,password})).status,200);}
 const state=async()=>(await pool.query('SELECT email,phone FROM customers WHERE id=$1',[customer.id])).rows[0];
 const request=body=>owner.request('/api/customer-auth/contact-change/request','POST',body);
 const complete=(api,token)=>api.request('/api/customer-auth/contact-change/complete','POST',{token});
 const token=message=>new URL(message.text.match(/https:\/\/\S+/)[0]).searchParams.get('contactVerify');
 assert.equal((await owner.request('/api/customer/profile','PATCH',{fullName:'Renamed Owner',phone:'0911111111'})).status,409);
 assert.equal((await owner.request('/api/customer/profile','PATCH',{fullName:'Renamed Owner',email:'new@example.invalid'})).status,409);
 assert.equal((await owner.request('/api/customer/profile','PATCH',{fullName:'Renamed Owner'})).status,200);
 assert.equal((await request({email:'new@example.invalid',phone:'0911111111',password:'wrong'})).status,403);
 assert.equal((await request({email:'new@example.invalid',phone:'0911111111',password})).status,200);
 assert.equal(messages.length,2);assert.equal(messages[0].to,'old@example.invalid');assert.equal(messages[1].to,'new@example.invalid');
 assert.deepEqual(await state(),{email:'old@example.invalid',phone:'0900000000'});
 const oldToken=token(messages[0]),newToken=token(messages[1]);
 const stored=(await pool.query('SELECT old_token_hash,new_token_hash FROM customer_contact_changes')).rows[0];
 assert.notEqual(stored.old_token_hash,oldToken);assert.notEqual(stored.new_token_hash,newToken);
 assert.equal((await complete(guest,oldToken)).status,401);
 assert.equal((await complete(other,oldToken)).status,400);
 const first=await complete(owner,oldToken);assert.equal(first.status,200);assert.equal(first.data.pending,true);
 assert.deepEqual(await state(),{email:'old@example.invalid',phone:'0900000000'});
 assert.equal((await complete(owner,oldToken)).status,400);
 for(const table of ['customer_password_reset_tokens','customer_email_verification_tokens'])await pool.query(`INSERT INTO ${table}(customer_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[customer.id,'fixture-old-token']);
 const applied=await complete(owner,newToken);assert.equal(applied.status,200);assert.equal(applied.data.customer.email,'new@example.invalid');
 for(const table of ['customer_password_reset_tokens','customer_email_verification_tokens'])assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE customer_id=$1`,[customer.id])).rows[0].n),0);
 assert.deepEqual(await state(),{email:'new@example.invalid',phone:'0911111111'});
 assert.equal((await complete(owner,newToken)).status,400);
 // Phone-only changes have a single proof sent to the current email.
 assert.equal((await request({email:'new@example.invalid',phone:'0922222222',password})).status,200);
 assert.equal(messages.length,3);assert.equal(messages[2].to,'new@example.invalid');
 assert.equal((await complete(owner,token(messages[2]))).status,200);
 assert.equal((await state()).phone,'0922222222');
 assert.equal((await request({email:'new@example.invalid',phone:'0933333333',password})).status,200);
 await pool.query("UPDATE customer_contact_changes SET expires_at=now()-interval '1 minute' WHERE applied_at IS NULL");
 assert.equal((await complete(owner,token(messages[3]))).status,400);
 assert.equal((await state()).phone,'0922222222');
 mailFailure=true;
 assert.equal((await request({email:'new@example.invalid',phone:'0944444444',password})).status,503);
 assert.equal(Number((await pool.query('SELECT count(*) AS n FROM customer_contact_changes WHERE applied_at IS NULL AND cancelled_at IS NULL')).rows[0].n),0);
 assert.equal((await state()).phone,'0922222222');
});
