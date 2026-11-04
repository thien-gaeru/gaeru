'use strict';
// Display renditions only. Never overwrite source artwork or uploaded originals.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
async function main(){const root=path.join(__dirname,'..'),map={};for(const file of ['k9.webp','m3-home-cutout.webp','p01.webp','g1-ultra-874bf1d3db77.webp']){
 const source='/assets/products/'+file,metadata=await sharp(path.join(root,source)).metadata();map[source]=[];
 for(const width of [480,800]){const {data,info}=await sharp(path.join(root,source)).resize(width,width,{fit:'inside',withoutEnlargement:true}).webp({lossless:true,effort:6}).toBuffer({resolveWithObject:true});const hash=crypto.createHash('sha256').update(data).digest('hex').slice(0,12),name=file.replace('.webp','')+'-display-'+width+'-'+hash+'.webp';await fs.writeFile(path.join(root,'assets','products',name),data);map[source].push({url:'/assets/products/'+name,width:info.width,bytes:data.length,sourceWidth:metadata.width});}
 }await fs.writeFile(path.join(root,'responsive-images.json'),JSON.stringify(map,null,2)+'\n');console.log(Object.fromEntries(Object.entries(map).map(([k,v])=>[k,v.map(r=>({width:r.width,bytes:r.bytes}))])));}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
