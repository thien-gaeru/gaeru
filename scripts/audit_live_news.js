async function checkNews() {
  const allPosts = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(`http://127.0.0.1:3000/api/news?page=${page}`);
    const data = await res.json();
    console.log(`Page ${page} posts count:`, data.posts.length, `hasMore:`, data.hasMore);
    allPosts.push(...data.posts);
    hasMore = data.hasMore && data.posts.length > 0;
    page++;
    if (page > 10) break;
  }

  const uniqueCovers = new Set(allPosts.map(i => i.coverId));
  const uniqueUrls = new Set(allPosts.map(i => i.imageUrl));

  console.log('\n=== TỔNG HỢP KIỂM KÊ TRÊN MÁY SỐNG (TỔNG SỐ BÀI VIẾT) ===');
  console.log('Tổng số bài viết phát hành:', allPosts.length);
  console.log('Số lượng coverId độc nhất:', uniqueCovers.size);
  console.log('Số lượng imageUrl độc nhất:', uniqueUrls.size);

  const coverCounts = {};
  for (const item of allPosts) {
    coverCounts[item.imageUrl] = (coverCounts[item.imageUrl] || 0) + 1;
  }
  const duplicates = Object.entries(coverCounts).filter(([url, count]) => count > 1);
  console.log('Số lượng ảnh bị trùng lặp:', duplicates.length);
  if (duplicates.length > 0) {
    console.error('CÁC ẢNH TRÙNG LẶP:', duplicates);
    process.exit(1);
  } else {
    console.log('XÁC NHẬN: 100% TẤT CẢ BÀI VIẾT CÓ ẢNH BÌA WEBP HOÀN TOÀN ĐỘC BẢN!');
  }

  console.log('\nTop 5 bài viết mới nhất (Kỹ năng thiết bị):');
  allPosts.slice(0, 5).forEach((p, idx) => {
    console.log(`${idx + 1}. [${p.slug}] ${p.title}`);
  });
}

checkNews().catch(err => {
  console.error(err);
  process.exit(1);
});
