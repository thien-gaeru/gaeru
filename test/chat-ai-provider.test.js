const test=require('node:test'),assert=require('node:assert/strict');
const {generate}=require('../src/chat-ai-provider');
const answer={answer:'Thông tin đã xác minh.',handoff:false};
for(const provider of ['openai','gemini','claude'])test(provider+' validates a real chat-shaped response and never exposes upstream failures',async()=>{
 const settings={enabled:true,provider,apiKey:'private-fixture-key',model:'fixture-model'};let request;
 const transport=async(url,options)=>{request={url,options,body:JSON.parse(options.body)};return {ok:true,json:async()=>provider==='openai'?{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(answer)}]}]}:provider==='gemini'?{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer)}]}}]}:{stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(answer)}]}};};
 assert.deepEqual(await generate({settings,product:{name:'Fixture'},question:'Question',decision:true,transport}),answer);
 assert.equal(request.options.redirect,'error');assert.ok(!request.url.includes(settings.apiKey));
 if(provider==='openai'){assert.equal(request.body.store,false);assert.equal(request.body.text.format.strict,true);}
 if(provider==='gemini'){assert.equal(request.options.headers['x-goog-api-key'],settings.apiKey);assert.equal(request.body.generationConfig.responseMimeType,'application/json');}
 if(provider==='claude')assert.equal(request.options.headers['x-api-key'],settings.apiKey);
 for(const data of [{},{error:{message:'private-fixture-key'}},provider==='gemini'?{candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:JSON.stringify(answer)}]}}]}:provider==='claude'?{stop_reason:'max_tokens',content:[{type:'text',text:JSON.stringify(answer)}]}:{status:'incomplete',output:[{content:[{type:'output_text',text:JSON.stringify(answer)}]}]}]){
  await assert.rejects(generate({settings,product:{},question:'Test',decision:true,transport:async()=>({ok:true,json:async()=>data})}),e=>e.status===503&&!e.message.includes(settings.apiKey));
 }
 await assert.rejects(generate({settings,decision:true,transport:async()=>{throw Error(settings.apiKey);}}),e=>!e.message.includes(settings.apiKey));
});
