#!/bin/bash
set -e

# 1. Update /storage/admin/server.js
sed -i "s|const DEB = '/storage/debian';|const DEB = '/storage/ubuntu';|" /storage/admin/server.js
sed -i "s|/usr/local/sbin/debian-mount.sh|/usr/local/sbin/ubuntu-mount.sh|g" /storage/admin/server.js
sed -i "s|\['postgresql-chroot', 'PostgreSQL 18'\],|\['postgresql-chroot', 'PostgreSQL 18 (Ubuntu 26)'\],|" /storage/admin/server.js

# 2. Update pty_helper.py
sed -i 's/\r$//' /tmp/pty_helper.py
mv /tmp/pty_helper.py /storage/admin/pty_helper.py
chmod 755 /storage/admin/pty_helper.py

# 3. Update host-node
sed -i 's/\r$//' /tmp/host-node
mv /tmp/host-node /usr/local/sbin/host-node
chmod 755 /usr/local/sbin/host-node

# 4. Update server-dashboard.conf
sed -i 's/\r$//' /tmp/server-dashboard.conf
mv /tmp/server-dashboard.conf /etc/init/server-dashboard.conf
chmod 644 /etc/init/server-dashboard.conf

initctl reload-configuration

# 5. Restart server-dashboard
stop server-dashboard 2>/dev/null || true
start server-dashboard

echo "ADMIN_UPDATED_SUCCESSFULLY"
