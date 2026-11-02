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
 if(provider==='claude'){assert.equal(request.options.headers['x-api-key'],settings.apiKey);assert.equal(request.body.output_config.format.type,'json_schema');assert.equal(request.body.max_tokens,4096);}if(provider==='gemini')assert.equal(request.body.generationConfig.maxOutputTokens,4096);
 for(const data of [{},{error:{message:'private-fixture-key'}},provider==='gemini'?{candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:JSON.stringify(answer)}]}}]}:provider==='claude'?{stop_reason:'max_tokens',content:[{type:'text',text:JSON.stringify(answer)}]}:{status:'incomplete',output:[{content:[{type:'output_text',text:JSON.stringify(answer)}]}]}]){
  await assert.rejects(generate({settings,product:{},question:'Test',decision:true,transport:async()=>({ok:true,json:async()=>data})}),e=>e.status===503&&!e.message.includes(settings.apiKey));
 }
 await assert.rejects(generate({settings,decision:true,transport:async()=>{throw Error(settings.apiKey);}}),e=>!e.message.includes(settings.apiKey));
});

for(const provider of ['openai','gemini','claude'])test(provider+' exposes only bounded, classified failure metadata',async()=>{
 const settings={enabled:true,provider,apiKey:'secret-fixture-api-key',model:'fixture-model'};
 const cases=[
  [400,{details:[{reason:'API_KEY_INVALID'}]},'KEY_INVALID'],[400,{message:'API key not valid. Please pass a valid API key.'},'KEY_INVALID'],
  [400,{details:[{reason:'API_KEY_HTTP_REFERRER_BLOCKED'}]},'KEY_RESTRICTED'],
  [403,{details:[{reason:'SERVICE_DISABLED'}]},'API_DISABLED'],
  [401,{},'KEY_INVALID'],[402,{},'BILLING'],[403,{},'PERMISSION_DENIED'],[404,{},'MODEL_NOT_FOUND'],[429,{},'RATE_OR_QUOTA'],[503,{},'PROVIDER_UNAVAILABLE'],[504,{},'TIMEOUT'],[400,{},'REQUEST_UNSUPPORTED'],
  [400,{message:'workspace spend limit reached'},'BILLING'],[400,{message:'workspace header required'},'WORKSPACE_REQUIRED']
 ];
 for(const [status,details,code]of cases){
  await assert.rejects(generate({settings,decision:true,product:{},question:'customer-private-question',transport:async()=>({ok:false,status,headers:new Headers({'request-id':'req_fixture_safe'}),json:async()=>({error:{message:'<script>'+settings.apiKey+' customer-private-question',...details}})})}),error=>{
   assert.equal(error.aiDiagnostic.code,code);assert.equal(error.aiDiagnostic.provider,provider);assert.equal(error.aiDiagnostic.model,'fixture-model');assert.equal(error.aiDiagnostic.upstreamStatus,status);assert.equal(error.aiDiagnostic.requestId,'req_fixture_safe');assert.ok(!JSON.stringify(error.aiDiagnostic).includes(settings.apiKey));assert.ok(!error.message.includes('customer-private-question'));return true;
  });
 }
 await assert.rejects(generate({settings,decision:true,transport:async()=>({ok:false,status:401,headers:new Headers({'request-id':settings.apiKey}),json:async()=>({})})}),e=>e.aiDiagnostic.requestId===undefined);
 await assert.rejects(generate({settings,decision:true,transport:async()=>{throw Object.assign(Error(settings.apiKey),{name:'TimeoutError'});}}),e=>e.aiDiagnostic.code==='TIMEOUT');
 await assert.rejects(generate({settings,decision:true,transport:async()=>{throw Object.assign(Error(settings.apiKey),{cause:{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'}});}}),e=>e.aiDiagnostic.code==='NETWORK_TLS');
 await assert.rejects(generate({settings,decision:true,transport:async()=>{throw Error(settings.apiKey);}}),e=>e.aiDiagnostic.code==='NETWORK');
 const limit=provider==='openai'?{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}:provider==='gemini'?{candidates:[{finishReason:'MAX_TOKENS'}]}:{stop_reason:'max_tokens'};await assert.rejects(generate({settings,decision:true,transport:async()=>({ok:true,json:async()=>limit})}),e=>e.aiDiagnostic.code==='OUTPUT_TRUNCATED');
 const envelope=text=>provider==='openai'?{status:'completed',output:[{content:[{type:'output_text',text}]}]}:provider==='gemini'?{candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]}:{stop_reason:'end_turn',content:[{type:'text',text}]};
 for(const invalid of ['```json\n{}\n```',JSON.stringify({answer:'Hello',handoff:'false'}),JSON.stringify({answer:'Hello',handoff:false,unexpected:true})])await assert.rejects(generate({settings,decision:true,transport:async()=>({ok:true,json:async()=>envelope(invalid)})}),e=>e.aiDiagnostic.code==='OUTPUT_FORMAT');
});
