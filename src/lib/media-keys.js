'use strict';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const pattern=new RegExp('^(products|banners|news|articles|videos|chat|documents|thumbnails)/(?:'+uuid+'/)?'+uuid+'\\.(jpg|png|webp|gif|heic|mp4|mov|webm|pdf|bin|txt|csv)$');
function checkKey(key){if(typeof key!=='string'||key!==key.trim()||!pattern.test(key))throw Object.assign(Error('Invalid media key'),{code:'MEDIA_KEY_INVALID'});return key;}
module.exports={checkKey};
