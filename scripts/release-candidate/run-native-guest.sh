#!/usr/bin/env bash
set -euo pipefail
test "$(hostname)" = yuvi-rc || { echo "Disposable RC guest required" >&2; exit 1; }
export DISPLAY=:99
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 GDK_BACKEND=x11
Xvfb :99 -screen 0 1280x1000x24 -nolisten tcp > /home/tester/xvfb.log 2>&1 &
task_xvfb_pid=$!
trap 'kill "$task_xvfb_pid" 2>/dev/null || true' EXIT
dbus-run-session -- bash -c '
set -e
printf "%s" "synthetic-test-keyring-password" | gnome-keyring-daemon --unlock --components=secrets
openbox > /home/tester/openbox.log 2>&1 &
task_wm_pid=$!
setsid /home/tester/tauri-driver --port 4444 --native-driver /usr/bin/WebKitWebDriver > /home/tester/driver.log 2>&1 &
task_driver_pid=$!
cleanup() {
  /home/tester/yuvi/yuvi stop > /home/tester/stop.log 2>&1 || true
  kill -- -"$task_driver_pid" 2>/dev/null || true
  kill "$task_wm_pid" 2>/dev/null || true
}
trap cleanup EXIT
if [ "$1" = keyring-unavailable ]; then
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/yuvi-test-unavailable-secret-bus
fi
python3 /home/tester/native-install.py "$1"
' shell "${1:-install}"
