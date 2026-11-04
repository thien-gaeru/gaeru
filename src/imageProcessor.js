'use strict';
const productBg = require('./lib/product-background');

module.exports = {
  ...productBg,
  processProductImage: productBg.processProductImage
};
