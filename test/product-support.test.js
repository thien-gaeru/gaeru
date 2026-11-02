const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const productSupportScript = fs.readFileSync(
  path.join(__dirname, "..", "product-support.js"),
  "utf8"
);

function renderSupportPage(product, query = "?id=k9") {
  const content = { innerHTML: "" };
  const listeners = new Map();
  const document = {
    title: "",
    querySelector: () => content,
    addEventListener: (event, callback) => listeners.set(event, callback)
  };
  const window = {
    location: { search: query },
    GAERUStore: { products: product ? [product] : [] }
  };

  vm.runInNewContext(productSupportScript, {
    document,
    window,
    URLSearchParams,
    String
  });

  return { content, document, listeners };
}

test("renders a category-specific support page for an active product", () => {
  const { content, document } = renderSupportPage({
    slug: "k9",
    name: "GAERU K9",
    category: "audio",
    descriptor: "Nhỏ mà có võ",
    description: "Micro cài áo GAERU K9",
    imageUrl: "/assets/products/k9.png",
    imageAlt: "Micro cài áo"
  });

  assert.match(document.title, /GAERU K9/);
  assert.match(content.innerHTML, /Hỗ trợ về GAERU K9/);
  assert.match(content.innerHTML, /Kiểm tra kết nối micro/);
  assert.match(content.innerHTML, /href="support\.html#contact"/);
  assert.doesNotMatch(content.innerHTML, /href="product\.html\?/);
});

test("escapes product content before inserting it into the support page", () => {
  const { content } = renderSupportPage({
    slug: "k9",
    name: '<img src=x onerror="alert(1)">',
    category: "unknown",
    description: "Safe description",
    imageUrl: "/image.png"
  });

  assert.match(content.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(content.innerHTML, /<img src=x onerror=/);
});

test("shows unavailable support content for a product absent from the active catalog", () => {
  const { content } = renderSupportPage(null);
  assert.match(content.innerHTML, /Không tìm thấy trang hỗ trợ sản phẩm/);
  assert.match(content.innerHTML, /ngừng kinh doanh/);
});
