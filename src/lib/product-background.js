'use strict';
const sharp = require('sharp');

/**
 * Tách nền trắng siêu tốc bằng Sharp + Thuật toán Connected-Component Labeling (CCL)
 * - Tự động xóa nền bao ngoài (Flood Fill từ 4 cạnh biên)
 * - Tự động đục thủng các khoảng trống khép kín lớn (lỗ kẹp áo, khe hở dây cáp, tay cầm)
 * - Bảo toàn 100% chữ in, logo, đèn báo màu trắng trên thân sản phẩm
 * - Khử răng cưa và khử viền sáng (Color Decontamination) tại mép sản phẩm
 *
 * @param {Buffer} buffer - Buffer ảnh gốc
 * @param {Object} [options] - Cấu hình tinh chỉnh
 * @returns {Promise<Buffer|null>} - Buffer ảnh WebP trong suốt hoặc null nếu không phải ảnh nền trắng
 */
async function removeWhiteBackground(buffer, options = {}) {
  const {
    whiteThreshold = Number(options.whiteThreshold || options.threshold) || 240,
    tolerance = Number(options.tolerance) || 35,
    maxWidth = options.maxWidth ? Number(options.maxWidth) : null,
    minHoleArea = (options.minHoleArea !== undefined && options.minHoleArea !== null && options.minHoleArea !== '')
      ? Number(options.minHoleArea)
      : null,
    maxTextDimension = Number(options.maxTextDimension) || 45,
    autoCenterSquare = Boolean(options.autoCenterSquare === true || options.autoCenterSquare === 'true' || options.autoCenterSquare === '1' || options.autoSquare === true || options.autoSquare === '1'),
    canvasSize = Number(options.canvasSize || options.mainSize) || 1000,
    mainSize = Number(options.mainSize || options.canvasSize) || 1000,
    thumbSize = Number(options.thumbSize) || 400,
    paddingRatio = options.paddingRatio !== undefined ? Number(options.paddingRatio) : 0.08,
    enableShadow = options.enableShadow !== undefined ? Boolean(options.enableShadow === true || options.enableShadow === 'true' || options.enableShadow === 1 || options.enableShadow === '1') : true,
    shadowBlur = Number(options.shadowBlur) || 18,
    shadowOpacity = options.shadowOpacity !== undefined ? Number(options.shadowOpacity) : 0.22,
    shadowOffsetY = options.shadowOffsetY !== undefined ? Number(options.shadowOffsetY) : 12
  } = options;

  const input = sharp(buffer, { limitInputPixels: 24_000_000, failOn: 'error' });
  const meta = await input.metadata();
  if (!meta.width || !meta.height) return null;
  if (meta.width * meta.height > 24_000_000) return null;

  let pipeline = sharp(buffer, { limitInputPixels: 24_000_000, failOn: 'error' }).rotate().toColourspace('srgb');
  if (maxWidth && (meta.width > maxWidth || meta.height > maxWidth)) {
    pipeline = pipeline.resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true });
  }

  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const totalPixels = width * height;

  const lowerBound = whiteThreshold - tolerance;

  // Đánh giá nhanh chu vi biên ảnh: phải có ít nhất 65% pixel màu trắng
  let edgeWhiteCount = 0;
  let totalEdgePixels = 0;

  const isWhitePixel = (idx) => {
    const bIdx = idx * 4;
    const a = data[bIdx + 3];
    if (a < 200) return false;
    const r = data[bIdx];
    const g = data[bIdx + 1];
    const b = data[bIdx + 2];
    const minCh = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const maxCh = r > g ? (r > b ? r : b) : (g > b ? g : b);
    return minCh >= whiteThreshold && (maxCh - minCh) <= 20;
  };

  for (let x = 0; x < width; x++) {
    totalEdgePixels += 2;
    if (isWhitePixel(x)) edgeWhiteCount++;
    if (isWhitePixel((height - 1) * width + x)) edgeWhiteCount++;
  }
  for (let y = 1; y < height - 1; y++) {
    totalEdgePixels += 2;
    if (isWhitePixel(y * width)) edgeWhiteCount++;
    if (isWhitePixel(y * width + width - 1)) edgeWhiteCount++;
  }

  if (totalEdgePixels === 0 || (edgeWhiteCount / totalEdgePixels) < 0.65) {
    return null;
  }

  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  const borderBuffer = new Int32Array(totalPixels);

  const smoothEdgePixel = (idx) => {
    if (visited[idx] === 2) return;
    visited[idx] = 2;

    const bIdx = idx * 4;
    const r = data[bIdx];
    const g = data[bIdx + 1];
    const b = data[bIdx + 2];
    const minCh = r < g ? (r < b ? r : b) : (g < b ? g : b);

    if (minCh > lowerBound) {
      const ratio = Math.max(0, Math.min(1, (whiteThreshold - minCh) / tolerance));
      const currentAlpha = data[bIdx + 3];
      const newAlpha = Math.round(currentAlpha * ratio);
      data[bIdx + 3] = newAlpha;
      if (newAlpha > 0 && newAlpha < 255) {
        const aNorm = newAlpha / 255;
        for (let c = 0; c < 3; c++) {
          data[bIdx + c] = Math.max(0, Math.min(255, Math.round((data[bIdx + c] - 255 * (1 - aNorm)) / aNorm)));
        }
      }
    }
  };

  let totalRemovedPixels = 0;

  for (let startIdx = 0; startIdx < totalPixels; startIdx++) {
    if (visited[startIdx] !== 0 || !isWhitePixel(startIdx)) continue;

    let head = 0;
    let tail = 0;
    let borderCount = 0;
    let touchesImageBorder = false;

    let minX = width, maxX = 0, minY = height, maxY = 0;

    visited[startIdx] = 1;
    queue[tail++] = startIdx;

    while (head < tail) {
      const curr = queue[head++];
      const x = curr % width;
      const y = (curr - x) / width;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        touchesImageBorder = true;
      }

      // Trái
      if (x > 0) {
        const nIdx = curr - 1;
        if (visited[nIdx] === 0) {
          if (isWhitePixel(nIdx)) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          } else {
            borderBuffer[borderCount++] = nIdx;
          }
        }
      }
      // Phải
      if (x < width - 1) {
        const nIdx = curr + 1;
        if (visited[nIdx] === 0) {
          if (isWhitePixel(nIdx)) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          } else {
            borderBuffer[borderCount++] = nIdx;
          }
        }
      }
      // Trên
      if (y > 0) {
        const nIdx = curr - width;
        if (visited[nIdx] === 0) {
          if (isWhitePixel(nIdx)) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          } else {
            borderBuffer[borderCount++] = nIdx;
          }
        }
      }
      // Dưới
      if (y < height - 1) {
        const nIdx = curr + width;
        if (visited[nIdx] === 0) {
          if (isWhitePixel(nIdx)) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          } else {
            borderBuffer[borderCount++] = nIdx;
          }
        }
      }
    }

    const pixelCount = tail;
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const fillRatio = pixelCount / (boxWidth * boxHeight);

    const isInteriorHole =
      minHoleArea !== null &&
      pixelCount >= minHoleArea &&
      (boxWidth > maxTextDimension || boxHeight > maxTextDimension || fillRatio > 0.45);

    if (touchesImageBorder || isInteriorHole) {
      totalRemovedPixels += pixelCount;
      for (let i = 0; i < pixelCount; i++) {
        data[queue[i] * 4 + 3] = 0;
      }
      for (let i = 0; i < borderCount; i++) {
        smoothEdgePixel(borderBuffer[i]);
      }
    }
  }

  if (totalRemovedPixels / totalPixels < 0.01 || totalRemovedPixels / totalPixels > 0.98) {
    return null;
  }

  if (autoCenterSquare) {
    let trimmedBuffer;
    try {
      trimmedBuffer = await sharp(data, { raw: { width, height, channels: 4 } })
        .png()
        .trim({ threshold: 5 })
        .toBuffer();
    } catch (_) {
      trimmedBuffer = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
    }

    const paddingPx = Math.round(mainSize * paddingRatio);
    const innerSize = Math.max(1, mainSize - (paddingPx * 2));
    const centeredProductBuffer = await sharp(trimmedBuffer)
      .resize({
        width: innerSize,
        height: innerSize,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .extend({
        top: paddingPx,
        bottom: paddingPx,
        left: paddingPx,
        right: paddingPx,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();

    let finalMasterPipeline;
    if (enableShadow) {
      const { data: fgData } = await sharp(centeredProductBuffer)
        .raw()
        .toBuffer({ resolveWithObject: true });

      const shadowData = new Uint8Array(fgData.length);
      for (let y = 0; y < mainSize; y++) {
        const targetY = y + shadowOffsetY;
        if (targetY < 0 || targetY >= mainSize) continue;

        for (let x = 0; x < mainSize; x++) {
          const srcIdx = (y * mainSize + x) * 4;
          const dstIdx = (targetY * mainSize + x) * 4;
          const srcAlpha = fgData[srcIdx + 3];

          if (srcAlpha > 0) {
            shadowData[dstIdx + 3] = Math.round(srcAlpha * shadowOpacity);
          }
        }
      }

      const blurredShadowBuffer = await sharp(shadowData, {
        raw: { width: mainSize, height: mainSize, channels: 4 }
      })
        .blur(shadowBlur)
        .png()
        .toBuffer();

      finalMasterPipeline = sharp(blurredShadowBuffer).composite([
        { input: centeredProductBuffer, top: 0, left: 0 }
      ]);
    } else {
      finalMasterPipeline = sharp(centeredProductBuffer);
    }

    const compositedBuffer = await finalMasterPipeline.png().toBuffer();

    const [mainBuffer, thumbBuffer] = await Promise.all([
      sharp(compositedBuffer)
        .webp({ lossless: true, alphaQuality: 100, effort: 4 })
        .toBuffer(),
      sharp(compositedBuffer)
        .resize(thumbSize, thumbSize, { fit: 'inside' })
        .webp({ quality: 82, alphaQuality: 90, effort: 4 })
        .toBuffer()
    ]);

    mainBuffer.thumbBuffer = thumbBuffer;
    return mainBuffer;
  }

  const [mainBuffer, thumbBuffer] = await Promise.all([
    sharp(data, { raw: { width, height, channels: 4 } })
      .webp({ lossless: true, alphaQuality: 100, effort: 4 })
      .toBuffer(),
    sharp(data, { raw: { width, height, channels: 4 } })
      .resize(thumbSize, thumbSize, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 90, effort: 4 })
      .toBuffer()
  ]);

  mainBuffer.thumbBuffer = thumbBuffer;
  return mainBuffer;
}

async function processProductImage(inputBuffer, options = {}) {
  const result = await removeWhiteBackground(inputBuffer, {
    autoCenterSquare: true,
    ...options
  });
  if (!result) return null;
  return {
    mainBuffer: result,
    thumbBuffer: result.thumbBuffer
  };
}

module.exports = {
  removeWhiteBackground,
  removeWhiteBgBuffer: removeWhiteBackground,
  processProductImage
};
