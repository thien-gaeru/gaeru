const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');const {PGlite}=require('@electric-sql/pglite');const {migrateDatabase}=require('../src/migrate');const shipping=require('../src/shipping-choice');
test('only enabled verified current carrier config is public; chosen carrier is validated and snapshotted atomically',async t=>{
 const db=await PGlite.create(),pool={async query(sql,values){return !values&&sql.includes(';')?(await db.exec(sql)).at(-1):db.query(sql,values)},async connect(){return {query:pool.query,release(){}}}};t.after(()=>db.close());await migrateDatabase(pool);
 for(const id of ['viettel','jt','spx'])await pool.query('INSERT INTO store_settings(setting_key,setting_value) VALUES($1,$2)',['private_admin:shipping_'+id,JSON.stringify({version:2,cipher:'test-only'})]);
 await pool.query("INSERT INTO shipping_carrier_connections(carrier_id,config_version,verified_at,enabled) VALUES('viettel',2,now(),true),('spx',1,now(),true),('jt',2,NULL,true)");
 assert.deepEqual(await shipping.availableCarriers(pool),[{id:'viettel',name:'Viettel Post',version:2}]);await assert.rejects(()=>shipping.validateSelection(pool,'spx'),e=>e.status===409);await assert.rejects(()=>shipping.validateSelection(pool),e=>e.status===409);
 await pool.query("UPDATE store_settings SET setting_value='{\"Hà Nội\":20000}' WHERE setting_key='shipping_rates'");const product=(await pool.query("INSERT INTO products(slug,name,category,active) VALUES('fixture','Fixture','audio',true) RETURNING id")).rows[0];const variant=(await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'FIXTURE','Type C',100000,10,true) RETURNING id",[product.id])).rows[0];
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.session={csrfToken:'fixture'};next();});app.use(require('../src/store-api').createStoreApi(pool,{ordersEnabled:true,shippingChoices:true}));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const publicSettings=await(await fetch(base+'/settings/public')).json();assert.deepEqual(publicSettings.shippingCarriers,[{id:'viettel',name:'Viettel Post'}]);assert.equal(JSON.stringify(publicSettings).includes('test-only'),false);
 const body={customer:{name:'Khách kiểm thử',email:'test@example.invalid',phone:'0900000000',address:'Địa chỉ minh họa',city:'Hà Nội'},paymentMethod:'cod',items:[{variantId:variant.id,quantity:1}],shippingCarrierId:'viettel',expectedShippingFeeVnd:20000};
 const post=b=>fetch(base+'/orders',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'fixture'},body:JSON.stringify(b)});
 assert.equal((await post({...body,shippingCarrierId:'spx'})).status,409);assert.equal((await post({...body,expectedShippingFeeVnd:0})).status,409);assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,0);
 const response=await post(body);assert.equal(response.status,201);const result=await response.json();assert.equal(result.order.shippingCarrierName,'Viettel Post');assert.deepEqual((await pool.query('SELECT carrier_id,carrier_name,fee_vnd FROM order_shipping_selection')).rows[0],{carrier_id:'viettel',carrier_name:'Viettel Post',fee_vnd:20000});
 await pool.query("UPDATE shipping_carrier_connections SET enabled=false WHERE carrier_id='viettel'");assert.deepEqual(await shipping.availableCarriers(pool),[]);assert.equal((await post(body)).status,409);assert.equal((await post({...body,shippingCarrierId:undefined})).status,201);
});
test('read-only provider connection checks reject incompatible/invalid responses and use fixed hosts',async()=>{
 const seen=[];const fetcher=async(url,options)=>{seen.push({url,options});return {ok:true,text:async()=>JSON.stringify(url.includes('spx.vn')?{code:200,data:{status:'active'}}:url.includes('jtexpress.vn')?{code:'1',data:{details:[]}}:[{MA_DV_CHINH:'VCN',TEN_DICHVU:'Nhanh',GIA_CUOC:20000}])};};
 assert.equal((await shipping.verifyCarrier('spx',{accountId:'SHOP123',secret:'fixture'},{fetcher})).id,'spx');assert.equal((await shipping.verifyCarrier('viettel',{secret:'fixture'},{fetcher})).id,'viettel');assert.equal((await shipping.verifyCarrier('jt',{protocol:'jt-vn-open-platform-v1',environment:'sandbox',accountId:'VIP123',partnerCode:'123456789012345678',customerPassword:'00000000000000000000000000000000',secret:'fixture'},{fetcher})).id,'jt');assert.match(seen[0].url,/^https:\/\/spx\.vn\/api\/v2\/fleet_order\/tracking\/open_api\?shop_id=SHOP123/);assert.match(seen[1].url,/^https:\/\/partner\.viettelpost\.vn\//);assert.equal(seen[0].options.redirect,'error');assert.equal(seen[0].options.headers.Token,'fixture');await assert.rejects(()=>shipping.verifyCarrier('jt',{secret:'fixture'},{fetcher}),e=>e.status===409);await assert.rejects(()=>shipping.verifyCarrier('spx',{secret:'fixture'},{fetcher}),e=>e.status===409);await assert.rejects(()=>shipping.verifyCarrier('spx',{accountId:'SHOP123',secret:'bad'},{fetcher:async()=>({ok:false,text:async()=>'error'})}),e=>e.status===502);await assert.rejects(()=>shipping.verifyCarrier('viettel',{secret:'fixture'},{fetcher:async()=>({ok:false,text:async()=>'error'})}),e=>e.status===502);
});

test('verifyCarrier viettel exchanges web token secret via LoginVTP and probe services', async () => {
  const { viettelTokenCache } = require('../src/shipping-adapters');
  viettelTokenCache.clear();
  const webSecret = '23C10A46F91884B';
  const exchangedJwt = 'eyJhbGciOiJFUzI1NiJ9.verified-jwt-token';
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://partner.viettelpost.vn/v2/user/LoginVTP') {
      const body = JSON.parse(options.body);
      assert.equal(body.token, webSecret);
      return {
        ok: true,
        json: async () => ({
          status: 200,
          error: false,
          data: { token: exchangedJwt, expired: Date.now() + 86400000 }
        })
      };
    }
    if (url === 'https://partner.viettelpost.vn/v2/order/getPriceAllNlp') {
      assert.equal(options.headers.Token, exchangedJwt);
      return {
        ok: true,
        text: async () => JSON.stringify({
          status: 200,
          error: false,
          data: [{ MA_DV_CHINH: 'VCN', TEN_DICHVU: 'Chuyển phát nhanh', GIA_CUOC: 22000 }]
        })
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const result = await shipping.verifyCarrier('viettel', { secret: webSecret, pickupAddress: 'Thôn 2, Xã Rạng Đông, Ninh Bình' }, { fetcher });
  assert.equal(result.id, 'viettel');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://partner.viettelpost.vn/v2/user/LoginVTP');
  assert.equal(calls[1].url, 'https://partner.viettelpost.vn/v2/order/getPriceAllNlp');
  assert.equal(calls[1].options.headers.Token, exchangedJwt);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.SENDER_ADDRESS, 'Thôn 2, Xã Rạng Đông, Ninh Bình');
});
