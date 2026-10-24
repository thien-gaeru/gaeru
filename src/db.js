const {Pool}=require('pg');
function poolOptions(config){let connectionString=config.DATABASE_URL;if(config.PGSSL==='require'){const url=new URL(connectionString);for(const name of ['ssl','sslmode','sslcert','sslkey','sslrootcert','uselibpqcompat'])url.searchParams.delete(name);connectionString=url.toString();}return {connectionString,ssl:config.PGSSL==='require'?{rejectUnauthorized:true,minVersion:'TLSv1.2',...(config.PGSSL_CA?{ca:config.PGSSL_CA}:{})}:undefined,max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:5000};}
function createPool(config){return new Pool(poolOptions(config));}
async function createVerifiedPool(config,factory=createPool){if(config.NODE_ENV!=='production'&&config.PGSSL!=='require')return {pool:factory(config),tlsVerified:false};const candidate=factory({...config,PGSSL:'require'});try{const result=await candidate.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');if(result.rows[0]?.ssl!==true)throw Object.assign(Error('TLS not confirmed'),{code:'TLS_NOT_CONFIRMED'});return {pool:candidate,tlsVerified:true};}catch(error){await candidate.end();if(config.PGSSL==='require')throw Object.assign(Error('Required database TLS could not be verified'),{code:error.code||'TLS_UNAVAILABLE'});return {pool:factory(config),tlsVerified:false,upgradeError:error.code||'TLS_UNAVAILABLE'};}}
async function withTransaction(pool, handler) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports={createPool,poolOptions,createVerifiedPool,withTransaction};
