'use strict';
// Display renditions only. Never overwrite source artwork or uploaded originals.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

async function main() {
  const root = path.join(__dirname, '..');
  const map = {};
  const files = [
    'k9.webp',
    'm3-home-cutout.webp',
    'p01.webp',
    'g1-ultra-874bf1d3db77.webp',
    'p185-cutout-1cc9dfde9fa3.webp'
  ];

  for (const file of files) {
    const source = '/assets/products/' + file;
    const sourceDisk = path.join(root, 'assets', 'products', file);
    if (!require('node:fs').existsSync(sourceDisk)) continue;
    const metadata = await sharp(sourceDisk).metadata();
    map[source] = [];

    // Also create base AVIF for the root image
    const baseAvif = await sharp(sourceDisk)
      .avif({ quality: 72, effort: 7, chromaSubsampling: '4:4:4', tune: 'ssim' })
      .toBuffer();
    await fs.writeFile(sourceDisk.replace(/\.webp$/, '.avif'), baseAvif);

    for (const width of [480, 800]) {
      const { data, info } = await sharp(sourceDisk)
        .resize(width, width, { fit: 'inside', withoutEnlargement: true })
        .webp({ lossless: true, effort: 6 })
        .toBuffer({ resolveWithObject: true });

      const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
      const name = file.replace('.webp', '') + '-display-' + width + '-' + hash + '.webp';
      await fs.writeFile(path.join(root, 'assets', 'products', name), data);

      // Pre-generate matching AVIF Ultra variant with high effort
      const avifData = await sharp(sourceDisk)
        .resize(width, width, { fit: 'inside', withoutEnlargement: true })
        .avif({ quality: width <= 480 ? 68 : 72, effort: 7, chromaSubsampling: '4:4:4', tune: 'ssim' })
        .toBuffer();
      const avifName = name.replace(/\.webp$/, '.avif');
      await fs.writeFile(path.join(root, 'assets', 'products', avifName), avifData);

      map[source].push({
        url: '/assets/products/' + name,
        width: info.width,
        bytes: data.length,
        sourceWidth: metadata.width,
        avifUrl: '/assets/products/' + avifName,
        avifBytes: avifData.length
      });
    }
  }

  await fs.writeFile(path.join(root, 'responsive-images.json'), JSON.stringify(map, null, 2) + '\n');
  console.log('AVIF Ultra & WebP responsive images generated successfully.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
