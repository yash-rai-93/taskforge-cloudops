#!/usr/bin/env bash
set -Eeuo pipefail

DATA_MOUNT=/srv/taskforge
DOCKER_ROOT="$DATA_MOUNT/docker"
DEPLOY_ROOT="$DATA_MOUNT/deploy"
DOCKER_APT_ORIGIN=https://download.docker.com/linux/ubuntu

retry() {
    local attempt
    for attempt in 1 2 3 4 5; do
        if "$@"; then return 0; fi
        if (( attempt < 5 )); then sleep "$((attempt * 5))"; fi
    done
    return 1
}

discover_data_disk() {
    local serial="$1" device attempt
    for attempt in $(seq 1 120); do
        device=$(lsblk -dn -o SERIAL,PATH,TYPE |
            awk -v serial="$serial" '$1 == serial && $3 == "disk" { print $2 }')
        if [[ -n "$device" && "$device" != *$'\n'* ]]; then
            printf '%s\n' "$device"
            return
        fi
        sleep 3
    done
    echo "Timed out waiting for the configured EBS volume" >&2
    return 1
}

prepare_filesystem() {
    local device="$1" root_device="$2" root_parent="$3" kind signatures
    if [[ "$device" == "$root_device" || "$device" == "$root_parent" ]]; then
        echo "Refusing to initialize the root device" >&2
        return 1
    fi
    if [[ $(lsblk -nr -o TYPE "$device") != disk ]]; then
        echo "Refusing a partitioned or stacked disk" >&2
        return 1
    fi
    kind=$(blkid -p -s TYPE -o value "$device" || true)
    case "$kind" in
        ext4) return 0 ;;
        "")
            if findmnt --noheadings --source "$device" >/dev/null; then
                echo "Refusing to format a mounted device" >&2
                return 1
            fi
            signatures=$(wipefs --no-act --noheadings --output TYPE "$device") || return 1
            if [[ -n "$signatures" ]]; then
                echo "Refusing a disk with unrecognized signatures" >&2
                return 1
            fi
            mkfs.ext4 -L taskforge-data "$device"
            ;;
        *)
            echo "Refusing an existing non-ext4 filesystem" >&2
            return 1
            ;;
    esac
}

mount_data_disk() {
    local device="$1" uuid expected existing
    uuid=$(blkid -s UUID -o value "$device")
    [[ "$uuid" =~ ^[a-fA-F0-9-]{36}$ ]]
    expected="UUID=$uuid"
    install -d -m 0755 "$DATA_MOUNT"
    existing=$(awk -v dest="$DATA_MOUNT" '$2 == dest {print $1}' /etc/fstab)
    if [[ -z "$existing" ]]; then
        printf '%s %s ext4 defaults,nofail,x-systemd.device-timeout=30s 0 2\n' "$expected" "$DATA_MOUNT" >> /etc/fstab
        systemctl daemon-reload
    elif [[ "$existing" != "$expected" ]]; then
        echo "Existing mount configuration references a different volume" >&2
        return 1
    fi
    if ! mountpoint -q "$DATA_MOUNT"; then mount "$DATA_MOUNT"; fi
    [[ $(findmnt -n --mountpoint "$DATA_MOUNT" -o UUID) == "$uuid" ]]
}

start_ssm_agent() {
    if systemctl cat amazon-ssm-agent.service >/dev/null 2>&1; then
        systemctl enable --now amazon-ssm-agent.service
    else
        if ! snap list amazon-ssm-agent >/dev/null 2>&1; then
            retry timeout 180 snap install amazon-ssm-agent --classic
        fi
        snap start --enable amazon-ssm-agent
    fi
}

install_docker() {
    # Configure storage before Docker's package post-install hook can start it.
    install -d -m 0755 /etc/docker /etc/systemd/system/docker.service.d /etc/apt/keyrings
    cat > /etc/docker/daemon.json <<'JSON'
{
  "data-root": "/srv/taskforge/docker",
  "features": {"containerd-snapshotter": false},
  "log-driver": "local",
  "log-opts": {"max-size": "10m", "max-file": "3"}
}
JSON
    cat > /etc/systemd/system/docker.service.d/10-taskforge-storage.conf <<'UNIT'
[Unit]
RequiresMountsFor=/srv/taskforge
[Service]
ExecStartPre=/usr/bin/mountpoint -q /srv/taskforge
UNIT
    systemctl daemon-reload
    retry apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=120 update
    retry apt-get -o DPkg::Lock::Timeout=120 install -y ca-certificates curl openssh-server
    retry curl --fail --silent --show-error --location --max-time 45 \
        "$DOCKER_APT_ORIGIN/gpg" -o /etc/apt/keyrings/docker.asc
    chmod 0644 /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: $DOCKER_APT_ORIGIN
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
    retry apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=120 update
    retry apt-get -o DPkg::Lock::Timeout=120 install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    systemctl enable docker.service
    systemctl restart docker.service
}

main() {
    [[ $EUID == 0 ]]
    umask 027
    exec 9>/run/taskforge-bootstrap.lock
    flock -n 9
    exec > >(tee -a /var/log/taskforge-bootstrap.log) 2>&1
    trap 'echo "Bootstrap failed at line $LINENO. Inspect the host log through SSM." >&2' ERR
    export DEBIAN_FRONTEND=noninteractive

    # shellcheck source=/dev/null
    source /etc/taskforge/bootstrap.env
    [[ "$TASKFORGE_VOLUME_ID" =~ ^vol-[0-9a-f]{17}$ ]]
    # shellcheck source=/dev/null
    source /etc/os-release
    [[ "$ID" == ubuntu && "$VERSION_CODENAME" == noble && $(uname -m) == x86_64 ]]
    install -d -m 0755 /var/lib/taskforge
    rm -f /var/lib/taskforge/bootstrap.ok
    start_ssm_agent

    local device root_device root_parent
    device=$(discover_data_disk "$(tr -d '-' <<< "$TASKFORGE_VOLUME_ID")")
    [[ -b "$device" ]]
    root_device=$(findmnt -n --mountpoint / -o SOURCE)
    root_parent=$(lsblk -ndo PKNAME "$root_device")
    if [[ -n "$root_parent" ]]; then root_parent="/dev/$root_parent"; fi
    prepare_filesystem "$device" "$root_device" "$root_parent"
    mount_data_disk "$device"
    install_docker

    # Keep on-disk release ownership stable when Terraform replaces the host.
    if ! getent group deploy >/dev/null; then
        groupadd --gid 1900 deploy
    fi
    if ! id deploy >/dev/null 2>&1; then
        useradd --create-home --uid 1900 --gid deploy --shell /bin/bash deploy
    fi
    if [[ $(id -u deploy) != 1900 || $(id -g deploy) != 1900 ]]; then
        echo "Existing deploy account does not match the persistent disk ownership" >&2
        return 1
    fi
    passwd -l deploy
    usermod -aG docker deploy
    install -d -o deploy -g deploy -m 0700 "$DEPLOY_ROOT" "$DEPLOY_ROOT/releases" "$DEPLOY_ROOT/incoming"

    cat > /etc/ssh/sshd_config.d/00-taskforge.conf <<'SSH'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers deploy
SSH
    sshd -t
    systemctl try-reload-or-restart ssh.service

    [[ $(docker info --format '{{.DockerRootDir}}') == "$DOCKER_ROOT" ]]
    runuser -u deploy -- docker compose version
    runuser -u deploy -- docker info --format '{{.ServerVersion}}'
    date -u +%FT%TZ > /var/lib/taskforge/bootstrap.ok
    echo "TaskForge host bootstrap complete"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
