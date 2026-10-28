const test=require('node:test'),assert=require('node:assert/strict');
const {poolOptions,inspectDatabaseTls}=require('../src/db');

test('production requires verified TLS despite legacy disabled flags or URI overrides',()=>{
  const v=poolOptions({NODE_ENV:'production',PGSSL:'disable',DATABASE_URL:'postgres://user:pass@db.example/store?sslmode=no-verify&ssl=false&application_name=gaeru'});
  assert.equal(v.ssl.rejectUnauthorized,true);
  assert.equal(v.ssl.minVersion,'TLSv1.2');
  const url=new URL(v.connectionString);
  assert.equal(url.searchParams.has('sslmode'),false);
  assert.equal(url.searchParams.has('ssl'),false);
  assert.equal(url.searchParams.get('application_name'),'gaeru');
});

test('custom CA is retained, remote database hosts require TLS by default, and local development can remain without TLS',()=>{
  assert.equal(poolOptions({PGSSL:'require',DATABASE_URL:'postgres://u:p@db.example/store',PGSSL_CA:'fixture-ca'}).ssl.ca,'fixture-ca');
  assert.equal(poolOptions({NODE_ENV:'development',DATABASE_URL:'postgres://u:p@ep-cool-pooler.ap-southeast-1.aws.neon.tech/gaeru'}).ssl.rejectUnauthorized,true);
  assert.equal(poolOptions({NODE_ENV:'development',DATABASE_URL:'postgres://localhost/store'}).ssl,undefined);
});

test('inspectDatabaseTls verifies both direct pg_stat_ssl and pooler/proxy TLS connections',async()=>{
  const directPool={
    async connect(){
      return {
        connection:{stream:{encrypted:true,authorized:true,getProtocol:()=>'TLSv1.3',getCipher:()=>({name:'TLS_AES_256_GCM_SHA384'})}},
        async query(sql){
          if(sql.includes('pg_stat_ssl'))return {rows:[{ssl:true,version:'TLSv1.3',cipher:'TLS_AES_256_GCM_SHA384',bits:256}]};
          if(sql.includes('current_setting'))return {rows:[{ssl:'on'}]};
          return {rows:[{'?column?':1}]};
        },
        release(){}
      };
    }
  };
  const direct=await inspectDatabaseTls(directPool,{NODE_ENV:'production',PGSSL:'require',DATABASE_URL:'postgres://u:p@db.example/store'});
  assert.equal(direct.databaseTls,true);
  assert.equal(direct.databaseCertificateVerified,true);
  assert.equal(direct.databaseBackendTls,true);
  assert.equal(direct.databaseDirectBackendSsl,true);
  assert.equal(direct.databaseTlsProtocol,'TLSv1.3');
  assert.equal(direct.databaseTlsCipher,'TLS_AES_256_GCM_SHA384');

  const poolerPool={
    async connect(){
      return {
        connection:{stream:{encrypted:true,authorized:true,getProtocol:()=>'TLSv1.3',getCipher:()=>({name:'TLS_AES_128_GCM_SHA256'})}},
        async query(sql){
          if(sql.includes('pg_stat_ssl'))return {rows:[{ssl:false,version:null,cipher:null,bits:null}]};
          if(sql.includes('current_setting'))return {rows:[{ssl:'on'}]};
          return {rows:[{'?column?':1}]};
        },
        release(){}
      };
    }
  };
  const pooler=await inspectDatabaseTls(poolerPool,{NODE_ENV:'production',PGSSL:'require',DATABASE_URL:'postgres://u:p@ep-pooler.aws.neon.tech/store'});
  assert.equal(pooler.databaseTls,true);
  assert.equal(pooler.databaseCertificateVerified,true);
  assert.equal(pooler.databaseBackendTls,false);
  assert.equal(pooler.databaseDirectBackendSsl,false);
  assert.equal(pooler.databaseServerSslSetting,'on');
  assert.equal(pooler.databaseTlsProtocol,'TLSv1.3');
});

test('TLS configuration and server capability never substitute for connection evidence',async()=>{
  const pool={async connect(){return {
    async query(sql){
      if(sql.includes('pg_stat_ssl'))throw Error('Statistics are unavailable');
      if(sql.includes('current_setting'))return {rows:[{ssl:'on'}]};
      return {rows:[{}]};
    },release(){}
  };}};
  const result=await inspectDatabaseTls(pool,{NODE_ENV:'production',PGSSL:'require',DATABASE_URL:'postgres://u:p@db.example/store'});
  assert.equal(result.databaseServerSslSetting,'on');
  assert.equal(result.databaseBackendTls,null);
  assert.equal(result.databaseTls,null);
  assert.equal(result.databaseCertificateVerified,null);
});

test('database-side TLS does not prove the application authenticated its peer certificate',async()=>{
  const pool={async connect(){return {
    async query(sql){
      if(sql.includes('pg_stat_ssl'))return {rows:[{ssl:true}]};
      if(sql.includes('current_setting'))return {rows:[{ssl:'on'}]};
      return {rows:[{}]};
    },release(){}
  };}};
  const result=await inspectDatabaseTls(pool,{NODE_ENV:'production',PGSSL:'require',DATABASE_URL:'postgres://u:p@db.example/store'});
  assert.equal(result.databaseBackendTls,true);
  assert.equal(result.databaseTls,null);
  assert.equal(result.databaseCertificateVerified,null);
});

test('database TLS pool options enforce maxVersion TLSv1.3, modern ciphers, and configurable minVersion',()=>{
  const def=poolOptions({NODE_ENV:'production',DATABASE_URL:'postgres://u:p@db.example/store'});
  assert.equal(def.ssl.minVersion,'TLSv1.2');
  assert.equal(def.ssl.maxVersion,'TLSv1.3');
  assert.equal(def.ssl.honorCipherOrder,true);
  assert.ok(def.ssl.ciphersuites.includes('TLS_AES_256_GCM_SHA384'));
  assert.ok(def.ssl.ciphersuites.includes('TLS_CHACHA20_POLY1305_SHA256'));
  assert.ok(def.ssl.ciphers.includes('ECDHE-ECDSA-AES256-GCM-SHA384'));
  assert.ok(def.ssl.ciphers.includes('ECDHE-RSA-AES256-GCM-SHA384'));

  const strict=poolOptions({NODE_ENV:'production',PGSSL_MIN_VERSION:'TLSv1.3',DATABASE_URL:'postgres://u:p@db.example/store'});
  assert.equal(strict.ssl.minVersion,'TLSv1.3');
  assert.equal(strict.ssl.maxVersion,'TLSv1.3');
});

test('inspectDatabaseTls detects TLSv1.3 latest protocol and server SSL protocol settings',async()=>{
  const tls13Pool={
    async connect(){
      return {
        connection:{stream:{encrypted:true,authorized:true,getProtocol:()=>'TLSv1.3',getCipher:()=>({name:'TLS_AES_256_GCM_SHA384',bits:256})}},
        async query(sql){
          if(sql.includes('pg_stat_ssl'))return {rows:[{ssl:true,version:'TLSv1.3',cipher:'TLS_AES_256_GCM_SHA384',bits:256}]};
          if(sql.includes('current_setting')) {
            if(sql.includes('ssl_min_protocol_version'))return {rows:[{val:'TLSv1.2'}]};
            if(sql.includes('ssl_max_protocol_version'))return {rows:[{val:'TLSv1.3'}]};
            if(sql.includes('ssl_ciphers'))return {rows:[{val:'HIGH:!aNULL'}]};
            return {rows:[{ssl:'on'}]};
          }
          return {rows:[{'?column?':1}]};
        },
        release(){}
      };
    }
  };
  const res13=await inspectDatabaseTls(tls13Pool,{NODE_ENV:'production',DATABASE_URL:'postgres://u:p@db.example/store'});
  assert.equal(res13.databaseTls,true);
  assert.equal(res13.databaseTlsProtocol,'TLSv1.3');
  assert.equal(res13.databaseTlsLatest,true);
  assert.equal(res13.databaseServerSslMinProtocol,'TLSv1.2');
  assert.equal(res13.databaseServerSslMaxProtocol,'TLSv1.3');
  assert.equal(res13.databaseServerSslCiphers,'HIGH:!aNULL');

  const tls12Pool={
    async connect(){
      return {
        connection:{stream:{encrypted:true,authorized:true,getProtocol:()=>'TLSv1.2',getCipher:()=>({name:'ECDHE-RSA-AES256-GCM-SHA384',bits:256})}},
        async query(sql){
          if(sql.includes('pg_stat_ssl'))return {rows:[{ssl:true,version:'TLSv1.2',cipher:'ECDHE-RSA-AES256-GCM-SHA384',bits:256}]};
          return {rows:[{ssl:'on'}]};
        },
        release(){}
      };
    }
  };
  const res12=await inspectDatabaseTls(tls12Pool,{NODE_ENV:'production',DATABASE_URL:'postgres://u:p@db.example/store'});
  assert.equal(res12.databaseTls,true);
  assert.equal(res12.databaseTlsProtocol,'TLSv1.2');
  assert.equal(res12.databaseTlsLatest,false);
});
