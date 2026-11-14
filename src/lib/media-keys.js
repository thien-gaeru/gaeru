'use strict';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const pattern=new RegExp('^(products|banners|news|articles|videos|chat|care|documents|thumbnails)/(?:'+uuid+'/)?'+uuid+'\\.(jpg|png|webp|gif|bmp|tiff|heic|avif|mp4|mov|webm|mp3|m4a|wav|ogg|pdf|bin|txt|csv|json|xml)$');
function checkKey(key){if(typeof key!=='string'||key!==key.trim()||!pattern.test(key))throw Object.assign(Error('Invalid media key'),{code:'MEDIA_KEY_INVALID'});return key;}
module.exports={checkKey};
