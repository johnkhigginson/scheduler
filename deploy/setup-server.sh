#!/usr/bin/env bash
#
# One time server bootstrap for Scheduler on Ubuntu.
# READ THIS BEFORE RUNNING IT. It creates a user, installs a runtime, and grants a sudoers rule.
#
# It does not install a web server. This app sits behind Caddy, which already runs on the host and
# already serves other sites; see deploy/caddy-draftpoll.conf for the block to add. An earlier
# version of this script installed nginx and certbot, which on a host already running Caddy would
# have fought over ports 80 and 443 and taken every site on the box down.
#
# It does not install or configure MongoDB. This deployment uses a hosted MongoDB instance.
#
# Usage: sudo bash deploy/setup-server.sh

set -euo pipefail

APP_USER=draftpoll
APP_DIR=/var/www/draftpoll
ENV_DIR=/etc/draftpoll
DOTNET_CHANNEL=10.0
DOTNET_DIR=/usr/share/dotnet

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

echo "==> Service user"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  # System account with a real home, because the deploy key lands in ~/.ssh/authorized_keys.
  adduser --system --group --home "/home/$APP_USER" --shell /bin/bash "$APP_USER"
else
  echo "    $APP_USER already exists, leaving it alone"
fi

echo "==> Directories"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "/home/$APP_USER/.ssh"
install -d -o root -g "$APP_USER" -m 750 "$ENV_DIR"

if [[ ! -f "$ENV_DIR/draftpoll.env" ]]; then
  cat > "$ENV_DIR/draftpoll.env" <<'EOF'
# Set the real connection string before starting the service.
ConnectionStrings__Mongo=PLACEHOLDER_NOT_SET
Mongo__Database=draftpoll
EOF
  chown root:"$APP_USER" "$ENV_DIR/draftpoll.env"
  chmod 640 "$ENV_DIR/draftpoll.env"
  echo "    wrote a placeholder env file, edit it before starting the service"
fi

echo "==> ASP.NET Core $DOTNET_CHANNEL runtime"
# Deliberately not apt. The apt packages install a second runtime root at /usr/lib/dotnet and
# repoint /usr/bin/dotnet at it, which hides every runtime the other apps on this host need.
# Nothing fails at install time; those apps break on their next restart.
if ! /usr/bin/dotnet --list-runtimes 2>/dev/null | grep -q "Microsoft.AspNetCore.App ${DOTNET_CHANNEL%%.*}\."; then
  if [[ ! -f /root/dotnet-install.sh ]]; then
    wget -q https://dot.net/v1/dotnet-install.sh -O /root/dotnet-install.sh
    chmod +x /root/dotnet-install.sh
  fi
  bash /root/dotnet-install.sh --runtime aspnetcore --channel "$DOTNET_CHANNEL" \
    --install-dir "$DOTNET_DIR" --no-path
  ln -sfn "$DOTNET_DIR/dotnet" /usr/bin/dotnet
else
  echo "    already installed"
fi

echo "==> rsync, used by the deploy workflow"
apt-get install -y rsync

echo "==> Restart permission for the deploy user"
# Narrow on purpose. The deploy user can restart this one unit and nothing else.
cat > /etc/sudoers.d/draftpoll <<EOF
$APP_USER ALL=(root) NOPASSWD: /bin/systemctl restart draftpoll, /bin/systemctl status draftpoll
EOF
chmod 440 /etc/sudoers.d/draftpoll
visudo -cf /etc/sudoers.d/draftpoll

echo
echo "Done. Next:"
echo "  1. Put the real Mongo connection string in $ENV_DIR/draftpoll.env"
echo "  2. Add the GitHub Actions deploy public key to /home/$APP_USER/.ssh/authorized_keys"
echo "  3. cp deploy/draftpoll.service /etc/systemd/system/ && systemctl daemon-reload"
echo "  4. systemctl enable --now draftpoll"
echo "  5. Add the block in deploy/caddy-draftpoll.conf to /etc/caddy/Caddyfile, then:"
echo "       caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
echo "       systemctl reload caddy"
echo "  6. Confirm every runtime the other apps need is still listed: dotnet --list-runtimes"
