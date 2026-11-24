#!/usr/bin/env python3
"""
Advanced Battery Bypass & Charge Limiter for Xiaomi Mi 6 (Snapdragon 835 / PMI8998)
Author: Antigravity Assistant

Mechanism:
1. Always keeps input_suspend = 0 when USB is plugged in, so external USB DC
   powers the SoC (Snapdragon 835), RAM, UFS storage, and Wi-Fi directly.
2. When battery reaches 80% (or configured TARGET_MAX):
   - Sets /sys/class/power_supply/battery/system_temp_level to 7.
   - PMIC immediately stops battery charging (Status: 'Not charging', Battery Current: ~0 mA).
   - Server runs 100% on external power without touching battery capacity.
3. When battery drops below 75% (or configured TARGET_MIN):
   - Sets system_temp_level to 0.
   - Resumes normal charging from external power back up to 80%.
4. Clamps /sys/class/power_supply/bms/constant_charge_voltage to 4.08V (4080000 uV)
   as a hardware-level safety ceiling.
5. When unplugged:
   - Resets system_temp_level to 0 for normal battery operation.
"""

import time
import os
import json
import sys

# Paths
NODE_SUSPEND     = '/sys/class/power_supply/battery/input_suspend'
NODE_TEMP_LEVEL  = '/sys/class/power_supply/battery/system_temp_level'
NODE_BATT_STATUS = '/sys/class/power_supply/battery/status'
NODE_BATT_CURR   = '/sys/class/power_supply/battery/current_now'
NODE_BATT_VOLT   = '/sys/class/power_supply/battery/voltage_now'
NODE_BATT_TEMP   = '/sys/class/power_supply/battery/temp'

NODE_BMS_CAP     = '/sys/class/power_supply/bms/capacity'
NODE_BMS_FLOAT_V = '/sys/class/power_supply/bms/constant_charge_voltage'

NODE_USB_ONLINE  = '/sys/class/power_supply/usb/online'
NODE_USB_CURR    = '/sys/class/power_supply/usb/input_current_now'
NODE_USB_VOLT    = '/sys/class/power_supply/usb/voltage_now'

CONFIG_FILE = '/etc/battery_limiter.conf'
STATE_FILE  = '/run/battery_limiter.json'
LOG_FILE    = '/var/log/battery_limiter.log'

DEFAULT_TARGET_MAX = 80
DEFAULT_TARGET_MIN = 75
FLOAT_VOLT_CLAMP   = 4080000  # 4.08V
CHECK_INTERVAL     = 5        # seconds

def log(msg):
    ts = time.strftime('%Y-%m-%d %H:%M:%S')
    line = "[{}] {}\n".format(ts, msg)
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line)
    except Exception:
        pass
    if sys.stdout.isatty():
        try:
            sys.stdout.write(line)
            sys.stdout.flush()
        except Exception:
            pass

def rd(path, default=None):
    try:
        with open(path, 'r') as f:
            return f.read().strip()
    except Exception:
        return default

def wr(path, val):
    try:
        with open(path, 'w') as f:
            f.write(str(val))
        return True
    except Exception as e:
        log("Error writing {} to {}: {}".format(val, path, e))
        return False

def load_config():
    target_max = DEFAULT_TARGET_MAX
    target_min = DEFAULT_TARGET_MIN
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    k = k.strip().upper()
                    v = int(v.strip())
                    if k in ('TARGET_MAX', 'MAX_CAPACITY', 'LIMIT'):
                        target_max = max(50, min(100, v))
                    elif k in ('TARGET_MIN', 'MIN_CAPACITY', 'RESUME'):
                        target_min = max(40, min(95, v))
    except Exception as e:
        log("Config parse error: {}".format(e))
    if target_min >= target_max:
        target_min = max(40, target_max - 5)
    return target_max, target_min

def get_live_metrics():
    # Use real BMS fuel gauge for capacity
    cap_str = rd(NODE_BMS_CAP)
    if not cap_str:
        cap_str = rd('/sys/class/power_supply/battery/capacity', '0')
    cap = int(cap_str or 0)

    # Battery current in mA: negative = charging, positive = discharging
    raw_b_curr = int(rd(NODE_BATT_CURR, '0') or 0)
    batt_ma = -raw_b_curr // 1000

    raw_b_volt = int(rd(NODE_BATT_VOLT, '0') or 0)
    batt_v = round(raw_b_volt / 1e6, 3)

    raw_temp = int(rd(NODE_BATT_TEMP, '0') or 0)
    batt_temp = round(raw_temp / 10.0, 1)

    status = rd(NODE_BATT_STATUS, 'Unknown')
    temp_lvl = int(rd(NODE_TEMP_LEVEL, '0') or 0)
    input_suspended = rd(NODE_SUSPEND, '0') == '1'

    # USB metrics
    raw_u_volt = int(rd(NODE_USB_VOLT, '0') or 0)
    usb_v = round(raw_u_volt / 1e6, 2)

    raw_u_curr = int(rd(NODE_USB_CURR, '0') or 0)
    usb_ma = raw_u_curr // 1000

    usb_online = rd(NODE_USB_ONLINE, '0') == '1'
    is_plugged = usb_online or usb_v >= 4.0 or usb_ma > 30

    return {
        'capacity': cap,
        'batt_ma': batt_ma,
        'batt_v': batt_v,
        'batt_temp': batt_temp,
        'status': status,
        'temp_level': temp_lvl,
        'input_suspended': input_suspended,
        'usb_v': usb_v,
        'usb_ma': usb_ma,
        'is_plugged': is_plugged,
    }

def main():
    log("=== Battery Bypass & Limiter Daemon Started (Snapdragon 835 / PMI8998) ===")

    # Ensure external input is not suspended
    wr(NODE_SUSPEND, '0')

    # Clamp float voltage to 4.08V ceiling
    wr(NODE_BMS_FLOAT_V, FLOAT_VOLT_CLAMP)

    last_mode = None
    is_bypass_active = False
    low_volt_streak = 0
    last_switch_ts = 0.0
    MIN_DWELL_SEC = 90.0

    while True:
        target_max, target_min = load_config()
        m = get_live_metrics()

        cap = m['capacity']
        is_plugged = m['is_plugged']

        if is_plugged:
            # SAFETY: Always ensure USB input is connected to power the phone directly
            if m['input_suspended']:
                wr(NODE_SUSPEND, '0')
                log("Re-enabled USB input (input_suspend=0) for external DC power")

            # SDP Anti-Suspend Watchdog: if plugged into a PC USB port (REAL_TYPE=USB, VBUS >= 4.4V)
            # and the PC host puts the USB bus into 2mA Suspend (sdp_current_max <= 2000, current_max == 0),
            # re-enumerate the ConfigFS USB gadget (with MSFT100 RNDIS descriptors) to wake the port back to 500mA.
            sdp_max = int(rd('/sys/class/power_supply/usb/sdp_current_max', '-22') or -22)
            cur_max = int(rd('/sys/class/power_supply/usb/current_max', '500000') or 0)
            real_type = rd('/sys/class/power_supply/usb/real_type', '')
            now_ts = time.time()
            if real_type == 'USB' and m['usb_v'] >= 4.4 and (0 <= sdp_max <= 2500 or cur_max == 0):
                if now_ts - getattr(main, '_last_sdp_wake', 0) >= 20:
                    main._last_sdp_wake = now_ts
                    log("SDP USB Suspend detected (sdp_current_max={}uA, current_max={}uA, V={}V). Waking USB gadget...".format(sdp_max, cur_max, m['usb_v']))
                    wr('/sys/kernel/config/usb_gadget/g1/os_desc/use', '1')
                    wr('/sys/kernel/config/usb_gadget/g1/os_desc/b_vendor_code', '0x1')
                    wr('/sys/kernel/config/usb_gadget/g1/os_desc/qw_sign', 'MSFT100')
                    wr('/sys/kernel/config/usb_gadget/g1/functions/rndis.usb0/os_desc/interface.rndis/compatible_id', 'RNDIS')
                    wr('/sys/kernel/config/usb_gadget/g1/functions/rndis.usb0/os_desc/interface.rndis/sub_compatible_id', '5162001')
                    wr('/sys/kernel/config/usb_gadget/g1/UDC', '')
                    time.sleep(0.3)
                    wr('/sys/kernel/config/usb_gadget/g1/UDC', 'a800000.dwc3')
                    wr(NODE_SUSPEND, '0')

            # Maintain float voltage clamp
            cur_float = int(rd(NODE_BMS_FLOAT_V, '0') or 0)
            if cur_float > FLOAT_VOLT_CLAMP:
                wr(NODE_BMS_FLOAT_V, FLOAT_VOLT_CLAMP)

            raw_ocv = int(rd('/sys/class/power_supply/bms/voltage_ocv', '3900000') or 3900000)
            ocv_v = round(raw_ocv / 1e6, 3)

            # Debounce transient CPU/GPU load voltage dips (< 3.68V) when resting OCV & capacity are healthy,
            # while still resuming immediately on severe sag (< 3.45V), low OCV (< 3.78V), or low SOC (< target_min).
            if 3.45 <= m['batt_v'] < 3.68 and cap >= target_min and ocv_v >= 3.78:
                low_volt_streak += 1
            else:
                low_volt_streak = 0

            need_resume = (
                cap < target_min
                or ocv_v < 3.78
                or m['batt_v'] < 3.45
                or low_volt_streak >= 3
            )
            dwell_ok = (last_switch_ts == 0.0) or ((now_ts - last_switch_ts) >= MIN_DWELL_SEC) or (cap >= target_max + 2)

            if need_resume:
                if m['temp_level'] != 0:
                    wr(NODE_TEMP_LEVEL, '0')
                    last_switch_ts = now_ts
                    log("RESUME CHARGE: Cap={}% (min={}%), Batt={}V, OCV={}V, streak={}. Re-enabling charge (level=0).".format(
                        cap, target_min, m['batt_v'], ocv_v, low_volt_streak
                    ))
                elif is_bypass_active:
                    last_switch_ts = now_ts
                is_bypass_active = False
                low_volt_streak = 0
                mode = "CHARGING_FROM_EXTERNAL"

            elif cap >= target_max and ocv_v >= 3.88 and m['batt_v'] >= 3.80 and (is_bypass_active or dwell_ok):
                if m['temp_level'] != 7:
                    wr(NODE_TEMP_LEVEL, '7')
                    last_switch_ts = now_ts
                    log("TARGET REACHED: Battery at {}% (>= {}%, OCV={}V). CUT OFF charging (level=7). Phone running 100% on external power.".format(cap, target_max, ocv_v))
                elif not is_bypass_active:
                    last_switch_ts = now_ts
                is_bypass_active = True
                mode = "DIRECT_EXTERNAL_POWER_BYPASS"

            else:
                if is_bypass_active and ocv_v >= 3.84 and m['batt_v'] >= 3.72:
                    if m['temp_level'] != 7:
                        wr(NODE_TEMP_LEVEL, '7')
                    mode = "DIRECT_EXTERNAL_POWER_BYPASS"
                else:
                    if is_bypass_active:
                        last_switch_ts = now_ts
                    is_bypass_active = False
                    if m['temp_level'] != 0:
                        wr(NODE_TEMP_LEVEL, '0')
                    mode = "CHARGING_FROM_EXTERNAL"

        else:
            # Unplugged -> normal battery operation
            if m['temp_level'] != 0:
                wr(NODE_TEMP_LEVEL, '0')
            if m['input_suspended']:
                wr(NODE_SUSPEND, '0')
            is_bypass_active = False
            low_volt_streak = 0
            mode = "RUNNING_ON_BATTERY"

        if mode != last_mode:
            log("Mode changed to: {} | Cap: {}% | Batt: {}V, {}mA | USB: {}V, {}mA".format(
                mode, cap, m['batt_v'], m['batt_ma'], m['usb_v'], m['usb_ma']
            ))
            last_mode = mode

        # Publish unified status for Admin Panel (port 8080) and Web App (port 80)
        state_data = {
            'target_max': target_max,
            'target_min': target_min,
            'is_suspended': m['input_suspended'],
            'bypass_active': is_bypass_active and is_plugged,
            'charge_cut_off': is_bypass_active and is_plugged,
            'limiter_mode': mode,
            'mode': mode,
            'battery': {
                'capacity': cap,
                'status': m['status'],
                'temperature': m['batt_temp'],
                'current_ma': m['batt_ma'],
                'voltage_v': m['batt_v'],
                'is_suspended': m['input_suspended'],
            },
            'usb': {
                'plugged': is_plugged,
                'voltage_v': m['usb_v'],
                'input_current_ma': m['usb_ma'],
            },
            'float_voltage_v': round(FLOAT_VOLT_CLAMP / 1e6, 2),
            'last_update': time.strftime('%Y-%m-%d %H:%M:%S'),
        }

        try:
            tmp_file = STATE_FILE + '.tmp'
            with open(tmp_file, 'w', encoding='utf-8') as f:
                json.dump(state_data, f, indent=2)
            os.replace(tmp_file, STATE_FILE)
        except Exception:
            pass

        time.sleep(CHECK_INTERVAL)

if __name__ == '__main__':
    main()
