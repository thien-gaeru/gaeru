#!/bin/bash
set -e

sed -i 's/\r$//' /tmp/postgresql-chroot.conf /tmp/node-app.conf
mv /tmp/postgresql-chroot.conf /etc/init/postgresql-chroot.conf
chmod 644 /etc/init/postgresql-chroot.conf
mv /tmp/node-app.conf /etc/init/node-app.conf
chmod 644 /etc/init/node-app.conf

initctl reload-configuration

restart postgresql-chroot
sleep 2
restart node-app APP=gaeru
sleep 3

PG_PID=$(initctl status postgresql-chroot | awk '{print $NF}')
NODE_PID=$(initctl status node-app APP=gaeru | awk '{print $NF}')

echo "PG PID: $PG_PID, OOM: $(cat /proc/$PG_PID/oom_score_adj), NOFILE: $(grep 'open files' /proc/$PG_PID/limits | tr -s ' ')"
echo "NODE PID: $NODE_PID, OOM: $(cat /proc/$NODE_PID/oom_score_adj), NOFILE: $(grep 'open files' /proc/$NODE_PID/limits | tr -s ' ')"
