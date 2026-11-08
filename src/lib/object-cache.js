'use strict';
function createObjectCache({
  maxBytes = Number(process.env.OBJECT_CACHE_MAX_BYTES) || 256 * 1024 * 1024,
  maxEntryBytes = Number(process.env.OBJECT_CACHE_MAX_ENTRY_BYTES) || 16 * 1024 * 1024,
  ttl = 300000,
  maxPending = Number(process.env.OBJECT_CACHE_MAX_PENDING) || 128,
  now = Date.now
} = {}) {
 const items=new Map(),pending=new Map();let used=0;
 const remove=key=>{const entry=items.get(key);if(entry){used-=entry.bytes.length;items.delete(key);}};
 const peek=key=>{const entry=items.get(key);if(entry&&entry.until>now()){items.delete(key);items.set(key,entry);return entry.bytes;}if(entry)remove(key);return null;};
 async function get(key,load){const hit=peek(key);if(hit)return hit;if(pending.has(key))return pending.get(key);if(pending.size>=maxPending)throw Object.assign(Error('Media cache busy'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});
 const task=Promise.resolve().then(load).then(bytes=>{if(bytes.length<=maxEntryBytes&&bytes.length<=maxBytes){for(const [k,e]of items)if(e.until<=now())remove(k);while(used+bytes.length>maxBytes)remove(items.keys().next().value);items.set(key,{bytes,until:now()+ttl});used+=bytes.length;}return bytes;}).finally(()=>pending.delete(key));pending.set(key,task);return task;}
 return {get,peek,clear(){items.clear();used=0;},stats:()=>({bytes:used,entries:items.size,pending:pending.size})};
}
module.exports={createObjectCache};
