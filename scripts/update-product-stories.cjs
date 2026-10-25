// Authorized catalog update. DATABASE_URL is supplied by the operator; never printed.
require('dotenv').config({quiet:true});
const fs=require('node:fs'),path=require('node:path'),{Client}=require('pg');
const {appendAudit}=require('../src/audit');
const plan=require('../content/product-stories.json');
async function update(client,{apply=false,imageOnly=false}={}){
 await client.query('BEGIN');try{
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:product-stories-20261025'))");
  const before=(await client.query('SELECT p.*,m.gallery,m.option_groups,m.description_media FROM products p JOIN product_presentations m ON m.product_id=p.id WHERE p.slug=ANY($1) ORDER BY p.slug FOR UPDATE OF p,m',[plan.map(p=>p.slug)])).rows;
  if(before.length!==2)throw Error('Expected G1 ULTRA and P01');
  const backupFile=process.env.PRODUCT_STORY_BACKUP;
  if(apply){if(!backupFile||fs.existsSync(backupFile))throw Error('Provide a new PRODUCT_STORY_BACKUP file before applying');fs.writeFileSync(backupFile,JSON.stringify(before,null,2),{flag:'wx'});}
  const stockBefore=(await client.query('SELECT * FROM product_variants WHERE product_id=ANY($1) ORDER BY id',[before.map(p=>p.id)])).rows;
  for(const p of plan){const old=before.find(o=>o.slug===p.slug);if(!old.active||old.deleted_at)throw Error('Product is not published');
   if(imageOnly&&p.slug!=='gaeru-g1-ultra')continue;
   
   if(!imageOnly&&old.description!==p.description&&old.description!==p.expectedDescription)throw Error('Description has changed; review before replacing');
   if(!imageOnly&&old.description_media.length&&JSON.stringify(old.description_media)!==JSON.stringify(p.descriptionMedia))throw Error('Description media changed; review first');
   for(const url of [p.imageUrl,...p.descriptionMedia.map(m=>m.url)]){if(url.startsWith('/api/catalog-images/')&&!(await client.query('SELECT id FROM catalog_images WHERE id=$1',[url.split('/').at(-1)])).rowCount)throw Error('Missing image');}
   if(imageOnly){await client.query('UPDATE products SET image_url=$2,image_alt=$3,updated_at=now() WHERE id=$1',[old.id,p.imageUrl,p.imageAlt]);await client.query('UPDATE product_presentations SET gallery=$2 WHERE product_id=$1',[old.id,JSON.stringify([p.imageUrl,...old.gallery.filter(u=>u!==p.imageUrl)])]);}
   else {await client.query('UPDATE products SET description=$2,image_url=$3,image_alt=$4,updated_at=now() WHERE id=$1',[old.id,p.description,p.imageUrl,p.imageAlt]);await client.query('UPDATE product_presentations SET gallery=$2,description_media=$3 WHERE product_id=$1',[old.id,JSON.stringify([p.imageUrl,...old.gallery.filter(u=>u!==p.imageUrl)]),JSON.stringify(p.descriptionMedia)]);}
   await appendAudit(client,{actor:{username:'codex-product-story',role:'system',source:'system'},action:imageOnly?'catalog.main_image.update':'catalog.description.editorial',entityType:'product',entityId:old.id,before:{description:old.description,imageUrl:old.image_url,descriptionMedia:old.description_media},after:{imageUrl:p.imageUrl,...(!imageOnly?{description:p.description,descriptionMedia:p.descriptionMedia}:{})}});
  }
  const stockAfter=(await client.query('SELECT * FROM product_variants WHERE product_id=ANY($1) ORDER BY id',[before.map(p=>p.id)])).rows;
  if(JSON.stringify(stockBefore)!==JSON.stringify(stockAfter))throw Error('Variants changed');
  await client.query(apply?'COMMIT':'ROLLBACK');return {applied:apply,imageOnly,variantsUnchanged:true};
 }catch(e){await client.query('ROLLBACK');throw e;}
}
if(require.main===module)(async()=>{const apply=process.argv.includes('--apply'),imageOnly=process.argv.includes('--image-only');if(apply&&!imageOnly){const css=await fetch('https://gaeru.org/product-choices.css?story-deploy-check='+Date.now());if(!css.ok||!(await css.text()).includes('.product-editorial-story'))throw Error('Deploy and review editorial layout before applying content');}const client=new Client({connectionString:process.env.DATABASE_URL});try{await client.connect();console.log(JSON.stringify(await update(client,{apply,imageOnly})));}finally{await client.end();}})().catch(()=>{console.error('Product update failed. Check access, backup path and current catalog before retrying.');process.exitCode=1;});
module.exports={update};
