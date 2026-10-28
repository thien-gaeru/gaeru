const test=require('node:test'),assert=require('node:assert/strict');
const {adminSessionPolicy,stampAdminSession,ADMIN_IDLE_MS,ADMIN_ABSOLUTE_MS}=require('../src/admin-session-policy');
function request(session,path='/api/gaeru_ceo/orders',method='GET'){const req={session,path,method};let called=0;adminSessionPolicy(req,{},()=>called++);assert.equal(called,1);return req;}
test('admin idle and absolute expiry are enforced on the server',()=>{const idle={admin:{source:'staff'},adminAuthenticatedAt:Date.now()-ADMIN_IDLE_MS-5000,adminLastSeenAt:Date.now()-ADMIN_IDLE_MS-1000};request(idle);assert.equal(idle.admin,undefined);const absolute={admin:{source:'staff'},adminAuthenticatedAt:Date.now()-ADMIN_ABSOLUTE_MS-1000,adminLastSeenAt:Date.now()};request(absolute);assert.equal(absolute.admin,undefined);});
test('passive chat and notification polling do not prolong idle sessions',()=>{const s={admin:{source:'staff'}};stampAdminSession(s,Date.now()-10000);const last=s.adminLastSeenAt;request(s,'/api/gaeru_ceo/notifications');assert.equal(s.adminLastSeenAt,last);request(s,'/api/gaeru_ceo/care-requests/thread/messages');assert.equal(s.adminLastSeenAt,last);request(s,'/api/auth/activity','POST');assert.ok(s.adminLastSeenAt>last);});
test('existing admin sessions transition and customer sessions are untouched',()=>{const admin={admin:{source:'bootstrap'}};request(admin);assert.ok(admin.adminAuthenticatedAt);const customer={customer:{id:'fixture'}};request(customer);assert.equal(customer.adminAuthenticatedAt,undefined);});

test('saved session limits replace defaults on the server',()=>{const session={admin:{source:'bootstrap'},adminAuthenticatedAt:Date.now()-600000,adminLastSeenAt:Date.now()-360000};adminSessionPolicy({session,path:'/api/auth/me',method:'GET',adminSessionLimits:{idleMinutes:5,absoluteHours:2}},{},()=>{});assert.equal(session.admin,undefined);});

test('automatic order, overview and shopping chat refreshes cannot defeat idle expiry', t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 for(const path of ['/api/gaeru_ceo/orders','/api/gaeru_ceo/summary','/api/gaeru_ceo/shopping-chat','/api/gaeru_ceo/shopping-chat/thread/messages']){
  const session={admin:{source:'bootstrap'}};stampAdminSession(session,now);
  const started=now;
  for(const elapsed of [15000,600000,1740000]){now=started+elapsed;request(session,path);assert.ok(session.admin);}
  now=started+ADMIN_IDLE_MS+1000;request(session,path);assert.equal(session.admin,undefined,path+' must expire without user activity');
 }
});
