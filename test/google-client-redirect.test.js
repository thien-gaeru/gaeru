const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('Google callback completes login without following untrusted return URLs',async()=>{
 const all=fs.readFileSync(require.resolve('../account.js'),'utf8'),source=all.slice(all.indexOf('async function initGoogleOAuth('),all.indexOf('function bindOAuthButtons('));
 for(const target of ['//outside.invalid','/\n/outside.invalid','javascript:alert(1)','https://outside.invalid/']){
  let callback,customer=null;const location={pathname:'/tai-khoan',search:'?returnUrl='+encodeURIComponent(target),href:'/tai-khoan'};
  const context={window:{location,google:{accounts:{id:{initialize:options=>callback=options.callback}}}},history:{replaceState(){}},document:{querySelectorAll:()=>[]},loadOAuthConfig:async()=>({google:{clientId:'test.apps.googleusercontent.com'}}),loadGoogleSdk:async()=>{},googleGsiInitialized:false,accountCsrfToken:'',setAccountFeedback(){},showCustomerProfile:c=>customer=c,accountRequest:async(url,body)=>{assert.equal(url,'/api/customer-auth/oauth/google');assert.equal(body.credential,'signed-token-fixture');return {csrfToken:'new-token',customer:{id:'fixture'}};},URLSearchParams,setTimeout:fn=>fn()};
  vm.runInNewContext(source+';this.init=initGoogleOAuth;',context);await context.init();await callback({credential:'signed-token-fixture'});assert.equal(customer.id,'fixture');assert.equal(location.href,'/tai-khoan');assert.equal(context.accountCsrfToken,'new-token');
 }
});
