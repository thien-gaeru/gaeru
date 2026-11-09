const cp = require('child_process');
const p = cp.spawnSync('chroot', ['/storage/ubuntu', 'su', 'postgres', '-c', 'psql -d gaeru_store -c "SELECT count(*) FROM products;"']);
console.log('STDOUT:', p.stdout.toString());
console.log('STATUS:', p.status);
