'use strict';
const {image,attributes}=require('../product-art');
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy={
 'gaeru-k9':['Giọng nói ở gần hơn.','Micro cài áo nhỏ gọn cho vlog, livestream và những cuộc trò chuyện. Chọn cổng kết nối và số lượng micro phù hợp với thiết bị của bạn.'],
 'gaeru-m3':['Gọn từ micro đến hộp sạc.','Hai micro, đầu thu và hộp sạc giúp bạn chuẩn bị cho buổi ghi hình. Kiểm tra pin, cổng kết nối và thử từng nguồn âm trước khi bắt đầu.'],
 'gaeru-p01':['Bạn sáng tạo. Khung hình theo bạn.','Giá đỡ theo dõi người dành cho những lúc tự quay. Bố trí trên bề mặt vững, kiểm tra góc kẹp và thử chuyển động trong không gian sử dụng.'],
 'gaeru-p185':['Gập gọn. Mở thêm góc chụp.','Gậy chụp hình cầm tay với điều khiển từ xa Bluetooth. Chọn chiều cao và góc đặt điện thoại theo không gian; đối chiếu phụ kiện của phiên bản trước khi mua.'],
 'gaeru-g1-ultra':['Thêm kết nối cho câu chuyện.','Bộ micro không dây kết nối đa thiết bị. Kiểm tra đường âm thanh phù hợp với điện thoại, máy ảnh hoặc máy tính và nghe thử bản thu trước khi sử dụng.']
};
const url=p=>'/san-pham/'+encodeURIComponent(p.slug);
function storyMarkup(products){
 return '<section class="story-page-hero"><p class="eyebrow">CÂU CHUYỆN GAERU</p><h1>Nhỏ gọn để bắt đầu.<br><span>Tự do để sáng tạo.</span></h1><p>Một câu chuyện có thể bắt đầu từ giọng nói, một góc quay hay khoảnh khắc rất đời thường. GAERU mang đến thiết bị thu âm và ghi hình để bạn chủ động chuẩn bị, thử nghiệm và chia sẻ theo cách của mình.</p><a class="button button-blue" href="/cua-hang">Tìm thiết bị của bạn</a></section>'+
 '<section class="section-wrap story-page-intro"><p class="eyebrow">TỪ Ý TƯỞNG ĐẾN BUỔI QUAY</p><h2>Bắt đầu từ điều bạn muốn kể.</h2><p>Thu âm một cuộc phỏng vấn cần cách bố trí khác với quay một mình. Hãy bắt đầu từ thiết bị bạn đang dùng, số người tham gia, môi trường và cách đặt máy. Chọn đúng kết nối giúp việc chuẩn bị đơn giản hơn.</p></section>'+
 '<section class="section-wrap story-complete-products" aria-label="Các sản phẩm GAERU đang bán">'+products.map(p=>{const [headline,body]=copy[p.slug]||[p.name,p.cardSummary||p.descriptor];return '<article><div><p class="eyebrow">'+escape(p.name)+'</p><h2>'+escape(headline)+'</h2><p>'+escape(body)+'</p><a class="text-link" href="'+url(p)+'">Khám phá '+escape(p.name)+' ›</a></div><a class="story-range-image" href="'+url(p)+'"><img src="'+escape(image(p))+'" alt="'+escape(p.imageAlt||p.name)+'" width="560" height="440" loading="lazy"></a></article>';}).join('')+'</section>'+
 '<section class="section-wrap story-page-intro"><p class="eyebrow">CHUẨN BỊ ĐỂ TỰ TIN SỬ DỤNG</p><h2>Thử trước một phút.<br>Chủ động cả buổi quay.</h2><p>Đối chiếu phiên bản và phụ kiện trong đơn. Sạc thiết bị theo hướng dẫn, kiểm tra cổng kết nối và quay hoặc thu thử một đoạn ngắn. Nghe lại giọng nói, kiểm tra khung hình rồi mới bắt đầu nội dung chính. Khoảng cách, ánh sáng và môi trường sử dụng có thể ảnh hưởng kết quả.</p><a class="text-link" href="/huong-dan">Xem hướng dẫn sử dụng ›</a></section>'+
 '<section class="section-wrap story-page-intro"><p class="eyebrow">GAERU CARE+</p><h2>Đồng hành sau khi bạn chọn.</h2><p>Thông tin sản phẩm, đơn hàng và hồ sơ bảo hành được tập trung để bạn dễ tra cứu. Khi cần hỗ trợ, hãy gửi tên sản phẩm, phiên bản và tình huống sử dụng để GAERU đối chiếu và hướng dẫn đúng thiết bị.</p><a class="button button-blue" href="/dang-ky-bao-hanh">Đăng ký bảo hành</a> <a class="text-link" href="/ho-tro">Nhận hỗ trợ ›</a></section>';
}
function applyP185(document,products){
 const product=products.find(p=>p.slug==='gaeru-p185'),anchor=document.querySelector('section#gaeru-m3');if(!product||!anchor)return;
 const section=document.createElement('section');section.id='home-gaeru-p185';section.className='story-section home-p185-story';const [headline,body]=copy['gaeru-p185'];
 section.innerHTML='<div class="story-copy"><p class="eyebrow">'+escape(product.name)+'</p><h2>'+escape(headline)+'</h2><p>'+escape(body)+'</p><div class="home-m3-actions"><a class="text-link home-explore-link" href="'+url(product)+'">Khám phá '+escape(product.name)+' <span aria-hidden="true">↗</span></a><a class="button button-outline" href="'+url(product)+'">Mua</a></div></div><div class="story-art"><img src="'+escape(image(product))+'" '+attributes(image(product))+' alt="'+escape(product.imageAlt||product.name)+'" width="560" height="440" loading="lazy" decoding="async"></div>';anchor.after(section);
}
module.exports={storyMarkup,applyP185};
