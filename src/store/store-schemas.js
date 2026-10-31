'use strict';

const multer = require('multer');
const { z } = require('zod');

const orderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
    phone: z.string().trim().regex(/^[+0-9().\s-]{8,30}$/),
    address: z.string().trim().min(5).max(250),
    city: z.string().trim().min(2).max(120),
    note: z.string().trim().max(1000).default('')
  }),
  shippingCarrierId: z.enum(['ghn', 'ghtk', 'viettel', 'jt', 'spx']).optional(),
  expectedShippingFeeVnd: z.number().int().min(0).max(1000000000).optional(),
  expectedSubtotalVnd: z.number().int().min(0).max(2000000000).optional(),
  expectedQuoteHash: z.string().trim().min(16).max(128).optional(),
  voucherCode: z.string().trim().toUpperCase().max(40).optional(),
  idempotencyKey: z.string().trim().min(4).max(120).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  retryOrderNumber: z.string().trim().min(5).max(80).optional(),
  paymentMethod: z.enum(['cod', 'bank_transfer', 'vnpay', '9pay', 'momo', 'zalopay']),
  items: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.number().int().min(1).max(99)
  })).min(1).max(30)
});

const transitions = Object.freeze({
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['completed'],
  completed: [],
  cancelled: []
});

const productSchema = z.object({
  slug: z.string().trim().min(2).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(2).max(160),
  category: z.enum(['audio', 'video', 'accessory']),
  descriptor: z.string().trim().max(160).default(''),
  description: z.string().trim().max(3000).default(''),
  imageUrl: z.string().trim().regex(/^(?:\/assets\/products\/[a-zA-Z0-9._-]+|\/api\/catalog-images\/[0-9a-f-]{36})$/),
  imageAlt: z.string().trim().max(250).default(''),
  active: z.boolean().default(false),
  sortOrder: z.number().int().min(-1000).max(10000).default(0)
});

const variantSchema = z.object({
  sku: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().trim().min(1).max(160),
  options: z.record(z.string(), z.string()).default({}),
  priceVnd: z.number().int().min(0).max(20_000_000),
  stockQuantity: z.number().int().min(0).max(1_000_000),
  active: z.boolean().default(false)
});

const orderUpdateSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled']).optional(),
  paymentStatus: z.enum(['pending', 'paid']).optional(),
  shippingFeeVnd: z.number().int().min(0).max(1_000_000_000).optional()
}).refine((value) => Object.keys(value).length > 0);

const settingsSchema = z.object({
  shippingNote: z.string().trim().max(1000),
  shippingRates: z.record(
    z.string().trim().min(2).max(120).regex(/^[\p{L}\p{N} .’'-]+$/u),
    z.number().int().min(0).max(1_000_000_000)
  ).default({}).superRefine((rates, context) => {
    if (Object.keys(rates).length > 100) {
      context.addIssue({ code: 'custom', message: 'Chỉ cấu hình tối đa 100 tỉnh/thành phố.' });
    }
    const provinceNames = new Set();
    for (const province of Object.keys(rates)) {
      const normalized = province.normalize('NFC').toLocaleLowerCase('vi');
      if (provinceNames.has(normalized)) {
        context.addIssue({ code: 'custom', path: [province], message: 'Tỉnh/thành phố không được trùng tên.' });
      }
      provinceNames.add(normalized);
    }
  })
});

function requireUuidParam(name) {
  return (req, res, next) => {
    if (!z.string().uuid().safeParse(req.params[name]).success) {
      return res.status(400).json({ error: 'Mã định danh không hợp lệ.' });
    }
    next();
  };
}

function createImageUploadParser() {
  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) return callback(null, true);
      callback(new Error('Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.'));
    }
  });
  return (req, res, next) => {
    imageUpload.single('image')(req, res, (error) => {
      if (error) return res.status(400).json({ error: error.message });
      next();
    });
  };
}

module.exports = {
  orderSchema,
  transitions,
  productSchema,
  variantSchema,
  orderUpdateSchema,
  settingsSchema,
  requireUuidParam,
  createImageUploadParser
};
