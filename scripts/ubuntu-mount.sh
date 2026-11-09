#!/bin/bash
R=/storage/ubuntu
mnt() { mountpoint -q "$R$2" || { mkdir -p "$R$2"; mount $1 "$R$2"; }; }
mnt "-t proc proc" /proc
mnt "-t sysfs sys" /sys
mnt "--bind /dev" /dev
mnt "--bind /dev/pts" /dev/pts
mountpoint -q $R/dev/shm || { mkdir -p $R/dev/shm; mount -t tmpfs -o mode=1777 tmpfs $R/dev/shm; }
mountpoint -q $R/run || { mkdir -p $R/run; mount -t tmpfs -o mode=755 tmpfs $R/run; }
mkdir -p $R/run/postgresql && chown 999:997 $R/run/postgresql && chmod 2775 $R/run/postgresql 2>/dev/null
mkdir -p $R/var/www && mountpoint -q $R/var/www/html || { mkdir -p $R/var/www/html; mount --bind /storage/www/html $R/var/www/html 2>/dev/null || true; }
mountpoint -q $R/storage || { mkdir -p $R/storage; mount --bind /userdata/storage $R/storage; }
cp /etc/resolv.conf $R/etc/resolv.conf 2>/dev/null || true
cp /etc/hosts $R/etc/hosts 2>/dev/null || true
true
