sed -i 's/\r$//' /tmp/ubuntu-mount.sh /tmp/postgresql-chroot.conf /tmp/node-app.conf
mv /tmp/ubuntu-mount.sh /usr/local/sbin/ubuntu-mount.sh
chmod 755 /usr/local/sbin/ubuntu-mount.sh
mv /tmp/postgresql-chroot.conf /etc/init/postgresql-chroot.conf
chmod 644 /etc/init/postgresql-chroot.conf
mv /tmp/node-app.conf /etc/init/node-app.conf
chmod 644 /etc/init/node-app.conf
/usr/local/sbin/ubuntu-mount.sh
initctl reload-configuration
echo ALL_DEPLOYED_OK
