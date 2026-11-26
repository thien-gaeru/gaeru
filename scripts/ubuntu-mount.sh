#!/bin/bash
set -euo pipefail
R="/storage/ubuntu"
if [ ! -d "$R/usr" ] && [ -d "/userdata/storage/ubuntu/usr" ]; then
  R="/userdata/storage/ubuntu"
fi
mountpoint -q "$R/proc" || { mkdir -p "$R/proc"; mount -t proc proc "$R/proc"; }
mountpoint -q "$R/sys" || { mkdir -p "$R/sys"; mount -t sysfs sys "$R/sys"; }
mountpoint -q "$R/dev" || { mkdir -p "$R/dev"; mount --bind /dev "$R/dev"; }
mountpoint -q "$R/dev/pts" || { mkdir -p "$R/dev/pts"; mount --bind /dev/pts "$R/dev/pts"; }
mountpoint -q "$R/dev/shm" || { mkdir -p "$R/dev/shm"; mount -t tmpfs -o mode=1777 tmpfs "$R/dev/shm"; }
mountpoint -q "$R/run" || { mkdir -p "$R/run"; mount -t tmpfs -o mode=755 tmpfs "$R/run"; }
mkdir -p "$R/run/postgresql" && chown 999:997 "$R/run/postgresql" && chmod 2775 "$R/run/postgresql" 2>/dev/null || true
mkdir -p "$R/var/www"
if [ -d /storage/www/html ] && ! mountpoint -q "$R/var/www/html"; then
  mkdir -p "$R/var/www/html"
  mount --bind /storage/www/html "$R/var/www/html" 2>/dev/null || true
fi
mountpoint -q "$R/storage" || { mkdir -p "$R/storage"; mount --bind /userdata/storage "$R/storage"; }
cp /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || true
cp /etc/hosts "$R/etc/hosts" 2>/dev/null || true
exit 0
