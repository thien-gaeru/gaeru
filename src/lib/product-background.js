'use strict';
const sharp=require('sharp');

// Only remove a nearly white region connected to the image border. Enclosed
// white labels, product details and existing transparency remain untouched.
// Photographs without a predominantly white perimeter are left unchanged.
async function removeWhiteBackground(buffer){
  // The optional flood fill needs a full-size pixel mask. Skip very large
  // cutouts instead of shrinking the product or allocating an unbounded mask.
  const meta=await sharp(buffer,{limitInputPixels:24_000_000,failOn:'error'}).metadata();
  if(meta.width*meta.height>8_000_000)return null;
  const {data,info}=await sharp(buffer,{limitInputPixels:24_000_000,failOn:'error'}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const {width:w,height:h}=info,n=w*h;
  const white=i=>{const p=i*4;return data[p+3]>240&&Math.min(data[p],data[p+1],data[p+2])>=240&&Math.max(data[p],data[p+1],data[p+2])-Math.min(data[p],data[p+1],data[p+2])<=12;};
  const edge=[];for(let x=0;x<w;x++){edge.push(x);if(h>1)edge.push((h-1)*w+x);}for(let y=1;y<h-1;y++){edge.push(y*w);if(w>1)edge.push(y*w+w-1);}
  if(!edge.length||edge.filter(white).length/edge.length<0.85)return null;
  const seen=new Uint8Array(n),queue=new Uint32Array(n);let head=0,tail=0;
  const add=i=>{if(!seen[i]&&white(i)){seen[i]=1;queue[tail++]=i;}};edge.forEach(add);
  while(head<tail){const i=queue[head++],x=i%w;if(x)add(i-1);if(x<w-1)add(i+1);if(i>=w)add(i-w);if(i<n-w)add(i+w);}
  if(tail/n<0.01||tail/n>0.97)return null;
  for(let j=0;j<tail;j++){const p=queue[j]*4,min=Math.min(data[p],data[p+1],data[p+2]);const alpha=Math.max(0,Math.min(1,(250-min)/10));data[p+3]=Math.round(data[p+3]*alpha);if(alpha>0)for(let c=0;c<3;c++)data[p+c]=Math.max(0,Math.min(255,Math.round((data[p+c]-255*(1-alpha))/alpha)));}
  return sharp(data,{raw:{width:w,height:h,channels:4}}).webp({lossless:true,effort:5,alphaQuality:100}).toBuffer();
}
module.exports={removeWhiteBackground};
