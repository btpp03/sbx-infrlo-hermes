#!/usr/bin/env bash
# Infrlo instance bootstrap: diagnostics first, then launch the sbx node.
set -u

echo "===== INFRLO DIAG $(date -u +%FT%TZ) ====="
echo "host: $(hostname)  pwd: $(pwd)  id: $(id)"
echo "--- os"; cat /etc/os-release 2>/dev/null | head -4
echo "--- arch/uname"; uname -a
echo "--- cpu/mem"; nproc; grep -E 'MemTotal|MemAvailable' /proc/meminfo
echo "--- cgroup limits"; cat /sys/fs/cgroup/memory.max 2>/dev/null; cat /sys/fs/cgroup/cpu.max 2>/dev/null
echo "--- disk"; df -h / /tmp 2>/dev/null | head -5
echo "--- resolv.conf"; cat /etc/resolv.conf 2>/dev/null
echo "--- tools"; for t in bash sh curl wget node npm python3 git nslookup dig ss netstat jq unzip tar; do
  printf '%-10s %s\n' "$t" "$(command -v "$t" 2>/dev/null || echo MISSING)"
done
echo "--- env (secrets masked)"; env | sort | sed -E 's/(KEY|TOKEN|SECRET|PASS|AUTH)=.*/\1=***/g'
echo "--- egress test"; curl -sS -m 15 https://api.ipify.org || echo "EGRESS-FAIL"
echo; echo "--- dns test"; getent hosts github.com || echo "DNS-FAIL"; getent hosts main.ssss.nyc.mn || echo "DNS-FAIL sbx"
echo "--- tcp test"; timeout 8 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443 && echo TCP-OK' || echo TCP-FAIL
echo "===== DIAG END ====="

SBX_URL="${SBX_URL:-https://main.ssss.nyc.mn/sb.sh}"
echo "=== launching sbx from $SBX_URL"
mkdir -p /app/.npm 2>/dev/null || true
if curl -Ls --max-time 60 "$SBX_URL" -o /tmp/sb.sh && [ -s /tmp/sb.sh ]; then
  echo "--- sb.sh head"; head -5 /tmp/sb.sh
  cd /app 2>/dev/null || cd /tmp
  bash /tmp/sb.sh 2>&1 | tail -80
else
  echo "sb.sh download FAILED"
fi

echo "=== bootstrap done, keeping container alive ==="
i=0
while true; do
  i=$((i + 1))
  sleep 60
  echo "[alive $i] $(date -u +%T) procs: $(ps -eo comm= 2>/dev/null | sort | uniq -c | sort -rn | head -5 | tr '\n' ' ')"
done
