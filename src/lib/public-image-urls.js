'use strict';

const CATALOG_IMAGE = /^\/api\/catalog-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATIC_IMAGES = new Set([
  'assets/brand/gaeru-logo.png',
  ...['g1-ultra', 'k9', 'm3', 'p01', 'm3-home-cutout']
    .map(name => 'assets/products/' + name + '.png'),
  ...[1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]
    .map(number => 'assets/products/m3-description/' + number + '.png')
]);

function publicImageUrl(url) {
  if (typeof url !== 'string') return url;
  if (CATALOG_IMAGE.test(url)) return url + '?v=webp-20261025';
  const suffixAt = url.search(/[?#]/);
  const pathname = suffixAt < 0 ? url : url.slice(0, suffixAt);
  const suffix = suffixAt < 0 ? '' : url.slice(suffixAt);
  const relative = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return STATIC_IMAGES.has(relative) ? pathname.replace(/\.png$/, '.webp') + suffix : url;
}

// Only decorate display DTOs. Stored references and administrator write data stay canonical.
function decoratePublicProductImages(value) {
  if (Array.isArray(value)) return value.map(decoratePublicProductImages);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'imageUrl' || key === 'image_url') return [key, publicImageUrl(item)];
    if (key === 'gallery' && Array.isArray(item)) return [key, item.map(publicImageUrl)];
    if ((key === 'descriptionMedia' || key === 'description_media') && Array.isArray(item)) {
      return [key, item.map(media => media?.type === 'image'
        ? { ...media, url: publicImageUrl(media.url) } : media)];
    }
    if (key === 'products' || key === 'product' || key === 'variants') {
      return [key, decoratePublicProductImages(item)];
    }
    return [key, item];
  }));
}

module.exports = { publicImageUrl, decoratePublicProductImages };
