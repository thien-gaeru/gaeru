const test=require('node:test'),assert=require('node:assert/strict');
const {answerAI,fileType}=require('../src/shopping-chat-extras');
test('shopping AI sends only explicit question and product facts, labels failures and avoids provider storage',async()=>{
  let sent;
  const answer=await answerAI({config:{OPENAI_API_KEY:'fixture'},product:{name:'Fixture',description:'USB C'},question:'Kết nối nào?',transport:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(options.body);return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:'Sản phẩm hỗ trợ USB C.'}]}]})};}});
  assert.equal(sent.store,false);assert.equal(sent.max_output_tokens,650);assert.deepEqual(JSON.parse(sent.input),{product:{name:'Fixture',description:'USB C'},question:'Kết nối nào?'});assert.equal(answer,'Sản phẩm hỗ trợ USB C.');
  await assert.rejects(answerAI({config:{},product:{},question:'test'}),/chưa được cấu hình/);
  await assert.rejects(answerAI({config:{OPENAI_API_KEY:'fixture'},product:{},question:'test',transport:async()=>({ok:false})}),/chưa phản hồi/);
});
test('chat attachment validation rejects executable or forged image content',()=>{
  assert.equal(fileType({originalname:'bad.png',buffer:Buffer.from('<script>bad</script>')}),null);
  assert.equal(fileType({originalname:'bad.exe',buffer:Buffer.from('MZbinary')}),null);
  assert.equal(fileType({originalname:'file.pdf',buffer:Buffer.from('%PDF-1.7')}),'application/pdf');
  assert.equal(fileType({originalname:'notes.txt',buffer:Buffer.from('Nội dung tiếng Việt')}),'text/plain');
});
