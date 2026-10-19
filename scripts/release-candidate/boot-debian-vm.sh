#!/usr/bin/env bash
# Disposable RC laboratory only. No host directories or user configuration are shared.
set -euo pipefail
: "${YUVI_RC_LAB:?Set a new absolute laboratory directory}"
: "${YUVI_RC_IMAGE:?Set a verified Debian 12 genericcloud qcow2 image}"
: "${YUVI_RC_IMAGE_SHA512:?Set the official image checksum}"
: "${YUVI_RC_SSH_KEY:?Set a new private key path on a POSIX filesystem}"
: "${YUVI_RC_SSH_PORT:=22286}"
case "$YUVI_RC_LAB" in /*) ;; *) exit 2;; esac
if [ -e "$YUVI_RC_LAB/vm.qcow2" ]; then
  echo 'Refusing to overwrite an existing VM.' >&2; exit 1
fi
mkdir -p "$YUVI_RC_LAB/seed"
chmod 700 "$YUVI_RC_LAB"
printf '%s  %s\n' "$YUVI_RC_IMAGE_SHA512" "$YUVI_RC_IMAGE" | sha512sum -c -
ssh-keygen -q -t ed25519 -N '' -f "$YUVI_RC_SSH_KEY"
test "$(stat -c %a "$YUVI_RC_SSH_KEY")" = 600 || { echo 'Private key filesystem must enforce mode 0600.' >&2; exit 1; }
printf 'instance-id: yuvi-rc-%s\nlocal-hostname: yuvi-rc\n' "$(date +%s)" > "$YUVI_RC_LAB/seed/meta-data"
cat > "$YUVI_RC_LAB/seed/user-data" <<CLOUD
#cloud-config
users:
  - name: tester
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - $(cat "$YUVI_RC_SSH_KEY.pub")
ssh_pwauth: false
disable_root: true
CLOUD
cat > "$YUVI_RC_LAB/seed/network-config" <<'NETWORK'
version: 2
ethernets:
  uplink:
    match:
      name: "e*"
    dhcp4: true
NETWORK
genisoimage -quiet -output "$YUVI_RC_LAB/seed.iso" -volid cidata -joliet -rock "$YUVI_RC_LAB/seed/user-data" "$YUVI_RC_LAB/seed/meta-data" "$YUVI_RC_LAB/seed/network-config"
qemu-img create -q -f qcow2 -F qcow2 -b "$YUVI_RC_IMAGE" "$YUVI_RC_LAB/vm.qcow2" 28G
qemu-system-x86_64 -enable-kvm -cpu host -m 6144 -smp 6 \
  -drive "file=$YUVI_RC_LAB/vm.qcow2,if=virtio,format=qcow2" \
  -drive "file=$YUVI_RC_LAB/seed.iso,media=cdrom,readonly=on" \
  -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:$YUVI_RC_SSH_PORT-:22" \
  -display none -serial "file:$YUVI_RC_LAB/serial.log" \
  -pidfile "$YUVI_RC_LAB/qemu.pid" -daemonize
printf 'SSH: ssh -i %q -o UserKnownHostsFile=%q -o StrictHostKeyChecking=accept-new -p %q tester@127.0.0.1\n' "$YUVI_RC_SSH_KEY" "$YUVI_RC_LAB/known-hosts" "$YUVI_RC_SSH_PORT"
