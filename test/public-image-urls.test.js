const test = require('node:test');
const assert = require('node:assert/strict');
const { publicImageUrl, decoratePublicProductImages } = require('../src/lib/public-image-urls');

const imageId = '8467673c-8a88-41f9-a6b1-ada46e04dec3';
const canonical = '/api/catalog-images/' + imageId;
const versioned = canonical + '?v=webp-20261025';

test('public catalog image URLs get a cache version without changing their canonical ID', () => {
  assert.equal(publicImageUrl(canonical), versioned);
  assert.equal(publicImageUrl(versioned), versioned);
  assert.equal(publicImageUrl(canonical + '?v=another-release'), canonical + '?v=another-release');
  for (const url of [
    '/api/catalog-images/not-a-uuid',
    '/api/catalog-images/' + imageId.toUpperCase(),
    '/api/catalog-images/../' + imageId,
    '/api/catalog-images/%2e%2e/' + imageId,
    'https://other.test' + canonical,
    '//other.test' + canonical,
    '/api/gaeru_ceo/catalog-images/' + imageId,
    '/api/catalog-videos/' + imageId
  ]) assert.equal(publicImageUrl(url), url, url);
});

test('only the reviewed static artwork gets a WebP path, retaining URL suffixes', () => {
  const paths = [
    'assets/brand/gaeru-logo.png',
    ...['g1-ultra', 'k9', 'm3', 'p01', 'm3-home-cutout'].map(name => 'assets/products/' + name + '.png'),
    ...[1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12].map(number => 'assets/products/m3-description/' + number + '.png')
  ];
  assert.equal(paths.length, 17);
  for (const path of paths) {
    const webp = path.replace(/\.png$/, '.webp');
    assert.equal(publicImageUrl(path), webp);
    assert.equal(publicImageUrl('/' + path + '?v=old#artwork'), '/' + webp + '?v=old#artwork');
    assert.equal(publicImageUrl('/' + webp), '/' + webp);
  }
  for (const url of [
    '/assets/products/m3-description/5.png',
    '/assets/products/m3-description/../secret.png',
    '/assets/products/../brand/gaeru-logo.png',
    '/assets/products/uploaded-photo.png',
    '/assets/products/m3.png/extra'
  ]) assert.equal(publicImageUrl(url), url, url);
});

test('public DTO decoration covers covers, galleries, variants and image media without modifying write data', () => {
  const input = {
    products: [{
      id: 'product-id',
      imageUrl: canonical,
      description: 'Keep this literal ' + canonical,
      imageAlt: '/assets/products/m3.png',
      options: { imageUrl: canonical },
      gallery: [canonical, '/assets/products/m3.png', '/assets/products/uploaded-photo.png'],
      variants: [{ imageUrl: canonical }, { image_url: '/assets/products/k9.png', stockQuantity: 3 }],
      descriptionMedia: [
        { type: 'image', url: '/assets/products/m3-description/1.png', caption: canonical, alt: '/assets/products/m3.png', afterParagraph: 1 },
        { type: 'image', url: canonical, caption: 'Product image' },
        { type: 'video', url: canonical, caption: 'Keep video URL unchanged' }
      ],
      extra: { url: '/assets/products/m3.png', enabled: false, value: null }
    }]
  };
  const original = structuredClone(input);
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(input);
  const result = decoratePublicProductImages(input);
  const product = result.products[0];
  assert.notEqual(result, input);
  assert.notEqual(product, input.products[0]);
  assert.equal(product.imageUrl, versioned);
  assert.deepEqual(product.gallery, [versioned, '/assets/products/m3.webp', '/assets/products/uploaded-photo.png']);
  assert.equal(product.variants[0].imageUrl, versioned);
  assert.equal(product.variants[1].image_url, '/assets/products/k9.webp');
  assert.equal(product.variants[1].stockQuantity, 3);
  assert.equal(product.descriptionMedia[0].url, '/assets/products/m3-description/1.webp');
  assert.equal(product.descriptionMedia[1].url, versioned);
  assert.deepEqual(product.descriptionMedia[2], original.products[0].descriptionMedia[2]);
  assert.equal(product.descriptionMedia[0].caption, canonical);
  assert.equal(product.descriptionMedia[0].alt, '/assets/products/m3.png');
  assert.equal(product.descriptionMedia[0].afterParagraph, 1);
  assert.equal(product.description, original.products[0].description);
  assert.equal(product.imageAlt, original.products[0].imageAlt);
  assert.deepEqual(product.options, original.products[0].options);
  assert.deepEqual(product.extra, original.products[0].extra);
  assert.deepEqual(input, original);
  assert.deepEqual(decoratePublicProductImages(result), result);
});

test('public DTO decoration leaves non-image scalar values intact', () => {
  for (const value of [null, undefined, false, 0, 'description text', canonical]) {
    assert.equal(decoratePublicProductImages(value), value);
  }
});

test('owned absolute image URLs become primary same-site paths while external URLs stay intact',()=>{for(const host of ['gaeru.com','www.gaeru.com'])assert.equal(publicImageUrl('https://'+host+'/assets/products/m3.png?v=one'),'/assets/products/m3.webp?v=one');assert.equal(publicImageUrl('https://external.invalid/image.png'),'https://external.invalid/image.png');});
