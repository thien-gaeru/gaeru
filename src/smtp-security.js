function smtpOptions(s){return {host:s.host,port:s.port,secure:s.secure===true,requireTLS:true,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:{user:s.user,pass:s.password},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000};}
module.exports={smtpOptions};
