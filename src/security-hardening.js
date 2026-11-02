const {createHash}=require('node:crypto');
const required=config=>config.NODE_ENV==='production'||config.SECURITY_HARDENING===true;
class PgRateLimitStore {
 constructor(pool,prefix){this.pool=pool;this.prefix=prefix;this.localKeys=false;this.operations=0;}
 init(options){this.windowMs=options.windowMs;}
 key(value){return this.prefix+':'+createHash('sha256').update(String(value)).digest('hex');}
 async increment(value){if(this.operations++%100===0)await this.pool.query("DELETE FROM security_rate_limits WHERE key IN (SELECT key FROM security_rate_limits WHERE expires_at<now()-interval '1 day' LIMIT 100)");const row=(await this.pool.query(`INSERT INTO security_rate_limits(key,hits,expires_at) VALUES($1,1,now()+$2*interval '1 millisecond') ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN security_rate_limits.expires_at<=now() THEN 1 ELSE security_rate_limits.hits+1 END,expires_at=CASE WHEN security_rate_limits.expires_at<=now() THEN now()+$2*interval '1 millisecond' ELSE security_rate_limits.expires_at END RETURNING hits,expires_at`,[this.key(value),this.windowMs])).rows[0];return {totalHits:row.hits,resetTime:new Date(row.expires_at)};}
 async decrement(value){await this.pool.query('UPDATE security_rate_limits SET hits=GREATEST(0,hits-1) WHERE key=$1',[this.key(value)]);}
 async resetKey(value){await this.pool.query('DELETE FROM security_rate_limits WHERE key=$1',[this.key(value)]);}
}
const sharedStore=(pool,config,prefix)=>required(config)?{store:new PgRateLimitStore(pool,prefix)}:{};
async function enrollment(config,req,principal){if(!principal||!required(config))return false;const key=principal.source==='bootstrap'?'owner':'staff:'+principal.id;return (await config.accountSecurity.settings(key)).method==='off';}
module.exports={required,PgRateLimitStore,sharedStore,enrollment};
