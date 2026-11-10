#!/bin/bash
set -euo pipefail
# New interface: --root /opt/taskforge --repository owner/repo --release .../releases/<sha>
exec python3 -B "$(dirname "$(realpath "$0")")/deploy.py" "$@"
