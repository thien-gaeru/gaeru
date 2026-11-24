#!/bin/sh
# GAERU Mi 6 24/7 Web Server Hardware Tuning
# Profile: Smart Turbo Passive-Cooled High Performance (No External Cooler Required)
# Architecture: Race-to-Idle (Low Idle Floors + Instant Knee Hispeed + Full 2.46GHz Burst + 3-Stage Passive Thermal Guard)

MODE="${1:---boot}"

# 0. Ensure physical input keys (Power button) are never disabled (boot mode only)
if [ "$MODE" != "--thermal" ]; then
  for _inp in /sys/class/input/input*/enabled; do
    [ -w "$_inp" ] && [ "$(cat "$_inp" 2>/dev/null)" = "0" ] && echo 1 > "$_inp" 2>/dev/null || true
  done
fi

# 1. Keep BCL (Battery Current Limiting) enabled for 24/7 brownout safety & hold 24/7 wake lock
[ -w /sys/devices/soc/soc:qcom,bcl/mode ] && echo enabled > /sys/devices/soc/soc:qcom,bcl/mode 2>/dev/null || true
if [ -w /sys/power/wake_lock ]; then
  grep -qw server_24x7 /sys/power/wake_lock 2>/dev/null || echo server_24x7 > /sys/power/wake_lock 2>/dev/null || true
fi

# 1b. Read uptime, thermal & power telemetry (pure shell reads, zero awk subprocess)
read -r uptime_raw _ < /proc/uptime 2>/dev/null || uptime_raw="120"
uptime_sec="${uptime_raw%%.*}"
case "$uptime_sec" in ''|*[!0-9]*) uptime_sec=120 ;; esac
max_tsens=0
for z in /sys/class/thermal/thermal_zone*; do
  [ -r "$z/type" ] || continue
  read -r ztype < "$z/type" 2>/dev/null || ztype=""
  case "$ztype" in
    tsens_tz_sensor*)
      read -r t < "$z/temp" 2>/dev/null || t=""
      [ -n "$t" ] && [ "$t" -gt "$max_tsens" ] 2>/dev/null && max_tsens="$t"
      ;;
  esac
done
read -r batt_temp < /sys/class/power_supply/battery/temp 2>/dev/null || batt_temp=300
read -r batt_cap < /sys/class/power_supply/battery/capacity 2>/dev/null || batt_cap=100
read -r batt_volt < /sys/class/power_supply/battery/voltage_now 2>/dev/null || batt_volt=3900000

# Soft-Start during first 45s of boot if battery voltage is low (< 3.75V)
BOOT_SOFT=0
if [ "${uptime_sec:-120}" -lt 45 ] 2>/dev/null && [ "${batt_volt:-3900000}" -lt 3750000 ] 2>/dev/null; then
  BOOT_SOFT=1
fi

# 3-Stage Passive Thermal Guard (designed for 24/7 operation WITHOUT external cooler):
# - Stage 0 (Normal: SoC < 52C & Batt < 39C): Full 1.90GHz / 2.46GHz Turbo, 518/576MHz low-power idle floor
# - Stage 1 (Warm:   SoC 52-58C or Batt 39-42C): Cap Big cluster at sweet-spot 2.21GHz (-30% heat, ~95% perf), 300MHz floor
# - Stage 2 (Hot:    SoC >= 58C or Batt >= 42C): Cap Big at 1.90GHz & Little at 1.75GHz until cooled below 52C
if [ "$BOOT_SOFT" = "1" ]; then
  P0_MAX=1401600
  P0_MIN=300000
  P0_HI=1401600
  P4_MAX=1420800
  P4_MIN=300000
  P4_HI=1420800
  CPUBW_MIN=1525
  CPUBW_IDLE=1200
elif [ "$max_tsens" -ge 580 ] 2>/dev/null || [ "${batt_temp:-300}" -ge 420 ] 2>/dev/null; then
  P0_MAX=1747200
  P0_MIN=300000
  P0_HI=1401600
  P4_MAX=1900800
  P4_MIN=300000
  P4_HI=1804800
  CPUBW_MIN=1525
  CPUBW_IDLE=1200
elif [ "$max_tsens" -ge 520 ] 2>/dev/null || [ "${batt_temp:-300}" -ge 390 ] 2>/dev/null || [ "${batt_cap:-100}" -lt 50 ] 2>/dev/null; then
  P0_MAX=1900800
  P0_MIN=300000
  P0_HI=1747200
  P4_MAX=2208000
  P4_MIN=300000
  P4_HI=1958400
  CPUBW_MIN=1525
  CPUBW_IDLE=1600
else
  P0_MAX=1900800
  P0_MIN=518400
  P0_HI=1747200
  P4_MAX=2457600
  P4_MIN=576000
  P4_HI=2208000
  CPUBW_MIN=2288
  CPUBW_IDLE=1600
fi

# 1c. Set msm_performance ceiling matching current thermal stage
if [ -w /sys/module/msm_performance/parameters/cpu_max_freq ]; then
  echo "0:$P0_MAX 1:$P0_MAX 2:$P0_MAX 3:$P0_MAX 4:$P4_MAX 5:$P4_MAX 6:$P4_MAX 7:$P4_MAX" > /sys/module/msm_performance/parameters/cpu_max_freq 2>/dev/null || true
fi

# 2. Keep all 8 Kryo 280 cores online (0ms hotplug delay; idle cores enter deep C-states at 518/576MHz)
if [ "${batt_volt:-3900000}" -ge 3550000 ] 2>/dev/null; then
  OCF="/sys/module/msm_thermal/core_control/cpus_offlined"
  if [ -w "$OCF" ] && [ "$(cat "$OCF" 2>/dev/null)" != "0" ]; then
    if [ "$max_tsens" -lt 680 ] 2>/dev/null && [ "${batt_temp:-300}" -lt 460 ] 2>/dev/null; then
      echo 0 > "$OCF" 2>/dev/null || true
    fi
  fi

  CC0="/sys/devices/system/cpu/cpu0/core_ctl"
  if [ -d "$CC0" ]; then
    echo 4 > "$CC0/max_cpus" 2>/dev/null || true
    echo 4 > "$CC0/min_cpus" 2>/dev/null || true
  fi
  CC="/sys/devices/system/cpu/cpu4/core_ctl"
  if [ -d "$CC" ]; then
    echo "25 25 25 25" > "$CC/busy_up_thres" 2>/dev/null || true
    echo "12 12 12 12" > "$CC/busy_down_thres" 2>/dev/null || true
    echo 2 > "$CC/task_thres" 2>/dev/null || true
    echo 2000 > "$CC/offline_delay_ms" 2>/dev/null || true
    echo 4 > "$CC/max_cpus" 2>/dev/null || true
    echo 4 > "$CC/min_cpus" 2>/dev/null || true
  fi

  for _c in /sys/devices/system/cpu/cpu[1-7]/online; do
    [ -w "$_c" ] && [ "$(cat "$_c" 2>/dev/null)" = "0" ] && echo 1 > "$_c" 2>/dev/null || true
  done
fi

# 3. Interactive CPU Governor - Race-to-Idle Smart Turbo
P0="/sys/devices/system/cpu/cpufreq/policy0"
if [ -d "$P0" ]; then
  echo "$P0_MAX" > "$P0/scaling_max_freq" 2>/dev/null || true
  echo "$P0_MIN" > "$P0/scaling_min_freq" 2>/dev/null || true
  if [ "$MODE" = "--thermal" ]; then
    [ -w "$P0/interactive/hispeed_freq" ] && echo "$P0_HI" > "$P0/interactive/hispeed_freq" 2>/dev/null || true
  else
    echo interactive > "$P0/scaling_governor" 2>/dev/null || true
    if [ -d "$P0/interactive" ]; then
      echo "$P0_HI" > "$P0/interactive/hispeed_freq" 2>/dev/null || true
      echo 45 > "$P0/interactive/go_hispeed_load" 2>/dev/null || true
      echo "10000 1747200:20000" > "$P0/interactive/above_hispeed_delay" 2>/dev/null || true
      echo "50 1401600:60 1747200:75" > "$P0/interactive/target_loads" 2>/dev/null || true
      echo 40000 > "$P0/interactive/min_sample_time" 2>/dev/null || true
      echo 40000 > "$P0/interactive/max_freq_hysteresis" 2>/dev/null || true
      echo 10000 > "$P0/interactive/timer_rate" 2>/dev/null || true
      echo 40000 > "$P0/interactive/timer_slack" 2>/dev/null || true
      echo 1 > "$P0/interactive/io_is_busy" 2>/dev/null || true
    fi
  fi
fi

P4="/sys/devices/system/cpu/cpufreq/policy4"
if [ -d "$P4" ]; then
  echo "$P4_MAX" > "$P4/scaling_max_freq" 2>/dev/null || true
  echo "$P4_MIN" > "$P4/scaling_min_freq" 2>/dev/null || true
  if [ "$MODE" = "--thermal" ]; then
    [ -w "$P4/interactive/hispeed_freq" ] && echo "$P4_HI" > "$P4/interactive/hispeed_freq" 2>/dev/null || true
  else
    echo interactive > "$P4/scaling_governor" 2>/dev/null || true
    if [ -d "$P4/interactive" ]; then
      echo "$P4_HI" > "$P4/interactive/hispeed_freq" 2>/dev/null || true
      echo 45 > "$P4/interactive/go_hispeed_load" 2>/dev/null || true
      echo "10000 2208000:25000" > "$P4/interactive/above_hispeed_delay" 2>/dev/null || true
      echo "45 1804800:60 2208000:75 2361600:85" > "$P4/interactive/target_loads" 2>/dev/null || true
      echo 40000 > "$P4/interactive/min_sample_time" 2>/dev/null || true
      echo 40000 > "$P4/interactive/max_freq_hysteresis" 2>/dev/null || true
      echo 10000 > "$P4/interactive/timer_rate" 2>/dev/null || true
      echo 40000 > "$P4/interactive/timer_slack" 2>/dev/null || true
      echo 1 > "$P4/interactive/io_is_busy" 2>/dev/null || true
    fi
  fi
fi

if [ "$MODE" = "--thermal" ]; then
  CPUBW="/sys/class/devfreq/soc:qcom,cpubw"
  if [ -d "$CPUBW" ]; then
    echo "$CPUBW_MIN" > "$CPUBW/min_freq" 2>/dev/null || true
    [ -w "$CPUBW/bw_hwmon/idle_mbps" ] && echo "$CPUBW_IDLE" > "$CPUBW/bw_hwmon/idle_mbps" 2>/dev/null || true
  fi
  exit 0
fi

# 4. GPU (Adreno 540 - kgsl-3d0): 257MHz idle default, 710MHz max burst, hardware clock gating ON
KGSL="/sys/class/kgsl/kgsl-3d0"
if [ -d "$KGSL" ]; then
  echo 0 > "$KGSL/max_pwrlevel" 2>/dev/null || true
  echo 6 > "$KGSL/min_pwrlevel" 2>/dev/null || true
  echo 6 > "$KGSL/default_pwrlevel" 2>/dev/null || true
  echo 710000000 > "$KGSL/max_gpuclk" 2>/dev/null || true
  echo 1 > "$KGSL/pwrscale" 2>/dev/null || true
  echo 1 > "$KGSL/preemption" 2>/dev/null || true
  echo 1 > "$KGSL/hwcg" 2>/dev/null || true
  echo 1 > "$KGSL/bus_split" 2>/dev/null || true
  echo 0 > "$KGSL/force_no_nap" 2>/dev/null || true
  echo 60 > "$KGSL/idle_timer" 2>/dev/null || true
fi
KGSL_DF="/sys/class/devfreq/5000000.qcom,kgsl-3d0"
if [ -d "$KGSL_DF" ]; then
  echo msm-adreno-tz > "$KGSL_DF/governor" 2>/dev/null || true
  echo 710000000 > "$KGSL_DF/max_freq" 2>/dev/null || true
  echo 10 > "$KGSL_DF/polling_interval" 2>/dev/null || true
fi

# 5. Memory Bus (cpubw) & L3 Cache Latency: Cool idle floor (2288) + 4ms fast scale-up to 13763
CPUBW="/sys/class/devfreq/soc:qcom,cpubw"
if [ -d "$CPUBW" ]; then
  echo 10 > "$CPUBW/polling_interval" 2>/dev/null || true
  echo "$CPUBW_MIN" > "$CPUBW/min_freq" 2>/dev/null || true
  if [ -d "$CPUBW/bw_hwmon" ]; then
    echo 4 > "$CPUBW/bw_hwmon/sample_ms" 2>/dev/null || true
    echo 16 > "$CPUBW/bw_hwmon/io_percent" 2>/dev/null || true
    echo 150 > "$CPUBW/bw_hwmon/guard_band_mbps" 2>/dev/null || true
    echo 6 > "$CPUBW/bw_hwmon/up_thres" 2>/dev/null || true
    echo 80 > "$CPUBW/bw_hwmon/decay_rate" 2>/dev/null || true
    echo 4 > "$CPUBW/bw_hwmon/down_count" 2>/dev/null || true
    echo "$CPUBW_IDLE" > "$CPUBW/bw_hwmon/idle_mbps" 2>/dev/null || true
  fi
fi
MINCPUBW="/sys/class/devfreq/soc:qcom,mincpubw"
if [ -d "$MINCPUBW" ]; then
  echo 10 > "$MINCPUBW/polling_interval" 2>/dev/null || true
fi
for ml in /sys/class/devfreq/soc:qcom,memlat-cpu0 /sys/class/devfreq/soc:qcom,memlat-cpu4; do
  if [ -d "$ml" ]; then
    echo 10 > "$ml/polling_interval" 2>/dev/null || true
    [ -w "$ml/mem_latency/ratio_ceil" ] && echo 115 > "$ml/mem_latency/ratio_ceil" 2>/dev/null || true
  fi
done
UFSHC="/sys/class/devfreq/1da4000.ufshc"
if [ -d "$UFSHC" ]; then
  echo 10 > "$UFSHC/polling_interval" 2>/dev/null || true
fi

# 6. Wi-Fi 5GHz (wlan1): Power Save OFF (only when interface is UP to avoid kernel error spam), Big-Core RPS/XPS & IRQ Pinning
[ "$(cat /sys/class/net/wlan1/operstate 2>/dev/null)" = "up" ] && iw dev wlan1 set power_save off >/dev/null 2>&1 || true
[ "$(cat /sys/class/net/wlan0/operstate 2>/dev/null)" = "up" ] && iw dev wlan0 set power_save off >/dev/null 2>&1 || true
[ -w /sys/class/net/wlan1/tx_queue_len ] && echo 400 > /sys/class/net/wlan1/tx_queue_len 2>/dev/null || true
for q in /sys/class/net/wlan1/queues/rx-*; do
  [ -w "$q/rps_cpus" ] && echo f0 > "$q/rps_cpus" 2>/dev/null || true
  [ -w "$q/rps_flow_cnt" ] && echo 2048 > "$q/rps_flow_cnt" 2>/dev/null || true
done
for q in /sys/class/net/wlan1/queues/tx-*; do
  [ -w "$q/xps_cpus" ] && echo f0 > "$q/xps_cpus" 2>/dev/null || true
done
pin_irq() {
  local irq
  irq=$(awk -v n="$1" '$NF == n {sub(/:$/, "", $1); print $1; exit}' /proc/interrupts 2>/dev/null)
  [ -n "$irq" ] && [ -w "/proc/irq/$irq/smp_affinity" ] && echo "$2" > "/proc/irq/$irq/smp_affinity" 2>/dev/null || true
}
pin_irq WLAN_CE_1 10
pin_irq WLAN_CE_2 20
pin_irq WLAN_CE_3 10
pin_irq WLAN_CE_9 40
pin_irq WLAN_CE_10 20
pin_irq WLAN_CE_11 80

# 7. UFS Flash I/O Scheduling
for dev in /sys/block/sd*; do
  [ -d "$dev" ] || continue
  echo deadline > "$dev/queue/scheduler" 2>/dev/null || true
  echo 256 > "$dev/queue/read_ahead_kb" 2>/dev/null || true
  echo 256 > "$dev/queue/nr_requests" 2>/dev/null || true
  echo 2 > "$dev/queue/rq_affinity" 2>/dev/null || true
  echo 0 > "$dev/queue/add_random" 2>/dev/null || true
done

# 8. Backlight permissions (root-owned 0644; both server-dashboard and gaeru-screen run as root)
if [ -e /sys/class/leds/lcd-backlight/brightness ]; then
  chown root:root /sys/class/leds/lcd-backlight/brightness 2>/dev/null || true
  chmod 644 /sys/class/leds/lcd-backlight/brightness 2>/dev/null || true
fi
if [ -e /etc/screen_brightness.conf ]; then
  chown root:root /etc/screen_brightness.conf 2>/dev/null || true
  chmod 644 /etc/screen_brightness.conf 2>/dev/null || true
fi

sysctl -w vm.max_map_count=262144 >/dev/null 2>&1 || true
if [ "$(cat /proc/sys/kernel/sched_upmigrate 2>/dev/null)" != "45" ] || \
   [ "$(cat /proc/sys/kernel/sched_downmigrate 2>/dev/null)" != "25" ] || \
   [ "$(cat /proc/sys/kernel/sched_freq_inc_notify 2>/dev/null)" != "150000" ] || \
   [ "$(cat /proc/sys/net/core/rps_sock_flow_entries 2>/dev/null)" != "8192" ] || \
   [ "$(cat /proc/sys/net/core/wmem_max 2>/dev/null)" != "16777216" ] || \
   [ "$(cat /proc/sys/net/core/netdev_max_backlog 2>/dev/null)" != "16384" ] || \
   [ "$(cat /proc/sys/net/core/netdev_budget 2>/dev/null)" != "600" ] || \
   [ "$(cat /proc/sys/net/ipv4/tcp_low_latency 2>/dev/null)" != "1" ] || \
   [ "$(cat /proc/sys/net/ipv4/tcp_thin_linear_timeouts 2>/dev/null)" != "1" ] || \
   [ "$(cat /proc/sys/net/ipv4/tcp_thin_dupack 2>/dev/null)" != "1" ] || \
   [ "$(cat /proc/sys/net/ipv4/tcp_rfc1337 2>/dev/null)" != "1" ] || \
   [ "$(cat /proc/sys/net/ipv4/tcp_syncookies 2>/dev/null)" != "1" ] || \
   [ "$(cat /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null)" != "cubic" ]; then
  sysctl -p /etc/sysctl.d/99-zzz-web-perf.conf >/dev/null 2>&1 || true
fi
exit 0
