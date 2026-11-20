(function (root, createReader) {
  if (typeof module === 'object' && module.exports) module.exports = createReader();
  else root.GAERUNewsGuide = createReader();
})(globalThis, function () {
  'use strict';

  const topics = new Map([
    ['chinh-sach-bao-hanh-dien-tu-mot-doi-mot-gaeru', 'Bảo hành'],
    ['huong-dan-sac-va-bao-quan-micro-thu-am-khong-day', 'Bảo quản thiết bị'],
    ['phan-biet-gimbal-ai-gaeru-p01-va-tripod-p185', 'So sánh thiết bị'],
    ['so-sanh-chi-tiet-micro-gaeru-k9-va-gaeru-m3', 'So sánh thiết bị'],
    ['kich-ban-video-ngan-45-giay-chuyen-doi-cao-affiliate', 'Sản xuất nội dung'],
    ['tu-quay-video-nau-an-diy-mot-minh-gimbal-ai-p01', 'Kỹ thuật ghi hình'],
    ['thu-am-podcast-phong-van-hai-nguoi-can-bang-am-luong', 'Kỹ thuật thu âm'],
    ['setup-goc-quay-livestream-tai-nha-duoi-1-trieu', 'Livestream'],
    ['thu-am-ngoai-troi-khong-bi-gio-giat-deadcat-loc-ai', 'Kỹ thuật thu âm'],
    ['dien-thoai-khong-nhan-micro-thu-am-cach-khac-phuc', 'Hỗ trợ kết nối']
  ]);
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);

  function isGuide(post) {
    return topics.has(post.slug) && /^\s*## [^\n]/.test(post.body);
  }

  function safeHref(href) {
    if (/[\s\\\u0000-\u001f\u007f]/.test(href)) return false;
    if (/^\/(?!\/)/.test(href)) return true;
    if (!href.startsWith('https://')) return false;
    try {
      const url = new URL(href);
      return Boolean(url.hostname && !url.username && !url.password);
    } catch {
      return false;
    }
  }

  // This small format treats all article text as text, including unrecognised markup.
  function inline(text) {
    return String(text).split(/(\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s()]+\))/g).map((part, index) => {
      if (!(index % 2)) return escape(part);
      if (part.startsWith('**')) return '<strong>' + escape(part.slice(2, -2)) + '</strong>';
      const end = part.indexOf('](');
      const href = part.slice(end + 2, -1);
      return safeHref(href) ? '<a href="' + escape(href) + '">' + escape(part.slice(1, end)) + '</a>' : escape(part);
    }).join('');
  }

  const cells = row => row.replace(/^\||\|$/g, '').split('|').map(value => value.trim());

  function table(lines, section) {
    const headings = cells(lines[0]);
    if (headings.length < 2 || lines.length < 3) return '';
    const separator = cells(lines[1]);
    if (separator.length !== headings.length || !separator.every(value => /^:?-{3,}:?$/.test(value))) return '';
    const rows = lines.slice(2).map(cells);
    if (!rows.every(row => row.length === headings.length)) return '';
    const thead = headings.map(value => '<th scope="col">' + inline(value) + '</th>').join('');
    const tbody = rows.map(row => '<tr><th scope="row">' + inline(row[0]) + '</th>' +
      row.slice(1).map((value, i) => '<td><span class="guide-cell-label" aria-hidden="true">' +
        inline(headings[i + 1]) + '</span>' + inline(value) + '</td>').join('') + '</tr>').join('');
    return '<table class="guide-table" aria-label="' + escape(section) + '"><thead><tr>' + thead +
      '</tr></thead><tbody>' + tbody + '</tbody></table>';
  }

  function bodyMarkup(body) {
    const sections = [];
    let lastHeading = '';
    const blocks = body.replace(/\r\n?/g, '\n').replace(/^(#{2,3} .+)$/gm, '\n\n$1\n\n')
      .trim().split(/\n[\t ]*\n/);
    const html = blocks.map(block => {
      const lines = block.trim().split('\n').map(line => line.trim());
      if (lines.length === 1 && lines[0].startsWith('## ')) {
        lastHeading = lines[0].slice(3).trim();
        const id = 'muc-' + (sections.length + 1);
        sections.push({id, title:lastHeading});
        return '<h2 id="' + id + '">' + inline(lastHeading) + '</h2>';
      }
      if (lines.length === 1 && lines[0].startsWith('### ')) return '<h3>' + inline(lines[0].slice(4)) + '</h3>';
      if (lines.every(line => line.startsWith('- '))) {
        return '<ul>' + lines.map(line => '<li>' + inline(line.slice(2)) + '</li>').join('') + '</ul>';
      }
      if (lines.every(line => /^\d+\. /.test(line))) {
        const start = Number.parseInt(lines[0], 10);
        return '<ol' + (Number.isSafeInteger(start) && start > 1 ? ' start="' + start + '"' : '') + '>' +
          lines.map(line => '<li>' + inline(line.replace(/^\d+\. /, '')) + '</li>').join('') + '</ol>';
      }
      const grid = lines.every(line => line.includes('|')) && table(lines, lastHeading);
      return grid || '<p>' + lines.map(inline).join(' ') + '</p>';
    }).join('');
    return { html, sections };
  }

  function render(post, cover) {
    const body = bodyMarkup(post.body);
    const date = new Date(post.publishedAt);
    const dateText = date.toLocaleDateString('vi-VN', {day:'numeric', month:'long', year:'numeric', timeZone:'Asia/Ho_Chi_Minh'});
    const path = '/tin-tuc/' + encodeURIComponent(post.slug);
    const productPhoto = post.slug === 'phan-biet-gimbal-ai-gaeru-p01-va-tripod-p185' || post.slug === 'so-sanh-chi-tiet-micro-gaeru-k9-va-gaeru-m3';
    const caption = productPhoto ? 'Ảnh sản phẩm của GAERU.' : 'Ảnh minh họa tạo bằng AI.';
    const contents = '<nav class="guide-contents" aria-labelledby="guide-contents-title"><h2 id="guide-contents-title">Trong bài này</h2><ul>' +
      body.sections.map(section => '<li><a href="' + path + '#' + section.id + '">' +
        escape(section.title.replace(/\*\*/g, '')) + '</a></li>').join('') + '</ul></nav>';
    return '<div class="news-guide"><header class="guide-masthead"><div class="guide-headline"><p class="guide-topic">' +
      escape(topics.get(post.slug)) + '</p><h1>' + escape(post.title) + '</h1><p class="guide-deck">' + escape(post.excerpt) +
      '</p><p class="guide-byline">GAERU <span aria-hidden="true">·</span> <time datetime="' +
      escape(date.toISOString()) + '">' + escape(dateText) + '</time></p></div><figure class="guide-art">' + cover +
      '<figcaption>' + caption + '</figcaption></figure></header><div class="guide-reading">' + contents + '<div class="guide-copy">' + body.html + '</div></div></div>';
  }
  const coverSizes = '(max-width: 760px) calc(100vw - 40px), (max-width: 1120px) 46vw, 510px';
  return {isGuide, render, coverSizes};
});
