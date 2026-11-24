#!/usr/bin/env python3
"""
GAERU On-Demand Status Display Daemon (Headless Linux Server Mode)
- Keeps display powered off (0% CPU, 0% GPU, no Mir/LightDM/Unity8) at boot and when idle.
- Wakes ONLY on physical Power key (/dev/input/event0), control signal,
  or Web Admin brightness > 0; renders live server metrics via Mir software buffer + Cairo/PangoCairo.
- Auto-blanks after timeout or second Power key press.
"""

import ctypes
import fcntl
import glob
import json
import math
import os
import select
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.request

W = 1080
H = 1920

BL_PATH = "/sys/class/leds/lcd-backlight/brightness"
BL_CONF = "/etc/screen_brightness.conf"
WLED_BL_PATH = "/sys/class/leds/wled/brightness"
WLED_TRIG_PATH = "/sys/class/leds/wled/trigger"
WLED_REGS_PATH = "/sys/class/leds/wled/dump_regs"
MDP_CAPS_PATH = "/sys/devices/soc/c900000.qcom,mdss_mdp/caps"
FB_PATH = "/dev/fb0"
MIR_SOCKET = "/run/mir_socket"
PID_FILE = "/run/gaeru-screen.pid"
STATUS_FILE = "/run/gaeru-screen.status"
USC_LOG = "/var/log/gaeru-screen-usc.log"
DAEMON_LOG = "/var/log/gaeru-screen.log"

FBIOBLANK = 0x4611
FB_BLANK_UNBLANK = 0
FB_BLANK_POWERDOWN = 4

EV_KEY = 1
EV_ABS = 3
KEY_HOME = 102
KEY_VOLUMEDOWN = 114
KEY_VOLUMEUP = 115
KEY_POWER = 116
INPUT_EVENT_FMT = "qqHHi"
INPUT_EVENT_SIZE = struct.calcsize(INPUT_EVENT_FMT)

AUTO_OFF_POWER_SEC = 30.0
AUTO_OFF_ADMIN_SEC = 60.0
REFRESH_INTERVAL_SEC = 2.0
DEFAULT_BRIGHTNESS = 1600


def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = "[%s] %s\n" % (ts, msg)
    try:
        if os.path.exists(DAEMON_LOG) and os.path.getsize(DAEMON_LOG) > 524288:
            with open(DAEMON_LOG, "r") as rf:
                tail = rf.readlines()[-500:]
            with open(DAEMON_LOG, "w") as wf:
                wf.writelines(tail)
        with open(DAEMON_LOG, "a") as f:
            f.write(line)
    except Exception:
        pass


mir = ctypes.CDLL("/usr/lib/aarch64-linux-gnu/libmirclient.so.9")
cairo = ctypes.CDLL("/usr/lib/aarch64-linux-gnu/libcairo.so.2")
pango = ctypes.CDLL("/usr/lib/aarch64-linux-gnu/libpango-1.0.so.0")
pangocairo = ctypes.CDLL("/usr/lib/aarch64-linux-gnu/libpangocairo-1.0.so.0")
gobject = ctypes.CDLL("/usr/lib/aarch64-linux-gnu/libgobject-2.0.so.0")


class MirGraphicsRegion(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("stride", ctypes.c_int),
        ("pixel_format", ctypes.c_int),
        ("vaddr", ctypes.c_void_p),
    ]


mir.mir_connect_sync.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
mir.mir_connect_sync.restype = ctypes.c_void_p
mir.mir_connection_is_valid.argtypes = [ctypes.c_void_p]
mir.mir_connection_is_valid.restype = ctypes.c_bool
mir.mir_connection_release.argtypes = [ctypes.c_void_p]
mir.mir_create_normal_window_spec.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
mir.mir_create_normal_window_spec.restype = ctypes.c_void_p
mir.mir_window_spec_set_name.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
mir.mir_window_spec_set_pixel_format.argtypes = [ctypes.c_void_p, ctypes.c_int]
mir.mir_window_spec_set_buffer_usage.argtypes = [ctypes.c_void_p, ctypes.c_int]
mir.mir_window_spec_set_fullscreen_on_output.argtypes = [ctypes.c_void_p, ctypes.c_uint]
mir.mir_create_window_sync.argtypes = [ctypes.c_void_p]
mir.mir_create_window_sync.restype = ctypes.c_void_p
mir.mir_window_spec_release.argtypes = [ctypes.c_void_p]
mir.mir_window_is_valid.argtypes = [ctypes.c_void_p]
mir.mir_window_is_valid.restype = ctypes.c_bool
mir.mir_window_get_buffer_stream.argtypes = [ctypes.c_void_p]
mir.mir_window_get_buffer_stream.restype = ctypes.c_void_p
mir.mir_window_release_sync.argtypes = [ctypes.c_void_p]
mir.mir_buffer_stream_get_graphics_region.argtypes = [ctypes.c_void_p, ctypes.POINTER(MirGraphicsRegion)]
mir.mir_buffer_stream_get_graphics_region.restype = ctypes.c_bool
mir.mir_buffer_stream_swap_buffers_sync.argtypes = [ctypes.c_void_p]

cairo.cairo_image_surface_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
cairo.cairo_image_surface_create.restype = ctypes.c_void_p
cairo.cairo_surface_destroy.argtypes = [ctypes.c_void_p]
cairo.cairo_surface_flush.argtypes = [ctypes.c_void_p]
cairo.cairo_image_surface_get_data.argtypes = [ctypes.c_void_p]
cairo.cairo_image_surface_get_data.restype = ctypes.c_void_p
cairo.cairo_image_surface_get_stride.argtypes = [ctypes.c_void_p]
cairo.cairo_image_surface_get_stride.restype = ctypes.c_int
cairo.cairo_create.argtypes = [ctypes.c_void_p]
cairo.cairo_create.restype = ctypes.c_void_p
cairo.cairo_destroy.argtypes = [ctypes.c_void_p]
cairo.cairo_set_source_rgb.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double, ctypes.c_double]
cairo.cairo_set_source_rgba.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double]
cairo.cairo_set_line_width.argtypes = [ctypes.c_void_p, ctypes.c_double]
cairo.cairo_paint.argtypes = [ctypes.c_void_p]
cairo.cairo_new_sub_path.argtypes = [ctypes.c_void_p]
cairo.cairo_arc.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double]
cairo.cairo_close_path.argtypes = [ctypes.c_void_p]
cairo.cairo_fill.argtypes = [ctypes.c_void_p]
cairo.cairo_fill_preserve.argtypes = [ctypes.c_void_p]
cairo.cairo_stroke.argtypes = [ctypes.c_void_p]
cairo.cairo_move_to.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double]
cairo.cairo_line_to.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double]

pangocairo.pango_cairo_create_layout.argtypes = [ctypes.c_void_p]
pangocairo.pango_cairo_create_layout.restype = ctypes.c_void_p
pangocairo.pango_cairo_show_layout.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
pango.pango_font_description_from_string.argtypes = [ctypes.c_char_p]
pango.pango_font_description_from_string.restype = ctypes.c_void_p
pango.pango_font_description_free.argtypes = [ctypes.c_void_p]
pango.pango_layout_set_font_description.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
pango.pango_layout_set_text.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
pango.pango_layout_set_width.argtypes = [ctypes.c_void_p, ctypes.c_int]
pango.pango_layout_set_alignment.argtypes = [ctypes.c_void_p, ctypes.c_int]
pango.pango_layout_set_ellipsize.argtypes = [ctypes.c_void_p, ctypes.c_int]
gobject.g_object_unref.argtypes = [ctypes.c_void_p]


def hex_rgb(h):
    h = h.lstrip("#")
    return int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0


def rounded_rect(cr, x, y, w, h, r):
    r = min(r, w / 2.0, h / 2.0)
    cairo.cairo_new_sub_path(cr)
    cairo.cairo_arc(cr, x + w - r, y + r, r, -math.pi / 2.0, 0.0)
    cairo.cairo_arc(cr, x + w - r, y + h - r, r, 0.0, math.pi / 2.0)
    cairo.cairo_arc(cr, x + r, y + h - r, r, math.pi / 2.0, math.pi)
    cairo.cairo_arc(cr, x + r, y + r, r, math.pi, 1.5 * math.pi)
    cairo.cairo_close_path(cr)


def draw_text(cr, x, y, text, font_str, color_hex, width=-1, align=0):
    layout = pangocairo.pango_cairo_create_layout(cr)
    desc = pango.pango_font_description_from_string(font_str.encode("utf-8"))
    pango.pango_layout_set_font_description(layout, desc)
    b = text.encode("utf-8")
    pango.pango_layout_set_text(layout, b, len(b))
    if width > 0:
        pango.pango_layout_set_width(layout, int(width * 1024))
        pango.pango_layout_set_alignment(layout, align)
        pango.pango_layout_set_ellipsize(layout, 3)
    r, g, bl = hex_rgb(color_hex)
    cairo.cairo_set_source_rgb(cr, r, g, bl)
    cairo.cairo_move_to(cr, float(x), float(y))
    pangocairo.pango_cairo_show_layout(cr, layout)
    pango.pango_font_description_free(desc)
    gobject.g_object_unref(layout)


def read_str(path, default=""):
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except Exception:
        return default


def read_int(path, default=None):
    s = read_str(path, "")
    try:
        return int(s)
    except Exception:
        return default


def write_brightness(val):
    v = max(0, min(4095, int(val)))
    try:
        with open(BL_PATH, "w") as f:
            f.write(str(v))
    except Exception as e:
        log("write_brightness error: %s" % e)


def fb_blank(mode):
    try:
        fd = os.open(FB_PATH, os.O_RDWR)
        try:
            fcntl.ioctl(fd, FBIOBLANK, mode)
        finally:
            os.close(fd)
    except Exception as e:
        log("fb_blank(%s) error: %s" % (mode, e))


def wled_is_enabled():
    try:
        with open(WLED_REGS_PATH, "r") as f:
            for line in f:
                if "REG_0xd846" in line:
                    val = line.split("=")[-1].strip().lower()
                    return val != "0x0" and val != "0x00" and val != "0"
    except Exception:
        pass
    return False


def mdp_handoff_active():
    try:
        with open(MDP_CAPS_PATH, "r") as f:
            return "pipe_is_handoff:1" in f.read()
    except Exception:
        return False


def ensure_wled_bkl_trigger():
    try:
        with open(WLED_TRIG_PATH, "r") as f:
            cur = f.read()
        if "[bkl-trigger]" not in cur:
            with open(WLED_TRIG_PATH, "w") as f:
                f.write("bkl-trigger")
    except Exception as e:
        log("ensure_wled_bkl_trigger error: %s" % e)


def force_wled_off():
    write_brightness(0)
    if wled_is_enabled():
        try:
            with open(WLED_BL_PATH, "w") as f:
                f.write("1")
            time.sleep(0.02)
            with open(WLED_BL_PATH, "w") as f:
                f.write("0")
            # qpnp-wled turns REG_0xd846 off asynchronously (~50-100ms);
            # wait before re-attaching bkl-trigger so it isn't cancelled.
            time.sleep(0.20)
        except Exception as e:
            log("force_wled_off wled write error: %s" % e)
    ensure_wled_bkl_trigger()


class MetricsCollector:
    def __init__(self):
        self.prev_cpu = None
        self.prev_net = None
        self.prev_net_t = 0.0
        self.cached_ssid = None
        self.cached_ssid_t = 0.0
        self.cached_http = {}
        self.cached_http_t = 0.0

    def cpu_pct(self):
        try:
            with open("/proc/stat", "r") as f:
                line = f.readline()
            parts = [int(x) for x in line.split()[1:]]
            idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
            total = sum(parts)
            pct = 0.0
            if self.prev_cpu is not None:
                dt = total - self.prev_cpu[0]
                di = idle - self.prev_cpu[1]
                if dt > 0:
                    pct = max(0.0, min(100.0, 100.0 * (1.0 - float(di) / float(dt))))
            self.prev_cpu = (total, idle)
            return pct
        except Exception:
            return 0.0

    def net_stats(self):
        now = time.time()
        rx_rate = 0.0
        tx_rate = 0.0
        iface = "wlan1"
        try:
            with open("/proc/net/dev", "r") as f:
                for line in f:
                    if ":" not in line:
                        continue
                    k, rest = line.split(":", 1)
                    k = k.strip()
                    if k == "wlan1":
                        cols = rest.split()
                        rx = int(cols[0])
                        tx = int(cols[8])
                        if self.prev_net and now > self.prev_net_t:
                            dt = now - self.prev_net_t
                            rx_rate = max(0.0, (rx - self.prev_net[0]) / dt)
                            tx_rate = max(0.0, (tx - self.prev_net[1]) / dt)
                        self.prev_net = (rx, tx)
                        self.prev_net_t = now
                        break
        except Exception:
            pass

        ip = "offline"
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                ip = socket.inet_ntoa(fcntl.ioctl(
                    s.fileno(), 0x8915, struct.pack("256s", iface.encode("ascii"))
                )[20:24])
            finally:
                s.close()
        except Exception:
            pass

        if now - self.cached_ssid_t > 10.0:
            self.cached_ssid_t = now
            try:
                out = subprocess.check_output(["iwgetid", "-r"], stderr=subprocess.DEVNULL, timeout=1.0)
                self.cached_ssid = out.decode("utf-8", "replace").strip() or "Wifi"
            except Exception:
                self.cached_ssid = "Wifi"

        return {"iface": iface, "ip": ip, "ssid": self.cached_ssid or "-", "rx_bps": rx_rate, "tx_bps": tx_rate}

    def http_probes(self):
        now = time.time()
        if now - self.cached_http_t < 4.0 and self.cached_http:
            return self.cached_http
        self.cached_http_t = now
        res = {}
        for name, url in [("3000", "http://127.0.0.1:3000/health"), ("8080", "http://127.0.0.1:8080/"), ("80", "http://127.0.0.1:80/")]:
            try:
                req = urllib.request.urlopen(url, timeout=1.2)
                res[name] = req.getcode()
                req.close()
            except Exception:
                try:
                    port = int(name)
                    sock = socket.create_connection(("127.0.0.1", port), timeout=0.6)
                    sock.close()
                    res[name] = 200
                except Exception:
                    res[name] = 0
        self.cached_http = res
        return res

    def scan_procs(self):
        services = {
            "postgres": {"pids": 0, "rss_kb": 0},
            "node_app": {"pids": 0, "rss_kb": 0},
            "admin": {"pids": 0, "rss_kb": 0},
            "gpu_ai": {"pids": 0, "rss_kb": 0},
            "cloudflared": {"pids": 0, "rss_kb": 0},
            "watchdog": {"pids": 0, "rss_kb": 0},
            "health": {"pids": 0, "rss_kb": 0},
            "battery": {"pids": 0, "rss_kb": 0},
            "gui": {"pids": 0, "rss_kb": 0},
        }
        for ent in os.listdir("/proc"):
            if not ent.isdigit():
                continue
            try:
                with open("/proc/%s/cmdline" % ent, "rb") as f:
                    cmd = f.read().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
                if not cmd:
                    continue
                rss = 0
                try:
                    with open("/proc/%s/status" % ent, "r") as sf:
                        for line in sf:
                            if line.startswith("VmRSS:"):
                                rss = int(line.split()[1])
                                break
                except Exception:
                    pass

                if "/postgres " in cmd or "postgres:" in cmd:
                    services["postgres"]["pids"] += 1
                    services["postgres"]["rss_kb"] += rss
                elif "/storage/apps/gaeru/" in cmd or "src/cluster.js" in cmd:
                    services["node_app"]["pids"] += 1
                    services["node_app"]["rss_kb"] += rss
                elif "/storage/admin/server.js" in cmd:
                    services["admin"]["pids"] += 1
                    services["admin"]["rss_kb"] += rss
                elif "gaeru-gpu-ai" in cmd or "llama-server" in cmd:
                    services["gpu_ai"]["pids"] += 1
                    services["gpu_ai"]["rss_kb"] += rss
                elif "cloudflared" in cmd and "tunnel" in cmd:
                    services["cloudflared"]["pids"] += 1
                    services["cloudflared"]["rss_kb"] += rss
                elif "network_watchdog.sh" in cmd:
                    services["watchdog"]["pids"] += 1
                    services["watchdog"]["rss_kb"] += rss
                elif "gaeru-healthcheck.sh" in cmd:
                    services["health"]["pids"] += 1
                    services["health"]["rss_kb"] += rss
                elif "battery_limiter.py" in cmd:
                    services["battery"]["pids"] += 1
                    services["battery"]["rss_kb"] += rss
                elif any(x in cmd for x in ("unity8", "lightdm", "repowerd", "upstart --user", "unity-system-compositor-spinner", "maliit-server", "mediascanner", "hfd-service", "usermetricsservice", "pulseaudio")):
                    if "gaeru-screen" not in cmd:
                        services["gui"]["pids"] += 1
                        services["gui"]["rss_kb"] += rss
            except Exception:
                continue
        return services

    def collect(self):
        host = socket.gethostname()
        kernel = os.uname().release
        uptime_s = float(read_str("/proc/uptime", "0").split()[0])

        mi = {}
        try:
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    p = line.split()
                    if len(p) >= 2:
                        mi[p[0].rstrip(":")] = int(p[1])
        except Exception:
            pass
        mem_tot_mb = mi.get("MemTotal", 0) / 1024.0
        mem_avail_mb = mi.get("MemAvailable", 0) / 1024.0
        mem_used_mb = max(0.0, mem_tot_mb - mem_avail_mb)
        swap_tot_mb = mi.get("SwapTotal", 0) / 1024.0
        swap_free_mb = mi.get("SwapFree", 0) / 1024.0
        swap_used_mb = max(0.0, swap_tot_mb - swap_free_mb)

        loads = read_str("/proc/loadavg", "0 0 0").split()[:3]

        cpu_max_c = 0.0
        for z in glob.glob("/sys/class/thermal/thermal_zone*"):
            t = read_str(os.path.join(z, "type"))
            if t.startswith("tsens_tz_sensor"):
                val = read_int(os.path.join(z, "temp"))
                if val is not None:
                    cpu_max_c = max(cpu_max_c, val / 10.0)

        b_cap = read_int("/sys/class/power_supply/battery/capacity", 0)
        b_stat = read_str("/sys/class/power_supply/battery/status", "?")
        b_volt = (read_int("/sys/class/power_supply/battery/voltage_now", 0) or 0) / 1e6
        b_curr = -(read_int("/sys/class/power_supply/battery/current_now", 0) or 0) / 1000.0
        b_temp = (read_int("/sys/class/power_supply/battery/temp", 0) or 0) / 10.0
        u_curr_max = (read_int("/sys/class/power_supply/usb/current_max", 0) or 0) / 1000.0
        u_volt = (read_int("/sys/class/power_supply/usb/voltage_now", 0) or 0) / 1e6
        lim = {}
        try:
            lim = json.loads(read_str("/run/battery_limiter.json", "{}"))
        except Exception:
            pass

        disks = {}
        data_mnt = "/userdata" if os.path.exists("/userdata") else "/data"
        for label, mnt in [("userdata", data_mnt), ("root", "/")]:
            try:
                st = os.statvfs(mnt)
                tot = st.f_blocks * st.f_frsize
                avail = st.f_bavail * st.f_frsize
                used = (st.f_blocks - st.f_bfree) * st.f_frsize
                pct = (100.0 * used / tot) if tot > 0 else 0.0
                disks[label] = {
                    "tot_gb": tot / (1024.0 ** 3),
                    "used_gb": used / (1024.0 ** 3),
                    "free_gb": avail / (1024.0 ** 3),
                    "pct": pct,
                }
            except Exception:
                disks[label] = {"tot_gb": 0, "used_gb": 0, "free_gb": 0, "pct": 0}

        return {
            "host": host,
            "kernel": kernel,
            "uptime_s": uptime_s,
            "cpu_pct": self.cpu_pct(),
            "loads": loads,
            "cpu_temp": cpu_max_c,
            "mem_used_mb": mem_used_mb,
            "mem_tot_mb": mem_tot_mb,
            "swap_used_mb": swap_used_mb,
            "swap_tot_mb": swap_tot_mb,
            "bat": {
                "cap": b_cap, "status": b_stat, "volt": b_volt,
                "curr_ma": b_curr, "temp": b_temp,
                "usb_v": lim.get("usb", {}).get("voltage_v", u_volt),
                "usb_in_ma": lim.get("usb", {}).get("input_current_ma", 0),
                "usb_max_ma": u_curr_max,
                "lim_max": lim.get("target_max", 80),
                "cutoff": bool(lim.get("bypass_active") or lim.get("charge_cut_off")),
            },
            "disks": disks,
            "net": self.net_stats(),
            "procs": self.scan_procs(),
            "http": self.http_probes(),
        }


def fmt_uptime(sec):
    s = int(sec)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    if d > 0:
        return "%dd %02dh %02dm" % (d, h, m)
    return "%02dh %02dm %02ds" % (h, m, s)


def fmt_rate(bps):
    if bps >= 1024 * 1024:
        return "%.1f MB/s" % (bps / (1024.0 * 1024.0))
    if bps >= 1024:
        return "%.0f KB/s" % (bps / 1024.0)
    return "%.0f B/s" % bps


def draw_card(cr, x, y, w, h, title=None):
    r, g, b = hex_rgb("#131c31")
    cairo.cairo_set_source_rgb(cr, r, g, b)
    rounded_rect(cr, x, y, w, h, 24)
    cairo.cairo_fill_preserve(cr)
    r, g, b = hex_rgb("#24334f")
    cairo.cairo_set_source_rgb(cr, r, g, b)
    cairo.cairo_set_line_width(cr, 2.5)
    cairo.cairo_stroke(cr)
    if title:
        draw_text(cr, x + 28, y + 22, title, "DejaVu Sans Bold 14", "#7dd3fc")


def draw_bar(cr, x, y, w, h, pct, color_hex):
    pct = max(0.0, min(100.0, pct))
    r, g, b = hex_rgb("#1e293b")
    cairo.cairo_set_source_rgb(cr, r, g, b)
    rounded_rect(cr, x, y, w, h, h / 2.0)
    cairo.cairo_fill(cr)
    fill_w = max(h if pct > 0 else 0.0, w * (pct / 100.0))
    if fill_w > 0:
        r, g, b = hex_rgb(color_hex)
        cairo.cairo_set_source_rgb(cr, r, g, b)
        rounded_rect(cr, x, y, min(w, fill_w), h, h / 2.0)
        cairo.cairo_fill(cr)


def render_dashboard(data, remaining_sec):
    surf = cairo.cairo_image_surface_create(0, W, H)
    cr = cairo.cairo_create(surf)

    r, g, b = hex_rgb("#0b1120")
    cairo.cairo_set_source_rgb(cr, r, g, b)
    cairo.cairo_paint(cr)

    procs = data["procs"]
    http = data["http"]
    core_ok = (
        procs["postgres"]["pids"] > 0
        and procs["node_app"]["pids"] > 0
        and procs["admin"]["pids"] > 0
        and procs["cloudflared"]["pids"] > 0
        and http.get("3000") == 200
    )

    # 1. HEADER CARD
    draw_card(cr, 36, 36, W - 72, 196)
    draw_text(cr, 66, 62, "GAERU SERVER", "DejaVu Sans Bold 30", "#f8fafc")
    draw_text(
        cr, 66, 134,
        "%s  •  Linux %s  •  Headless (No GUI)" % (data["host"], data["kernel"].split("-")[0]),
        "DejaVu Sans 13", "#94a3b8"
    )
    draw_text(
        cr, 66, 174,
        "Uptime: %s    •    IP: %s" % (fmt_uptime(data["uptime_s"]), data["net"]["ip"]),
        "DejaVu Sans Mono Bold 14", "#cbd5e1"
    )

    pill_color = "#10b981" if core_ok else "#f59e0b"
    pill_text = "ONLINE" if core_ok else "CHECK"
    r, g, b = hex_rgb(pill_color)
    cairo.cairo_set_source_rgba(cr, r, g, b, 0.20)
    rounded_rect(cr, W - 260, 62, 196, 56, 28)
    cairo.cairo_fill_preserve(cr)
    cairo.cairo_set_source_rgb(cr, r, g, b)
    cairo.cairo_set_line_width(cr, 2.5)
    cairo.cairo_stroke(cr)
    cairo.cairo_arc(cr, W - 224, 90, 9, 0, 2 * math.pi)
    cairo.cairo_fill(cr)
    draw_text(cr, W - 202, 71, pill_text, "DejaVu Sans Bold 16", pill_color)

    draw_text(cr, W - 360, 132, time.strftime("%H:%M:%S"), "DejaVu Sans Mono Bold 18", "#f1f5f9", width=296, align=2)
    draw_text(cr, W - 360, 174, time.strftime("%d/%m/%Y"), "DejaVu Sans Mono 13", "#94a3b8", width=296, align=2)

    # 2. METRIC GRID ROW 1
    cw = (W - 72 - 24) / 2.0
    x1, x2 = 36, 36 + cw + 24

    draw_card(cr, x1, 256, cw, 280, "CPU & NHIỆT ĐỘ")
    cpu_pct = data["cpu_pct"]
    cpu_c = "#22c55e" if cpu_pct < 65 else ("#f59e0b" if cpu_pct < 85 else "#f43f5e")
    draw_text(cr, x1 + 28, 72 + 256, "%.1f%%" % cpu_pct, "DejaVu Sans Bold 28", "#f8fafc")
    t_c = data["cpu_temp"]
    t_col = "#38bdf8" if t_c < 60 else ("#f59e0b" if t_c < 75 else "#f43f5e")
    draw_text(cr, x1 + cw - 200, 86 + 256, "%.1f°C" % t_c, "DejaVu Sans Bold 20", t_col, width=172, align=2)
    draw_bar(cr, x1 + 28, 152 + 256, cw - 56, 16, cpu_pct, cpu_c)
    draw_text(cr, x1 + 28, 186 + 256, "Load: %s  %s  %s" % tuple(data["loads"]), "DejaVu Sans Mono 13", "#cbd5e1")
    draw_text(cr, x1 + 28, 224 + 256, "Snapdragon 835 • 8 nhân", "DejaVu Sans 12", "#94a3b8")

    draw_card(cr, x2, 256, cw, 280, "BỘ NHỚ RAM & SWAP")
    ram_pct = (100.0 * data["mem_used_mb"] / data["mem_tot_mb"]) if data["mem_tot_mb"] > 0 else 0.0
    ram_c = "#38bdf8" if ram_pct < 75 else ("#f59e0b" if ram_pct < 90 else "#f43f5e")
    draw_text(cr, x2 + 28, 72 + 256, "%.0f%%" % ram_pct, "DejaVu Sans Bold 28", "#f8fafc")
    draw_text(
        cr, x2 + 170, 92 + 256,
        "%d / %d MB" % (data["mem_used_mb"], data["mem_tot_mb"]),
        "DejaVu Sans Mono 13", "#94a3b8", width=cw - 198, align=2
    )
    draw_bar(cr, x2 + 28, 152 + 256, cw - 56, 16, ram_pct, ram_c)
    swap_pct = (100.0 * data["swap_used_mb"] / data["swap_tot_mb"]) if data["swap_tot_mb"] > 0 else 0.0
    draw_text(
        cr, x2 + 28, 186 + 256,
        "ZRAM Swap: %d / %d MB (%.0f%%)" % (data["swap_used_mb"], data["swap_tot_mb"], swap_pct),
        "DejaVu Sans Mono 12", "#cbd5e1"
    )
    draw_text(cr, x2 + 28, 224 + 256, "Khả dụng: %d MB" % (data["mem_tot_mb"] - data["mem_used_mb"]), "DejaVu Sans 12", "#94a3b8")

    # 3. METRIC GRID ROW 2
    bat = data["bat"]
    draw_card(cr, x1, 560, cw, 280, "PIN & NGUỒN ĐIỆN")
    bat_c = "#10b981" if bat["cap"] >= 40 else ("#f59e0b" if bat["cap"] >= 20 else "#f43f5e")
    draw_text(cr, x1 + 28, 72 + 560, "%d%%" % bat["cap"], "DejaVu Sans Bold 28", "#f8fafc")
    mode_lbl = "BYPASS (%d%%)" % bat["lim_max"] if bat["cutoff"] else bat["status"]
    mode_col = "#10b981" if bat["cutoff"] else "#38bdf8"
    draw_text(cr, x1 + 165, 92 + 560, mode_lbl, "DejaVu Sans Bold 13", mode_col, width=cw - 193, align=2)
    draw_bar(cr, x1 + 28, 152 + 560, cw - 56, 16, bat["cap"], bat_c)
    draw_text(
        cr, x1 + 28, 186 + 560,
        "Pin: %.2fV  •  %.0f mA  •  %.1f°C" % (bat["volt"], bat["curr_ma"], bat["temp"]),
        "DejaVu Sans Mono 12", "#cbd5e1"
    )
    draw_text(
        cr, x1 + 28, 224 + 560,
        "USB: %.2fV  •  %d mA / %d mA" % (bat["usb_v"], bat["usb_in_ma"], bat["usb_max_ma"]),
        "DejaVu Sans Mono 12", "#94a3b8"
    )

    ud = data["disks"]["userdata"]
    rt = data["disks"]["root"]
    draw_card(cr, x2, 560, cw, 280, "LƯU TRỮ (/DATA & /)")
    draw_text(cr, x2 + 28, 72 + 560, "%.1f GB" % ud["free_gb"], "DejaVu Sans Bold 24", "#f8fafc")
    draw_text(cr, x2 + 240, 88 + 560, "trống", "DejaVu Sans 14", "#94a3b8", width=cw - 268, align=2)
    draw_bar(cr, x2 + 28, 152 + 560, cw - 56, 16, ud["pct"], "#818cf8")
    draw_text(
        cr, x2 + 28, 186 + 560,
        "/data: %.1f / %.1f GB (%.0f%%)" % (ud["used_gb"], ud["tot_gb"], ud["pct"]),
        "DejaVu Sans Mono 12", "#cbd5e1"
    )
    draw_text(
        cr, x2 + 28, 224 + 560,
        "Root /: %.1f / %.1f GB (%.0f%%)" % (rt["used_gb"], rt["tot_gb"], rt["pct"]),
        "DejaVu Sans Mono 12", "#94a3b8"
    )

    # 4. NETWORK CARD
    net = data["net"]
    draw_card(cr, 36, 864, W - 72, 204, "MẠNG & ĐỊA CHỈ TRUY CẬP")
    draw_text(
        cr, 64, 864 + 72,
        "Wi-Fi: %s (%s)    •    IP LAN: %s" % (net["ssid"], net["iface"], net["ip"]),
        "DejaVu Sans Bold 15", "#f1f5f9"
    )
    draw_text(
        cr, 64, 864 + 114,
        "Lưu lượng trực tiếp:  ↓ %s    ↑ %s" % (fmt_rate(net["rx_bps"]), fmt_rate(net["tx_bps"])),
        "DejaVu Sans Mono 14", "#38bdf8"
    )
    draw_text(
        cr, 64, 864 + 154,
        "Web: https://gaeru.com (:3000)   •   Admin: https://server.gaeru.com (:8080)",
        "DejaVu Sans 13", "#94a3b8"
    )

    # 5. SERVICES CARD
    draw_card(cr, 36, 1092, W - 72, 690, "TRẠNG THÁI DỊCH VỤ SERVER (24/7)")
    rows = [
        ("PostgreSQL 19 (Chroot :5432)", procs["postgres"]["pids"] > 0, "%d proc • %.0f MB" % (procs["postgres"]["pids"], procs["postgres"]["rss_kb"] / 1024.0)),
        ("GAERU Web Cluster (:3000)", procs["node_app"]["pids"] > 0 and http.get("3000") == 200, "HTTP %s • %d proc • %.0f MB" % (http.get("3000", 0), procs["node_app"]["pids"], procs["node_app"]["rss_kb"] / 1024.0)),
        ("Server Dashboard (:8080)", procs["admin"]["pids"] > 0 and http.get("8080") in (200, 302, 401), "HTTP %s • %.0f MB" % (http.get("8080", 0), procs["admin"]["rss_kb"] / 1024.0)),
        ("GAERU GPU AI (:3100)", procs["gpu_ai"]["pids"] > 0, "%d proc • %.0f MB" % (procs["gpu_ai"]["pids"], procs["gpu_ai"]["rss_kb"] / 1024.0)),
        ("Cloudflare Tunnel (Zero Trust)", procs["cloudflared"]["pids"] > 0, "HTTP/2 • %.0f MB" % (procs["cloudflared"]["rss_kb"] / 1024.0)),
        ("Network Watchdog (Auto-Heal)", procs["watchdog"]["pids"] > 0, "Chu kỳ 20s"),
        ("GAERU Health Monitor", procs["health"]["pids"] > 0, "Active"),
        ("Battery Limiter (80% Bypass)", procs["battery"]["pids"] > 0, "Target %d%%" % bat["lim_max"]),
    ]

    ry = 1092 + 78
    for label, up, detail in rows:
        r, g, b = hex_rgb("#1e293b")
        cairo.cairo_set_source_rgb(cr, r, g, b)
        cairo.cairo_set_line_width(cr, 1.5)
        cairo.cairo_move_to(cr, 64, ry + 56)
        cairo.cairo_line_to(cr, W - 64, ry + 56)
        cairo.cairo_stroke(cr)

        dot_c = "#22c55e" if up else "#f43f5e"
        r, g, b = hex_rgb(dot_c)
        cairo.cairo_set_source_rgb(cr, r, g, b)
        cairo.cairo_arc(cr, 78, ry + 26, 9, 0, 2 * math.pi)
        cairo.cairo_fill(cr)

        draw_text(cr, 106, ry + 10, label, "DejaVu Sans Bold 14", "#f1f5f9")
        draw_text(cr, 560, ry + 12, detail, "DejaVu Sans Mono 13", "#94a3b8", width=330, align=2)

        badge = "UP" if up else "DOWN"
        r, g, b = hex_rgb(dot_c)
        cairo.cairo_set_source_rgba(cr, r, g, b, 0.18)
        rounded_rect(cr, W - 154, ry + 6, 90, 38, 12)
        cairo.cairo_fill(cr)
        draw_text(cr, W - 154, ry + 11, badge, "DejaVu Sans Bold 13", dot_c, width=90, align=1)

        ry += 66

    gui_pids = procs["gui"]["pids"]
    gui_color = "#38bdf8" if gui_pids == 0 else "#f59e0b"
    gui_msg = "ĐÃ TẮT TOÀN BỘ (0 tiến trình GUI)" if gui_pids == 0 else "%d GUI proc" % gui_pids
    draw_text(cr, 70, ry + 16, "Giao diện Desktop (Unity8 / LightDM)", "DejaVu Sans Bold 14", "#94a3b8")
    draw_text(cr, 540, ry + 16, gui_msg, "DejaVu Sans Bold 13", gui_color, width=W - 604, align=2)

    # 6. FOOTER BAR
    draw_card(cr, 36, 1806, W - 72, 82)
    draw_text(
        cr, 64, 1830,
        "[Power] Tắt màn hình  •  Tự tắt sau %ds  •  Chế độ tiết kiệm 0%% CPU khi tắt" % max(0, int(remaining_sec)),
        "DejaVu Sans 13", "#94a3b8", width=W - 128, align=1
    )

    cairo.cairo_surface_flush(surf)
    data_ptr = cairo.cairo_image_surface_get_data(surf)
    c_stride = cairo.cairo_image_surface_get_stride(surf)
    raw = bytearray((ctypes.c_ubyte * (c_stride * H)).from_address(data_ptr))
    raw[0::4], raw[2::4] = raw[2::4], raw[0::4]

    cairo.cairo_destroy(cr)
    cairo.cairo_surface_destroy(surf)
    return raw, c_stride


class ScreenDaemon:
    def __init__(self):
        self.metrics = MetricsCollector()
        self.running = True
        self.screen_on = False
        self.usc_proc = None
        self.mir_conn = None
        self.mir_win = None
        self.mir_bs = None
        self.wake_deadline = 0.0
        self.next_render = 0.0
        self.cur_brightness = 0
        self.toggle_req = False
        self.wake_req = False
        self.sleep_req = False

        signal.signal(signal.SIGUSR1, self._on_usr1)
        signal.signal(signal.SIGUSR2, self._on_usr2)
        signal.signal(signal.SIGHUP, self._on_hup)
        signal.signal(signal.SIGTERM, self._on_term)
        signal.signal(signal.SIGINT, self._on_term)

    def _on_usr1(self, *_):
        self.toggle_req = True

    def _on_usr2(self, *_):
        self.wake_req = True

    def _on_hup(self, *_):
        self.sleep_req = True

    def _on_term(self, *_):
        self.running = False

    def _preferred_brightness(self):
        val = read_int(BL_CONF, DEFAULT_BRIGHTNESS)
        if val is None or val < 120:
            return DEFAULT_BRIGHTNESS
        return min(4095, val)

    def _kill_stray_usc(self):
        try:
            subprocess.call(["pkill", "-TERM", "-f", "/usr/sbin/unity-system-compositor"], stderr=subprocess.DEVNULL)
            time.sleep(0.3)
            subprocess.call(["pkill", "-KILL", "-f", "/usr/sbin/unity-system-compositor"], stderr=subprocess.DEVNULL)
        except Exception:
            pass
        for sock in glob.glob("/run/mir_socket*"):
            try:
                os.unlink(sock)
            except Exception:
                pass

    def _release_mir(self):
        if self.mir_win:
            try:
                mir.mir_window_release_sync(self.mir_win)
            except Exception:
                pass
            self.mir_win = None
            self.mir_bs = None
        if self.mir_conn:
            try:
                mir.mir_connection_release(self.mir_conn)
            except Exception:
                pass
            self.mir_conn = None

    def _stop_usc(self):
        if self.usc_proc is not None:
            try:
                self.usc_proc.terminate()
                self.usc_proc.wait(timeout=2.0)
            except Exception:
                try:
                    self.usc_proc.kill()
                    self.usc_proc.wait(timeout=1.0)
                except Exception:
                    pass
            self.usc_proc = None
        for sock in glob.glob("/run/mir_socket*"):
            try:
                os.unlink(sock)
            except Exception:
                pass

    def _start_usc_and_mir(self):
        self._release_mir()
        self._stop_usc()
        self._kill_stray_usc()

        env = os.environ.copy()
        env["LD_LIBRARY_PATH"] = "/vendor/lib64:/system/lib64"
        env["MIR_SERVER_ENABLE_MIRCLIENT"] = "1"
        cmd = [
            "/usr/sbin/unity-system-compositor",
            "--enable-num-framebuffers-quirk=true",
            "--disable-overlays=false",
            "--console-provider=vt",
            "--vt", "1",
            "--enable-input=0",
            "--debug-without-dm",
            "--debug-active-session-name=gaeru-status",
            "--file", MIR_SOCKET,
            "--arw-file",
        ]
        for attempt in range(2):
            logf = open(USC_LOG, "w")
            self.usc_proc = subprocess.Popen(cmd, env=env, stdout=logf, stderr=subprocess.STDOUT)
            logf.close()

            deadline = time.time() + 4.0
            ready = False
            while time.time() < deadline:
                if os.path.exists(MIR_SOCKET):
                    ready = True
                    break
                if self.usc_proc.poll() is not None:
                    break
                time.sleep(0.08)

            if ready:
                break
            log("USC failed on attempt %d, restarting vendor.hwcomposer-2-1" % (attempt + 1))
            self._stop_usc()
            subprocess.call(["lxc-attach", "-n", "android", "--", "/system/bin/setprop", "ctl.restart", "vendor.hwcomposer-2-1"], stderr=subprocess.DEVNULL)
            time.sleep(0.6)

        if not os.path.exists(MIR_SOCKET):
            log("Failed to start USC socket")
            return False

        conn = mir.mir_connect_sync(MIR_SOCKET.encode("ascii"), b"gaeru-status")
        if not conn or not mir.mir_connection_is_valid(conn):
            log("mir_connect_sync failed")
            return False

        spec = mir.mir_create_normal_window_spec(conn, W, H)
        mir.mir_window_spec_set_name(spec, b"gaeru-status")
        mir.mir_window_spec_set_pixel_format(spec, 1)
        mir.mir_window_spec_set_buffer_usage(spec, 2)
        mir.mir_window_spec_set_fullscreen_on_output(spec, 1)
        win = mir.mir_create_window_sync(spec)
        mir.mir_window_spec_release(spec)
        if not win or not mir.mir_window_is_valid(win):
            log("mir_create_window_sync failed")
            mir.mir_connection_release(conn)
            return False

        bs = mir.mir_window_get_buffer_stream(win)
        self.mir_conn = conn
        self.mir_win = win
        self.mir_bs = bs
        return True

    def _blit_frame(self, raw, c_stride):
        if not self.mir_bs:
            return False
        reg = MirGraphicsRegion()
        if not mir.mir_buffer_stream_get_graphics_region(self.mir_bs, ctypes.byref(reg)):
            return False
        if not reg.vaddr:
            return False
        if c_stride == reg.stride:
            ctypes.memmove(reg.vaddr, (ctypes.c_char * len(raw)).from_buffer(raw), len(raw))
        else:
            row_bytes = min(c_stride, reg.stride)
            c_buf = (ctypes.c_char * len(raw)).from_buffer(raw)
            ptr = ctypes.addressof(c_buf)
            for y in range(min(H, reg.height)):
                ctypes.memmove(reg.vaddr + y * reg.stride, ptr + y * c_stride, row_bytes)
        mir.mir_buffer_stream_swap_buffers_sync(self.mir_bs)
        return True

    def wake_screen(self, target_bl=None, timeout_s=AUTO_OFF_POWER_SEC):
        if self.screen_on:
            self.wake_deadline = time.time() + timeout_s
            return
        log("Waking server status screen (timeout=%.0fs)" % timeout_s)
        bl = target_bl if (target_bl is not None and target_bl > 0) else self._preferred_brightness()
        ensure_wled_bkl_trigger()
        fb_blank(FB_BLANK_UNBLANK)
        self.metrics.cpu_pct()
        self.metrics.net_stats()
        if not self._start_usc_and_mir():
            self.sleep_screen()
            return

        self.screen_on = True
        self.wake_deadline = time.time() + timeout_s
        data = self.metrics.collect()
        raw, c_stride = render_dashboard(data, timeout_s)
        self._blit_frame(raw, c_stride)
        write_brightness(bl)
        self.cur_brightness = bl
        self.next_render = time.time() + REFRESH_INTERVAL_SEC
        self._write_status("ON")

    def sleep_screen(self):
        was_on = self.screen_on
        self.screen_on = False
        self.cur_brightness = 0
        write_brightness(0)
        self._release_mir()
        self._stop_usc()
        if read_str("/sys/class/graphics/fb0/msm_fb_panel_status", "") != "panel_status=suspend":
            fb_blank(FB_BLANK_POWERDOWN)
        force_wled_off()
        self._write_status("OFF")
        if was_on:
            log("Screen turned OFF (0% GUI/display CPU)")

    def _clear_boot_splash(self):
        if not mdp_handoff_active() and not wled_is_enabled():
            return False
        log("Clearing bootloader Mi logo splash (handoff=%s wled_on=%s)" % (
            mdp_handoff_active(), wled_is_enabled()
        ))
        force_wled_off()
        fb_blank(FB_BLANK_UNBLANK)
        if self._start_usc_and_mir():
            black_raw = bytearray(b"\x00\x00\x00\xff" * (W * H))
            self._blit_frame(black_raw, W * 4)
            time.sleep(0.05)
            self._blit_frame(black_raw, W * 4)
            time.sleep(0.05)
        self.sleep_screen()
        log("Boot splash cleared (handoff=%s wled_on=%s)" % (
            mdp_handoff_active(), wled_is_enabled()
        ))
        return True

    def _write_status(self, state):
        try:
            with open(STATUS_FILE, "w") as f:
                f.write("%s %s\n" % (state, time.strftime("%Y-%m-%dT%H:%M:%S")))
        except Exception:
            pass

    def _open_inputs(self):
        fds = {}
        for path in ("/dev/input/event0", "/dev/input/event1", "/dev/input/event2", "/dev/input/event3"):
            if os.path.exists(path):
                try:
                    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                    fds[fd] = path
                except Exception as e:
                    log("open %s failed: %s" % (path, e))
        return fds

    def run(self):
        try:
            self.lock_fd = os.open("/run/gaeru-screen.lock", os.O_CREAT | os.O_RDWR, 0o644)
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError):
            log("Another gaeru-screen daemon is already running. Exiting.")
            sys.exit(0)
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))

        log("gaeru-screen daemon started (PID %d)" % os.getpid())
        fds = self._open_inputs()
        # Wake the status dashboard for 30s on startup so boot transitions directly
        # from the Mi logo to the live GAERU Server Dashboard before entering headless sleep
        try:
            self.wake_screen(timeout_s=AUTO_OFF_POWER_SEC)
        except Exception as e:
            log("Initial boot wake failed (%s), falling back to sleep_screen" % e)
            self.sleep_screen()

        try:
            while self.running:
                if self.toggle_req:
                    self.toggle_req = False
                    if self.screen_on:
                        self.sleep_screen()
                    else:
                        self.wake_screen(timeout_s=AUTO_OFF_POWER_SEC)
                if self.wake_req:
                    self.wake_req = False
                    self.wake_screen(timeout_s=AUTO_OFF_POWER_SEC)
                if self.sleep_req:
                    self.sleep_req = False
                    self.sleep_screen()

                timeout = 0.25 if self.screen_on else 1.0
                rlist, _, _ = select.select(list(fds.keys()), [], [], timeout)
                now = time.time()

                power_pressed = False
                activity = False
                for fd in rlist:
                    path = fds[fd]
                    while True:
                        try:
                            chunk = os.read(fd, INPUT_EVENT_SIZE * 16)
                        except BlockingIOError:
                            break
                        except Exception:
                            break
                        if not chunk:
                            break
                        for off in range(0, len(chunk) - (len(chunk) % INPUT_EVENT_SIZE), INPUT_EVENT_SIZE):
                            _, _, etype, code, val = struct.unpack_from(INPUT_EVENT_FMT, chunk, off)
                            if etype == EV_KEY and val == 1:
                                if code == KEY_POWER:
                                    power_pressed = True
                                elif code in (KEY_VOLUMEUP, KEY_VOLUMEDOWN, KEY_HOME):
                                    activity = True
                            elif path == "/dev/input/event1" and etype == EV_ABS:
                                activity = True

                if power_pressed:
                    if self.screen_on:
                        self.sleep_screen()
                    else:
                        self.wake_screen(timeout_s=AUTO_OFF_POWER_SEC)
                    continue

                if activity and self.screen_on:
                    self.wake_deadline = now + AUTO_OFF_POWER_SEC

                sys_bl = read_int(BL_PATH, 0)
                if not self.screen_on:
                    if sys_bl is not None and sys_bl > 0 and sys_bl != self.cur_brightness:
                        self.wake_screen(target_bl=sys_bl, timeout_s=AUTO_OFF_ADMIN_SEC)
                        continue
                else:
                    if sys_bl == 0:
                        self.sleep_screen()
                        continue
                    elif sys_bl is not None and sys_bl > 0 and sys_bl != self.cur_brightness:
                        self.cur_brightness = sys_bl
                        self.wake_deadline = now + AUTO_OFF_ADMIN_SEC

                    if now >= self.wake_deadline:
                        self.sleep_screen()
                        continue

                    if now >= self.next_render:
                        rem = max(0.0, self.wake_deadline - now)
                        data = self.metrics.collect()
                        raw, c_stride = render_dashboard(data, rem)
                        if not self._blit_frame(raw, c_stride):
                            log("blit failed, restarting USC/Mir")
                            self.screen_on = False
                            self.wake_screen(target_bl=self.cur_brightness, timeout_s=rem)
                        else:
                            self.next_render = time.time() + REFRESH_INTERVAL_SEC
        finally:
            for fd in fds:
                try:
                    os.close(fd)
                except Exception:
                    pass
            self.sleep_screen()
            try:
                os.unlink(PID_FILE)
            except Exception:
                pass
            log("gaeru-screen daemon stopped")


def _get_daemon_pid():
    try:
        with open(PID_FILE, "r") as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return pid
    except Exception:
        return None

if __name__ == "__main__":
    if len(sys.argv) >= 2:
        cmd = sys.argv[1]
        if cmd == "--status":
            try:
                with open(STATUS_FILE, "r") as f:
                    print(f.read().strip())
            except Exception:
                print("OFF")
            sys.exit(0)
        elif cmd == "--wake":
            pid = _get_daemon_pid()
            if pid:
                os.kill(pid, signal.SIGUSR2)
                print("Wake signal sent to PID", pid)
            else:
                print("Daemon not running")
            sys.exit(0)
        elif cmd == "--sleep":
            pid = _get_daemon_pid()
            if pid:
                os.kill(pid, signal.SIGHUP)
                print("Sleep signal sent to PID", pid)
            else:
                print("Daemon not running")
            sys.exit(0)
        elif cmd == "--toggle":
            pid = _get_daemon_pid()
            if pid:
                os.kill(pid, signal.SIGUSR1)
                print("Toggle signal sent to PID", pid)
            else:
                print("Daemon not running")
            sys.exit(0)
        elif cmd == "--render-once":
            mc = MetricsCollector()
            mc.cpu_pct()
            mc.net_stats()
            time.sleep(0.35)
            d = mc.collect()
            raw, c_stride = render_dashboard(d, 28)
            out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/gaeru_preview.rgba"
            trimmed = bytearray(W * H * 4)
            for y in range(H):
                trimmed[y * W * 4:(y + 1) * W * 4] = raw[y * c_stride:y * c_stride + W * 4]
            with open(out, "wb") as f:
                f.write(trimmed)
            print("WROTE", out, len(trimmed))
            sys.exit(0)

    ScreenDaemon().run()
