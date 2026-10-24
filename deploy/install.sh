#!/usr/bin/env bash
# Cài vhost dkmh.local cho nginx (chạy với sudo): sudo bash deploy/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ln -sf "$PWD/deploy/nginx-dkmh.local.conf" /etc/nginx/sites-enabled/dkmh
grep -q 'dkmh.local' /etc/hosts || echo '127.0.0.1 dkmh.local' >> /etc/hosts
systemctl is-active --quiet php8.3-fpm || systemctl start php8.3-fpm
nginx -t
systemctl reload nginx
echo "OK: http://dkmh.local"
