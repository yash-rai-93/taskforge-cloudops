#!/bin/bash
set -euo pipefail

: "${RUNNER_TEMP:?GitHub runner temp directory is required}"
: "${GITHUB_PATH:?GitHub runner PATH file is required}"
[[ $(uname -m) == x86_64 ]]
directory=$(mktemp -d "$RUNNER_TEMP/taskforge-ssm.XXXXXX")
package="$directory/session-manager-plugin.deb"
version=1.2.896.0
curl --fail --silent --show-error --location --retry 3 --max-time 60 \
    "https://s3.amazonaws.com/session-manager-downloads/plugin/$version/ubuntu_64bit/session-manager-plugin.deb" \
    --output "$package"
echo "53f51fcc67314a4bf85888a38a3967cd41f8d0f28a60a9469a63acf935ba713e  $package" | sha256sum --check
dpkg-deb -x "$package" "$directory"
bin="$directory/usr/local/sessionmanagerplugin/bin"
"$bin/session-manager-plugin" --version
printf '%s\n' "$bin" >> "$GITHUB_PATH"
