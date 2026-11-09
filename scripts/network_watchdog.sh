#!/bin/bash
# 24/7 Full System & Network Self-Healing Watchdog for Xiaomi Mi 6
# Author: Antigravity Assistant

LOG_FILE="/var/log/network_watchdog.log"
GATEWAY="192.168.31.1"
DNS="1.1.1.1"
SSID="Wifi_5G"
FAIL_COUNT=0
MAX_FAILS=3
CHECK_INTERVAL=20

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Ensure log doesn't grow unbounded (> 2MB)
rotate_log() {
  if [ -f "$LOG_FILE" ]; then
    local sz=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$sz" -gt 2097152 ]; then
      tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
  fi
}

log "System & Network Watchdog started 24/7 (Monitoring Network, PG18, Node26, Nginx, Cloudflared)"

# Ensure power save is off
iw dev wlan1 set power_save off 2>/dev/null || true
iw dev wlan0 set power_save off 2>/dev/null || true

# Ensure big CPU cores run at peak performance without frequency ramping delay
echo performance > /sys/devices/system/cpu/cpufreq/policy4/scaling_governor 2>/dev/null || true

while true; do
  rotate_log

  # 1. Wi-Fi Connectivity Check
  if ping -c 1 -W 2 "$GATEWAY" >/dev/null 2>&1 || ping -c 1 -W 2 "$DNS" >/dev/null 2>&1; then
    if [ $FAIL_COUNT -gt 0 ]; then
      log "Network connectivity recovered! Fail count reset."
      FAIL_COUNT=0
    fi
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    log "Network ping check FAILED ($FAIL_COUNT/$MAX_FAILS)"

    if [ $FAIL_COUNT -ge $MAX_FAILS ]; then
      log "Auto-reconnect triggered: attempting to reconnect to $SSID..."
      nmcli dev wifi connect "$SSID" >> "$LOG_FILE" 2>&1 || true
      sleep 5

      if ping -c 1 -W 3 "$GATEWAY" >/dev/null 2>&1 || ping -c 1 -W 3 "$DNS" >/dev/null 2>&1; then
        log "Reconnection to $SSID successful!"
        FAIL_COUNT=0
      else
        log "Soft reconnect failed. Recycling Wi-Fi radio..."
        nmcli radio wifi off 2>/dev/null || true
        sleep 2
        nmcli radio wifi on 2>/dev/null || true
        sleep 5
        nmcli dev wifi connect "$SSID" >> "$LOG_FILE" 2>&1 || true
        FAIL_COUNT=0
      fi
    fi
  fi

  # 2. Ubuntu 26 PostgreSQL 18 Service Check
  if ! initctl status postgresql-chroot 2>/dev/null | grep -q "start/running"; then
    log "[AUTO-HEAL] postgresql-chroot is stopped! Restarting now..."
    start postgresql-chroot >> "$LOG_FILE" 2>&1 || true
  fi

  # 3. Ubuntu 26 Node.js (gaeru) Service Check
  if ! initctl status node-app APP=gaeru 2>/dev/null | grep -q "start/running"; then
    log "[AUTO-HEAL] node-app (gaeru) is stopped! Restarting now..."
    start node-app APP=gaeru >> "$LOG_FILE" 2>&1 || true
  fi

  # 4. Web Admin Dashboard (8080) Check
  if ! initctl status server-dashboard 2>/dev/null | grep -q "start/running"; then
    log "[AUTO-HEAL] server-dashboard is stopped! Restarting now..."
    start server-dashboard >> "$LOG_FILE" 2>&1 || true
  fi

  # 5. Nginx Reverse Proxy Check
  if ! initctl status nginx 2>/dev/null | grep -q "start/running"; then
    log "[AUTO-HEAL] nginx is stopped! Restarting now..."
    start nginx >> "$LOG_FILE" 2>&1 || true
  fi

  # 6. Cloudflare Tunnel Check
  if ! pgrep -f "cloudflared.*tunnel run" >/dev/null 2>&1; then
    log "[AUTO-HEAL] cloudflared is not running! Starting cloudflared..."
    /etc/init.d/cloudflared start >> "$LOG_FILE" 2>&1 || true
  fi

  # 7. Battery Limiter Check (Protect battery 24/7)
  if ! initctl status battery-limiter 2>/dev/null | grep -q "start/running"; then
    log "[AUTO-HEAL] battery-limiter is stopped! Restarting now..."
    start battery-limiter >> "$LOG_FILE" 2>&1 || true
  fi

  sleep "$CHECK_INTERVAL"
done
