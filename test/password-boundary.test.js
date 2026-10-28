const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createCustomerAuthRouter } = require('../src/customer-auth');
const { createAccountSecurity } = require('../src/account-security');
const { createContactChangeApi } = require('../src/contact-change-api');

const customerId = '11111111-1111-4111-8111-111111111111';

test('customer login checks the entire password at the 72 UTF-8 byte boundary', async t => {
  for (const password of ['a'.repeat(72), '界'.repeat(24)]) {
    const passwordHash = bcrypt.hashSync(password, 4);
    const app = express();
    app.use(express.json());
    app.use(session({secret:'password-boundary-fixture-session-secret',resave:false,saveUninitialized:false}));
    app.get('/csrf', (req,res) => { req.session.csrfToken='fixture';res.json({}); });
    app.use(createCustomerAuthRouter({async query() { return {rows:[{
      id:customerId,fullName:'Boundary Customer',email:'boundary@example.invalid',
      phone:'0900000000',active:true,password_hash:passwordHash
    }]}; }}, {mailer:null}));
    const server=app.listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base=`http://127.0.0.1:${server.address().port}`;
    for (const [candidate,status] of [[password,200],[password+'unexpected-suffix',401],[password.slice(0,-1)+'x',401]]) {
      const csrf=await fetch(base+'/csrf');
      const cookie=csrf.headers.get('set-cookie').split(';')[0];
      await csrf.text();
      const response=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'fixture',Cookie:cookie},body:JSON.stringify({email:'boundary@example.invalid',password:candidate})});
      await response.text();
      assert.equal(response.status,status,`${Buffer.byteLength(candidate)}-byte login candidate`);
    }
  }
});

test('sensitive account actions reject a truncated current password', async () => {
  for (const password of ['a'.repeat(72), '界'.repeat(24)]) {
    const passwordHash=bcrypt.hashSync(password,4);
    const query=async sql => ({rows:sql.includes('FROM customers')?[{
      id:customerId,fullName:'Boundary Customer',email:'boundary@example.invalid',
      phone:'0900000000',active:true,passwordHash,emailVerified:true
    }]:[],rowCount:0});
    const pool={query,async connect() {return {query,release(){}};}};
    const security=createAccountSecurity(pool,{SESSION_SECRET:'password-boundary-fixture-session-secret'},null);
    const request=candidate => ({session:{customer:{id:customerId}},body:{password:candidate}});
    let actions=0;
    const action=async () => {actions++;return {ok:true};};
    assert.deepEqual(await security.authorize(request(password),action),{ok:true});
    await assert.rejects(security.authorize(request(password+'unexpected-suffix'),action),error => error.status===403&&error.code==='CURRENT_PASSWORD_INVALID');
    assert.equal(actions,1,'an inexact password must never reach the sensitive action');
  }
});

test('contact changes reject a truncated current password before requesting email proofs', async t => {
  const password='界'.repeat(24);
  const passwordHash=bcrypt.hashSync(password,4);
  let emails=0;
  const app=express();
  app.use(express.json());
  app.use((req,_res,next) => {req.session={customer:{id:customerId},csrfToken:'fixture'};next();});
  app.use(createContactChangeApi({async query() {return {rows:[{
    id:customerId,email:'boundary@example.invalid',phone:'0900000000',password_hash:passwordHash
  }]};}}, {smtpConfig:{from:'sender@example.invalid',publicBaseUrl:'https://example.invalid'},mailer:{async sendMail() {emails++;}}}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [candidate,status] of [[password,200],[password+'unexpected-suffix',403]]) {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/request`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'fixture'},body:JSON.stringify({email:'boundary@example.invalid',phone:'0900000000',password:candidate})});
    await response.text();
    assert.equal(response.status,status);
  }
  assert.equal(emails,0);
});
