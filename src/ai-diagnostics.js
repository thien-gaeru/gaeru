const messages={
  NOT_CONFIGURED:'AI chưa được cấu hình. Lưu nhà cung cấp, model và khóa API trước khi kiểm tra.',
  KEY_INVALID:'Nhà cung cấp từ chối khóa API. Kiểm tra khóa đã lưu có đúng dịch vụ và còn hiệu lực.',
  KEY_RESTRICTED:'Khóa API bị giới hạn ứng dụng, tên miền, IP hoặc dịch vụ. Kiểm tra quyền dùng khóa từ máy chủ GAERU.',
  API_DISABLED:'API chưa được bật cho dự án của khóa. Bật dịch vụ tương ứng trong tài khoản nhà cung cấp.',
  WORKSPACE_REQUIRED:'Nhà cung cấp yêu cầu workspace hợp lệ. Dùng khóa được cấp cho đúng workspace.',
  PERMISSION_DENIED:'Khóa chưa có quyền truy cập dịch vụ hoặc model này. Kiểm tra quyền của tài khoản và dự án.',
  BILLING:'Nhà cung cấp báo vấn đề thanh toán hoặc giới hạn chi tiêu. Kiểm tra tài khoản API.',
  MODEL_NOT_FOUND:'Không tìm thấy model hoặc khóa chưa được quyền truy cập model này. Kiểm tra lại ID model.',
  RATE_OR_QUOTA:'Nhà cung cấp báo hết hạn mức hoặc vượt tần suất API. Kiểm tra quota và giới hạn sử dụng.',
  REQUEST_UNSUPPORTED:'Nhà cung cấp từ chối định dạng yêu cầu. Model hoặc phiên bản API có thể chưa hỗ trợ cấu hình Chat AI này.',
  PROVIDER_UNAVAILABLE:'Dịch vụ AI đang lỗi hoặc quá tải. Thử lại sau.',
  TIMEOUT:'Máy chủ GAERU chờ dịch vụ AI quá lâu. Chưa xác minh được kết nối.',
  NETWORK:'Máy chủ GAERU chưa kết nối được tới dịch vụ AI. Kiểm tra kết nối mạng từ máy chủ.',
  NETWORK_TLS:'Không xác minh được kết nối HTTPS tới dịch vụ AI. Cần kiểm tra chứng chỉ hoặc mạng máy chủ.',
  OUTPUT_TRUNCATED:'Model đã phản hồi nhưng hết giới hạn đầu ra trước khi hoàn tất. Chưa thể xác nhận Chat AI hoạt động.',
  CONTENT_BLOCKED:'Nhà cung cấp chặn hoặc từ chối nội dung thử. Chưa xác minh được định dạng Chat AI.',
  RESPONSE_INVALID:'Nhà cung cấp đã phản hồi nhưng dữ liệu trả về không hợp lệ.',
  OUTPUT_FORMAT:'Model đã phản hồi nhưng chưa trả đúng định dạng Chat AI của GAERU.',
  UNKNOWN:'Chưa xác minh được Chat AI. Cần kiểm tra kết nối và cấu hình nhà cung cấp.'
};
function aiError(settings,code,details={}){
  if(!Object.hasOwn(messages,code))code='UNKNOWN';
  const diagnostic={code,provider:['openai','gemini','claude'].includes(settings?.provider)?settings.provider:'unknown',model:(settings?.apiKey&&String(settings?.model||'').includes(settings.apiKey))||/^(sk-|AIza)/.test(String(settings?.model||''))?'[model không hợp lệ]':String(settings?.model||'').slice(0,120)};
  if(Number.isInteger(details.upstreamStatus)&&details.upstreamStatus>=100&&details.upstreamStatus<=599)diagnostic.upstreamStatus=details.upstreamStatus;
  const id=details.requestId;
  if(typeof id==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(id)&&(!settings?.apiKey||!id.includes(settings.apiKey)))diagnostic.requestId=id;
  return Object.assign(Error(messages[code]),{status:503,aiDiagnostic:diagnostic});
}
function upstreamError(settings,response,data){
  const status=response.status,details=Array.isArray(data?.error?.details)?data.error.details:[],reason=String(details.find(d=>d?.reason)?.reason||data?.error?.code||'');
  // Only classify upstream text. Never return it: it can echo credentials or prompts.
  const message=String(data?.error?.message||'').slice(0,2000);let code;
  if(/API_KEY_(INVALID|EXPIRED)|invalid_api_key/.test(reason)||status===401||([400,403].includes(status)&&/API key not valid|invalid API[- ]?key|API[- ]?key.*(?:expired|revoked)/i.test(message)))code='KEY_INVALID';
  else if(/^API_KEY_.*BLOCKED$/.test(reason))code='KEY_RESTRICTED';
  else if(reason==='SERVICE_DISABLED')code='API_DISABLED';
  else if(status===402||/BILLING|insufficient_quota/.test(reason)||(status===400&&/spend limit|credit balance|billing/i.test(message)))code='BILLING';
  else if((status===400||status===403)&&/workspace/i.test(message))code='WORKSPACE_REQUIRED';
  else if(status===403)code='PERMISSION_DENIED';
  else if(status===404)code='MODEL_NOT_FOUND';
  else if(status===429)code='RATE_OR_QUOTA';
  else if(status===408||status===504)code='TIMEOUT';
  else if(status>=500)code='PROVIDER_UNAVAILABLE';
  else if(status===400||status===422)code='REQUEST_UNSUPPORTED';
  else code='UNKNOWN';
  return aiError(settings,code,{upstreamStatus:status,requestId:response.headers?.get?.('request-id')||response.headers?.get?.('x-request-id')});
}
module.exports={aiError,upstreamError};
