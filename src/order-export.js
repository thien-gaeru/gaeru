const ExcelJS = require('exceljs');
async function orderWorkbook(orders) {
 const book=new ExcelJS.Workbook();book.creator='GAERU';book.created=new Date();
 const sheet=book.addWorksheet('Đơn hàng',{views:[{state:'frozen',ySplit:1}]});
 sheet.columns=[['Mã đơn','orderNumber',26],['Ngày đặt','createdAt',22],['Khách hàng','customerName',28],['Điện thoại','phone',19],['Email','email',30],['Địa chỉ','address',45],['Tỉnh / thành','city',20],['Trạng thái','status',20],['Thanh toán','paymentMethod',20],['Tình trạng thanh toán','paymentStatus',24],['Sản phẩm','items',55],['Tạm tính','subtotalVnd',20],['Giảm giá','discountVnd',18],['Phí giao hàng','shippingFeeVnd',20],['Tổng cộng','totalVnd',20]].map(([header,key,width])=>({header,key,width}));
 const labels={pending:'Chờ xác nhận',confirmed:'Đã xác nhận',processing:'Đang xử lý',shipped:'Đang giao',completed:'Hoàn tất',cancelled:'Đã hủy',cod:'COD',bank_transfer:'Chuyển khoản',vnpay:'VNPAY','9pay':'9Pay'};
 for(const o of orders)sheet.addRow({...o,createdAt:new Date(o.createdAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}),status:labels[o.status]||o.status,paymentMethod:labels[o.paymentMethod]||o.paymentMethod,paymentStatus:o.paymentStatus==='paid'?'Đã thanh toán':'Chưa thanh toán',items:(o.items||[]).map(i=>`${i.productName} · ${i.variantName} × ${i.quantity}`).join('\n')});
 sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF087E8B'}};
 sheet.autoFilter={from:'A1',to:'O1'};
 ['subtotalVnd','discountVnd','shippingFeeVnd','totalVnd'].forEach(key=>sheet.getColumn(key).numFmt='#,##0" ₫"');
 sheet.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};});
 return book.xlsx.writeBuffer();
}
module.exports={orderWorkbook};
