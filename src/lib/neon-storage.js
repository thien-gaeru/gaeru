
const {
  S3Client,
  PutObjectCommand
} = require("@aws-sdk/client-s3");

const { randomUUID } = require("node:crypto");

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  forcePathStyle: true
});

async function uploadProductImage(buffer, mimeType) {
  const allowedTypes = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  };

  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Du lieu anh khong hop le");
  }

  const ext = allowedTypes[mimeType];
  if (!ext) {
    throw new Error("Dinh dang anh khong duoc ho tro");
  }

  if (buffer.length > 5 * 1024 * 1024) {
    throw new Error("Anh vuot qua 5MB");
  }

  const key = `products/${randomUUID()}.${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET || "assets",
    Key: key,
    Body: buffer,
    ContentType: mimeType
  }));

  return { key };
}

module.exports = { uploadProductImage };
