async function checkNews() {
  const res1 = await fetch('http://127.0.0.1:3000/api/news');
  const d1 = await res1.json();
  console.log('Page 1 posts count:', d1.posts.length, 'page:', d1.page, 'hasMore:', d1.hasMore);

  const res2 = await fetch('http://127.0.0.1:3000/api/news?page=2');
  const d2 = await res2.json();
  console.log('Page 2 posts count:', d2.posts.length, 'page:', d2.page, 'hasMore:', d2.hasMore);

  const res3 = await fetch('http://127.0.0.1:3000/api/news?page=3');
  const d3 = await res3.json();
  console.log('Page 3 posts count:', d3.posts.length, 'page:', d3.page, 'hasMore:', d3.hasMore);

  const allPosts = [...d1.posts, ...d2.posts, ...d3.posts];
  const uniqueCovers = new Set(allPosts.map(i => i.coverId));
  const uniqueUrls = new Set(allPosts.map(i => i.imageUrl));

  console.log('\n=== TỔNG HỢP KIỂM KÊ TRÊN MÁY SỐNG ===');
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
  } else {
    console.log('>> KẾT QUẢ: 100% ẢNH ĐỘC NHẤT, KHÔNG TRÙNG LẶP DÙ CHỈ 1 ẢNH! <<');
  }

  console.log('\nDanh sách chi tiết 26 bài:');
  allPosts.forEach((p, idx) => {
    console.log(`${idx + 1}. [${p.slug}]\n   Tiêu đề: ${p.title}\n   Ảnh: ${p.imageUrl}\n`);
  });
}

checkNews().catch(console.error);
