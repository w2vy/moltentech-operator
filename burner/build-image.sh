#!/bin/bash
# Build the fh-burner VM image: Debian 13 genericcloud + sysbench + the guest agent +
# burn-run. Runs in CI (publish-fh-burner.yml); needs libguestfs-tools and network.
#
#   build-image.sh <out-dir>   →  <out-dir>/fh-burner-<ver>.qcow2 (+ .sha256)
#
# No guest network is ever configured: the host drives burn VMs through the
# qemu-guest-agent socket. cloud-init is disabled for the same reason (no datasource
# to wait for), and fh-burner-grow does its one job instead.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "${1:?out dir}" && cd "$1" && pwd)
ver=$(cat "$here/VERSION")
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cd "$work"

base=https://cloud.debian.org/images/cloud/trixie/latest
img=debian-13-genericcloud-amd64.qcow2
curl -fsSLO "$base/$img"
curl -fsSLO "$base/SHA512SUMS"
grep " $img\$" SHA512SUMS | sha512sum -c -

virt-customize -a "$img" \
  --run-command 'apt-get update -qq' \
  --install sysbench,qemu-guest-agent,python3,cloud-guest-utils \
  --copy-in "$here/burn-run:/usr/local/bin" \
  --chmod 0755:/usr/local/bin/burn-run \
  --copy-in "$here/fh-burner-grow:/usr/local/sbin" \
  --chmod 0755:/usr/local/sbin/fh-burner-grow \
  --copy-in "$here/fh-burner-grow.service:/etc/systemd/system" \
  --run-command 'systemctl enable fh-burner-grow.service' \
  --touch /etc/cloud/cloud-init.disabled \
  --write "/etc/fh-burner-version:$ver" \
  --run-command 'apt-get clean' \
  --truncate /etc/machine-id

# Smoke: the tools the controller relies on are really in the image.
virt-customize -a "$img" --no-network \
  --run-command 'sysbench --version && test -x /usr/local/bin/burn-run && command -v growpart && systemctl is-enabled fh-burner-grow.service && grep -q . /etc/fh-burner-version'

name="fh-burner-$ver.qcow2"
qemu-img convert -c -O qcow2 "$img" "$out/$name"
(cd "$out" && sha256sum "$name" > "$name.sha256")
ls -l "$out"
