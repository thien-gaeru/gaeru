const test=require('node:test'),assert=require('node:assert/strict');
const {answerAI,fileType}=require('../src/shopping-chat-extras');
test('shopping AI sends only explicit question and product facts, labels failures and avoids provider storage',async()=>{
  let sent;
  const answer=await answerAI({config:{OPENAI_API_KEY:'fixture'},product:{name:'Fixture',description:'USB C'},question:'Kết nối nào?',transport:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(options.body);return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:'Sản phẩm hỗ trợ USB C.'}]}]})};}});
  assert.equal(sent.store,false);assert.equal(sent.max_output_tokens,650);assert.deepEqual(JSON.parse(sent.input),{product:{name:'Fixture',description:'USB C'},question:'Kết nối nào?'});assert.equal(answer,'Sản phẩm hỗ trợ USB C.');
  await assert.rejects(answerAI({config:{},product:{},question:'test'}),/chưa được cấu hình/);
  await assert.rejects(answerAI({config:{OPENAI_API_KEY:'fixture'},product:{},question:'test',transport:async()=>({ok:false})}),e=>e.aiDiagnostic?.code==='UNKNOWN');
});
test('chat attachment validation rejects executable or forged image content',()=>{
  assert.equal(fileType({originalname:'bad.png',buffer:Buffer.from('<script>bad</script>')}),null);
  assert.equal(fileType({originalname:'bad.exe',buffer:Buffer.from('MZbinary')}),null);
  assert.equal(fileType({originalname:'file.pdf',buffer:Buffer.from('%PDF-1.7')}),'application/pdf');
  assert.equal(fileType({originalname:'notes.txt',buffer:Buffer.from('Nội dung tiếng Việt')}),'text/plain');
});

test('AI decision uses a strict handoff schema and human requests bypass the model',async()=>{
 const {requestsHuman}=require('../src/shopping-chat-ai-first');assert.equal(requestsHuman('Tôi muốn gặp nhân viên'),true);assert.equal(requestsHuman('Chuyển cho người thật giúp tôi'),true);assert.equal(requestsHuman('Tôi không cần nhân viên'),false);assert.equal(requestsHuman('Sản phẩm có Type C không?'),false);
 const result=await answerAI({config:{OPENAI_API_KEY:'fixture'},product:{name:'Fixture'},question:'Need verified account action',decision:true,transport:async(url,options)=>{const body=JSON.parse(options.body);assert.equal(body.text.format.type,'json_schema');assert.equal(body.text.format.strict,true);return{ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify({answer:'Cần nhân viên kiểm tra.',handoff:true})}]}]})};}});assert.equal(result.handoff,true);
});

test('web knowledge crawler automatically indexes website pages and retrieves relevant content',async()=>{
  const {loadWebPagesIndex,getRelevantWebKnowledge}=require('../src/chat-web-knowledge');
  const pages=loadWebPagesIndex();
  assert.ok(pages.length>=15);
  assert.ok(pages.some(p=>p.url==='https://gaeru.com/care.html'));
  const careKnowledge=await getRelevantWebKnowledge(null,{question:'Chính sách bảo hành Care+ và đổi mới'});
  assert.ok(careKnowledge.webPages.some(p=>p.url.includes('care.html')||p.url.includes('warranty')));
  const k9Knowledge=await getRelevantWebKnowledge(null,{question:'Hướng dẫn kết nối',selectedProduct:{slug:'gaeru-k9',name:'GAERU K9'}});
  assert.ok(k9Knowledge.webPages.some(p=>p.url.includes('k9')));
});
