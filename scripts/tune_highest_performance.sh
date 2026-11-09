#!/bin/bash
set -e

echo "=== 1. Tuning Host Sysctl ==="
sysctl -w vm.max_map_count=262144
cat > /etc/sysctl.d/99-server-tuning.conf << 'EOF'
net.core.somaxconn = 8192
net.ipv4.tcp_max_syn_backlog = 8192
net.core.netdev_max_backlog = 10000
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
vm.swappiness = 10
vm.vfs_cache_pressure = 50
vm.max_map_count = 262144
fs.file-max = 2097152
EOF
sysctl -p /etc/sysctl.d/99-server-tuning.conf

echo "=== 2. Tuning PostgreSQL 18 ==="
PG_CONF=/storage/ubuntu/etc/postgresql/18/main/postgresql.conf
sed -i 's/^max_connections = .*/max_connections = 200/' "$PG_CONF"
sed -i 's/^#wal_buffers = .*/wal_buffers = 16MB/' "$PG_CONF"
sed -i 's/^max_wal_size = .*/max_wal_size = 2GB/' "$PG_CONF"
sed -i 's/^min_wal_size = .*/min_wal_size = 512MB/' "$PG_CONF"

echo "=== 3. Tuning app.env for Gaeru ==="
APP_ENV=/storage/apps/gaeru/app.env
grep -q '^ENV_PG_MAX_CONNECTIONS=' "$APP_ENV" && sed -i 's/^ENV_PG_MAX_CONNECTIONS=.*/ENV_PG_MAX_CONNECTIONS=20/' "$APP_ENV" || echo 'ENV_PG_MAX_CONNECTIONS=20' >> "$APP_ENV"
grep -q '^ENV_PG_POOL_SIZE=' "$APP_ENV" && sed -i 's/^ENV_PG_POOL_SIZE=.*/ENV_PG_POOL_SIZE=20/' "$APP_ENV" || echo 'ENV_PG_POOL_SIZE=20' >> "$APP_ENV"

echo "=== 4. Updating server-hardware-tuning.conf ==="
grep -q 'vm.max_map_count' /etc/init/server-hardware-tuning.conf || sed -i '/end script/i \  sysctl -w vm.max_map_count=262144 2>/dev/null || true' /etc/init/server-hardware-tuning.conf

echo "=== 5. Restarting PostgreSQL & Node App ==="
restart postgresql-chroot
sleep 2
restart node-app APP=gaeru
sleep 3

echo "=== 6. Verification ==="
PG_CONN=$(chroot --userspec=999:997 /storage/ubuntu psql -d gaeru_store -tAc "SHOW max_connections;")
PG_BUF=$(chroot --userspec=999:997 /storage/ubuntu psql -d gaeru_store -tAc "SHOW shared_buffers;")
PG_WAL=$(chroot --userspec=999:997 /storage/ubuntu psql -d gaeru_store -tAc "SHOW wal_buffers;")
MAP_COUNT=$(sysctl -n vm.max_map_count)

echo "PostgreSQL max_connections: $PG_CONN"
echo "PostgreSQL shared_buffers: $PG_BUF"
echo "PostgreSQL wal_buffers: $PG_WAL"
echo "Linux vm.max_map_count: $MAP_COUNT"

echo "PEAK_TUNING_APPLIED_SUCCESSFULLY"
