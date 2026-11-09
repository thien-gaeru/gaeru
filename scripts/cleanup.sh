#!/bin/bash
set -e

echo "=== 1. Removing /storage/debian ==="
rm -rf /storage/debian
echo "Debian directory removed successfully."

echo "=== 2. Cleaning legacy Debian scripts ==="
rm -f /usr/local/sbin/debian-mount.sh
rm -f /usr/local/bin/debian
rm -f /usr/local/sbin/deb-wrap
echo "Legacy scripts cleaned."

echo "=== 3. Cleaning APT caches inside Ubuntu 26 ==="
chroot /storage/ubuntu apt-get clean
chroot /storage/ubuntu apt-get autoremove -y 2>/dev/null || true
echo "Ubuntu 26 APT cleaned."

echo "=== 4. Cleaning temporary files ==="
rm -rf /tmp/update_admin.sh /tmp/install*.sh /tmp/test_*.sql /tmp/test_admin_pg.js /tmp/check.sql /tmp/run_test.sh
rm -rf /storage/ubuntu/tmp/test_db.sql

echo "=== 5. Current disk status ==="
df -h /userdata /storage /
