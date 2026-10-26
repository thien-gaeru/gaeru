
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const { randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

const KEY_PATTERN = /^(?:(?:products|banners|news)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)|videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4|chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp|heic|mp4|mov|webm|pdf|bin|txt))$/;

let client;

function getClient() {
  if (!client) {
    const required = [
      'AWS_ENDPOINT_URL_S3',
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY'
    ];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
      throw new Error('Missing Storage config: ' + missing.join(', '));
    }

    client = new S3Client({
      endpoint: process.env.AWS_ENDPOINT_URL_S3,
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED'
    });
  }
  return client;
}

function bucket() {
  return process.env.AWS_S3_BUCKET || 'assets';
}

function checkKey(key) {
  if (typeof key !== 'string' || key !== key.trim() || !KEY_PATTERN.test(key)) {
    throw new Error('Invalid Neon Storage image key');
  }
}

async function uploadProductImage(buffer, mimeType) {
  const ext = TYPES[mimeType];
  if (!Buffer.isBuffer(buffer)) throw Error('Invalid image buffer');
  if (!ext) throw Error('Unsupported image format');
  if (buffer.length > MAX_IMAGE_BYTES) throw Error('Image exceeds 8 MB');

  const key = 'products/' + randomUUID() + '.' + ext;

  await getClient().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ContentLength: buffer.length
  }));

  return { key };
}

async function downloadProductImage(key) {
  checkKey(key);
  const result = await getClient().send(new GetObjectCommand({
    Bucket: bucket(),
    Key: key
  }));
  if (!result.Body) throw Error('Empty storage object');
  return Buffer.from(await result.Body.transformToByteArray());
}

async function deleteProductImage(key) {
  checkKey(key);
  await getClient().send(new DeleteObjectCommand({
    Bucket: bucket(),
    Key: key
  }));
}

async function uploadAsset(scope,buffer,mimeType){
 const types={...TYPES,'image/heic':'heic','video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm','application/pdf':'pdf','application/octet-stream':'bin','text/plain':'txt'};
 const limits={products:8,banners:5,news:5,videos:25,chat:10};
 const ext=types[mimeType];
 if(!Object.hasOwn(limits,scope)||!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>limits[scope]*1024*1024||!ext)throw Error('Invalid storage asset');
 if(['products','banners','news'].includes(scope)&&!TYPES[mimeType]||scope==='videos'&&mimeType!=='video/mp4')throw Error('Invalid storage asset type');
 const key=scope+'/'+randomUUID()+'.'+ext;checkKey(key);
 await getClient().send(new PutObjectCommand({Bucket:bucket(),Key:key,Body:buffer,ContentType:mimeType,ContentLength:buffer.length}));
 return {key};
}
async function listAssets(continuationToken){const r=await getClient().send(new ListObjectsV2Command({Bucket:bucket(),MaxKeys:100,ContinuationToken:continuationToken}));return {objects:(r.Contents||[]).map(o=>({key:o.Key,size:o.Size,etag:o.ETag})),next:r.IsTruncated?r.NextContinuationToken:null};}
module.exports = {
  listAssets,
  uploadAsset,checkKey,
  uploadProductImage,
  downloadProductImage,
  deleteProductImage
};
