# TaskForge EC2 infrastructure

This stack prepares a dedicated Docker Compose host for the existing
[GHCR release workflow](../../docs/CI_CD.md). The first rollout uses a single
Ubuntu 24.04 x86-64 EC2 instance in Mumbai. Terraform creates an isolated VPC and
one public subnet. An Elastic IP gives the host outbound internet access and a
stable address for future DNS. All inbound traffic stays closed by default.
Use Systems Manager Session Manager for initial administration.

## Proposed resources and cost

The baseline uses `ap-south-1a`, Canonical AMI `ami-09d8c1e69d114dbf7`, and a
`t3.medium` with 2 vCPUs and 4 GiB RAM. It uses standard CPU credits to avoid
unlimited-mode surplus charges. Sustained CPU load can throttle once credits run
out. Builds stay on GitHub runners.

| Item | Rate | 730-hour month |
| --- | --- | ---: |
| Linux t3.medium on demand | USD 0.0448/hour | USD 32.70 |
| 12 GiB root and 20 GiB data gp3 disks | USD 0.0912/GiB-month | USD 2.92 |
| One Elastic IP | USD 0.005/hour | USD 3.65 |
| **Baseline total** | | **USD 39.27** |

Rates were checked on 10 November 2026 against the AWS Price List for Mumbai and
[Amazon VPC pricing](https://aws.amazon.com/vpc/pricing/). Allow separately for
taxes, outbound transfer, snapshots, DNS and optional monitoring. Stopping the
instance leaves disk and Elastic IP charges, about USD 6.57/month at these sizes.
Credit eligibility and expiration depend on the account.

The baseline plan contains 16 resources. It includes the instance, separate data
disk and attachment, Elastic IP and association, VPC, subnet, internet gateway,
route table and association, security group, two outbound rules, EC2 role,
instance profile and Systems Manager policy attachment. It adds no NAT gateway,
load balancer, database service or paid monitoring. The Mumbai inventory check
found the default VPC and no active or stopped EC2 instances, EBS volumes or
Elastic IPs. The region had quotas of 32 standard on-demand vCPUs and 5 Elastic
IPs, and all three zones offered the selected instance type.

The AWS provider restricts operations to the expected account. The host
requires IMDSv2 with response hop limit 1 and uses the AWS-managed SSM node role.
Both EBS disks are encrypted. Ingress rules for public 80/443 and static SSH
clients are explicit opt-ins. There are no rules for PostgreSQL, Redis or the
Compose HTTP port. Outbound HTTP/HTTPS supports OS packages, GHCR and SSM.

## Validate and review the live plan

Use Terraform 1.11 or later and a short-lived AWS profile authorized for the
target account. Keep the working directory and Terraform state in a private,
durable location. Use an encrypted backup of local state, or configure an
existing locked remote backend before applying. This module does not create a
backend bucket.

```bash
cd infra/aws
terraform init -backend=false -lockfile=readonly
terraform fmt -check -recursive
terraform validate
terraform test
bash tests/bootstrap-test.sh
```

The test provider mocks AWS. These checks validate the configuration, default
closed ingress, the optional web/SSH rules, and disk protections without
creating resources. A real plan requires Terraform credentials in addition to
any AWS connector session.

Copy `terraform.tfvars.example` to the ignored `terraform.tfvars` and supply the
expected account ID. Check the pinned AMI and zone for your target region. Keep
public web and SSH disabled for the first bootstrap. With an authorized profile,
run these commands from `infra/aws`:

```bash
terraform init -lockfile=readonly
terraform plan -out=taskforge.tfplan
terraform show -no-color taskforge.tfplan
```

Review every proposed resource and its cost before applying the saved plan.
Keep the saved plan and state out of Git and CI artifacts. After approval, apply
the reviewed plan with `terraform apply taskforge.tfplan`. Re-plan if the code,
account, region, pricing assumptions or requested inputs change.

## Bootstrap and host checks

Cloud-init receives the bootstrap program and the data volume ID. It starts
the SSM agent, waits for the EBS attachment by its NVMe serial, and creates ext4
only on a blank, unmounted disk. The bootstrap refuses the root device, disks
with partitions, unfamiliar filesystems and mount conflicts. It mounts by
filesystem UUID at `/srv/taskforge` and makes Docker refuse startup if that mount
is missing. Docker's signed apt repository supplies the engine and Compose
plugin. Docker data, PostgreSQL and Redis volumes, and release directories live
on the separate disk.

The `deploy` user owns `/srv/taskforge/deploy` and can run Docker. UID and GID
1900 preserve ownership when the host is replaced. Docker access
is equivalent to host administration. Treat the deployment key and the SSM
operator role accordingly. SSH password authentication and root SSH login are
disabled. Bootstrap leaves authorized keys empty. App credentials, registry
credentials and SSH keys are provisioned separately after the host is verified.

Use the instance ID output to open Session Manager. For CLI sessions install
the Session Manager plugin. Run these checks in the host session:

```bash
sudo cloud-init status --wait
sudo test -f /var/lib/taskforge/bootstrap.ok
findmnt --mountpoint /srv/taskforge
sudo docker info --format '{{.DockerRootDir}}'
sudo -u deploy docker compose version
sudo -u deploy docker info --format '{{.ServerVersion}}'
```

Expect a successful cloud-init status and Docker root `/srv/taskforge/docker`.
For a failed boot, inspect `/var/log/taskforge-bootstrap.log` and
`/var/log/cloud-init-output.log` through SSM. The bootstrap can be rerun as root
after correcting the failure. It reapplies the managed Docker config and
restarts Docker, so use a maintenance window once the host serves traffic.

## First release and automated delivery

The published main release uses the same three digest-pinned images that passed
Compose. Download its release artifact and verify its checksum. Use the
existing deploy helper with the persistent root `/srv/taskforge/deploy`. First
configure a private mode-600 `.env.production` owned by `deploy` and registry pull
access if packages are private. Keep Compose bound to loopback with
`HTTP_PORT=127.0.0.1:8080` and place a TLS proxy in front of it. Test image pulls,
health and the real job flow before enabling production delivery.

For the existing direct SSH workflow, give a trusted static-egress deployment
runner an approved narrow CIDR, install its public key through SSM and verify
the new host fingerprint through SSM before adding it to GitHub. For GitHub-hosted runners, use the opt-in SSM transport documented in the
[production runbook](../../docs/PRODUCTION.md). That path keeps inbound SSH
closed. Keep `AWS_DEPLOY_ENABLED` unset until the runner route,
DNS, TLS, registry access, production environment and first healthy rollout are
verified.

## Persistence and cleanup

The data volume survives instance replacement and is protected by Terraform
`prevent_destroy`. The root volume is deleted on termination. A bootstrap or AMI
change replaces the host, so review the plan and schedule downtime. Reinstall
any host-local SSH authorization and registry login, and verify the replacement
host key before re-enabling direct SSH delivery. Keep
database backups and test restoration separately. Disk retention is not a backup.
If decommissioning the stack, verify the backup and explicitly review removal of
the data-volume deletion guard. Release the Elastic IP when the stack is retired.
