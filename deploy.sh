#!/usr/bin/env bash
# Deploy DKMH — app chạy tại http://187.127.220.246:1712
# (server Node tự viết trong deploy/server.cjs, VPS chỉ cần Node >= 18, không cần nginx/PHP).
#
# Cách 1 — từ MÁY LOCAL (mặc định, VPS không cần quyền vào repo GitHub private):
#   ./deploy.sh
#   -> build ở local, upload qua SSH vào <REMOTE_DIR>/releases/<thời gian>, kích hoạt trên VPS.
#
# Cách 2 — chạy TRỰC TIẾP TRÊN VPS, trong thư mục đã clone repo (VPS cần SSH key/deploy key của GitHub):
#   git clone git@github.com:khangtran2404/dkmh.git && cd dkmh && ./deploy.sh --here
#   cập nhật: git pull && ./deploy.sh --here
#   -> build trên VPS, release nằm trong <repo>/.deploy/releases.
#
# Tuỳ chỉnh qua biến môi trường, ví dụ:
#   SSH_USER=ubuntu ./deploy.sh         # user SSH (mặc định root; user thường cần sudo để cài systemd)
#   SSH_PORT=2222 ./deploy.sh           # cổng SSH (mặc định 22)
#   APP_PORT=1712 ./deploy.sh           # cổng web của app
#   REMOTE_DIR=/var/www/dkmh ./deploy.sh
#   SKIP_BUILD=1 ./deploy.sh            # dùng dist/ có sẵn
#   FORCE=1 ./deploy.sh                 # dừng app khác đang chiếm APP_PORT trên VPS
#
# Trên VPS (deploy/remote.sh): trỏ symlink current, chạy bằng systemd (hoặc pm2/nohup), mở ufw, health check.
# Mật khẩu SSH chỉ hỏi 1 lần (dùng chung kết nối). Nên cài SSH key: ssh-copy-id -p <port> <user>@<ip>
set -euo pipefail

SSH_HOST="${SSH_HOST:-187.127.220.246}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
APP_PORT="${APP_PORT:-1712}"
APP_NAME="${APP_NAME:-dkmh}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/dkmh}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"

MODE="ssh"
case "${1:-}" in
    --here) MODE="here" ;;
    "") ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) printf 'Tham số không hợp lệ: %s (dùng --here hoặc --help)\n' "$1" >&2; exit 2 ;;
esac

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[x] %s\033[0m\n' "$*"; exit 1; }

command -v curl >/dev/null || die "Thiếu curl."

# --- 0. phiên bản code (git) ---
REVISION="không có git"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    REVISION="$(git rev-parse --short HEAD 2>/dev/null || echo 'chưa có commit')"
    if [ -n "$(git status --porcelain)" ]; then
        warn "Có thay đổi CHƯA COMMIT — bản deploy sẽ khác code trên GitHub:"
        git status --short | head -10
        REVISION="$REVISION-dirty"
    elif [ "$MODE" = "ssh" ] && git rev-parse '@{u}' >/dev/null 2>&1 && [ -n "$(git log '@{u}..' --oneline)" ]; then
        warn "Có commit CHƯA PUSH lên GitHub ($(git log '@{u}..' --oneline | wc -l) commit). Nhớ: git push"
    fi
fi
log "Phiên bản: $REVISION"

# --- 1. build ---
if [ -z "${SKIP_BUILD:-}" ]; then
    command -v npm >/dev/null || die "Thiếu Node.js/npm (cần >= 18)."
    log "Cài dependencies (npm ci)"
    npm ci --include=dev --no-audit --no-fund
    log "Chạy test"
    npm test --silent
    log "Build production"
    npm run build
fi
[ -f dist/index.html ] || die "Không thấy dist/index.html — build lỗi?"
node --check deploy/server.cjs || die "deploy/server.cjs lỗi cú pháp"

RELEASE="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r dist "$STAGE/dist"
cp deploy/server.cjs deploy/remote.sh "$STAGE/"
printf '%s\n' "$REVISION" >"$STAGE/REVISION"

REMOTE_ENV="APP_PORT='$APP_PORT' APP_NAME='$APP_NAME' KEEP_RELEASES='$KEEP_RELEASES' FORCE='${FORCE:-}'"

# --- Cách 2: ngay trên máy này ---
if [ "$MODE" = "here" ]; then
    APP_DIR="${APP_DIR:-$REPO_DIR/.deploy}"
    REL_DIR="$APP_DIR/releases/$RELEASE"
    mkdir -p "$REL_DIR"
    cp -r "$STAGE/." "$REL_DIR/"
    log "Release: $REL_DIR"
    eval "$REMOTE_ENV APP_DIR='$APP_DIR' bash '$REL_DIR/remote.sh'"
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    log "DEPLOY THÀNH CÔNG ($REVISION) → http://${IP:-<ip-vps>}:$APP_PORT/"
    exit 0
fi

# --- Cách 1: upload qua SSH ---
command -v ssh >/dev/null || die "Thiếu ssh."
CTL="$(mktemp -u "${TMPDIR:-/tmp}/dkmh-ssh-XXXXXX")"
SSH=(ssh -p "$SSH_PORT" -o ControlMaster=auto -o "ControlPath=$CTL" -o ControlPersist=120
    -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
TARGET="$SSH_USER@$SSH_HOST"
trap 'rm -rf "$STAGE"; ssh -o "ControlPath=$CTL" -O exit "$TARGET" >/dev/null 2>&1 || true' EXIT

log "Kết nối $TARGET:$SSH_PORT"
"${SSH[@]}" "$TARGET" true || die "Không SSH được vào $TARGET:$SSH_PORT"

REL_DIR="$REMOTE_DIR/releases/$RELEASE"
log "Upload release $RELEASE -> $REL_DIR"
# Thư mục cha có thể cần sudo nếu SSH bằng user thường (-t để sudo hỏi được mật khẩu)
"${SSH[@]}" -t "$TARGET" "mkdir -p '$REL_DIR' 2>/dev/null || { sudo mkdir -p '$REL_DIR' && sudo chown -R \"\$(id -u):\$(id -g)\" '$REMOTE_DIR'; }" \
    || die "Không tạo được $REL_DIR trên VPS"
tar -czf - -C "$STAGE" . | "${SSH[@]}" "$TARGET" "tar -xzf - -C '$REL_DIR'" || die "Upload thất bại"

log "Kích hoạt trên VPS"
"${SSH[@]}" -t "$TARGET" "$REMOTE_ENV APP_DIR='$REMOTE_DIR' bash '$REL_DIR/remote.sh'" \
    || die "Kích hoạt trên VPS thất bại (xem log ở trên)."

URL="http://$SSH_HOST:$APP_PORT/"
code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$URL" || true)"
if [ "$code" = "200" ]; then
    log "DEPLOY THÀNH CÔNG ($REVISION) → $URL"
else
    warn "App chạy trên VPS nhưng từ máy này không truy cập được $URL (HTTP $code)."
    warn "Kiểm tra firewall của nhà cung cấp VPS (security group/panel) đã mở cổng $APP_PORT/tcp chưa."
fi
