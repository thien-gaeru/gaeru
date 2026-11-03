'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { randomUUID } = require('node:crypto');
const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const { appendAudit } = require('../src/audit');
const inventory = require('../src/inventory');
const finance = require('../src/finance-api');
const { createStoreApi } = require('../src/store-api');

async function fixture(t) {
  const db = await PGlite.create();
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = { query, connect: async () => ({ query, release() {} }) };
  t.after(() => db.close());
  await migrateDatabase(pool);
  const actor = { username: 'transaction-audit', role: 'owner', source: 'bootstrap', permissions: ['orders.write', 'payments.write'] };
  const customer = (await query("INSERT INTO customers(email,full_name,phone) VALUES('transaction@example.invalid','Transaction Buyer','0900000000') RETURNING id")).rows[0];
  const product = (await query("INSERT INTO products(name,slug,category,active) VALUES('Transaction Product','transaction-product','audio',true) RETURNING id")).rows[0];
  const variant = (await query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'TRANSACTION-SKU','Default',100000,10,true) RETURNING id", [product.id])).rows[0];
  await withTransaction(pool, c => inventory.initializeVariantStock(c, { variantId: variant.id, quantity: 10, actor }));
  async function order(status = 'pending') {
    const row = (await query(`INSERT INTO orders(order_number,customer_id,customer_name,email,phone,address,city,payment_method,status,subtotal_vnd,shipping_fee_vnd,total_vnd)
      VALUES($1,$2,'Transaction Buyer','transaction@example.invalid','0900000000','Fixture Street','Hà Nội','cod',$3,200000,0,200000) RETURNING *`, [randomUUID(), customer.id, status])).rows[0];
    await query("INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd) VALUES($1,$2,'Transaction Product','Default','TRANSACTION-SKU',100000,2,200000)", [row.id, variant.id]);
    await withTransaction(pool, c => inventory.reserveStock(c, { variantId: variant.id, quantity: 2, orderId: row.id, actor }));
    return row;
  }
  const state = async id => (await query('SELECT status,payment_status FROM orders WHERE id=$1', [id])).rows[0];
  return { pool, query, actor, customer, variant, order, state };
}


for (const lostOwnership of ['missing', 'changed_hash', 'completed_status', 'altered_token', 'aba_replaced_claim']) {
  test('checkout rejects '+lostOwnership+' idempotency ownership and rolls back order, stock and allocations', async t=>{
    const f=await fixture(t);
    await f.query("UPDATE store_settings SET setting_value=$1 WHERE setting_key='shipping_rates'",[JSON.stringify({'Toàn quốc':20000})]);
    let inject=true,replacedAfterRollback=false;const successorToken=randomUUID();
    const pool={query:f.query,connect:async()=>({release(){},async query(sql,args){
      if(inject&&sql.includes("SET status = 'completed', order_id")){
        inject=false;
        if(lostOwnership==='missing') await f.query('DELETE FROM order_idempotency_keys WHERE scope_key=$1 AND idempotency_key=$2',args.slice(0,2));
        if(lostOwnership==='changed_hash') await f.query("UPDATE order_idempotency_keys SET request_hash='another-request-hash' WHERE scope_key=$1 AND idempotency_key=$2",args.slice(0,2));
        if(['altered_token','aba_replaced_claim'].includes(lostOwnership)) await f.query('UPDATE order_idempotency_keys SET claim_token=$3 WHERE scope_key=$1 AND idempotency_key=$2',[...args.slice(0,2),randomUUID()]);
        if(lostOwnership==='completed_status') await f.query("UPDATE order_idempotency_keys SET status='completed' WHERE scope_key=$1 AND idempotency_key=$2",args.slice(0,2));
      }
      const result=await f.query(sql,args);
      if(lostOwnership==='aba_replaced_claim'&&!inject&&!replacedAfterRollback&&sql==='ROLLBACK'){
        replacedAfterRollback=true;
        // Simulate the same key/hash being re-claimed by a successor after rollback
        // but before the stale request's outer failure cleanup executes.
        await f.query("UPDATE order_idempotency_keys SET claim_token=$1 WHERE idempotency_key=$2",[successorToken,'ownership-'+lostOwnership]);
      }
      return result;
    }})};
    const router=createStoreApi(pool,{ordersEnabled:true,inventory,finance,audit:appendAudit});
    const handler=router.stack.find(l=>l.route?.path==='/orders'&&l.route.methods.post).route.stack.at(-1).handle;
    const body={customer:{name:'Transaction Buyer',email:'transaction@example.invalid',phone:'0900000000',address:'Fixture Street',city:'Hà Nội'},paymentMethod:'cod',idempotencyKey:'ownership-'+lostOwnership,items:[{variantId:f.variant.id,quantity:2}]};
    async function checkout(){let status=200,result,error;await handler({body,get:()=>undefined,session:{customer:{id:f.customer.id}}},{status(x){status=x;return this;},json(x){result=x;return this;}},e=>{error=e;});if(error)return {status:error.status||500,error};return{status,result};}
    const rejected=await checkout();assert.equal(rejected.status,409,'lost ownership must reject before committing the order');
    assert.equal((await f.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,0);
    assert.equal((await f.query('SELECT count(*)::int AS n FROM order_stock_allocations')).rows[0].n,0);
    assert.equal((await f.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[f.variant.id])).rows[0].stock_quantity,10);
    assert.equal(Number((await f.query('SELECT SUM(quantity) AS n FROM warehouse_stock WHERE variant_id=$1',[f.variant.id])).rows[0].n),10);
    if(lostOwnership==='aba_replaced_claim'){
      const successor=(await f.query('SELECT claim_token,status FROM order_idempotency_keys WHERE idempotency_key=$1',[body.idempotencyKey])).rows[0];
      assert.deepEqual(successor,{claim_token:successorToken,status:'in_progress'},'stale cleanup must preserve the replacement claim with the same key and hash');
      // End the simulated successor; a fresh properly owned request can retry.
      await f.query('DELETE FROM order_idempotency_keys WHERE claim_token=$1',[successorToken]);
    }
    const created=await checkout(),replay=await checkout();assert.equal(created.status,201);assert.equal(replay.status,201);assert.equal(created.result.order.id,replay.result.order.id);
    assert.equal((await f.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,1);
    assert.equal((await f.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[f.variant.id])).rows[0].stock_quantity,8);
    assert.equal((await f.query('SELECT count(*)::int AS n FROM order_stock_allocations')).rows[0].n,1);
  });
}
