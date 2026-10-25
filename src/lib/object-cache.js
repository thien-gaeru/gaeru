'use strict';
function createObjectCache({maxBytes=64*1024*1024,maxEntryBytes=8*1024*1024,ttl=300000,maxPending=16,now=Date.now}={}){
 const items=new Map(),pending=new Map();let used=0;
 const remove=key=>{const entry=items.get(key);if(entry){used-=entry.bytes.length;items.delete(key);}};
 async function get(key,load){const entry=items.get(key);if(entry&&entry.until>now()){items.delete(key);items.set(key,entry);return entry.bytes;}if(entry)remove(key);if(pending.has(key))return pending.get(key);if(pending.size>=maxPending)throw Object.assign(Error('Media cache busy'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});
 const task=Promise.resolve().then(load).then(bytes=>{if(bytes.length<=maxEntryBytes&&bytes.length<=maxBytes){for(const [k,e]of items)if(e.until<=now())remove(k);while(used+bytes.length>maxBytes)remove(items.keys().next().value);items.set(key,{bytes,until:now()+ttl});used+=bytes.length;}return bytes;}).finally(()=>pending.delete(key));pending.set(key,task);return task;}
 return {get,clear(){items.clear();used=0;},stats:()=>({bytes:used,entries:items.size,pending:pending.size})};
}
module.exports={createObjectCache};
