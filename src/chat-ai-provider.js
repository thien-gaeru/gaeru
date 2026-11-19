const {z}=require('zod');
const {createHash}=require('node:crypto');
const {aiError,upstreamError}=require('./ai-diagnostics');
const decisionSchema=z.object({answer:z.string().trim().min(1).max(2500),handoff:z.boolean()}).strict();
const jsonSchema={type:'object',properties:{answer:{type:'string'},handoff:{type:'boolean'}},required:['answer','handoff'],additionalProperties:false};
const instructions='Bạn là chuyên viên tư vấn công nghệ và bán hàng GAERU thông minh, chuyên sâu và chính xác. Trả lời bằng tiếng Việt tự nhiên, rõ ràng, định dạng văn bản gọn gàng. Quy tắc trả lời: 1. Đi thẳng vào đúng trọng tâm câu hỏi trong 2-5 câu hoặc tối đa 5 gạch đầu dòng gọn; KHÔNG trả lời lan man, KHÔNG tự ý chèn thêm quảng cáo hoặc bảng giá toàn cửa hàng khi khách không hỏi. 2. Dữ liệu tham khảo: Chỉ dùng thông tin xác thực trong product, webKnowledge và externalKnowledge được cung cấp; ưu tiên thông số/giá/tồn kho từ catalog thực tế (GAERU K9 & M3 & G1 ULTRA là micro thu âm, GAERU P01 là gimbal AI quay theo người, GAERU P185 là gậy selfie 4 chân); tuyệt đối không bịa thông số, giá, tồn kho hay chính sách. Chính sách chuẩn: Bảo hành 12 tháng, đổi mới 1:1 trong 7 ngày lỗi NSX/giao sai; đồng kiểm ngoại quan (không cắm thử); KHÔNG hỗ trợ xuất hóa đơn VAT điện tử (hóa đơn đỏ). 3. Hướng dẫn kỹ thuật: Phân biệt chính xác chân cắm cho từng dòng Điện thoại, Máy tính bảng, Laptop, PC; với OPPO/vivo/Realme/Redmi hướng dẫn vào Cài đặt → gõ "OTG" → bật Kết nối OTG; với máy Android không có OTG hoặc Samsung hướng dẫn kích hoạt "Gỡ lỗi USB" trước khi sử dụng; lưu ý trên OPPO, Realme/Redmi, Samsung dòng A/M và một số máy Trung Quốc, app "Máy ảnh" (cam thường) chỉ dùng mic điện thoại nên cần quay bằng TikTok, CapCut, Ulike, WutaCam (VutaCam), B612 hoặc Open Camera (Micro ngoài), chưa hiểu hướng dẫn gọi trực tiếp 082 919 1080; lưu ý iOS 18+ có mục chọn mic gắn ngoài trong Trung tâm điều khiển, còn iOS dưới 18 không cần chọn thủ công. 4. Đề xuất mua hàng: Khi khách chốt mua sản phẩm còn hàng và có `id` phân loại trong catalog, bạn có thể đính kèm tối đa 2-3 liên kết đặt hàng dạng `[Mua ngay Tên sản phẩm · Phân loại (Giá)](/thanh-toan?variant=VARIANT_ID)` hoặc `[Chọn phân loại & Mua ngay Tên sản phẩm](/san-pham/SLUG)` (tuyệt đối không gắn link Mua ngay cho phân loại hết hàng). 5. Không tiết lộ bí mật, không yêu cầu mật khẩu/OTP, không tự ý xác nhận thanh toán khi chưa có nhân viên duyệt, không nói đã xem tệp. Trả JSON gồm answer (chuỗi) và handoff (boolean). handoff=true: CHỈ KHI khách hàng đích danh yêu cầu gặp nhân viên/người thật hoặc yêu cầu thao tác riêng tư trên tài khoản/đơn hàng cần nhân viên xử lý. handoff=false: Cho TẤT CẢ câu hỏi tư vấn sản phẩm, kỹ thuật, tương thích, so sánh, giá bán, khuyến mãi và bảo hành.';
const responseCache=new Map();
const RESPONSE_CACHE_TTL_MS=300000;
const RESPONSE_CACHE_MAX=250;

async function getChatAIConfig(pool,config){
  const record=await require('./admin-configuration').readRecord(pool,config,'chat_ai');
  if(!record.version)return {provider:'openai',apiKey:config.OPENAI_API_KEY||'',model:config.OPENAI_CHAT_MODEL||'gpt-4.1-mini',enabled:Boolean(config.OPENAI_API_KEY)};
  const value=record.data,profile=value.profiles?.[value.provider]||{};
  return {provider:value.provider,apiKey:profile.apiKey||'',model:profile.model||'',enabled:value.enabled===true};
}

async function generate({settings,product,question,decision=false,transport=fetch}){
  if(!settings?.enabled||!settings.apiKey||!settings.model)throw aiError(settings,'NOT_CONFIGURED');
  const input=JSON.stringify({product,question});
  const useCache=transport===fetch;
  let cacheKey='';
  if(useCache){
    cacheKey=createHash('sha256').update(`${settings.provider}:${settings.model}:${decision?1:0}:${input}`).digest('hex');
    const hit=responseCache.get(cacheKey);
    if(hit&&hit.expiresAt>Date.now()){
      return structuredClone(hit.value);
    }
    if(hit)responseCache.delete(cacheKey);
  }
  let url,headers={'Content-Type':'application/json','Connection':'keep-alive'},body;
  if(settings.provider==='openai'){
    url='https://api.openai.com/v1/responses';headers.Authorization='Bearer '+settings.apiKey;
    body={model:settings.model,store:false,max_output_tokens:650,instructions:decision?instructions:instructions.replace('Trả JSON gồm answer (chuỗi) và handoff (boolean).','Trả lời văn bản thuần.'),input,...(decision?{text:{format:{type:'json_schema',name:'gaeru_chat_decision',strict:true,schema:jsonSchema}}}:{})};
  }else if(settings.provider==='gemini'){
    url='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(settings.model)+':generateContent';headers['x-goog-api-key']=settings.apiKey;
    const fastThinking=/^gemini-2\.5-flash/i.test(settings.model)?{thinkingConfig:{thinkingBudget:0}}:{};
    body={systemInstruction:{parts:[{text:instructions}]},contents:[{role:'user',parts:[{text:input}]}],generationConfig:{maxOutputTokens:4096,responseMimeType:'application/json',responseJsonSchema:jsonSchema,...fastThinking}};
  }else if(settings.provider==='claude'){
    url='https://api.anthropic.com/v1/messages';headers['x-api-key']=settings.apiKey;headers['anthropic-version']='2023-06-01';
    body={model:settings.model,max_tokens:4096,system:instructions,messages:[{role:'user',content:input}],output_config:{format:{type:'json_schema',schema:jsonSchema}}};
  }else throw aiError(settings,'NOT_CONFIGURED');
  let received=false;try{
    const response=await transport(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000),redirect:'error'});received=true;
    if(!response.ok){let data;try{data=await response.json();}catch{}throw upstreamError(settings,response,data);}
    let data;try{data=await response.json();}catch{throw aiError(settings,'RESPONSE_INVALID');}if(!data||typeof data!=='object')throw aiError(settings,'RESPONSE_INVALID');let text;
    if(settings.provider==='openai')text=(data.output||[]).flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('\n');
    else if(settings.provider==='gemini'){const candidate=data.candidates?.[0];if(candidate?.finishReason==='MAX_TOKENS')throw aiError(settings,'OUTPUT_TRUNCATED');if(data.promptFeedback?.blockReason||['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT'].includes(candidate?.finishReason))throw aiError(settings,'CONTENT_BLOCKED');if(candidate?.finishReason!=='STOP')throw aiError(settings,'RESPONSE_INVALID');text=(candidate.content?.parts||[]).filter(p=>!p.thought).map(p=>p.text||'').join('\n');}
    else {if(data.stop_reason==='max_tokens')throw aiError(settings,'OUTPUT_TRUNCATED');if(data.stop_reason==='refusal')throw aiError(settings,'CONTENT_BLOCKED');if(data.stop_reason!=='end_turn')throw aiError(settings,'RESPONSE_INVALID');text=(data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');}
    if(settings.provider==='openai'&&data.status&&data.status!=='completed')throw aiError(settings,data.incomplete_details?.reason==='max_output_tokens'?'OUTPUT_TRUNCATED':'RESPONSE_INVALID');
    text=String(text||'').trim();if(!text||text.length>10000)throw aiError(settings,'RESPONSE_INVALID');
    let finalOutput;
    if(decision||settings.provider!=='openai'){let result;try{result=decisionSchema.parse(JSON.parse(text));}catch{throw aiError(settings,'OUTPUT_FORMAT');}finalOutput=decision?result:result.answer;}
    else finalOutput=text.slice(0,3000);
    if(useCache&&cacheKey){
      if(responseCache.size>=RESPONSE_CACHE_MAX){
        const oldestKey=responseCache.keys().next().value;
        if(oldestKey)responseCache.delete(oldestKey);
      }
      responseCache.set(cacheKey,{value:structuredClone(finalOutput),expiresAt:Date.now()+RESPONSE_CACHE_TTL_MS});
    }
    return finalOutput;
  }catch(error){if(error?.aiDiagnostic)throw error;if(received)throw aiError(settings,'RESPONSE_INVALID');if(error?.name==='TimeoutError'||error?.name==='AbortError')throw aiError(settings,'TIMEOUT');if(['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN'].includes(error?.cause?.code))throw aiError(settings,'NETWORK_TLS');throw aiError(settings,'NETWORK');}
}
module.exports={getChatAIConfig,generate};
