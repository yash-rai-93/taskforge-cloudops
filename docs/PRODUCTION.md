# TaskForge production rollout

The production workflow deploys the same checksummed, digest-pinned release
bundle tested and published by GitHub Actions. The SSM transport runs the
existing SSH and SCP commands inside a Session Manager tunnel. Host-key
verification, the dedicated deploy user, Docker health checks, migrations and
release rollback continue to use the existing helpers.

## Prepare and approve infrastructure

Use the [Terraform guide](../infra/aws/README.md) to generate and review an
account-backed plan. The default stack keeps all inbound ports closed. Set
`enable_ssm_cd = true` in the reviewed plan to add the GitHub OIDC provider, role
and inline SSM policy. If the account already has GitHub's OIDC provider, import
that provider into the Terraform resource before applying. The role trusts the
exact immutable GitHub subject for this repository's `production` environment,
and authorizes SSH sessions to the Terraform host. Keep `ssh_ipv4_cidrs = []`.

Provision after approval and verify cloud-init, the persistent mount and Docker
through an operator's SSM session. Check that the node reports Online. Provision
app and SSH credentials through an authorized channel. Use a dedicated
deployment key, install only its public key under the host's `deploy` account
and store the private key in the GitHub production environment.

## Configure the first HTTPS rollout

The current deployment uses the Mumbai EC2 Elastic IP directly at
[https://13.205.250.123](https://13.205.250.123). Its security group admits public
TCP 80/443. Caddy terminates TLS on the host and forwards to the Compose Nginx
proxy at `127.0.0.1:8080`. Nginx forwards API and WebSocket traffic to NestJS
and page requests to Next.js. PostgreSQL and Redis stay on the internal data
network. SSH access uses Session Manager.

For the current IP deployment, the host Caddy configuration uses a trusted
Let's Encrypt short-lived IP certificate. Set the default SNI to the IP so
clients that omit SNI still receive that certificate. Replace the IP in both
places when reproducing the deployment:

```caddyfile
{
    default_sni 13.205.250.123
}
https://13.205.250.123 {
    tls {
        issuer acme {
            profile shortlived
        }
    }
    reverse_proxy 127.0.0.1:8080
}
```

Validate the configuration and check that the HTTPS certificate and name are
trusted before enabling automatic delivery. Use a Caddy version that supports the
ACME shortlived profile and keep ports 80/443 reachable for renewal. A DNS name pointing to the Elastic IP is
another supported configuration.

Create `/srv/taskforge/deploy/.env.production` on the host, owned by `deploy` with
mode 600. Supply generated database, Redis and JWT credentials privately and
set `FRONTEND_URL` to the public HTTPS origin. Give the deploy account GHCR
pull access if the packages are private. For signup verification, configure an
existing SMTP provider with `SMTP_ENABLED=true`, `SMTP_SECURE=true`,
`SMTP_PORT=465`, and the provider's hostname and credentials. Review
`enable_smtp_egress = true` for that path. Leave SMTP disabled until provider
credentials and a verified sender are available.

## Configure GitHub production

Restrict the `production` environment to the `main` branch before applying the
OIDC role. Keep the repository variable `AWS_DEPLOY_ENABLED` unset until the
host, SSH key, registry access and HTTPS proxy are ready.

| Setting | Scope | Value |
| --- | --- | --- |
| `DEPLOY_TRANSPORT` | Environment variable | `ssm` |
| `AWS_DEPLOY_REGION` | Environment variable | Region of the provisioned instance |
| `AWS_DEPLOY_ROLE_ARN` | Environment variable | Terraform `github_deploy_role_arn` output |
| `DEPLOY_HOST` | Environment variable | Terraform EC2 instance ID |
| `DEPLOY_USER` | Environment variable | `deploy` |
| `DEPLOY_ROOT` | Environment variable | `/srv/taskforge/deploy` |
| `PRODUCTION_URL` | Environment variable | Public HTTPS origin without a trailing slash |
| `DEPLOY_SSH_KEY` | Environment secret | Dedicated private SSH key |
| `DEPLOY_KNOWN_HOSTS` | Environment secret | Verified host public-key entry keyed by the EC2 instance ID |

Obtain the SSH host public key through your independent operator SSM session.
Build the known-hosts entry from that key and the instance ID, then verify its
fingerprint. Do not use an unauthenticated key scan. Repeat this step if the host
is replaced. When all prerequisites are ready, enable `AWS_DEPLOY_ENABLED` and
run a reviewed release on `main`. The workflow assumes a short-lived role via
GitHub OIDC and verifies the API and Next.js login page over public HTTPS. Direct
SSH remains available with `DEPLOY_TRANSPORT=ssh`.

## Operate and recover

Install the reviewed host helper from a checkout transferred through an operator
session. The command installs two systemd timers, takes an initial backup and
runs the health check. It expects the data disk already mounted at
`/srv/taskforge`.

```bash
sudo bash scripts/production-ops.sh install https://13.205.250.123
sudo systemctl list-timers 'taskforge-*'
sudo journalctl -u taskforge-check.service -u taskforge-backup.service --since today
```

- **Every five minutes:** check all six long-running containers, restart counts,
  the data mount, disk usage, backup freshness and trusted HTTPS through Caddy.
  A failed check appears as a failed systemd unit and in the journal. The probe
  connects to loopback while validating the public IP certificate.
- **Infrastructure:** EC2 CloudWatch basic monitoring provides CPU utilization,
  CPU credits, network metrics and instance status. The host journal provides
  memory and disk observations. Use `docker stats --no-stream` for per-container
  usage. The GitHub **Production public smoke** workflow is a separate,
  credential-free check from outside EC2. Host checks currently have no pager or
  CloudWatch log shipping.
- **Triage:** use Session Manager, check the failed unit, then inspect
  `docker ps -a`, bounded logs for the failing service, and
  `journalctl -u caddy` for HTTPS errors. Look at restart counts, OOM status,
  disk utilization and CPU credits before restarting a service. Keep logs
  private and redact before sharing. A Docker health failure alone does not
  restart a running process. Restart policies recover eligible process exits.
- **Backups:** PostgreSQL uses a named volume on encrypted EBS. A daily
  PostgreSQL custom-format dump runs at 02:15 UTC, validates its archive and
  retains about seven days under the root-only `/srv/taskforge/backups`
  directory. Redis uses a persistent volume and AOF. Local dumps cover logical
  recovery and accidental edits. A lost disk or instance can still take the
  local copies with it. Off-host backups and alerts need separate setup.
- **Restore drill:** select an archive and run the following. It starts a
  network-isolated temporary PostgreSQL container, verifies the project table
  and removes the container. A large database may require a separate host or
  larger test capacity. For actual recovery, restore into a separate database
  and validate it before planning a cutover.

```bash
sudo /usr/local/lib/taskforge/production-ops.sh restore-check \
  /srv/taskforge/backups/taskforge-YYYYMMDDTHHMMSSZ.dump
```

- **Release rollback:** when both `current` and `previous` exist, use
  `sudo -u deploy python3 -B /srv/taskforge/deploy/current/scripts/deploy.py --root /srv/taskforge/deploy --repository yash-rai-93/taskforge-cloudops --rollback`.
  The script waits for the restored application and probes it. Rollback retains
  PostgreSQL and Redis volumes and does not reverse migrations. Take a checked
  backup before schema changes and use backward-compatible migrations. A first
  release cannot roll back in place.

## Assessment evidence and remaining work

| Requirement | Evidence and limits |
| --- | --- |
| 1. Containerization | Three Dockerfiles, supporting services, one-command Compose, health checks and persistent volumes. Main CI built and smoke-tested the stack. |
| 2. Automated release | [Main release 42784350190](https://github.com/yash-rai-93/taskforge-cloudops/actions/runs/42784350190) passed lint, tests, audits, image builds, Compose smoke and digest-pinned GHCR publishing. The initial production job was skipped. [Run 42828875258](https://github.com/yash-rai-93/taskforge-cloudops/actions/runs/42828875258) subsequently completed automatic production deployment on its first attempt. |
| 3. AWS deployment | On 10 November 2026, EC2 was verified running release `400c8effe8583956cc1ef4a23dc192f85bb6db2c` (v2.0.0). All three running image references matched the release manifest. Trusted host-side HTTPS reached the frontend and API. The AWS security group exposes only web ports, and both EBS volumes are encrypted. |
| 4. Redis worker | Authenticated production HTTPS project read and report submission passed. A report stayed queued during a controlled worker stop and completed at 100% with a result after restart. CI covers the browser UI in its Compose stack. Capture the public browser flow with the verified demo account for the submission. |
| 5. Reliability and documentation | Host health check detected the stopped worker. The first scheduled-backup setup produced a valid PostgreSQL dump, which restored into an isolated container with the demo project. The CI disposable rollout verifies rollback. Production retains a previous release. Live production rollback has not been exercised. |
| Submission | The repository and architecture diagrams are in [container operations](CONTAINERS.md) and the README. Submit the public URL and a recording of the running stack under 180 seconds. Use the verified demo account while SMTP remains disabled and keep credentials out of the recording. |
