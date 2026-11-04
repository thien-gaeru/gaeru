'use strict';
const productBg = require('./src/lib/product-background');

module.exports = {
  ...productBg,
  processProductImage: productBg.processProductImage
};
