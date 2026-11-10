#!/usr/bin/env bash
set -Eeuo pipefail

# Source functions only. Device commands below are test doubles.
# shellcheck source=../bootstrap.sh
source "$(dirname "$0")/../bootstrap.sh"
formatted=0
disk_type=disk
filesystem=
signature=
mounted=false

lsblk() { printf '%s\n' "$disk_type"; }
blkid() { printf '%s' "$filesystem"; }
wipefs() { printf '%s' "$signature"; }
findmnt() { "$mounted"; }
mkfs.ext4() {
    [[ "$*" == "-L taskforge-data /dev/test-data" ]]
    (( formatted += 1 ))
}

reject() {
    if "$@"; then
        echo "Expected unsafe disk initialization to fail" >&2
        exit 1
    fi
}
reject prepare_filesystem /dev/root /dev/root /dev/root-parent
reject prepare_filesystem /dev/root-parent /dev/root /dev/root-parent
disk_type=$'disk\npart'
reject prepare_filesystem /dev/test-data /dev/root /dev/root-parent
disk_type=disk
filesystem=xfs
reject prepare_filesystem /dev/test-data /dev/root /dev/root-parent
filesystem=
signature=gpt
reject prepare_filesystem /dev/test-data /dev/root /dev/root-parent
signature=
mounted=true
reject prepare_filesystem /dev/test-data /dev/root /dev/root-parent
mounted=false
[[ "$formatted" == 0 ]]
prepare_filesystem /dev/test-data /dev/root /dev/root-parent
[[ "$formatted" == 1 ]]
filesystem=ext4
prepare_filesystem /dev/test-data /dev/root /dev/root-parent
[[ "$formatted" == 1 ]]
echo "PASS: blank disk initialized once; root, mounted, partitioned and existing disks protected"
