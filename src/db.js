const { Pool } = require("pg");

function poolOptions(config){
  const requireTls=config.NODE_ENV==='production'||config.PGSSL==='require';
  let connectionString=config.DATABASE_URL;
  if(requireTls){const url=new URL(connectionString);for(const name of ['ssl','sslmode','sslcert','sslkey','sslrootcert','uselibpqcompat'])url.searchParams.delete(name);connectionString=url.toString();}
  return {connectionString,ssl:requireTls?{rejectUnauthorized:true,minVersion:'TLSv1.2',...(config.PGSSL_CA?{ca:config.PGSSL_CA}:{})}:undefined,max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:5000};
}
function createPool(config){return new Pool(poolOptions(config));}

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

module.exports = { createPool, poolOptions, withTransaction };
