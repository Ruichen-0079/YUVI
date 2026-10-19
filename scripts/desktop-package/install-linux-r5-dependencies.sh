#!/usr/bin/env bash
# Debian 12 online system-package dependency contract. Does not install Node/PG.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run through the system package administrator.' >&2; exit 1; }
. /etc/os-release
test "$ID:$VERSION_ID:$(uname -m)" = debian:12:x86_64 || { echo 'Only Debian 12 x86_64 is validated.' >&2; exit 1; }
apt-get update
deps=(ca-certificates libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2
  libssl3 libsecret-1-0 gnome-keyring dbus-x11 libasound2 libxdo3 fonts-dejavu-core)
if [ "${1:-}" = --test-tools ]; then
  deps+=(xvfb xauth xdotool openbox webkit2gtk-driver python3)
elif [ "$#" -ne 0 ]; then
  echo 'Usage: install-linux-r5-dependencies.sh [--test-tools]' >&2; exit 2
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${deps[@]}"
echo 'System libraries installed. A graphical user session with an unlocked Secret Service is required.'
echo 'Offline installation requires a separately prepared compatible OS package repository; this script requires network.'
