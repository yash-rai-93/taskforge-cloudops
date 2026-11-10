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

Choose an existing DNS name you control and point its A record to the Terraform
Elastic IP. Review the `enable_public_web = true` change to expose the host TLS
proxy on ports 80 and 443. Keep Compose on the loopback binding from the
production environment example. Configure a host Caddy installation using your
actual DNS name, for example:

```caddyfile
taskforge.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Validate the configuration and check that the HTTPS certificate and name are
trusted before enabling automatic delivery. The proxy example needs a real DNS
name and an installed Caddy service. Leave the existing Nginx API and WebSocket
routing in the Compose release.

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

## Verify and record

- Save the release workflow URL and record the image digests from the host's
  active `current/release.json`. Check that the running API, worker and frontend
  use the referenced images.
- Verify public `/health` and `/login`. Sign up using a controlled mailbox,
  verify the email, and create a project, tasks and an asynchronous summary.
  Confirm the browser receives the worker's actual result.
- Restart the app services during a maintenance window. Confirm the project
  still exists and submit another summary.
- Verify the production job followed successful build and integration jobs.
  Record its public health evidence and test rollback with a known healthy
  previous release in a controlled window. A first release has no rollback
  target. Application rollback leaves database schema and persistent data in
  place.
