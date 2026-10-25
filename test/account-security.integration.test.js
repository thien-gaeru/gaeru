const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const bcrypt=require('bcryptjs');
const session=require('express-session');
const {createApp}=require('../src/app');
const {migrateDatabase}=require('../src/migrate');
const {totp}=require('../src/totp');
const sharp=require('sharp');
const QRCode=require('qrcode');
const decodeQR=require('jsqr');
test('owner credentials and recovery, email and app MFA, backup codes and session revocation integrate',{timeout:60000},async t=>{
 const db=await PGlite.create();let queue=Promise.resolve();async function lock(){const previous=queue;let release;queue=new Promise(r=>release=r);await previous;return release;}
 async function query(sql,values){const r=!values&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,values);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
 const pool={async query(sql,values){const release=await lock();try{return await query(sql,values);}finally{release();}},async connect(){const release=await lock();return {query,release};}};
 await migrateDatabase(pool);const password='Security-test-2026',newPassword='Security-new-password-2026',messages=[];
 const app=createApp({pool,sessionStore:new session.MemoryStore(),config:{NODE_ENV:'test',SESSION_SECRET:'security-fixture-key-at-least-32-chars',ADMIN_USERNAME:'owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync(password,4),smtp:{from:'sender@example.invalid',publicBaseUrl:'https://gaeru.example'}},customerMailer:{async sendMail(m){messages.push(m);}}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});const base=`http://127.0.0.1:${server.address().port}`;
 function client(){let cookie='',csrf='';const api={async request(path,method='GET',body,csrfEnabled=true){const r=await fetch(base+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrfEnabled?csrf:'',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();if(data.csrfToken)csrf=data.csrfToken;return {status:r.status,data};},async ok(path,method='GET',body,status=200){const r=await api.request(path,method,body);assert.equal(r.status,status,path+': '+JSON.stringify(r.data));return r.data;},async login(username,pw=password){await api.ok('/api/csrf');return api.ok('/api/auth/login','POST',{username,password:pw});},async security(path,body,status=200){return api.ok('/api/account-security'+path,body?'POST':'GET',body,status);}};return api;}
 const code=()=>messages.at(-1).text.match(/Mã xác thực GAERU: (\d{6})/)[1];
 const owner=client(),oldSession=client();await owner.login('owner');await oldSession.login('owner');
 const invalidPassword=await owner.security('/setup',{password:'incorrect',method:'email'},403);assert.equal(invalidPassword.code,'CURRENT_PASSWORD_INVALID');
 let challenge=await owner.security('/contacts/request',{password,email:'owner@example.invalid',phone:'0900000000'});
 assert.equal((await owner.security('/settings')).email,'');
 await owner.security('/contacts/confirm',{challengeId:challenge.challengeId,code:'wrong'},400);
 await owner.security('/contacts/confirm',{challengeId:challenge.challengeId,code:code()});
 assert.equal((await oldSession.request('/api/gaeru_ceo/owner')).status,401);
 assert.equal((await owner.security('/settings')).email,'owner@example.invalid');
 let setup=await owner.security('/setup',{password,method:'email'});assert.equal((await owner.security('/settings')).method,'off');
 const enabled=await owner.security('/confirm',{method:'email',challengeId:setup.challengeId,code:code()});assert.equal(enabled.recoveryCodes.length,8);
 const second=client();const pending=await second.login('owner');assert.equal(pending.mfaRequired,true);assert.equal(pending.method,'email');
 assert.equal((await second.request('/api/gaeru_ceo/owner')).status,401);
 await second.security('/login/complete',{code:'000000'},403);await second.security('/login/complete',{code:code()});
 await second.security('/login/complete',{code:code()},401);
 const authorized=await second.security('/authorize',{password});await second.security('/password',{password,newPassword,factorChallengeId:authorized.challengeId,factorCode:code()});
 assert.equal((await owner.request('/api/gaeru_ceo/owner')).status,401);
 const denied=client();await denied.ok('/api/csrf');assert.equal((await denied.request('/api/auth/login','POST',{username:'owner',password})).status,401);
 const guest=client();await guest.ok('/api/csrf');await guest.security('/recover/request',{email:'owner@example.invalid',phone:'0900000000'});
 const link=new URL(messages.at(-1).text.match(/https:\/\/\S+/)[0]);assert.match(messages.at(-1).text,/Tên đăng nhập quản trị GAERU của bạn: owner/);
 const reset={id:link.searchParams.get('securityReset'),token:link.searchParams.get('token'),newPassword:password};await guest.security('/recover/complete',reset,400);
 const recoveryCode=await guest.security('/recover/code',reset);await guest.security('/recover/complete',{...reset,factorChallengeId:recoveryCode.challengeId,factorCode:code()});await guest.security('/recover/complete',reset,400);
 assert.equal((await second.request('/api/gaeru_ceo/owner')).status,401);
 // A verified customer can use an authenticator app, never exposing its secret in storage.
 const customerId=(await pool.query("INSERT INTO customers(full_name,email,phone,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now()) RETURNING id",['Fixture Customer','customer@example.invalid','0900000001',bcrypt.hashSync(password,4)])).rows[0].id;
 const customer=client();await customer.ok('/api/csrf');await customer.ok('/api/customer-auth/login','POST',{email:'customer@example.invalid',password});
 setup=await customer.security('/setup',{password,method:'app'});assert.equal((await customer.security('/settings')).method,'off');
 assert.match(setup.qrDataUrl,/^data:image\/webp;base64,/);
 const qrBytes=Buffer.from(setup.qrDataUrl.split(',')[1],'base64');
 const qrInfo=await sharp(qrBytes).metadata();assert.equal(qrInfo.format,'webp');assert.equal(qrInfo.width,280);assert.equal(qrInfo.height,280);
 const qr=await sharp(qrBytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const originalPng=await QRCode.toBuffer(setup.uri,{width:280,margin:4,errorCorrectionLevel:'M'});
 const originalPixels=await sharp(originalPng).ensureAlpha().raw().toBuffer();
 assert.deepEqual(qr.data,originalPixels,'WebP authenticator QR must retain the original pixels');
 const decoded=decodeQR(new Uint8ClampedArray(qr.data),qr.info.width,qr.info.height);
 assert.equal(decoded?.data,setup.uri);assert.equal(new URL(decoded.data).searchParams.get('secret'),setup.secret);
 const counter=Math.floor(Date.now()/30000);const appCodes=await customer.security('/confirm',{method:'app',setupId:setup.setupId,code:totp(setup.secret,counter)});assert.equal(appCodes.recoveryCodes.length,8);
 const stored=(await pool.query('SELECT * FROM account_security WHERE account_key=$1',['customer:'+customerId])).rows[0];assert.notEqual(stored.encrypted_secret,setup.secret);assert.ok(!JSON.stringify(stored).includes(appCodes.recoveryCodes[0]));
 const login=client();await login.ok('/api/csrf');const appPending=await login.ok('/api/customer-auth/login','POST',{email:'customer@example.invalid',password});assert.equal(appPending.mfaRequired,true);assert.equal(appPending.method,'app');
 assert.equal((await login.request('/api/customer-auth/me')).data.authenticated,false);
 await login.security('/login/complete',{code:totp(setup.secret,counter)},403); // Enrollment code cannot be replayed.
 await login.security('/login/complete',{code:appCodes.recoveryCodes[0]});
 await login.security('/disable',{password,factorCode:appCodes.recoveryCodes[0]},403); // Backup code used once.
 await login.security('/disable',{password,factorCode:appCodes.recoveryCodes[1]});assert.equal((await login.security('/settings')).method,'off');
 assert.equal((await customer.request('/api/customer-auth/me')).data.authenticated,false);
 // Retired customer deletion endpoints cannot change state or send email.
 const mailCount=messages.length;
 await login.security('/delete/request',{password},404);
 await login.security('/delete/confirm',{token:'0'.repeat(64)},404);
 assert.equal(messages.length,mailCount);assert.equal((await login.ok('/api/customer-auth/me')).authenticated,true);
 await owner.login('owner');await owner.security('/login/complete',{code:code()});
 const deletionBody={reason:'Khách liên hệ và đã đối chiếu thông tin.',confirmed:true};
 await owner.ok('/api/gaeru_ceo/customers/'+customerId+'/delete','POST',deletionBody);assert.equal((await login.ok('/api/customer-auth/me')).authenticated,true);const confirmationToken=new URL(messages.at(-1).text.match(/https:\/\/[^\s]+/)[0]).searchParams.get('confirmDeletion');assert.ok(confirmationToken);await login.ok('/api/account-deletion/confirm','POST',{token:confirmationToken});
 assert.equal((await login.ok('/api/customer-auth/me')).authenticated,false);
 assert.equal((await login.request('/api/customer-auth/login','POST',{email:'customer@example.invalid',password})).status,403);
 assert.equal((await owner.request('/api/gaeru_ceo/customers/'+customerId,'PATCH',{active:true})).status,404);
 await owner.ok('/api/gaeru_ceo/customers/'+customerId+'/restore','POST',{reason:deletionBody.reason});
 await login.ok('/api/customer-auth/login','POST',{email:'customer@example.invalid',password});assert.equal((await login.ok('/api/customer-auth/me')).authenticated,true);
 // Staff accounts share the same optional MFA controls; no owner privilege required.
 await pool.query('INSERT INTO staff_accounts(username,full_name,password_hash,role) VALUES($1,$2,$3,$4)',['staff-fixture','Staff Fixture',bcrypt.hashSync(password,4),'viewer']);
 const staff=client();await staff.login('staff-fixture');challenge=await staff.security('/contacts/request',{password,email:'staff@example.invalid',phone:'0900000002'});await staff.security('/contacts/confirm',{challengeId:challenge.challengeId,code:code()});setup=await staff.security('/setup',{password,method:'email'});await staff.security('/confirm',{method:'email',challengeId:setup.challengeId,code:code()});
 const staffLogin=client();assert.equal((await staffLogin.login('staff-fixture')).mfaRequired,true);await staffLogin.security('/login/complete',{code:code()});assert.equal((await staffLogin.ok('/api/auth/me')).role,'viewer');
});

