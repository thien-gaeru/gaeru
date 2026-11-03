'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const jt = require('../src/jt-vietnam');
const { jtAdapter } = require('../src/shipping-adapters');
const { verifyCarrier, verifyAndRecord, availableCarriers } = require('../src/shipping-choice');
const { schemas, publicRecord, readRecord } = require('../src/admin-configuration');
const { migrateDatabase } = require('../src/migrate');
const { seal } = require('../src/totp');
const settings = Object.freeze({ protocol: jt.PROTOCOL, environment: 'sandbox', accountId: 'FIXTURE-VN',
  partnerCode: '10000000000000001', secret: 'fixture-private-key', customerPassword: '00000000000000000000000000000000',
  pickupName: 'GAERU Fixture', pickupPhone: '0900000000', pickupAddress: '10 Fixture', pickupProvince: 'Hà Nội',
  pickupArea: 'Phường Ba Đình', payType: 'PP_CASH', serviceType: 1 });
const order = Object.freeze({ orderNumber: 'FIXTURE-ORDER', receiver: { name: 'Khách Fixture', mobile: '0900000000',
  prov: 'Hà Nội', area: 'Phường Ba Đình', address: '10 Fixture & 20 + thử nghiệm' },
  weightGrams: 750, subtotalVnd: 100000, totalVnd: 120000, codAmountVnd: 120000,
  items: [{ productName: 'GAERU K9', variantName: 'Type-C', quantity: 1, priceVnd: 100000 }] });
const response = data => new Response(JSON.stringify(data));
const createReply = (extra = {}) => ({ code: '1', msg: 'success', data: { txlogisticId: order.orderNumber,
  billCode: 'VN-FIXTURE-TRACKING', inquiryFee: 20000, codFee: 0, insuranceFee: 0, ...extra } });

test('VN account verification sends the documented fixed form endpoint and separate account/header signatures', async () => {
  let request;
  const result = await jt.verifyAccount(settings, { now: () => 1793678400000, fetcher: async (url, init) => {
    request = { url, ...init }; return response({ code: '1', msg: 'success' });
  }});
  assert.equal(request.url, jt.BASES.sandbox + 'vip/checkCusPwd');
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.apiAccount, settings.partnerCode, 'identifier must not lose integer precision');
  assert.equal(request.headers.timestamp, '1793678400000');
  assert.match(request.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  assert.equal(new URLSearchParams(request.body).get('bizContent'), '{"customerCode":"FIXTURE-VN","digest":"bjHdo5tbo+ruYlaeIdY1cw=="}');
  assert.equal(request.headers.digest, 'PrCIGEbD9ThXBl6IKCKReQ==');
  assert.deepEqual([...new URLSearchParams(request.body).keys()], ['bizContent']);
  assert.equal(result.environment, 'sandbox');
  assert.equal(result.protocol, jt.PROTOCOL);
  assert.equal(result.accountVerified, true);
  assert.equal(result.checkoutReady, false);
});

test('legacy, incomplete and unbound environments stop before any J&T network request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return response({ code: '1' }); };
  for (const overrides of [{ protocol: undefined }, { environment: undefined }, { environment: 'staging' }, { accountId: '' },
    { partnerCode: 'not-a-number' }, { secret: '' }, { customerPassword: 'plaintext-is-never-hashed-here' }, { customerPassword: 'abcdefabcdefabcdefabcdefabcdefab' }]) {
    await assert.rejects(() => verifyCarrier('jt', { ...settings, ...overrides }, { fetcher }), error => error.status === 409);
  }
  assert.equal(calls, 0);
  let url;
  await jt.verifyAccount({ ...settings, environment: 'production' }, { fetcher: async value => { url = value; return response({ code: 1 }); } });
  assert.equal(url, jt.BASES.production + 'vip/checkCusPwd');
});

test('HTTP success, arbitrary text and contradictory acknowledgements cannot verify J&T or expose credentials', async () => {
  const rejected = [{ code: 200 }, { success: true }, { msg: 'success' }, { code: '1', success: false }, { code: '1', error: true },
    { code: '403', msg: settings.secret + settings.customerPassword }];
  for (const data of rejected) await assert.rejects(() => jt.verifyAccount(settings, { fetcher: async () => response(data) }), error => {
    assert.doesNotMatch(error.message, /fixture-private-key|00000000000000000000000000000000/);
    return error.status === 502;
  });
  await assert.rejects(() => jt.verifyAccount(settings, { fetcher: async () => new Response('<html>Error</html>') }), { status: 502 });
  await assert.rejects(() => jt.verifyAccount(settings, { fetcher: async () => new Response('unauthorized', {status:401}) }), { status: 502 });
  await assert.rejects(() => jt.verifyAccount(settings, { fetcher: async () => { throw Error(settings.secret); } }), error => !error.message.includes(settings.secret));
});

test('unconfirmed mutations remain ambiguous after HTTP errors and oversized responses are cancelled', async () => {
  for (const operation of ['create','cancel']) {
    for (const status of [400,500,502,504]) await assert.rejects(()=>jt.request(settings,operation,{fixture:true},{fetcher:async()=>new Response('unconfirmed',{status})}),error=>error.status===502&&error.ambiguous===true);
    await assert.rejects(()=>jt.request(settings,operation,{fixture:true},{fetcher:async()=>response({code:'failure'})}),error=>error.ambiguous===true);
  }
  let cancelled=false;
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(600000));},cancel(){cancelled=true;}});
  await assert.rejects(()=>jt.verifyAccount(settings,{fetcher:async()=>new Response(body)}),{status:502});
  assert.equal(cancelled,true);
});

test('waybill/quote require structured province and ward without guessing or sending placeholder addresses', async () => {
  let calls = 0; const options = { fetcher: async () => { calls++; return response(createReply()); } };
  await assert.rejects(() => jtAdapter.createWaybill(settings, { ...order, receiver: undefined }, options), { status: 409 });
  await assert.rejects(() => jtAdapter.createWaybill(settings, { ...order, receiver: { ...order.receiver, area: '' } }, options), { status: 400 });
  await assert.rejects(() => jtAdapter.createWaybill({ ...settings, pickupProvince: '' }, order, options), { status: 400 });
  await assert.rejects(() => jtAdapter.quoteShippingFee(settings, { city: 'Hà Nội', address: 'Text only' }, options), { status: 409 });
  await assert.rejects(() => jtAdapter.createWaybill(settings, { ...order, weightGrams: 0 }, options), { status: 400 });
  assert.equal(calls, 0);
});

test('VN waybill form uses case-sensitive business fields, actual package data and matching provider references', async () => {
  let wire;
  const result = await jtAdapter.createWaybill(settings, order, { fetcher: async (url, init) => {
    wire = { url, init, business: JSON.parse(new URLSearchParams(init.body).get('bizContent')) };
    return response(createReply());
  }});
  assert.equal(wire.url, jt.BASES.sandbox + 'order/addOrder');
  assert.equal(wire.business.txlogisticId, order.orderNumber);
  assert.equal(wire.business.password, settings.customerPassword);
  assert.deepEqual(wire.business.receiver, order.receiver, 'unicode, ampersand and plus survive form encoding');
  assert.equal(wire.business.packageInfo.weight, '0.75');
  assert.equal(wire.business.codMoney, '120000');
  assert.equal(wire.business.items[0].itemValue, '100000');
  assert.equal(wire.business.payType, 'PP_CASH');
  assert.equal(wire.business.serviceType, 1);
  assert.equal(wire.business.selfAddress, 0);
  assert.equal(wire.business.txlogisticid, undefined);
  assert.equal(wire.init.headers.digest, jt.headerDigest(JSON.stringify(wire.business), settings.secret));
  assert.equal(result.trackingNumber, 'VN-FIXTURE-TRACKING');
  assert.equal(result.shippingFeeVnd, 20000);
  assert.equal(result.labelUrl, null, 'do not invent a public GET label endpoint');
  assert.ok(!JSON.stringify(result).includes(settings.customerPassword));
  assert.ok(!JSON.stringify(result).includes(settings.secret));
  for (const data of [createReply({ txlogisticId: 'OTHER-ORDER' }), { code: '1', data: { txlogisticId: order.orderNumber } }]) {
    await assert.rejects(() => jtAdapter.createWaybill(settings, order, {fetcher:async()=>response(data)}), error => error.status === 502 && error.ambiguous === true);
  }
});

test('cancellation is signed, bound to the requested order and rejects a different successful reference', async () => {
  let wire; const reference = { trackingNumber:'VN-FIXTURE-TRACKING',carrierOrderId:order.orderNumber,reason:'Fixture cancellation' };
  const result = await jtAdapter.cancelWaybill(settings, reference, {fetcher:async(url,init)=>{
    wire={url,business:JSON.parse(new URLSearchParams(init.body).get('bizContent'))};return response(createReply());
  }});
  assert.equal(wire.url, jt.BASES.sandbox + 'order/cancelOrder');
  assert.equal(wire.business.billCode, reference.trackingNumber);
  assert.equal(wire.business.txlogisticId, order.orderNumber);
  assert.equal(result.cancelled, true);
  await assert.rejects(()=>jtAdapter.cancelWaybill(settings,reference,{fetcher:async()=>response(createReply({billCode:'OTHER'}))}), {status:502});
  await assert.rejects(()=>jtAdapter.cancelWaybill(settings,reference,{fetcher:async()=>response({code:'1'})}), {status:502});
});

test('tracking binds the bill and leaves status/COD unchanged while VN status documentation conflicts', async () => {
  let wire;
  const result = await jtAdapter.queryTracking(settings, {trackingNumber:'VN-FIXTURE-TRACKING'}, {fetcher:async(url,init)=>{
    wire={url,business:JSON.parse(new URLSearchParams(init.body).get('bizContent'))};
    return response({code:'1',data:[{billCode:'VN-FIXTURE-TRACKING',details:[
      {scanTime:'2026-11-02 08:00:00',scanTypeCode:94,desc:'Earlier'},
      {scanTime:'2026-11-03 08:00:00',scanTypeCode:100,desc:'Raw provider event'}]}]});
  }});
  assert.equal(wire.url,jt.BASES.sandbox+'logistics/trace');
  assert.equal(wire.business.billCodes,'VN-FIXTURE-TRACKING');
  assert.equal(result.carrierStatusRaw,'100');
  assert.equal(result.status,'pending');
  assert.equal(result.statusMappingVerified,false);
  assert.equal(result.history[0].timestamp,'2026-11-03 08:00:00');
  await assert.rejects(()=>jtAdapter.queryTracking(settings,{trackingNumber:'VN-FIXTURE-TRACKING'},{fetcher:async()=>response({code:'1',data:[{billCode:'OTHER',details:[]}]})}),{status:502});
  await assert.rejects(()=>require('../src/shipping-management').handleCarrierWebhook(null,{},'jt',{status:'delivered'}),{status:501});
});

test('quote uses the documented fee operation and never supplies a fabricated delivery estimate', async () => {
  let wire; const options={fetcher:async(url,init)=>{wire={url,business:JSON.parse(new URLSearchParams(init.body).get('bizContent'))};return response({code:'1',data:{price:20000,codFee:1000,insuranceFee:0}});}};
  const quote=await jtAdapter.quoteShippingFee(settings,order,options);
  assert.equal(wire.url,jt.BASES.sandbox+'spmComCost/getComCost');
  assert.deepEqual(wire.business.receiver,{prov:'Hà Nội',area:'Phường Ba Đình'});
  assert.equal(wire.business.weight,0.75);
  assert.equal(quote.feeVnd,21000);
  assert.equal(quote.estimatedDays,null);
  await assert.rejects(()=>jtAdapter.quoteShippingFee(settings,order,{fetcher:async()=>response({code:'1',data:{}})}),{status:502});
});

test('prepared password is schema-validated and always redacted by the configuration API', () => {
  const input={...settings,webhookSecret:'fixture-dedicated-webhook-secret-32'};
  assert.equal(schemas.shipping_jt.safeParse(input).success,true);
  assert.equal(schemas.shipping_jt.safeParse({...input,customerPassword:'plaintext'}).success,false);
  assert.equal(schemas.shipping_jt.safeParse({...input,endpoint:'http://127.0.0.1'}).success,false);
  const publicData=publicRecord('shipping_jt',{version:1,data:input}).data;
  assert.equal(publicData.customerPassword,undefined);
  assert.equal(publicData.secret,undefined);
  assert.equal(publicData.webhookSecret,undefined);
  assert.equal(publicData.customerPasswordConfigured,true);
  assert.equal(publicData.secretConfigured,true);
});

test('account-only verification is version/environment scoped and cannot activate customer checkout', async t => {
  const db=await PGlite.create();
  const pool={query:(sql,values)=>!values&&sql.includes(';')?db.exec(sql).then(rows=>rows.at(-1)):db.query(sql,values),async connect(){return {query:pool.query,release(){}};}};
  t.after(()=>db.close()); await migrateDatabase(pool);
  const config={SESSION_SECRET:'isolated-jt-configuration-encryption-key'};
  await pool.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('private_admin:shipping_jt',$1)",[JSON.stringify({version:1,cipher:seal(JSON.stringify(settings),process.env.AUTH_ENCRYPTION_KEY||config.SESSION_SECRET)})]);
  const result=await verifyAndRecord(pool,config,'jt',1,{actor:{username:'fixture'},fetcher:async()=>response({code:'1'})});
  assert.equal(result.accountVerified,true);assert.equal(result.verified,false);assert.equal(result.checkoutReady,false);
  const connection=(await pool.query("SELECT * FROM shipping_carrier_connections WHERE carrier_id='jt'")).rows[0];
  assert.equal(connection.verified_protocol,jt.PROTOCOL);assert.equal(connection.verified_environment,'sandbox');
  assert.equal(connection.verification_scope,'account_lookup');assert.equal(connection.enabled,false);
  await migrateDatabase(pool);
  assert.equal((await pool.query("SELECT verification_scope FROM shipping_carrier_connections WHERE carrier_id='jt'")).rows[0].verification_scope,'account_lookup','a repeated migration run preserves newly tested account proof');
  assert.equal((await readRecord(pool,config,'shipping_jt')).data.customerPassword,settings.customerPassword);
  await pool.query("UPDATE shipping_carrier_connections SET enabled=true WHERE carrier_id='jt'");
  assert.deepEqual(await availableCarriers(pool),[],'a legacy enabled flag cannot bypass missing fulfillment acceptance');
  await assert.rejects(()=>verifyAndRecord(pool,config,'jt',2,{fetcher:async()=>{throw Error('must not call');}}),{status:409});
});

test('owner J&T configuration encrypts both secrets, preserves blanks and requires fresh credentials when switching environments', async t => {
  const express=require('express'),{withTransaction}=require('../src/db');
  const db=await PGlite.create();
  const pool={query:(sql,values)=>!values&&sql.includes(';')?db.exec(sql).then(rows=>rows.at(-1)):db.query(sql,values),async connect(){return {query:pool.query,release(){}};}};
  t.after(()=>db.close());await migrateDatabase(pool);
  let calls=0;
  const config={SESSION_SECRET:'isolated-jt-configuration-encryption-key',shippingFetcher:async()=>{calls++;return response({code:'1'});},accountSecurity:{authorize:(req,fn)=>withTransaction(pool,c=>fn(null,c))}};
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.session={csrfToken:'fixture'};req.admin={username:'fixture',role:'owner',source:'bootstrap'};next();});
  app.use(require('../src/admin-configuration').createAdminConfiguration(pool,config));
  app.use(require('../src/shipping-choice').createShippingAdmin(pool,config,{fetcher:config.shippingFetcher}));
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const post=(path,method,body)=>fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'content-type':'application/json','x-csrf-token':'fixture'},body:JSON.stringify(body)});
  const path='/owner/configuration/shipping_jt';
  let result=await post(path,'PUT',{version:0,data:settings});assert.equal(result.status,200);
  let data=await result.json();assert.equal(data.data.customerPasswordConfigured,true);assert.equal(data.verification.accountVerified,true);assert.equal(data.verification.verified,false);
  assert.ok(!JSON.stringify(data).includes(settings.customerPassword));assert.ok(!JSON.stringify(data).includes(settings.secret));assert.equal(calls,1);
  const saved=(await pool.query("SELECT setting_value FROM store_settings WHERE setting_key='private_admin:shipping_jt'")).rows[0];
  assert.ok(!JSON.stringify(saved).includes(settings.customerPassword));assert.ok(!JSON.stringify(saved).includes(settings.secret));
  const {secret,customerPassword,...withoutSecrets}=settings;
  result=await post(path,'PUT',{version:1,data:{...withoutSecrets,environment:'production'}});assert.equal(result.status,400);assert.equal(calls,1);
  result=await post(path,'PUT',{version:1,data:withoutSecrets});assert.equal(result.status,200);assert.equal(calls,2,'same-environment blank secret fields preserve the encrypted credentials');
  assert.equal((await readRecord(pool,config,'shipping_jt')).data.customerPassword,customerPassword);
  result=await post('/owner/shipping/jt/availability','PATCH',{version:2,enabled:true});assert.equal(result.status,501);assert.equal(calls,2);
  assert.deepEqual(await availableCarriers(pool),[]);
  assert.ok(!JSON.stringify((await pool.query('SELECT metadata FROM audit_events')).rows).includes(customerPassword));
});
