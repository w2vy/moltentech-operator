#!/bin/bash
# Build the fh-burner VM image: Debian 13 genericcloud + sysbench + the guest agent +
# burn-run. Runs in CI (publish-fh-burner.yml) as root; needs qemu-utils (qemu-nbd),
# the nbd kernel module, and network.
#
#   sudo build-image.sh <out-dir>   →  <out-dir>/fh-burner-<ver>.qcow2 (+ .sha256)
#
# The image is edited through qemu-nbd + chroot, which uses the build machine's own
# network for apt — the method first proven on pve25. (libguestfs was tried first: its
# appliance networking, passt, will not start on the GitHub Ubuntu runner.)
#
# No guest network is ever configured: the host drives burn VMs through the
# qemu-guest-agent socket. cloud-init is disabled for the same reason (no datasource
# to wait for), and fh-burner-grow does its one job instead.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "${1:?out dir}" && cd "$1" && pwd)
ver=$(cat "$here/VERSION")
work=$(mktemp -d)
cd "$work"

base=https://cloud.debian.org/images/cloud/trixie/latest
img=debian-13-genericcloud-amd64.qcow2
curl -fsSLO "$base/$img"
curl -fsSLO "$base/SHA512SUMS"
grep " $img\$" SHA512SUMS | sha512sum -c -

modprobe nbd max_part=8
dev=/dev/nbd0
qemu-nbd -c "$dev" "$img"
mnt=$work/mnt; mkdir -p "$mnt"
cleanup() {
  for p in dev/pts dev proc sys; do umount "$mnt/$p" 2>/dev/null || true; done
  umount "$mnt" 2>/dev/null || true
  qemu-nbd -d "$dev" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for _ in $(seq 20); do [ -b "${dev}p1" ] && break; sleep 0.5; done
mount "${dev}p1" "$mnt"   # p1 = root in Debian cloud images
for p in proc sys dev dev/pts; do mount --bind "/$p" "$mnt/$p"; done

# The image's resolv.conf is a systemd-resolved symlink; borrow the builder's for apt.
mv "$mnt/etc/resolv.conf" "$mnt/etc/resolv.conf.fh"
cp -L /etc/resolv.conf "$mnt/etc/resolv.conf"
chroot "$mnt" /bin/bash -euc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get -qq update
  apt-get -qq install -y --no-install-recommends sysbench qemu-guest-agent python3 cloud-guest-utils >/dev/null
  apt-get -qq clean'
rm "$mnt/etc/resolv.conf"; mv "$mnt/etc/resolv.conf.fh" "$mnt/etc/resolv.conf"

install -m 0755 "$here/burn-run" "$mnt/usr/local/bin/burn-run"
install -m 0755 "$here/fh-burner-grow" "$mnt/usr/local/sbin/fh-burner-grow"
install -m 0644 "$here/fh-burner-grow.service" "$mnt/etc/systemd/system/fh-burner-grow.service"
chroot "$mnt" systemctl enable fh-burner-grow.service
touch "$mnt/etc/cloud/cloud-init.disabled"
echo "$ver" > "$mnt/etc/fh-burner-version"
: > "$mnt/etc/machine-id"   # each clone gets its own on first boot

# Smoke: the tools the controller relies on are really in the image.
chroot "$mnt" /bin/bash -euc '
  sysbench --version
  test -x /usr/local/bin/burn-run
  command -v growpart
  systemctl is-enabled fh-burner-grow.service
  burn-run version'

cleanup; trap - EXIT
name="fh-burner-$ver.qcow2"
qemu-img convert -c -O qcow2 "$img" "$out/$name"
(cd "$out" && sha256sum "$name" > "$name.sha256")
rm -rf "$work"
ls -l "$out"
