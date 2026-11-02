'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createGatewayPayment, queryGatewayPayment, verifyGatewayAccount } = require('../src/payment-provider-clients');
const momo = { environment: 'sandbox', partnerCode: 'MOMO_TEST', accessKey: 'MOMO_ACCESS', secretKey: 'fixture-momo-secret' };
const zalopay = { environment: 'sandbox', appId: '2554', key1: 'fixture-zalo-key-one', key2: 'fixture-zalo-key-two' };
const options = { amountVnd: 123000, txnRef: 'GR-20261028-ABC12345', baseUrl: 'https://gaeru.com', now: Date.parse('2026-10-27T18:01:00Z') };
const sign = (key, value) => createHmac('sha256', key).update(value).digest('hex');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function createdMomo(body, changes = {}) { return { partnerCode: body.partnerCode, requestId: body.requestId, orderId: body.orderId,
  amount: body.amount, resultCode: 0, responseTime: options.now, message: 'Successful.', payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=provider-token', ...changes }; }
function createFetcher(provider, capture = [], changes = {}) {
  return async (url, init) => { const body = JSON.parse(init.body); capture.push({ url, init, body });
    return json(provider === 'momo' ? createdMomo(body, changes) : { return_code: 1, sub_return_code: 1, order_url: 'https://qcgateway.zalopay.vn/openinapp?order=provider-token', ...changes }); };
}

test('MoMo creates a signed server order and returns only the provider-issued payment URL with stable requestId', async () => {
  const calls = [];
  for (const now of [options.now, options.now + 1000]) {
    const result = await createGatewayPayment('momo', momo, { ...options, now, fetcher: createFetcher('momo', calls) });
    assert.equal(result.paymentUrl, 'https://test-payment.momo.vn/v2/gateway/pay?t=provider-token');
    assert.equal(result.requestId, options.txnRef);
    assert.equal(result.callbackVerified, false);
  }
  const { body, init, url } = calls[0];
  assert.equal(url, 'https://test-payment.momo.vn/v2/gateway/api/create');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(body.requestType, 'captureWallet');
  assert.equal(body.ipnUrl, 'https://gaeru.com/api/payments/momo/ipn');
  assert.equal(body.redirectUrl, 'https://gaeru.com/api/payments/momo/return');
  assert.equal(body.signature, sign(momo.secretKey, 'accessKey=MOMO_ACCESS&amount=123000&extraData=&ipnUrl=https://gaeru.com/api/payments/momo/ipn&orderId=GR-20261028-ABC12345&orderInfo=Thanh toan don hang GR-20261028-ABC12345&partnerCode=MOMO_TEST&redirectUrl=https://gaeru.com/api/payments/momo/return&requestId=GR-20261028-ABC12345&requestType=captureWallet'));
  assert.equal(body.secretKey, undefined);
  assert.ok(!url.includes(momo.accessKey));
  assert.equal(calls[0].body.requestId, calls[1].body.requestId);
});

test('ZaloPay creates a signed provider order using the Vietnam date and persists a reusable app_trans_id', async () => {
  const calls = [];
  const result = await createGatewayPayment('zalopay', zalopay, { ...options, fetcher: createFetcher('zalopay', calls) });
  const { body, url, init } = calls[0];
  assert.equal(url, 'https://sb-openapi.zalopay.vn/v2/create');
  assert.equal(init.method, 'POST');
  assert.equal(body.app_trans_id, '261028_' + options.txnRef, 'date must be GMT+7, not UTC');
  assert.equal(result.requestId, body.app_trans_id);
  assert.equal(body.app_id, 2554);
  assert.equal(body.description, 'Thanh toan don hang ' + options.txnRef);
  assert.equal(body.expire_duration_seconds, 900);
  const embed = JSON.stringify({ redirecturl: 'https://gaeru.com/api/payments/zalopay/return', orderNumber: options.txnRef });
  assert.equal(body.embed_data, embed);
  assert.equal(body.mac, sign(zalopay.key1, `2554|261028_${options.txnRef}|gaeru|123000|${options.now}|${embed}|[]`));
  assert.equal(result.paymentUrl, 'https://qcgateway.zalopay.vn/openinapp?order=provider-token');
  const again = await createGatewayPayment('zalopay', zalopay, { ...options, now: options.now + 86400000, requestId: result.requestId, fetcher: createFetcher('zalopay', calls) });
  assert.equal(again.requestId, result.requestId);
});

test('MoMo rejects mismatched provider identities, amounts and response signatures', async () => {
  for (const changes of [{partnerCode:'OTHER'}, {orderId:'OTHER'}, {requestId:'OTHER'}, {amount:1}, {amount:'123000'}, {signature:'0'.repeat(64)}]) {
    await assert.rejects(createGatewayPayment('momo', momo, { ...options, fetcher: createFetcher('momo', [], changes) }), error => error.status === 502 && error.ambiguous);
  }
  await assert.doesNotReject(createGatewayPayment('momo', momo, { ...options, fetcher: async (_url, init) => {
    const data = createdMomo(JSON.parse(init.body));
    data.signature = sign(momo.secretKey, `accessKey=${momo.accessKey}&amount=${data.amount}&message=${data.message}&orderId=${data.orderId}&partnerCode=${data.partnerCode}&payUrl=${data.payUrl}&requestId=${data.requestId}&responseTime=${data.responseTime}&resultCode=${data.resultCode}`);
    return json(data);
  } }));
});

test('both gateways reject missing payment URLs and hostile or cross-environment redirect hosts', async () => {
  for (const [provider, settings, field, host] of [['momo',momo,'payUrl','test-payment.momo.vn'], ['zalopay',zalopay,'order_url','qcgateway.zalopay.vn']]) {
    for (const badUrl of [undefined, '', 'javascript:alert(1)', `http://${host}/pay`, `https://${host}.example.invalid/pay`, `https://owner:secret@${host}/pay`, `https://${host}:444/pay`, `https://${host}/pay#fragment`, 'https://example.invalid/pay']) {
      await assert.rejects(createGatewayPayment(provider, settings, { ...options, fetcher: createFetcher(provider, [], { [field]: badUrl }) }), error => error.code === 'PAYMENT_RESPONSE_INVALID' && error.ambiguous);
    }
  }
  await assert.rejects(createGatewayPayment('momo', { ...momo, environment:'production' }, { ...options, fetcher:createFetcher('momo') }), /Chưa nhận/);
  await assert.rejects(createGatewayPayment('zalopay', { ...zalopay, environment:'production' }, { ...options, fetcher:createFetcher('zalopay') }), /Chưa nhận/);
});

test('production uses fixed provider API and payment hosts', async () => {
  const calls=[];
  const a=await createGatewayPayment('momo',{...momo,environment:'production'},{...options,fetcher:createFetcher('momo',calls,{payUrl:'https://payment.momo.vn/v2/gateway/pay?t=provider-token'})});
  assert.equal(new URL(calls[0].url).origin,'https://payment.momo.vn');
  assert.equal(new URL(a.paymentUrl).hostname,'payment.momo.vn');
  const b=await createGatewayPayment('zalopay',{...zalopay,environment:'production'},{...options,fetcher:createFetcher('zalopay',calls,{order_url:'https://gateway.zalopay.vn/openinapp?order=provider-token'})});
  assert.equal(calls[1].url,'https://openapi.zalopay.vn/v2/create');
  assert.equal(new URL(b.paymentUrl).hostname,'gateway.zalopay.vn');
});

test('provider rejection, HTTP error/redirect, invalid JSON and excessive body all fail closed', async () => {
  for (const [provider,settings] of [['momo',momo],['zalopay',zalopay]]) {
    const badData=provider==='momo'?[{resultCode:13},{resultCode:'0'},{}]:[{return_code:2,sub_return_code:-402},{return_code:1,sub_return_code:-402},{return_code:'1'},{}];
    for(const data of badData)await assert.rejects(createGatewayPayment(provider,settings,{...options,fetcher:async()=>json(data)}),error=>error.status===502);
    for(const status of [302,404,500])await assert.rejects(createGatewayPayment(provider,settings,{...options,fetcher:async()=>new Response('provider error',{status})}),error=>error.code==='PAYMENT_HTTP_ERROR'&&error.upstreamStatus===status);
    for(const body of ['<html>Error</html>','[]','null'])await assert.rejects(createGatewayPayment(provider,settings,{...options,fetcher:async()=>new Response(body)}),error=>error.code==='PAYMENT_RESPONSE_INVALID');
    await assert.rejects(createGatewayPayment(provider,settings,{...options,fetcher:async()=>new Response('x'.repeat(65537))}),error=>error.code==='PAYMENT_RESPONSE_TOO_LARGE');
    await assert.rejects(createGatewayPayment(provider,settings,{...options,fetcher:async()=>new Response('{}',{headers:{'content-length':'1000000'}})}),error=>error.code==='PAYMENT_RESPONSE_TOO_LARGE');
  }
});

test('timeouts abort the request and untrusted network/provider details never enter errors', async () => {
  let signal;
  await assert.rejects(createGatewayPayment('momo',momo,{...options,timeoutMs:10,fetcher:async(_url,init)=>{signal=init.signal;return new Promise(()=>{});}}),error=>error.code==='PAYMENT_TIMEOUT'&&error.ambiguous);
  assert.equal(signal.aborted,true);
  await assert.rejects(createGatewayPayment('momo',momo,{...options,fetcher:async()=>{throw new Error('secret '+momo.secretKey);}}),error=>error.code==='PAYMENT_NETWORK_ERROR'&&!JSON.stringify(error).includes(momo.secretKey)&&!error.message.includes(momo.secretKey));
  await assert.rejects(createGatewayPayment('momo',momo,{...options,fetcher:async()=>json({resultCode:13,message:momo.secretKey})}),error=>!error.message.includes(momo.secretKey));
});

test('invalid configuration and request values are rejected before any remote call', async () => {
  let calls=0;const fetcher=async()=>{calls++;throw Error('must not call');};
  for(const badOptions of [{amountVnd:0},{amountVnd:1.5},{amountVnd:Number.MAX_SAFE_INTEGER},{txnRef:'bad&amount=1'},{baseUrl:'http://gaeru.com'},{baseUrl:'https://owner:secret@gaeru.com'},{baseUrl:'https://gaeru.com/path'},{requestId:'bad id'},{now:NaN}]) {
    await assert.rejects(createGatewayPayment('momo',momo,{...options,...badOptions,fetcher}),error=>error.status===400);
  }
  for(const settings of [{...momo,environment:'other'},{...momo,secretKey:'short'},{...momo,partnerCode:'bad&key=value'}])await assert.rejects(createGatewayPayment('momo',settings,{...options,fetcher}),error=>error.status===400);
  await assert.rejects(createGatewayPayment('zalopay',{...zalopay,appId:'999999999999'},{...options,fetcher}),error=>error.status===400);
  await assert.rejects(createGatewayPayment('zalopay',zalopay,{...options,requestId:'a'.repeat(41),fetcher}),error=>error.status===400);
  await assert.rejects(createGatewayPayment('zalopay',zalopay,{...options,requestId:'261028_OTHER',fetcher}),error=>error.status===400);
  await assert.rejects(createGatewayPayment('__proto__',zalopay,{...options,fetcher}),error=>error.status===400);
  assert.equal(calls,0);
});

test('MoMo status query is signed with the documented canonical fields and checks echoed identity', async () => {
  let request;
  const response=await queryGatewayPayment('momo',momo,{...options,queryRequestId:'query_fixture_1',fetcher:async(url,init)=>{
    const body=JSON.parse(init.body);request={url,init,body};
    return json({partnerCode:body.partnerCode,requestId:body.requestId,orderId:body.orderId,amount:options.amountVnd,resultCode:0,transId:1234});
  }});
  assert.equal(request.url,'https://test-payment.momo.vn/v2/gateway/api/query');
  assert.equal(request.init.method,'POST');
  assert.equal(request.body.signature,sign(momo.secretKey,'accessKey=MOMO_ACCESS&orderId=GR-20261028-ABC12345&partnerCode=MOMO_TEST&requestId=query_fixture_1'));
  assert.equal(response.found,true);assert.equal(response.successful,true);assert.equal(response.providerTransactionId,'1234');
  await assert.rejects(queryGatewayPayment('momo',momo,{...options,fetcher:async()=>json({resultCode:0,partnerCode:'OTHER',orderId:options.txnRef,requestId:'OTHER',amount:options.amountVnd})}),error=>error.code==='PAYMENT_RESPONSE_MISMATCH');
});

test('ZaloPay status query reuses the stored app_trans_id and uses key1 in the query MAC', async () => {
  let request;
  const requestId='261027_'+options.txnRef;
  const response=await queryGatewayPayment('zalopay',zalopay,{...options,requestId,fetcher:async(url,init)=>{
    request={url,body:JSON.parse(init.body)};return json({return_code:3,sub_return_code:1,amount:options.amountVnd,is_processing:true});
  }});
  assert.equal(request.url,'https://sb-openapi.zalopay.vn/v2/query');
  assert.equal(request.body.app_trans_id,requestId);
  assert.equal(request.body.mac,sign(zalopay.key1,`2554|${requestId}|${zalopay.key1}`));
  assert.equal(response.found,true);assert.equal(response.successful,false);
});

test('a nonce probe or a mismatched known order never verifies merchant credentials', async () => {
  for(const [provider,settings] of [['momo',momo],['zalopay',zalopay]]) {
    const fetcher=async(_url,init)=>{
      const body=JSON.parse(init.body);
      return json(provider==='momo'?{partnerCode:body.partnerCode,orderId:body.orderId,requestId:body.requestId,amount:1,resultCode:0}:{return_code:1,amount:1});
    };
    const nonce=await verifyGatewayAccount(provider,settings,{now:options.now,fetcher});
    assert.equal(nonce.verified,false);assert.equal(nonce.reachable,true);assert.equal(nonce.verificationScope,'reachability');
    const mismatch=await verifyGatewayAccount(provider,settings,{...options,fetcher});
    assert.equal(mismatch.verified,false);assert.equal(mismatch.callbackVerified,false);
    const missing=await verifyGatewayAccount(provider,settings,{...options,fetcher:async()=>json(provider==='momo'?{resultCode:58}:{return_code:2,sub_return_code:-101})});
    assert.equal(missing.verified,false);
    const http404=await verifyGatewayAccount(provider,settings,{...options,fetcher:async()=>json({message:'not found'},404)});
    assert.equal(http404.verified,false);
  }
});

test('a matched existing order verifies only API credentials and never claims callback keys were verified', async () => {
  for(const [provider,settings] of [['momo',momo],['zalopay',zalopay]]) {
    const result=await verifyGatewayAccount(provider,settings,{...options,fetcher:async(_url,init)=>{
      const body=JSON.parse(init.body);
      return json(provider==='momo'?{partnerCode:body.partnerCode,orderId:body.orderId,requestId:body.requestId,amount:options.amountVnd,resultCode:1000}:{return_code:3,sub_return_code:1,amount:options.amountVnd});
    }});
    assert.equal(result.verified,true);
    assert.equal(result.verificationScope,'api_credentials');
    assert.equal(result.callbackVerified,false);
    assert.match(result.message,/callback.*chưa được xác minh/);
    if(provider==='zalopay')assert.match(result.message,/Key 2/);
  }
});
