#!/bin/bash
set -u
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset LD_PRELOAD

LOG=/var/log/gaeru-health.log
EVENTLOG=/var/log/gaeru-health-events.log
STATEFILE=/var/run/gaeru-health-state
INTERVAL=300

has_job() {
    initctl status "$1" 2>/dev/null | grep -q 'start/running'
}

has_any_port() {
    ss -lnt 2>/dev/null | awk -v want="$1" \
      '$1 == "LISTEN" {n=split($4,a,":"); if (a[n] == want) ok=1} END {exit !ok}'
}

check_once() {
    local problems="" http mem disk root_disk load1 batt temp max_c c_val value f prev state line n3000 n8080 n3100 deploying=0
    [ -e /run/gaeru-deploy.lock ] && deploying=1

    if [ "$deploying" -eq 0 ]; then
        if ! has_job postgresql-chroot; then
            initctl start postgresql-chroot 2>/dev/null || true
            sleep 2
            has_job postgresql-chroot || problems="${problems}${problems:+,}job_postgresql-chroot"
        fi

        if ! has_any_port 3000; then
            initctl start node-app APP=gaeru 2>/dev/null || true
            sleep 3
            has_any_port 3000 || problems="${problems}${problems:+,}port_3000"
        fi

        if ! has_any_port 8080; then
            initctl start server-dashboard 2>/dev/null || true
            sleep 2
            has_any_port 8080 || problems="${problems}${problems:+,}port_8080"
        fi

        if ! has_any_port 3100; then
            initctl start gaeru-gpu-ai 2>/dev/null || true
            sleep 2
            has_any_port 3100 || problems="${problems}${problems:+,}port_3100"
        fi

        if ! pgrep -f "cloudflared.*tunnel run" >/dev/null 2>&1; then
            /etc/init.d/cloudflared start >/dev/null 2>&1 || true
            sleep 2
            pgrep -f "cloudflared.*tunnel run" >/dev/null 2>&1 || problems="${problems}${problems:+,}cloudflared"
        fi

        http=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health 2>/dev/null || echo 000)
        [ -n "$http" ] || http=000
        if [ "$http" != "200" ]; then
            problems="${problems}${problems:+,}web_health_${http}"
        fi
    else
        http=$(curl -sS -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health 2>/dev/null || echo 000)
        [ -n "$http" ] || http=000
    fi

    mem=$(awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {avail=$2; found=1} \
      END {if (found && total > 0) printf "%.0f", (total-avail)*100/total; else print "NA"}' /proc/meminfo)
    disk=$(df -P /userdata 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
    [ -n "$disk" ] || disk=NA
    case "$disk" in
        ''|*[!0-9]*) ;;
        *) if [ "$disk" -ge 90 ]; then problems="${problems}${problems:+,}disk_high"; fi ;;
    esac
    root_disk=$(df -P / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
    [ -n "$root_disk" ] || root_disk=NA
    case "$root_disk" in
        ''|*[!0-9]*) ;;
        *) if [ "$root_disk" -ge 90 ]; then problems="${problems}${problems:+,}root_disk_high"; fi ;;
    esac

    load1=$(awk '{print $1}' /proc/loadavg)
    batt=NA
    for f in /sys/class/power_supply/battery/capacity /sys/class/power_supply/BAT0/capacity /sys/class/power_supply/bms/capacity; do
        if [ -r "$f" ]; then
            value=$(cat "$f" 2>/dev/null || true)
            case "$value" in
                ''|*[!0-9]*) ;;
                *) batt=$value; break ;;
            esac
        fi
    done

    max_c=0
    for f in /sys/class/thermal/thermal_zone*/temp; do
        [ -r "$f" ] || continue
        value=$(cat "$f" 2>/dev/null || true)
        case "$value" in
            ''|*[!0-9]*) continue ;;
        esac
        c_val=0
        if [ "$value" -ge 1000 ] && [ "$value" -le 120000 ]; then
            c_val=$((value / 1000))
        elif [ "$value" -ge 200 ] && [ "$value" -lt 1000 ]; then
            c_val=$((value / 10))
        fi
        if [ "$c_val" -gt "$max_c" ]; then
            max_c=$c_val
        fi
    done
    temp=NA
    if [ "$max_c" -gt 0 ]; then temp=$max_c; fi

    n3000=down
    n8080=down
    n3100=down
    if has_any_port 3000; then n3000=up; fi
    if has_any_port 8080; then n8080=up; fi
    if has_any_port 3100; then n3100=up; fi

    state=OK
    [ -z "$problems" ] || state=ALERT
    line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') status=$state issues=${problems:-none} http=$http ram_used_pct=$mem disk_used_pct=$disk root_used_pct=$root_disk load1=$load1 battery_pct=$batt thermal_max_C=$temp node3000=$n3000 node8080=$n8080 gpu3100=$n3100"
    printf '%s\n' "$line" >> "$LOG"
    if [ "${GAERU_HEALTH_QUIET:-0}" != "1" ]; then
        printf '%s\n' "$line"
    fi

    prev=$(cat "$STATEFILE" 2>/dev/null || true)
    if [ "$state" != "$prev" ]; then
        printf '%s\n' "$line" >> "$EVENTLOG"
        if command -v logger >/dev/null 2>&1; then
            logger -t gaeru-health "$line" 2>/dev/null || true
        fi
        printf '%s\n' "$state" > "$STATEFILE"
    fi
}

case "${1:---once}" in
    --once) check_once ;;
    --loop)
        trap 'exit 0' TERM INT
        export GAERU_HEALTH_QUIET=1
        while :; do
            check_once
            sleep "$INTERVAL"
        done
        ;;
    *) echo 'Usage: gaeru-healthcheck.sh [--once|--loop]' >&2; exit 2 ;;
esac
