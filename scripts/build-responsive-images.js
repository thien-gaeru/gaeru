'use strict';
// Display renditions only. Never overwrite source artwork or uploaded originals.
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const AVIF_HIGH_OPT = { effort: 8, chromaSubsampling: '4:4:4', tune: 'ssim' };

async function encodeAndWriteAvif(srcDisk, destDisk, { width = null, quality = 86 } = {}) {
  let pipe = sharp(srcDisk, { limitInputPixels: 24000000 }).rotate();
  if (width) pipe = pipe.resize(width, width, { fit: 'inside', withoutEnlargement: true });
  const avifBuffer = await pipe.avif({ ...AVIF_HIGH_OPT, quality }).toBuffer();
  await fs.writeFile(destDisk, avifBuffer);
  return avifBuffer;
}

async function listFilesRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function main() {
  const root = path.join(__dirname, '..');
  const mapPath = path.join(root, 'responsive-images.json');
  const existingMap = fsSync.existsSync(mapPath) ? JSON.parse(fsSync.readFileSync(mapPath, 'utf8')) : {};
  const map = {};
  const files = [
    'k9.webp',
    'm3-home-cutout.webp',
    'p01.webp',
    'g1-ultra-874bf1d3db77.webp',
    'p185-cutout-1cc9dfde9fa3.webp'
  ];

  // Non-cutout assets can read from original lossless PNG if available
  const cleanPngOriginals = new Set(['k9.webp', 'm3-home-cutout.webp', 'p01.webp']);
  const upgradedStaticTargets = new Set();

  for (const file of files) {
    const source = '/assets/products/' + file;
    const sourceDisk = path.join(root, 'assets', 'products', file);
    if (!fsSync.existsSync(sourceDisk)) continue;
    const pngCandidate = sourceDisk.replace(/\.webp$/, '.png');
    const avifSourceDisk = cleanPngOriginals.has(file) && fsSync.existsSync(pngCandidate) ? pngCandidate : sourceDisk;
    const metadata = await sharp(sourceDisk).metadata();
    const prevEntries = Array.isArray(existingMap[source]) ? existingMap[source] : [];
    const stemBase = prevEntries[0]?.url
      ? path.basename(prevEntries[0].url).replace(/-display-\d+-[a-f0-9]+\.webp$/, '')
      : file.replace('.webp', '');
    map[source] = [];

    // High-quality base AVIF for full-resolution / large-screen HiDPI viewing
    const baseAvifDest = sourceDisk.replace(/\.webp$/, '.avif');
    await encodeAndWriteAvif(avifSourceDisk, baseAvifDest, { quality: 86 });
    upgradedStaticTargets.add(path.resolve(baseAvifDest));

    const targetWidths = metadata.width > 1000 ? [480, 800, 1200] : [480, 800];
    for (const width of targetWidths) {
      const targetScaledWidth = Math.min(width, metadata.width);
      const existing = prevEntries.find(e => e.width === targetScaledWidth || path.basename(e.url || '').includes('-display-' + width + '-'));
      const existingDisk = existing ? path.join(root, existing.url.replace(/^\/+/, '')) : '';

      let relWebpUrl, actualWidth, webpBytes;
      if (existing && fsSync.existsSync(existingDisk)) {
        // Preserve tracked lossless WebP filenames & hashes untouched
        relWebpUrl = existing.url;
        actualWidth = existing.width;
        webpBytes = fsSync.statSync(existingDisk).size;
      } else {
        const { data, info } = await sharp(sourceDisk)
          .resize(width, width, { fit: 'inside', withoutEnlargement: true })
          .webp({ lossless: true, effort: 6 })
          .toBuffer({ resolveWithObject: true });

        const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
        const name = stemBase + '-display-' + width + '-' + hash + '.webp';
        await fs.writeFile(path.join(root, 'assets', 'products', name), data);
        relWebpUrl = '/assets/products/' + name;
        actualWidth = info.width;
        webpBytes = data.length;
      }

      // Keep 480w compact (<20KB for k9 mobile), boost 800w/1200w to crisp high quality
      const avifQuality = width <= 480 ? 73 : (width <= 800 ? 84 : 86);
      const avifUrl = relWebpUrl.replace(/\.webp$/, '.avif');
      const avifDest = path.join(root, avifUrl.replace(/^\/+/, ''));
      const avifData = await encodeAndWriteAvif(avifSourceDisk, avifDest, { width, quality: avifQuality });
      upgradedStaticTargets.add(path.resolve(avifDest));

      map[source].push({
        url: relWebpUrl,
        width: actualWidth,
        bytes: webpBytes,
        sourceWidth: metadata.width,
        avifUrl,
        avifBytes: avifData.length
      });
    }
  }

  // Upgrade all remaining static .avif files (m3-description, k9-description, m3, g1-ultra-clean, news, brand, videos)
  const allAssets = await listFilesRecursive(path.join(root, 'assets'));
  for (const fullAvif of allAssets.filter(f => f.endsWith('.avif'))) {
    if (upgradedStaticTargets.has(path.resolve(fullAvif))) continue;
    const rel = path.relative(path.join(root, 'assets'), fullAvif).replace(/\\/g, '/');
    const sizedMatch = /^(.*)-w(480|800)\.avif$/.exec(fullAvif);
    if (sizedMatch) {
      const baseNoExt = sizedMatch[1];
      const w = Number(sizedMatch[2]);
      const srcDisk = fsSync.existsSync(baseNoExt + '.png') ? baseNoExt + '.png' : baseNoExt + '.webp';
      if (fsSync.existsSync(srcDisk)) {
        await encodeAndWriteAvif(srcDisk, fullAvif, { width: w, quality: w <= 480 ? 78 : 85 });
      }
      continue;
    }
    const baseNoExt = fullAvif.slice(0, -5);
    const usePng = !rel.includes('cutout') && !rel.includes('clean') && fsSync.existsSync(baseNoExt + '.png');
    const srcDisk = usePng ? baseNoExt + '.png' : (fsSync.existsSync(baseNoExt + '.webp') ? baseNoExt + '.webp' : null);
    if (srcDisk) {
      const q = rel.startsWith('brand/gaeru-logo') ? 82 : 86;
      await encodeAndWriteAvif(srcDisk, fullAvif, { quality: q });
    }
  }

  await fs.writeFile(path.join(root, 'responsive-images.json'), JSON.stringify(map, null, 2) + '\n');
  console.log('High-quality AVIF (480w/800w/1200w + static assets) & WebP responsive images generated successfully.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
