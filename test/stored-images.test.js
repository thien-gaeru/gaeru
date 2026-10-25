const test = require('node:test');
const assert = require('node:assert/strict');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { STORAGE_POINTER_PREFIX, readStoredImage } = require('../src/lib/stored-images');
const { uploadProductImage } = require('../src/lib/neon-storage');

const imageId = '8467673c-8a88-41f9-a6b1-ada46e04dec3';
const pointer = key => Buffer.concat([STORAGE_POINTER_PREFIX, Buffer.from(key, 'utf8')]);

function storageEnvironment(t) {
  const fixture = {
    AWS_ENDPOINT_URL_S3: 'https://storage.example.invalid',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'fixture-access-key',
    AWS_SECRET_ACCESS_KEY: 'fixture-secret-key',
    AWS_S3_BUCKET: 'fixture-assets'
  };
  const previous = Object.fromEntries(Object.keys(fixture).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixture);
  t.after(() => {
    for (const key of Object.keys(fixture)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test('legacy stored image bytes are returned without invoking object storage', async t => {
  storageEnvironment(t);
  const send = t.mock.method(S3Client.prototype, 'send', async () => {
    throw new Error('Legacy image reads must not contact storage');
  });
  const original = Buffer.from([137, 80, 78, 71, 0, 255, 1]);
  assert.deepEqual(await readStoredImage(original), original);
  assert.deepEqual(await readStoredImage(new Uint8Array(original)), original);
  assert.equal(send.mock.callCount(), 0);
  assert.deepEqual(STORAGE_POINTER_PREFIX, Buffer.from('GAERU_S3_V1:', 'ascii'));
});

test('stored product and banner pointers retrieve their exact object keys', async t => {
  storageEnvironment(t);
  const expected = Buffer.from('downloaded WebP fixture');
  const send = t.mock.method(S3Client.prototype, 'send', async command => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Bucket, 'fixture-assets');
    return { Body: { transformToByteArray: async () => new Uint8Array(expected) } };
  });
  const keys = ['products/' + imageId + '.webp', 'banners/' + imageId + '.webp'];
  for (const key of keys) assert.deepEqual(await readStoredImage(pointer(key)), expected);
  assert.deepEqual(send.mock.calls.map(call => call.arguments[0].input.Key), keys);
});

test('stored image pointers reject traversal and unsupported namespaces before the SDK', async t => {
  storageEnvironment(t);
  const send = t.mock.method(S3Client.prototype, 'send', async () => {
    throw new Error('Invalid keys must never reach the SDK');
  });
  for (const key of [
    '',
    'products/../' + imageId + '.webp',
    'banners/../../secret.png',
    'banners/%2e%2e/' + imageId + '.png',
    'other/' + imageId + '.webp',
    'products/' + imageId.toUpperCase() + '.webp',
    'products/not-a-uuid.png',
    'banners/' + imageId + '.svg',
    'products/' + imageId + '.webp\n',
    'banners/' + imageId + '.webp ',
    'https://other.test/' + imageId + '.webp'
  ]) await assert.rejects(() => readStoredImage(pointer(key)), /Invalid.*key/i, key);
  assert.equal(send.mock.callCount(), 0);
});

test('product uploads still create product keys after banner reads are supported', async t => {
  storageEnvironment(t);
  const original = Buffer.from('already encoded WebP fixture');
  const send = t.mock.method(S3Client.prototype, 'send', async command => {
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.Bucket, 'fixture-assets');
    assert.equal(command.input.ContentType, 'image/webp');
    assert.equal(command.input.ContentLength, original.length);
    assert.deepEqual(command.input.Body, original);
    return {};
  });
  const uploaded = await uploadProductImage(original, 'image/webp');
  assert.match(uploaded.key, /^products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(send.mock.calls[0].arguments[0].input.Key, uploaded.key);
});
