#!/usr/bin/env python3
# PTY helper for the Mi 6 admin web terminal (host Python 3.5).
# stdin  : framed messages  [1 byte type][4 byte BE length][payload]
#          type 'd' = keyboard data, 'r' = resize (rows, cols as 2x uint16 BE)
# stdout : raw terminal output
import os, pty, sys, select, struct, fcntl, termios, signal

def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]

pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['HOME'] = '/root'
    os.environ['LANG'] = 'C.UTF-8'
    os.environ['PATH'] = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    try:
        os.chdir('/root')
    except OSError:
        pass
    if os.path.exists('/storage/ubuntu/bin/bash'):
        cmd = ("if [ -f /usr/local/sbin/ubuntu-mount.sh ]; then /usr/local/sbin/ubuntu-mount.sh >/dev/null 2>&1; fi; "
               "echo -e '\\033[1;32m==============================================================\\033[0m'; "
               "echo -e '\\033[1;32m  Mi 6 Server: Ubuntu 26.10 Stonking (Node 26 & PG 18)        \\033[0m'; "
               "echo -e '\\033[0;36m  Môi trường máy chủ chính đã kích hoạt sẵn sàng             \\033[0m'; "
               "echo -e '\\033[0;33m  (Gõ exit để ra Host OS Ubuntu 16; gõ u26 để vào lại)        \\033[0m'; "
               "echo -e '\\033[1;32m==============================================================\\033[0m\\n'; "
               "chroot /storage/ubuntu /usr/bin/env -i HOME=/root TERM=xterm-256color LANG=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash --login; "
               "echo -e '\\n\\033[1;33m=== Đã trở lại Host OS (Ubuntu 16.04) ===\\033[0m'; "
               "echo -e '\\033[0;36m(Gõ u26 để vào lại Ubuntu 26.10)\\033[0m\\n'; "
               "exec /bin/bash -l")
        os.execvp('/bin/bash', ['bash', '-c', cmd])
    else:
        os.execvp('/bin/bash', ['bash', '-l'])

buf = b''
try:
    while True:
        r, _, _ = select.select([fd, 0], [], [])
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            write_all(1, data)
        if 0 in r:
            d = os.read(0, 65536)
            if not d:
                break
            buf += d
            while len(buf) >= 5:
                t = buf[0:1]
                n = struct.unpack('>I', buf[1:5])[0]
                if len(buf) < 5 + n:
                    break
                p = buf[5:5 + n]
                buf = buf[5 + n:]
                if t == b'd':
                    write_all(fd, p)
                elif t == b'r' and len(p) == 4:
                    rows, cols = struct.unpack('>HH', p)
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
