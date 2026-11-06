'use strict';
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const manifestPath = path.join(rootDir, 'responsive-images.json');

if (!fs.existsSync(manifestPath)) {
  console.error('Error: responsive-images.json manifest not found at', manifestPath);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let totalChecked = 0;
let missingFiles = [];

for (const [sourcePath, renditions] of Object.entries(manifest)) {
  for (const rendition of renditions) {
    if (rendition.url) {
      const relPath = rendition.url.replace(/^\//, '');
      const fullPath = path.join(rootDir, relPath);
      totalChecked++;
      if (!fs.existsSync(fullPath)) {
        missingFiles.push(relPath);
      } else {
        const stat = fs.statSync(fullPath);
        if (stat.size === 0) missingFiles.push(relPath + ' (empty file)');
      }
    }
    if (rendition.avifUrl) {
      const relPath = rendition.avifUrl.replace(/^\//, '');
      const fullPath = path.join(rootDir, relPath);
      totalChecked++;
      if (!fs.existsSync(fullPath)) {
        missingFiles.push(relPath);
      } else {
        const stat = fs.statSync(fullPath);
        if (stat.size === 0) missingFiles.push(relPath + ' (empty file)');
      }
    }
  }
}

if (missingFiles.length > 0) {
  console.error(`Asset verification FAILED: ${missingFiles.length} missing or invalid files:`);
  missingFiles.forEach(f => console.error('  - ' + f));
  process.exit(1);
}

console.log(`GAERU Asset verification SUCCESS: All ${totalChecked} renditions (WebP + AVIF) verified on disk.`);
