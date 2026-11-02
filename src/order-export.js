const writeExcelFile = require('write-excel-file/node');
const {unzipSync,zipSync,strFromU8,strToU8}=require('fflate');
const columns=[['Mã đơn','orderNumber',26],['Ngày đặt','createdAt',22],['Khách hàng','customerName',28],['Điện thoại','phone',19],['Email','email',30],['Địa chỉ','address',45],['Tỉnh / thành','city',20],['Hãng vận chuyển','shippingCarrierName',22],['Trạng thái','status',20],['Thanh toán','paymentMethod',20],['Tình trạng thanh toán','paymentStatus',24],['Sản phẩm','items',55],['Tạm tính','subtotalVnd',20],['Giảm giá','discountVnd',18],['Phí giao hàng','shippingFeeVnd',20],['Tổng cộng','totalVnd',20]];
const amounts=new Set(['subtotalVnd','discountVnd','shippingFeeVnd','totalVnd']);
async function orderWorkbook(orders) {
 const labels={pending:'Chờ xác nhận',confirmed:'Đã xác nhận',processing:'Đang xử lý',shipped:'Đang giao',completed:'Hoàn tất',cancelled:'Đã hủy',cod:'COD',bank_transfer:'Chuyển khoản',vnpay:'VNPAY','9pay':'9Pay',momo:'MoMo',zalopay:'ZaloPay'};
 const data=[columns.map(([title])=>({value:title,type:String,fontWeight:'bold',textColor:'#ffffff',backgroundColor:'#087e8b',wrap:true}))];
 for(const o of orders){const row={...o,createdAt:new Date(o.createdAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}),status:labels[o.status]||o.status,paymentMethod:labels[o.paymentMethod]||o.paymentMethod,paymentStatus:o.paymentStatus==='paid'?'Đã thanh toán':'Chưa thanh toán',items:(o.items||[]).map(i=>`${i.productName} · ${i.variantName} × ${i.quantity}`).join('\n')};data.push(columns.map(([,key])=>amounts.has(key)?{value:row[key]==null?null:Number(row[key]),type:Number,format:'#,##0" ₫"',wrap:true}:{value:String(row[key]??''),type:String,wrap:true}));}
 const buffer=await writeExcelFile(data,{sheet:'Đơn hàng',columns:columns.map(([, ,width])=>({width})),stickyRowsCount:1}).toBuffer();
 // Preserve the column filter in the generated standard OOXML workbook.
 const files=unzipSync(new Uint8Array(buffer));const file='xl/worksheets/sheet1.xml';files[file]=strToU8(strFromU8(files[file]).replace('</worksheet>',`<autoFilter ref="A1:P${Math.max(1,data.length)}"/></worksheet>`));return Buffer.from(zipSync(files,{level:6}));
}
module.exports={orderWorkbook};
