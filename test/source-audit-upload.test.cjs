'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const rules = require('../src/audit-fixes/upload-state');
const { receiveChunk } = require('../src/audit-fixes/upload-session');
const { withinBcryptLimit } = require('../src/audit-fixes/password-rules');
const key = '11111111-1111-4111-8111-111111111111';
const meta = (index=0, overrides={}) => ({requestKey:key,fileName:'example.txt',chunkIndex:index,totalChunks:3,totalBytes:3,...overrides});
const initial = () => ({file_name:'example.txt',total_bytes:3,total_chunks:3,received_chunks:0,content:Buffer.alloc(0),chunk_hashes:{},completed_file_id:null});
const step = (state, index, bytes, overrides={}) => {
  const result=rules.appendChunk(state,meta(index,overrides),Buffer.from(bytes));
  return {...state,content:result.content,chunk_hashes:result.receipts,received_chunks:result.received};
};
test('password byte rule accepts the exact 72-byte boundary',()=>{
  assert.equal(withinBcryptLimit('a'.repeat(72)),true);
  assert.equal(withinBcryptLimit('a'.repeat(73)),false);
});
test('password byte rule measures UTF-8, not JavaScript character count',()=>{
  assert.equal(withinBcryptLimit('\u00e9'.repeat(36)),true);
  assert.equal(withinBcryptLimit('\u00e9'.repeat(37)),false);
  assert.equal(withinBcryptLimit('\u{1f60a}'.repeat(18)),true);
  assert.equal(withinBcryptLimit('\u{1f60a}'.repeat(19)),false);
});
test('password byte rule rejects non-string values',()=>{
  for(const value of [null,undefined,72,{},Buffer.from('hello')])assert.equal(withinBcryptLimit(value),false);
});
test('ordered chunks assemble ABC exactly',()=>{
  let state=initial();for(const [i,b] of ['A','B','C'].entries())state=step(state,i,b);
  assert.equal(state.content.toString(),'ABC');assert.equal(state.received_chunks,3);
});
test('retrying a middle chunk does not append or advance',()=>{
  let state=step(step(initial(),0,'A'),1,'B');
  const retry=rules.appendChunk(state,meta(1),Buffer.from('B'));
  assert.equal(retry.duplicate,true);assert.equal(retry.received,2);assert.equal(retry.content.toString(),'AB');
  state=step(state,2,'C');assert.equal(state.content.toString(),'ABC');
});
test('retrying the first chunk does not reset progress',()=>{
  const state=step(step(initial(),0,'A'),1,'B');
  const retry=rules.appendChunk(state,meta(0),Buffer.from('A'));
  assert.equal(retry.received,2);assert.equal(retry.content.toString(),'AB');
});
test('retry with changed bytes is rejected',()=>{
  const state=step(initial(),0,'A');
  assert.throws(()=>rules.appendChunk(state,meta(0),Buffer.from('X')),e=>e.status===409);
});
test('out-of-order chunks are rejected',()=>assert.throws(()=>step(initial(),1,'B'),/out of order/));
test('a missing middle chunk cannot complete a file',()=>assert.throws(()=>step(step(initial(),0,'A'),2,'C'),/out of order/));
test('declared filename cannot change mid-upload',()=>assert.throws(()=>step(step(initial(),0,'A'),1,'B',{fileName:'other.txt'}),/metadata changed/));
test('declared byte count cannot change mid-upload',()=>assert.throws(()=>step(step(initial(),0,'A'),1,'B',{totalBytes:4}),/metadata changed/));
test('declared chunk count cannot change mid-upload',()=>assert.throws(()=>step(step(initial(),0,'A'),1,'B',{totalChunks:2}),/metadata changed/));
test('final chunk requires exact byte count',()=>{
  const state={...initial(),total_bytes:4};
  const first=step(state,0,'A',{totalBytes:4});const second=step(first,1,'B',{totalBytes:4});
  assert.throws(()=>step(second,2,'C',{totalBytes:4}),/length do not match/);
});
test('overflow beyond declared byte count is rejected',()=>{
  const state=step(step(initial(),0,'A'),1,'B');assert.throws(()=>step(state,2,'CC'),/exceed the declared/);
});
test('all bytes cannot arrive before the final chunk',()=>assert.throws(()=>step(initial(),0,'ABC'),/length do not match/));
test('completed upload retries preserve stored file marker',()=>{
  let state=initial();for(const [i,b]of ['A','B','C'].entries())state=step(state,i,b);
  state={...state,content:Buffer.alloc(0),completed_file_id:'saved-file'};
  const retry=rules.appendChunk(state,meta(2),Buffer.from('C'));
  assert.equal(retry.duplicate,true);assert.equal(retry.complete,true);assert.equal(retry.content.length,0);
});
test('legacy progress without chunk receipts must restart',()=>{
  const state={...initial(),received_chunks:1,content:Buffer.from('A')};
  assert.throws(()=>step(state,1,'B'),/older version/);
});
for(const [name,change]of Object.entries({zero:{totalBytes:0},negative:{totalBytes:-1},oversized:{totalBytes:rules.MAX_FILE_BYTES+1},unsafe:{totalBytes:Number.MAX_SAFE_INTEGER+1},fraction:{totalBytes:3.5}})){
  test(`metadata rejects ${name} file length`,()=>assert.throws(()=>rules.validateMeta(meta(0,change),Buffer.from('A')),e=>e.status===413));
}
for(const [name,change]of Object.entries({negative:{chunkIndex:-1},outOfBounds:{chunkIndex:3},fraction:{chunkIndex:0.5},tooMany:{totalChunks:257,totalBytes:1000},empty:{totalChunks:0}})){
  test(`metadata rejects ${name} chunk number`,()=>assert.throws(()=>rules.validateMeta(meta(0,change),Buffer.from('A')),e=>e.status===400));
}
test('metadata rejects malformed request key',()=>assert.throws(()=>rules.validateMeta(meta(0,{requestKey:'bad'}),Buffer.from('A')),e=>e.status===400));
test('metadata rejects empty or oversized chunk',()=>{
  assert.throws(()=>rules.validateMeta(meta(),Buffer.alloc(0)),e=>e.status===413);
  assert.throws(()=>rules.validateMeta(meta(0,{totalBytes:rules.MAX_FILE_BYTES}),Buffer.alloc(rules.MAX_CHUNK_BYTES+1)),e=>e.status===413);
});
function response(){const res=new EventEmitter();res.status=code=>{res.code=code;return res;};res.json=body=>{res.body=body;return res;};return res;}
test('upload gate caps concurrent requests before buffering',()=>{
  const gate=rules.createUploadGate(2),a=response(),b=response(),c=response();let started=0;
  gate({},a,()=>started++);gate({},b,()=>started++);gate({},c,()=>started++);
  assert.equal(started,2);assert.equal(c.code,429);
  a.emit('finish');gate({},response(),()=>started++);assert.equal(started,3);
});
test('upload gate releases only once on finish and close',()=>{
  const gate=rules.createUploadGate(1),a=response();gate({},a,()=>{});a.emit('finish');a.emit('close');
  gate({},response(),()=>{});const c=response();gate({},c,()=>assert.fail('gate released twice'));assert.equal(c.code,429);
});
test('upload gate releases capacity on synchronous middleware failure',()=>{
  const gate=rules.createUploadGate(1);assert.throws(()=>gate({},response(),()=>{throw Error('fixture');}),/fixture/);
  let started=false;gate({},response(),()=>started=true);assert.equal(started,true);
});
test('upload gate validates its configuration',()=>{for(const value of [0,-1,17,1.5,NaN])assert.throws(()=>rules.createUploadGate(value));});

// These are deliberately SQL-contract test doubles, NOT PostgreSQL integration tests.
function copy(value){if(Buffer.isBuffer(value))return Buffer.from(value);if(Array.isArray(value))return value.map(copy);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,copy(v)]));return value;}
class MemoryClient {
  constructor(){this.state={sessions:[],files:[],messages:[],threadStatus:'open',persistCalls:0};this.queries=[];}
  async transaction(fn){const old=copy(this.state);try{return await fn(this);}catch(error){this.state=old;throw error;}}
  async query(sql,values=[]){
    const q=sql.replace(/\s+/g,' ').trim();this.queries.push({q,values:copy(values)});const rows=value=>({rows:value});
    if(q.startsWith('SELECT pg_advisory_xact_lock'))return rows([]);
    if(q.startsWith('SELECT status FROM shopping_chat_threads'))return rows([{status:this.state.threadStatus}]);
    if(q.startsWith('DELETE FROM shopping_chat_upload_sessions')){this.state.sessions=this.state.sessions.filter(s=>!s.expired);return rows([]);}
    if(q.includes('CASE WHEN octet_length(content)')){
      const s=this.state.sessions.find(s=>s.thread_id===values[0]&&s.request_key===values[1]);
      if(!s)return rows([]);const c=copy(s);if(c.content.length>values[2])c.content=null;return rows([c]);
    }
    if(q.startsWith('SELECT id FROM shopping_chat_messages'))return rows(this.state.messages.filter(m=>m.thread_id===values[0]&&m.request_key===values[1]));
    if(q.startsWith('SELECT COUNT(*)::int AS sessions')){
      const active=this.state.sessions.filter(s=>!s.completed_file_id);
      return rows([{sessions:active.length,reserved:active.reduce((n,s)=>n+Number(s.total_bytes),0),thread_sessions:active.filter(s=>s.thread_id===values[0]).length}]);
    }
    if(q.startsWith('INSERT INTO shopping_chat_upload_sessions')){
      const [thread_id,sender,request_key,file_name,mime_type,total_bytes,total_chunks,content]=values;
      const s={id:randomUUID(),thread_id,sender,request_key,file_name,mime_type,total_bytes,total_chunks,content,received_chunks:0,chunk_hashes:{},completed_file_id:null};
      this.state.sessions.push(copy(s));return rows([copy(s)]);
    }
    if(q.startsWith('UPDATE shopping_chat_upload_sessions SET content=')){
      const s=this.state.sessions.find(s=>s.id===values[0]);Object.assign(s,{content:Buffer.from(values[1]),received_chunks:values[2],chunk_hashes:JSON.parse(values[3])});return rows([]);
    }
    if(q.startsWith('SELECT id,name,mime,byte_size FROM shopping_chat_files'))return rows(this.state.files.filter(f=>f.id===values[0]&&f.thread_id===values[1]).map(copy));
    if(q.startsWith('UPDATE shopping_chat_upload_sessions SET completed_file_id=')){
      const s=this.state.sessions.find(s=>s.id===values[0]);s.completed_file_id=values[1];s.content=Buffer.alloc(0);return rows([]);
    }
    throw Error('Unexpected SQL in test double: '+q);
  }
}
function receive(db,index,bytes,options={}){
  const threadId=options.threadId||'thread-1',request=meta(index,options.meta||{});
  return db.transaction(client=>receiveChunk(client,{
    thread:{id:threadId},isAdmin:options.isAdmin||false,meta:request,buffer:Buffer.from(bytes),
    detectType:options.detectType||(()=> 'text/plain'),
    persist:async(c,buffer,mime)=>{
      if(options.failStorage)throw Object.assign(Error('storage unavailable'),{status:503});
      c.state.persistCalls++;const file={id:randomUUID(),thread_id:threadId,name:request.fileName,mime,byte_size:buffer.length,bytes:Buffer.from(buffer)};
      c.state.files.push(file);c.state.messages.push({id:randomUUID(),thread_id:threadId,request_key:request.requestKey});return copy(file);
    }
  }));
}
test('SQL-contract double: ordered chunks complete exactly one file',async()=>{
  const db=new MemoryClient();assert.equal((await receive(db,0,'A')).status,'uploading');await receive(db,1,'B');
  const r=await receive(db,2,'C');assert.equal(r.status,'completed');assert.equal(db.state.persistCalls,1);assert.equal(db.state.files[0].bytes.toString(),'ABC');assert.equal(db.state.sessions[0].content.length,0);
});
test('SQL-contract double: final chunk retry returns same file without storing again',async()=>{
  const db=new MemoryClient();await receive(db,0,'A');await receive(db,1,'B');const first=await receive(db,2,'C');const retry=await receive(db,2,'C');
  assert.equal(retry.file.id,first.file.id);assert.equal(retry.duplicate,true);assert.equal(db.state.persistCalls,1);
});
test('SQL-contract double: storage failure rolls back final progress and permits retry',async()=>{
  const db=new MemoryClient();await receive(db,0,'A');await receive(db,1,'B');
  await assert.rejects(receive(db,2,'C',{failStorage:true}),/storage unavailable/);
  assert.equal(db.state.sessions[0].received_chunks,2);assert.equal(db.state.sessions[0].content.toString(),'AB');assert.equal(db.state.files.length,0);
  await receive(db,2,'C');assert.equal(db.state.files[0].bytes.toString(),'ABC');
});
test('SQL-contract double: repeated middle chunk cannot produce ABB',async()=>{
  const db=new MemoryClient();await receive(db,0,'A');await receive(db,1,'B');const r=await receive(db,1,'B');
  assert.equal(r.status,'uploading');assert.equal(r.receivedChunks,2);assert.equal(db.state.files.length,0);
  await receive(db,2,'C');assert.equal(db.state.files[0].bytes.toString(),'ABC');
});
test('SQL-contract double: modified retry leaves saved state unchanged',async()=>{
  const db=new MemoryClient();await receive(db,0,'A');await assert.rejects(receive(db,0,'X'),/different bytes/);assert.equal(db.state.sessions[0].content.toString(),'A');
});
test('SQL-contract double: closed chat rejects upload',async()=>{
  const db=new MemoryClient();db.state.threadStatus='closed';await assert.rejects(receive(db,0,'A'),/not open/);assert.equal(db.state.sessions.length,0);
});
test('SQL-contract double: sender cannot switch during upload',async()=>{
  const db=new MemoryClient();await receive(db,0,'A');await assert.rejects(receive(db,1,'B',{isAdmin:true}),e=>e.status===403);
});
test('SQL-contract double: expired upload requires a new start',async()=>{
  const db=new MemoryClient();await receive(db,0,'A');db.state.sessions[0].expired=true;await assert.rejects(receive(db,1,'B'),e=>e.status===404);
});
test('SQL-contract double: active session quota is enforced',async()=>{
  const db=new MemoryClient();await receive(db,0,'A');await receive(db,0,'A',{meta:{requestKey:randomUUID()}});
  await assert.rejects(receive(db,0,'A',{meta:{requestKey:randomUUID()}}),e=>e.status===429);assert.equal(db.state.sessions.length,2);
});
test('SQL-contract double: invalid final MIME rolls back the last chunk',async()=>{
  const db=new MemoryClient();await receive(db,0,'A');await receive(db,1,'B');
  await assert.rejects(receive(db,2,'C',{detectType:()=>null}),e=>e.status===400);assert.equal(db.state.sessions[0].content.toString(),'AB');
});
test('SQL-contract double: an oversized legacy bytea is not selected into memory',async()=>{
  const db=new MemoryClient();await receive(db,0,'A');db.state.sessions[0].content=Buffer.alloc(rules.MAX_FILE_BYTES+1);
  await assert.rejects(receive(db,1,'B'),e=>e.status===413);
  const bounded=db.queries.find(x=>x.q.includes('CASE WHEN octet_length(content)'));assert.equal(bounded.values[2],rules.MAX_FILE_BYTES);
});
test('disconnect does not free a slot while its storage task still holds a buffer',async()=>{
  const gate=rules.createUploadGate(1),req={},res=response();gate(req,res,()=>{});
  let complete;const pending=new Promise(resolve=>complete=resolve);
  const running=rules.withUploadWork(async()=>pending)(req,res,()=>{});
  res.emit('close');const blocked=response();gate({},blocked,()=>assert.fail('released during storage task'));assert.equal(blocked.code,429);
  complete();await running;let started=false;gate({},response(),()=>started=true);assert.equal(started,true);
});
test('a closed multipart request never starts a late storage task',async()=>{
  const gate=rules.createUploadGate(1),req={},res=response();gate(req,res,()=>{});res.emit('close');let called=false;
  await rules.withUploadWork(async()=>called=true)(req,res,()=>{});assert.equal(called,false);
});
