'use strict';
const fs = require('fs');

const html = fs.readFileSync('account.html', 'utf8');
const scriptMatches = [...html.matchAll(/src=["']([^"']+)["']/g)].map(m => m[1]);
const linkMatches = [...html.matchAll(/href=["']([^"']+\.css[^"']*)["']/g)].map(m => m[1]);

async function check() {
  console.log('Checking account scripts count:', scriptMatches.length);
  for (const src of scriptMatches) {
    const url = 'http://127.0.0.1:3000' + (src.startsWith('/') ? src : '/' + src);
    try {
      const res = await fetch(url);
      if (!res.ok) console.error('FAILED script:', res.status, src);
    } catch (e) {
      console.error('ERROR script:', src, e.message);
    }
  }

  console.log('Checking account css count:', linkMatches.length);
  for (const href of linkMatches) {
    const url = 'http://127.0.0.1:3000' + (href.startsWith('/') ? href : '/' + href);
    try {
      const res = await fetch(url);
      if (!res.ok) console.error('FAILED css:', res.status, href);
    } catch (e) {
      console.error('ERROR css:', href, e.message);
    }
  }
  console.log('Account assets check finished.');
}
check().catch(console.error);
