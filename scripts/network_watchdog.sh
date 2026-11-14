#!/bin/bash
# 24/7 Full System & Network Self-Healing Watchdog for Xiaomi Mi 6
# Author: Antigravity Assistant

LOG_FILE="/var/log/network_watchdog.log"
GATEWAY="192.168.31.1"
DNS="1.1.1.1"
SSID="Wifi_5G"
WIFI_UUID="c2ab6752-b9ba-4ad4-9aaa-6561211f2a8c"
FAIL_COUNT=0
MAX_FAILS=3
HTTP_FAIL_COUNT=0
HTTP_MAX_FAILS=3
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

reconnect_wifi() {
  nmcli dev wifi rescan ifname wlan1 >/dev/null 2>&1 || true
  nmcli connection up uuid "$WIFI_UUID" >> "$LOG_FILE" 2>&1 || \
    nmcli connection up id "$SSID" >> "$LOG_FILE" 2>&1 || true
  iw dev wlan1 set power_save off 2>/dev/null || true
}

ensure_upstart() {
  local svc="$1"
  [ -f "/etc/init/${svc}.conf" ] || return 0
  local ov="/etc/init/${svc}.override"
  if [ -f "$ov" ] && grep -qE '^[[:space:]]*manual[[:space:]]*$' "$ov"; then
    return 0
  fi
  if ! initctl status "$svc" 2>/dev/null | grep -q "start/running"; then
    log "[AUTO-HEAL] $svc is stopped! Restarting now..."
    start "$svc" >> "$LOG_FILE" 2>&1 || true
  fi
}

log "System & Network Watchdog started 24/7 (Monitoring Network, PG18, Node26, Dashboard, Nginx, Cloudflared, Battery, Cron, Peak HW Tuning)"

# Ensure power save is off and apply peak hardware tuning
iw dev wlan1 set power_save off 2>/dev/null || true
iw dev wlan0 set power_save off 2>/dev/null || true
/usr/local/bin/hw_tune.sh >/dev/null 2>&1 || true

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
      reconnect_wifi
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
        reconnect_wifi
        FAIL_COUNT=0
      fi
    fi
  fi

  # 2. Ubuntu 26 PostgreSQL 18 Service Check
  ensure_upstart postgresql-chroot

  # 3. Ubuntu 26 Node.js (gaeru) Service Check
  if ! initctl status node-app APP=gaeru 2>/dev/null | grep -q "start/running"; then
    log "[AUTO-HEAL] node-app (gaeru) is stopped! Restarting now..."
    start node-app APP=gaeru >> "$LOG_FILE" 2>&1 || true
    HTTP_FAIL_COUNT=0
  else
    if curl -fsS --max-time 5 http://127.0.0.1:3000/health >/dev/null 2>&1; then
      if [ "$HTTP_FAIL_COUNT" -gt 0 ]; then
        log "node-app HTTP health check recovered! HTTP fail count reset."
        HTTP_FAIL_COUNT=0
      fi
    else
      HTTP_FAIL_COUNT=$((HTTP_FAIL_COUNT + 1))
      log "node-app HTTP health check FAILED ($HTTP_FAIL_COUNT/$HTTP_MAX_FAILS)"
      if [ "$HTTP_FAIL_COUNT" -ge "$HTTP_MAX_FAILS" ]; then
        log "[AUTO-HEAL] node-app HTTP health check failed 3x! Restarting node-app (gaeru)..."
        restart node-app APP=gaeru >> "$LOG_FILE" 2>&1 || {
          stop node-app APP=gaeru >> "$LOG_FILE" 2>&1 || true
          start node-app APP=gaeru >> "$LOG_FILE" 2>&1 || true
        }
        HTTP_FAIL_COUNT=0
      fi
    fi
  fi

  # 4. Web Admin Dashboard (8080) & Nginx Reverse Proxy Check
  ensure_upstart server-dashboard
  ensure_upstart nginx

  # 5. Cloudflare Tunnel Check
  if ! pgrep -f "cloudflared.*tunnel run" >/dev/null 2>&1; then
    log "[AUTO-HEAL] cloudflared is not running! Starting cloudflared..."
    /etc/init.d/cloudflared start >> "$LOG_FILE" 2>&1 || true
  fi

  # 6. Battery Limiter & Cron Check
  ensure_upstart battery-limiter
  ensure_upstart cron

  # 7. Enforce Peak Hardware Performance & 24/7 Anti-Sleep Lock
  /usr/local/bin/hw_tune.sh >/dev/null 2>&1 || true

  sleep "$CHECK_INTERVAL"
done
