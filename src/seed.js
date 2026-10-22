require("dotenv").config();
const { loadConfig } = require("./config");
const { createPool } = require("./db");

const products = [
  ["k9", "GAERU K9", "audio", "Nhỏ mà có võ", "Mic cài áo nhỏ gọn. Cho những câu chuyện đầu tiên.", "/assets/products/k9.png", "Micro cài áo GAERU K9", 10],
  ["p01", "GAERU P01", "video", "Luôn trong khung hình", "Gimbal tự động theo người. Thêm linh hoạt cho khung hình.", "/assets/products/p01.png", "Gimbal theo dõi tự động GAERU P01", 30],
  ["g1-ultra", "GAERU G1 ULTRA", "audio", "Linh hoạt không giới hạn", "Mic không dây đa thiết bị. Mở rộng không gian sáng tạo.", "/assets/products/g1-ultra.png", "Bộ micro không dây đa thiết bị GAERU G1 ULTRA", 40]
];

async function main() {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    for (const product of products) {
      await pool.query(
        `INSERT INTO products (slug, name, category, descriptor, description, image_url, image_alt, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
         ON CONFLICT (slug) DO NOTHING`,
        product
      );
    }
    console.log("Draft GAERU catalog is ready. Add verified variants and stock in /admin before publishing products.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Catalog seed failed:", error.message);
  process.exitCode = 1;
});
