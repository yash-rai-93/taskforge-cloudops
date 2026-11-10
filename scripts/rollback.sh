#!/bin/bash
set -euo pipefail
exec python3 -B "$(dirname "$(realpath "$0")")/deploy.py" --rollback "$@"
