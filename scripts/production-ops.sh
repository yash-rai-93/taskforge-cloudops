#!/usr/bin/env bash
# Run on the TaskForge EC2 host via an authorized operator session.
set -euo pipefail
umask 077

project=taskforge-production
data=/srv/taskforge
backup_dir=$data/backups
ops_dir=/usr/local/lib/taskforge
services=(nginx frontend api worker postgres redis)

container() {
  local id
  id=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1")
  [[ $id =~ ^[a-f0-9]{12}$ ]] || return 1
  printf '%s\n' "$id"
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_data_disk() {
  mountpoint -q "$data" || die "TaskForge data disk is not mounted"
}

check() {
  local origin=$1 id role state failed=0 partition usage disk_available
  if ! mountpoint -q "$data"; then
    printf 'CRITICAL data disk is not mounted\n' >&2
    failed=1
  fi
  for role in "${services[@]}"; do
    if id=$(container "$role") &&
        state=$(docker inspect --format '{{.State.Health.Status}} restarts={{.RestartCount}}' "$id"); then
      printf '%s %s\n' "$role" "$state"
      [[ $state == healthy\ * ]] || failed=1
    else
      printf '%s unavailable\n' "$role" >&2
      failed=1
    fi
  done
  for partition in / "$data"; do
    read -r usage disk_available < <(df --output=pcent,avail -k "$partition" | tail -1)
    printf 'disk %s used=%s available_kib=%s\n' "$partition" "$usage" "$disk_available"
    if (( ${usage%%%} >= 85 )); then failed=1; fi
  done
  awk '/^MemAvailable:/ {print "memory available_kib=" $2}' /proc/meminfo
  local path
  for path in /health /login; do
    if ! curl --noproxy '*' --connect-to '::127.0.0.1:443' -fsS \
        --max-time 10 -o /dev/null "${origin}$path"; then
      printf 'HTTPS probe failed: %s\n' "$path" >&2
      failed=1
    fi
  done
  if ! find "$backup_dir" -maxdepth 1 -type f -name 'taskforge-*.dump' \
      -mmin -2160 -printf '%f\n' 2>/dev/null | awk 'NF { found=1 } END { exit !found }'; then
    printf 'No PostgreSQL backup newer than 36 hours\n' >&2
    failed=1
  fi
  return "$failed"
}

backup() (
  require_data_disk
  install -d -m 0700 "$backup_dir"
  exec 9>"$backup_dir/.lock"
  flock -n 9 || die "Another backup is running"
  local id dump output
  id=$(container postgres) || die "Production PostgreSQL container unavailable"
  output="$backup_dir/taskforge-$(date -u +%Y%m%dT%H%M%SZ).dump"
  dump=$(mktemp "$backup_dir/.dump.XXXXXXXX")
  trap 'rm -f -- "$dump"' EXIT
  docker exec "$id" sh -c 'exec pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    >"$dump" 2>/dev/null || die "PostgreSQL dump failed"
  test -s "$dump" || die "PostgreSQL dump is empty"
  docker exec -i "$id" pg_restore --list <"$dump" >/dev/null 2>&1 || die "Dump archive validation failed"
  mv -- "$dump" "$output"
  find "$backup_dir" -maxdepth 1 -type f -name 'taskforge-*.dump' -mmin +10080 -delete
  printf 'Backup validated: %s (%s bytes)\n' "${output##*/}" "$(stat -c '%s' "$output")"
)

restore_check() (
  require_data_disk
  local archive=$1 source image disposable
  [[ $archive == "$backup_dir"/taskforge-*.dump && -f $archive && ! -L $archive ]] ||
    die "Select a regular TaskForge archive in $backup_dir"
  source=$(container postgres) || die "Production PostgreSQL container unavailable"
  image=$(docker inspect --format '{{.Image}}' "$source")
  disposable=$(docker run --detach --pull=never --network=none --memory=384m \
    --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
    -e POSTGRES_HOST_AUTH_METHOD=trust "$image")
  trap 'docker rm -fv "$disposable" >/dev/null' EXIT
  local ready=0
  for attempt in {1..30}; do
    if docker exec "$disposable" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  (( ready )) || die "Isolated PostgreSQL did not start"
  docker exec -i "$disposable" pg_restore --exit-on-error --no-owner --no-acl \
    -U postgres -d postgres <"$archive" >/dev/null 2>&1 || die "Isolated restore failed"
  local project_count
  project_count=$(docker exec "$disposable" psql -XAtq -v ON_ERROR_STOP=1 -U postgres \
    -c 'SELECT count(*) FROM projects;')
  printf 'Isolated restore passed: projects=%s\n' "$project_count"
)

install_timers() {
  local origin=$1
  install -D -m 0755 "$0" "$ops_dir/production-ops.sh"
  local action schedule
  for action in check backup; do
    local args='' timeout=15min
    if [[ $action == check ]]; then args=" $origin"; timeout=45s; fi
    cat >"/etc/systemd/system/taskforge-$action.service" <<EOF
[Unit]
Description=TaskForge production $action
After=docker.service caddy.service
RequiresMountsFor=$data

[Service]
Type=oneshot
UMask=0077
ExecStart=$ops_dir/production-ops.sh $action$args
TimeoutStartSec=$timeout
EOF
    if [[ $action == check ]]; then
      schedule=$'OnBootSec=2min\nOnUnitActiveSec=5min'
    else
      schedule=$'OnCalendar=*-*-* 02:15:00 UTC\nPersistent=true'
    fi
    cat >"/etc/systemd/system/taskforge-$action.timer" <<EOF
[Unit]
Description=Schedule TaskForge production $action

[Timer]
$schedule

[Install]
WantedBy=timers.target
EOF
  done
  systemd-analyze verify /etc/systemd/system/taskforge-{check,backup}.{service,timer}
  systemctl daemon-reload
  systemctl enable --now taskforge-backup.timer taskforge-check.timer
  systemctl start taskforge-backup.service
  systemctl start taskforge-check.service
}

validate_origin() {
  [[ $1 =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "Supply a bare HTTPS origin"
}

(( EUID == 0 )) || die "Run as root on the production host"
case ${1:-} in
  check) validate_origin "${2:-}"; check "$2" ;;
  backup) backup ;;
  restore-check) restore_check "${2:-}" ;;
  install) validate_origin "${2:-}"; install_timers "$2" ;;
  *) die "Usage: $0 {check HTTPS_ORIGIN|backup|restore-check ARCHIVE|install HTTPS_ORIGIN}" ;;
esac
