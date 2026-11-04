const {createHash,createHmac,randomBytes,createCipheriv,createDecipheriv,timingSafeEqual}=require('node:crypto');
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const hash=v=>createHash('sha256').update(v).digest('hex');
function base32(bytes){let bits=0,value=0,out='';for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function decode(s){let bits=0,value=0,out=[];for(const c of s){const i=alphabet.indexOf(c);if(i<0)throw Error('Invalid base32');value=(value<<5)|i;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
function totp(secret,counter,digits=6){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(counter));const mac=createHmac('sha1',decode(secret)).update(b).digest(),o=mac[mac.length-1]&15;return String((mac.readUInt32BE(o)&0x7fffffff)%10**digits).padStart(digits,'0');}
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function verify(secret,code,last=-1,now=Date.now()){if(!/^\d{6}$/.test(code||''))return null;const current=Math.floor(now/30000);for(const c of [current,current-1,current+1])if(c>Number(last)&&equal(totp(secret,c),code))return c;return null;}
function seal(value,key){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(hash(key),'hex'),iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),data].map(b=>b.toString('base64url')).join('.');}
function open(value,key){const [iv,tag,data]=value.split('.').map(v=>Buffer.from(v,'base64url'));const decipher=createDecipheriv('aes-256-gcm',Buffer.from(hash(key),'hex'),iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8');}
module.exports={hash,base32,totp,verify,seal,open,equal};
