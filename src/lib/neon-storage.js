
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const { randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

const KEY_PATTERN =
  /^products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;

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
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new Error('Invalid Neon Storage product image key');
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

module.exports = {
  uploadProductImage,
  downloadProductImage,
  deleteProductImage
};
