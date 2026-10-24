#!/usr/bin/env bash
# Chạy TRÊN VPS (deploy.sh ở máy local tự gọi): kích hoạt 1 release đã upload và chạy app ở APP_PORT.
#   bash <release>/remote.sh
# Biến môi trường: APP_PORT, APP_NAME, APP_DIR, KEEP_RELEASES, FORCE=1 (dừng app lạ đang chiếm cổng)
set -euo pipefail

APP_PORT="${APP_PORT:-1712}"
APP_NAME="${APP_NAME:-dkmh}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
REL_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${APP_DIR:-$(dirname "$(dirname "$REL_DIR")")}"
CURRENT="$APP_DIR/current"

log() { printf '\033[1;36m[vps] ==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[vps] [!] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[vps] [x] %s\033[0m\n' "$*"; exit 1; }

# Xin quyền sudo 1 lần ở đầu (có thể hỏi mật khẩu), sau đó mọi lệnh sudo chạy không hỏi lại
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null && sudo -v; then SUDO="sudo -n"
    else warn "Không có quyền sudo: sẽ chạy bằng pm2/nohup, không cài systemd/ufw."; fi
fi
can_root() { [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; }

# --- 1. Node.js >= 18 ---
if ! command -v node >/dev/null; then
    if can_root && command -v apt-get >/dev/null; then
        log "Chưa có Node.js -> cài bằng apt"
        $SUDO apt-get update -qq && $SUDO apt-get install -y -qq nodejs >/dev/null
    else
        die "Chưa có Node.js (cần >= 18). Cài Node rồi chạy lại."
    fi
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js $(node -v) quá cũ, cần >= 18 (dùng fetch có sẵn). Nâng cấp: https://github.com/nodesource/distributions"
command -v curl >/dev/null || die "Thiếu curl trên VPS."

# --- 2. Cổng có bị app khác chiếm không ---
UNIT="$APP_NAME.service"
port_pids() { { $SUDO ss -Hltnp "sport = :$APP_PORT" 2>/dev/null | grep -o "pid=[0-9]*" | cut -d= -f2 | sort -u; } || true; }
ours() { # tiến trình có phải server của app này không (theo đường dẫn, hoặc thuộc service/pm2 tên APP_NAME)
    tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | grep -q "server.cjs --app=$APP_NAME\b\|$APP_DIR/.*server.cjs" && return 0
    [ "$(ps -o unit= -p "$1" 2>/dev/null | tr -d ' ')" = "$UNIT" ] && return 0
    command -v pm2 >/dev/null && [ "$(pm2 pid "$APP_NAME" 2>/dev/null | tr -d ' ')" = "$1" ] && return 0
    return 1
}
PIDS="$(port_pids)"
if [ -z "$PIDS" ] && [ -n "$(ss -Hltn "sport = :$APP_PORT" 2>/dev/null)" ]; then
    die "Cổng $APP_PORT đang được dùng bởi tiến trình không xem được (của user khác?). Đổi APP_PORT hoặc deploy bằng root."
fi
for pid in $PIDS; do
    ours "$pid" && continue
    desc="pid $pid: $(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"
    if [ -n "${FORCE:-}" ]; then
        warn "FORCE=1 -> dừng tiến trình đang chiếm cổng $APP_PORT ($desc)"
        $SUDO kill "$pid" || die "Không dừng được $desc"
    else
        die "Cổng $APP_PORT đang bị app khác dùng ($desc). Đổi APP_PORT hoặc chạy lại với FORCE=1 để dừng nó."
    fi
done

# --- 3. Kích hoạt release ---
[ -f "$REL_DIR/dist/index.html" ] && [ -f "$REL_DIR/server.cjs" ] || die "Release thiếu file: $REL_DIR"
chmod -R a+rX "$REL_DIR"
ln -sfn "$REL_DIR" "$CURRENT"
log "Release hiện tại: $REL_DIR (commit $(cat "$REL_DIR/REVISION" 2>/dev/null || echo ?))"

# --- 4. Dừng bản cũ của app (dù chạy bằng systemd/pm2/nohup, ở thư mục nào) rồi chạy bản mới ---
for pid in $(port_pids); do
    ours "$pid" || continue
    if [ "$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ')" = "$UNIT" ]; then
        $SUDO systemctl stop "$UNIT" || true
    elif command -v pm2 >/dev/null && [ "$(pm2 pid "$APP_NAME" 2>/dev/null | tr -d ' ')" = "$pid" ]; then
        pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
    else
        kill "$pid" 2>/dev/null || $SUDO kill "$pid" || true
    fi
done
for _ in $(seq 1 10); do
    [ -z "$(ss -Hltn "sport = :$APP_PORT" 2>/dev/null)" ] && break
    sleep 1
done
[ -z "$(ss -Hltn "sport = :$APP_PORT" 2>/dev/null)" ] || die "Không giải phóng được cổng $APP_PORT để chạy bản mới."

# Ưu tiên systemd: tự chạy lại khi lỗi/reboot
if can_root && command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
    $SUDO tee "/etc/systemd/system/$UNIT" >/dev/null <<EOF
[Unit]
Description=DKMH - xep thoi khoa bieu (port $APP_PORT)
After=network-online.target
Wants=network-online.target

[Service]
Environment=PORT=$APP_PORT
Environment=ROOT=$CURRENT/dist
ExecStart=$NODE_BIN $CURRENT/server.cjs --app=$APP_NAME
Restart=always
RestartSec=2
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable "$UNIT" >/dev/null 2>&1
    $SUDO systemctl restart "$UNIT"
    log "Đã chạy bằng systemd ($UNIT). Log: journalctl -u $APP_NAME -f"
elif command -v pm2 >/dev/null; then
    pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
    PORT="$APP_PORT" ROOT="$CURRENT/dist" pm2 start "$CURRENT/server.cjs" --name "$APP_NAME" --update-env -- "--app=$APP_NAME" >/dev/null
    pm2 save >/dev/null
    log "Đã chạy bằng pm2 ($APP_NAME). Log: pm2 logs $APP_NAME"
else
    PID_FILE="$APP_DIR/server.pid"
    [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true
    sleep 1
    PORT="$APP_PORT" ROOT="$CURRENT/dist" nohup node "$CURRENT/server.cjs" "--app=$APP_NAME" >"$APP_DIR/server.log" 2>&1 &
    echo $! >"$PID_FILE"
    warn "Chạy bằng nohup: sẽ KHÔNG tự chạy lại khi VPS reboot (cài pm2 hoặc deploy bằng user có sudo)."
fi

# --- 5. Mở firewall ---
if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q 'Status: active'; then
    $SUDO ufw allow "$APP_PORT/tcp" >/dev/null && log "ufw: đã mở cổng $APP_PORT/tcp"
fi

# --- 6. Kiểm tra ---
code=000
for _ in $(seq 1 15); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/" || true)"
    [ "$code" = "200" ] && break
    sleep 1
done
[ "$code" = "200" ] || die "App không trả về 200 (nhận: $code). Xem log: journalctl -u $APP_NAME -n 50 / pm2 logs $APP_NAME"
# (lưu ra biến trước: với pipefail, `curl | grep -q` / `| head` có thể fail do SIGPIPE)
page="$(curl -s "http://127.0.0.1:$APP_PORT/" || true)"
grep -q '<title>DKMH' <<<"$page" || die "Cổng $APP_PORT trả 200 nhưng không phải trang DKMH."
api="$(curl -s -m 30 "http://127.0.0.1:$APP_PORT/api/sheet.php?url=https%3A%2F%2Fdocs.google.com%2Fspreadsheets%2Fd%2Fe%2F2PACX-1vR8zy-lVDGNeZyfGiMJXQSxIDTZeuh6C93zK0TcRcK5k55NlgyP4-FWAWLNfRT83g%2Fpubhtml" || true)"
if grep -q '"sheets"' <<<"$api"; then log "Proxy Google Sheet OK"; else warn "Proxy chưa đọc được sheet mặc định: ${api:0:200}"; fi

# --- 7. Dọn release cũ ---
(cd "$APP_DIR/releases" && ls -1t | tail -n +"$((KEEP_RELEASES + 1))" | xargs -r rm -rf)
log "Xong."
