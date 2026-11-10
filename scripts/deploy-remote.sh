#!/bin/bash
set -euo pipefail
# Only the protected production job receives these values. Never enable shell tracing.
: "${DEPLOY_HOST:?Configure DEPLOY_HOST}"
: "${DEPLOY_USER:?Configure DEPLOY_USER}"
: "${DEPLOY_ROOT:?Configure DEPLOY_ROOT}"
: "${DEPLOY_SSH_KEY:?Configure DEPLOY_SSH_KEY}"
: "${DEPLOY_KNOWN_HOSTS:?Configure DEPLOY_KNOWN_HOSTS}"
: "${PRODUCTION_URL:?Configure PRODUCTION_URL}"
: "${RELEASE_SHA:?Missing release commit}"
: "${REPOSITORY:?Missing repository}"
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9.-]+$ && "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]
[[ "$DEPLOY_ROOT" =~ ^/[a-zA-Z0-9/_-]+$ && "$DEPLOY_ROOT" != / ]]
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ && "$REPOSITORY" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]]
[[ "$PRODUCTION_URL" =~ ^https://[a-zA-Z0-9.-]+(:443)?$ ]]
ARTIFACT_DIR="$(realpath "${1:?Supply downloaded artifact directory}")"
EXPECTED="$(awk 'NR==1 {print $1}' "$ARTIFACT_DIR/taskforge-release.tar.gz.sha256")"
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]]
ACTUAL="$(sha256sum "$ARTIFACT_DIR/taskforge-release.tar.gz" | cut -d ' ' -f1)"
[[ "$ACTUAL" == "$EXPECTED" ]]
PRIVATE_DIR="$(mktemp -d)"
trap 'rm -rf "$PRIVATE_DIR"' EXIT
chmod 700 "$PRIVATE_DIR"
printf '%s\n' "$DEPLOY_SSH_KEY" > "$PRIVATE_DIR/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$PRIVATE_DIR/known_hosts"
chmod 600 "$PRIVATE_DIR/key" "$PRIVATE_DIR/known_hosts"
unset DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS
SSH_OPTIONS=(-i "$PRIVATE_DIR/key" -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$PRIVATE_DIR/known_hosts" -o ConnectTimeout=15)
case "${DEPLOY_TRANSPORT:-ssh}" in
    ssh) ;;
    ssm)
        [[ "$DEPLOY_HOST" =~ ^i-[0-9a-f]{17}$ ]] || { echo 'SSM requires an EC2 instance ID in DEPLOY_HOST' >&2; exit 1; }
        [[ "${AWS_REGION:-}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || { echo 'SSM requires a valid AWS region' >&2; exit 1; }
        command -v aws >/dev/null
        command -v session-manager-plugin >/dev/null
        # The validated instance ID and region cannot introduce shell syntax.
        SSH_OPTIONS+=(-o "ProxyCommand=aws ssm start-session --region $AWS_REGION --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p")
        ;;
    *) echo 'DEPLOY_TRANSPORT must be ssh or ssm' >&2; exit 1 ;;
esac
TARGET="$DEPLOY_USER@$DEPLOY_HOST"
# Values interpolated into the remote shell are strictly validated above.
INCOMING="$DEPLOY_ROOT/incoming/$RELEASE_SHA-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
[[ "${GITHUB_RUN_ID:-manual}" =~ ^[a-zA-Z0-9-]+$ && "${GITHUB_RUN_ATTEMPT:-1}" =~ ^[0-9]+$ ]]
ssh "${SSH_OPTIONS[@]}" "$TARGET" "umask 077; mkdir -p '$INCOMING' '$DEPLOY_ROOT/releases'"
scp "${SSH_OPTIONS[@]}" "$ARTIFACT_DIR/taskforge-release.tar.gz" "$TARGET:$INCOMING/bundle.tar.gz"
ssh "${SSH_OPTIONS[@]}" "$TARGET" "python3 -B - '$DEPLOY_ROOT' '$INCOMING' '$RELEASE_SHA' '$EXPECTED'" <<'PY'
import hashlib, pathlib, shutil, sys, tarfile
root, incoming = map(pathlib.Path, sys.argv[1:3])
sha, expected = sys.argv[3:5]
archive = incoming / 'bundle.tar.gz'
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit('Transferred bundle checksum mismatch')
staging = incoming / 'unpacked'
staging.mkdir(exist_ok=False)
with tarfile.open(archive) as bundle:
    for member in bundle.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
            raise SystemExit('Unsafe bundle member')
    bundle.extractall(staging, filter='data')
destination = root / 'releases' / sha
if destination.exists():
    files = {p.relative_to(staging): p.read_bytes() for p in staging.rglob('*') if p.is_file()}
    existing = {p.relative_to(destination): p.read_bytes() for p in destination.rglob('*') if p.is_file()}
    if files != existing:
        raise SystemExit('Refusing to replace an existing release with different files')
else:
    staging.rename(destination)
shutil.rmtree(incoming)
PY
REMOTE_SCRIPT="$DEPLOY_ROOT/releases/$RELEASE_SHA/scripts/deploy.py"
ssh "${SSH_OPTIONS[@]}" "$TARGET" "python3 -B '$REMOTE_SCRIPT' --root '$DEPLOY_ROOT' --repository '$REPOSITORY' --release '$DEPLOY_ROOT/releases/$RELEASE_SHA'"
probe() {
    local path="$1" output="$2" status
    status=$(curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 3 --max-time 15 \
        --output "$output" --write-out '%{http_code}' "$PRODUCTION_URL$path") || return 1
    [[ "$status" == 200 ]]
}
if ! probe /health "$PRIVATE_DIR/health.json" ||
    ! python3 -B -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(d.get("data",d).get("status") != "ok")' "$PRIVATE_DIR/health.json" 2>/dev/null ||
    ! probe /login "$PRIVATE_DIR/login.html" ||
    ! grep -Fq '/_next/static/' "$PRIVATE_DIR/login.html"; then
    echo 'Public HTTPS verification failed; attempting previous application release' >&2
    ssh "${SSH_OPTIONS[@]}" "$TARGET" "python3 -B '$REMOTE_SCRIPT' --root '$DEPLOY_ROOT' --repository '$REPOSITORY' --rollback"
    exit 1
fi
echo "Verified public HTTPS release: $RELEASE_SHA"
