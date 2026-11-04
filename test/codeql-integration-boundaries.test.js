'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { extractPageKnowledge } = require('../src/chat-web-knowledge');

test('page knowledge excludes active/navigation content with whitespace and mixed-case closing tags', () => {
  const page = extractPageKnowledge('fixture.html', `<html><head><title>Fixture</title></head><body><main>
    <h1>Thông tin an toàn</h1><script data-test="x">SCRIPT_SHOULD_NOT_ENTER_AI</script >
    <style>STYLE_SHOULD_NOT_ENTER_AI</STYLE\t><nav>NAV_SHOULD_NOT_ENTER_AI</nav >
    <svg><text>SVG_SHOULD_NOT_ENTER_AI</text></svg ><dialog>DIALOG_SHOULD_NOT_ENTER_AI</dialog >
    <footer>FOOTER_SHOULD_NOT_ENTER_AI</footer ><template>TEMPLATE_SHOULD_NOT_ENTER_AI</template>
    <p>Hướng dẫn kết nối <strong>GAERU K9</strong> và bảo hành.</p><p>Dòng tiếp theo.</p>
    </main></body></html>`);
  assert.doesNotMatch(page.content, /SHOULD_NOT_ENTER_AI/);
  assert.match(page.content, /Hướng dẫn kết nối GAERU K9 và bảo hành\./);
  assert.match(page.content, /bảo hành\.\nDòng tiếp theo\./);
});

test('page knowledge decodes entities once, preserves literal entity notation and supports Unicode code points', () => {
  const page = extractPageKnowledge('fixture.html', `<html><head><title>Hướng dẫn &amp;lt;K9&amp;gt; &#x1F600;</title>
    <meta NAME="DESCRIPTION" content="A &amp;quot;quoted&amp;quot; &amp;amp; B"></head><body><main>
    <p>Literal &amp;lt;b&amp;gt; remains text; once &lt;b&gt; is text too; emoji &#128512;.</p>
    <p>Giá &amp;amp; VAT &nbsp; đã gồm.</p></main></body></html>`);
  assert.equal(page.title, 'Hướng dẫn &lt;K9&gt; 😀');
  assert.equal(page.description, 'A &quot;quoted&quot; &amp; B');
  assert.match(page.content, /Literal &lt;b&gt; remains text; once <b> is text too; emoji 😀\./);
  assert.match(page.content, /Giá &amp; VAT đã gồm\./);
});

test('adversarial bounded gateway references reject promptly before any provider request', () => {
  const modulePath = require.resolve('../src/payment-provider-clients');
  const script = `const assert=require('node:assert/strict');const {createGatewayPayment}=require(${JSON.stringify(modulePath)});
    const settings={environment:'sandbox',partnerCode:'FIXTURE',accessKey:'FIXTURE',secretKey:'fixture-secret'};
    const base={amountVnd:100,baseUrl:'https://gaeru.com'};let calls=0;const fetcher=async()=>{calls++;throw Error('must not call');};
    (async()=>{for(const length of [32,40,49]){const hostile='0'.repeat(length)+'!';
      await assert.rejects(createGatewayPayment('momo',settings,{...base,txnRef:hostile,fetcher}),e=>e.status===400);
      await assert.rejects(createGatewayPayment('momo',settings,{...base,txnRef:'SAFE',requestId:hostile,fetcher}),e=>e.status===400);
    }assert.equal(calls,0);})().catch(e=>{console.error(e);process.exitCode=1;});`;
  // A child watchdog keeps this regression safe even if exponential matching
  // is accidentally reintroduced before the async API can return a promise.
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 2500 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('linear gateway reference validation preserves existing single-character, repeated-separator and maximum-length identifiers', async () => {
  const { createGatewayPayment } = require('../src/payment-provider-clients');
  const settings={environment:'sandbox',partnerCode:'FIXTURE',accessKey:'FIXTURE',secretKey:'fixture-secret'};
  const base={amountVnd:100,baseUrl:'https://gaeru.com'};
  let calls=0;
  const fetcher=async(_url,init)=>{calls++;const body=JSON.parse(init.body);return new Response(JSON.stringify({partnerCode:body.partnerCode,orderId:body.orderId,requestId:body.requestId,amount:body.amount,resultCode:0,payUrl:'https://test-payment.momo.vn/pay?fixture=1'}));};
  for(const value of ['A','A..--__Z','0'.repeat(50)]){
    assert.equal((await createGatewayPayment('momo',settings,{...base,txnRef:value,requestId:value,fetcher})).requestId,value);
  }
  assert.equal(calls,3);
  for(const value of ['-A','A-','A B','A/B','0'.repeat(51)]){
    await assert.rejects(createGatewayPayment('momo',settings,{...base,txnRef:value,fetcher}),error=>error.status===400);
  }
  assert.equal(calls,3,'invalid references are rejected before the provider boundary');
});

test('J&T Vietnam public signature contract uses binary MD5 bytes before Base64', () => {
  const { jtAdapter } = require('../src/shipping-adapters');
  assert.equal(jtAdapter.createDigest('a', 'bc'), 'kAFQmDzST7DWlj99KOF/cg==');
});
