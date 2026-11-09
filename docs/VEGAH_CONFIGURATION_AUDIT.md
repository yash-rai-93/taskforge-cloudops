# VEGAH configuration audit

## Scope and provenance

Audited base: `31a9fd6a4ef39147c6f7bde21186215d2451a0d3`, branch `main`,
public repository <https://github.com/yash-rai-93/taskforge-cloudops>.
GitHub reports a standalone repository, not a GitHub fork relationship. The local
`origin` points only to that repository. Upstream is
<https://github.com/engmaryamameen/TaskForge>; retain its copyright and MIT license.
The assessment was read; a separate job description was not supplied.

Inherited: Next.js UI, NestJS REST/auth/organizations/projects/tasks, TypeORM
migrations, Redis/cache, queue classes, worker entry point, Socket.IO, SMTP/billing,
backend Dockerfile, Compose, Nginx, CI and deployment/rollback scripts.
This change prepares ownership and configuration; it does not deliver an AWS
installation, complete containerization or the assessment's end-to-end worker flow.
No cloud resources were created and no application images were published by this PR.
PR CI can build the API image without publishing; frontend/worker builds remain deferred.

## Findings and disposition

| Finding | Disposition |
| --- | --- |
| Latest base commit deleted `LICENSE`; historical MIT notice names engmaryamameen | **Fixed now:** restore exact notice from `d5756f6`, checked against upstream |
| README linked inherited `task-forge-demo.vercel.app` and a demo account | **Fixed now:** remove demo/account advertising, identify inherited features/screenshots, state no independent deployment URL |
| Production image was `ghcr.io/yash-rai-93/taskforge-backend`; CI used owner plus fixed `taskforge-backend` | **Fixed now:** derive lowercased full repository namespace in CI; coordinated image contracts below |
| Production defaulted to `latest`, CI emitted short SHA and latest | **Fixed now:** full commit-SHA CI tag, required production tags, strict full-SHA deployment helper input |
| Production example described Neon/Upstash while Compose hardcoded internal services | **Fixed now:** examples describe internal PostgreSQL/Redis; no inherited provider endpoint is required |
| Missing frontend environment example and inconsistent port 3000/3001 frontend links | **Fixed now:** track frontend example, align local origin and billing redirects with port 3001 / configured `FRONTEND_URL` |
| SMTP keys were documented but not forwarded through production Compose | **Fixed now:** forward optional settings; blank credentials disable delivery |
| Optional empty Stripe key threw `Neither apiKey nor config.authenticator provided` during construction | **Fixed now:** conditional SDK construction, disabled-operation guard and skip external customer initialization when disabled; preserve configured billing |
| JWT/database source configuration contained fallback credentials | **Fixed now:** remove credential fallbacks; retain required NestJS validation |
| Real env/private-key filenames were incompletely ignored; backend Docker ignore excluded only `.env` | **Fixed now:** expand Git and application build-context exclusions; explicitly permit examples and the synthetic test fixture |
| Local API, database and Redis ports bound all host interfaces | **Fixed now:** bind published development ports to `127.0.0.1`; production DB/Redis have no published ports |
| Production Redis had no authentication | **Fixed now:** require `REDIS_PASSWORD` for server and clients; health probe uses `REDISCLI_AUTH` without a password argument |
| API and worker reused one Dockerfile/image | **Docker phase:** worker gets a separate image reference now; its Dockerfile/build/publishing do not yet exist |
| Frontend absent from both Compose files; no frontend Dockerfile | **Docker phase:** frontend image extension is a planned contract, not a running service |
| Backend runtime image omits dev dependencies, but local Compose sets development mode which requests `pino-pretty` | **Docker phase:** repair fully containerized development mode; supported interim development runs Node on host plus Compose DB/Redis |
| Nginx `/` returns 404, only API/Socket.IO/health proxying exists; HTTP only | **Docker/AWS phases:** add frontend routing, verify WebSocket upgrade and configure HTTPS |
| API `app.enableCors()` and gateway CORS are permissive | **Later security phase:** constrain production origins and verify browser behavior; currently unchanged |
| Normal activity listener persists directly; BullMQ activity consumer exists but no job-status/result demonstration | **Worker phase:** implement actual frontend -> queue -> dedicated worker -> result API flow |
| `invoice.failed` is queued to notifications but no notifications consumer was found | **Worker/billing follow-up:** do not claim this queue is processed |
| Existing Jest command passes without tests | **CI phase:** add substantive application tests; this change adds a separate compiled configuration regression check after build |
| Restart policies, worker health, Redis persistence/eviction policy, backups, monitoring and automatic rollback absent | **Reliability phase:** implementation and failure testing required |
| Manual helper records one shared SHA and checks API/worker only; warning-only worker initialization check | **CD phase:** complete frontend checks, release manifest, migration compatibility and automatic rollback; do not treat helper success as assessment readiness |
| `frontend/vercel.json` and ignore-build script contain generic provider behavior, no account/project IDs | **Safe unchanged:** inert repository files; external Vercel connections cannot be established or ruled out by source inspection |
| Source localhost fallbacks, Postman localhost URL, API port 3000 / frontend 3001, DB 5432 / Redis 6379 | **Safe for local/internal use:** public frontend build must explicitly use your own origin; never embed container DNS names in browser URLs |
| Development/test credentials, including CI service fixtures, are hardcoded | **Safe locally only:** synthetic, isolated fixtures; never reuse in production |
| Generic provider documentation, schema URLs, SVG namespace URLs | **Safe unchanged:** not original-owner infrastructure |

No original-owner registry path remains in executable configuration. Original-author
references in this document, README and LICENSE are intentional attribution.
No repository-specific deployment secret names, AWS account IDs, fixed EC2 host,
deployment directory or OAuth credentials were found in the tracked configuration.
OAuth appears only as a future design idea, not an active integration.

## Image and deployment configuration contract

`IMAGE_NAMESPACE=ghcr.io/yash-rai-93/taskforge-cloudops` is the only production
namespace setting. CI derives the equivalent from lowercased `github.repository`,
so a future rename/fork requires updating the deployment environment, not workflow
source. Package existence and GHCR package permissions have **not** been verified.

| Role | Planned image | Version input | Current state |
| --- | --- | --- | --- |
| API and migration | `${IMAGE_NAMESPACE}-api` | `API_IMAGE_TAG` | Existing backend build is retargeted here; publishes only after main-push checks |
| Worker | `${IMAGE_NAMESPACE}-worker` | `WORKER_IMAGE_TAG` | Separate production reference prepared; dedicated Dockerfile/build deferred |
| Frontend | `${IMAGE_NAMESPACE}-frontend` | `FRONTEND_IMAGE_TAG` | `x-frontend-image` extension only; Dockerfile/service/build deferred |

Set each tag to a full 40-character lowercase commit SHA that was actually built
and published. There is no `latest` fallback. Compose requires nonempty tags but
cannot validate their format or prove that an image exists; the manual deployment
helper rejects non-SHA input. `scripts/deploy.sh <full-SHA>` sets all three tags to
the same release SHA; it cannot safely restore an arbitrary mixed-version release.
The inherited rollback helper is correspondingly limited to shared-SHA releases.
Historical short-SHA/latest deployment records are not accepted by the updated helper.

Production Compose alone is preparatory and must not be overlaid on the development
file (an overlay could reintroduce published DB/Redis ports). It keeps a one-shot
migration dependency using the API image, then starts API/worker. The API command
overrides the Dockerfile CMD, preventing a second automatic migration in that
service. Migration compatibility, ordering and retries require container tests.
The PostgreSQL named volume is retained; never use `down -v` on valuable data.
Local and production deployments on one host need distinct Compose project names
to avoid sharing the default project-scoped `pgdata` volume.

## Environment variables

Examples: `backend/.env.example` (host development),
`frontend/.env.local.example` (browser build), `.env.production.example` (future EC2).
No existing source-consumed variable was renamed. The obsolete deployment `TAG`
setting is replaced by independent image tags; a local shell `TAG` inside the
manual helper is just its validated release argument.

| Variables | Purpose / timing | Required / security |
| --- | --- | --- |
| `IMAGE_NAMESPACE` | Compose image prefix, lowercased GHCR owner/repository | Required production deployment setting; public |
| `API_IMAGE_TAG`, `WORKER_IMAGE_TAG`, `FRONTEND_IMAGE_TAG` | Independent image versions | Required full commit SHAs; frontend is still a planned extension |
| `NODE_ENV`, `PORT` | Node runtime and API listener | Local example development/3000; production Compose fixes production/3000 |
| `DB_HOST`, `DB_PORT` | PostgreSQL runtime endpoint | Host local: localhost/5432; production Compose fixes postgres/5432, not editable env-file knobs |
| `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` | Database name, role and credential | Required; password secret, production blank until privately set |
| `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED` | Optional source-supported DB TLS | Local/internal TLS disabled; production Compose fixes false/true. External DB adoption needs deliberate coordinated changes; never disable certificate verification as a routine fix |
| `REDIS_HOST`, `REDIS_PORT` | Redis runtime endpoint | Host local: localhost/6379; production Compose fixes redis/6379 |
| `REDIS_PASSWORD` | Redis authentication | Optional empty locally; required and forwarded to Redis/API/worker in production |
| `REDIS_TLS` | Source-supported Redis TLS | false for current internal Redis; not an external TLS endpoint |
| `JWT_SECRET` | Signing secret at runtime | Required, at least 32 characters; generate a unique value privately, no shipped production fallback |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` | Token lifetimes | Optional defaults 15m/7d |
| `FRONTEND_URL` | Email links and billing redirects at runtime | Required production public origin; local http://localhost:3001; no trailing slash |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SOCKET_URL` | Browser-visible build-time origins | Both required operationally for public builds; no suffix paths and no secrets. Empty uses localhost, not same-origin. Frontend build wiring is deferred |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Optional billing API/signature credentials | Secret; leave both blank for assessment. Disabled Stripe skips external initialization; paid operations unavailable; webhook input is still rejected |
| `STRIPE_PRICE_ID_PRO`, `STRIPE_PRICE_ID_ENTERPRISE` | Optional billing price IDs | Public configuration; leave blank while Stripe disabled |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Optional mail endpoint; defaults localhost/587/false | Set your own provider and transport mode; use literal true/false |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Optional SMTP credentials and sender | Password secret; delivery disabled unless both user and password set |

Stripe SDK initialization is now optional; the existing no-subscription path returns
free entitlements. This does not simulate Stripe customers, payments or subscriptions.
SMTP construction and disabled delivery are verified without a mail server. However,
registration requires email verification before login. SMTP cannot be omitted from
a public self-service signup demo without a deliberate alternative onboarding decision.
Preview/debug email text can contain verification/reset/invitation tokens: protect logs
and never include them in screenshots, PRs, walkthroughs or public monitoring.

## GitHub secrets and AWS settings

Current CI audits both backend and frontend dependency locks at the unchanged
`--audit-level=high` threshold. It needs only the automatically supplied `GITHUB_TOKEN`; package writes are
scoped to the Docker job, GHCR login/push only runs on main pushes, and PRs build
without login/push. Backend quality/test/build gates are retained; a configuration
regression check is added after build. Frontend/worker publishing and all CD remain
deferred. No workflow deployment credentials are introduced by this change.

Before the AWS phase, approve region, Ubuntu AMI/architecture, EC2 instance type,
root/EBS size and encryption, storage retention/backups, public IP/DNS/domain, HTTPS
method, IAM role, security groups, monitoring/log retention and estimated monthly
cost (compute, EBS, public IPv4, DNS, logs and any backups/transfer). No resources or
billing changes are authorized by this PR. Use only your own account and endpoints.

Future deployment transport must be selected before naming secrets: prefer scoped
AWS OIDC plus SSM where feasible, or tightly scoped SSH with a restricted deploy key
and verified host key. Region/host/domain/role identifiers are configuration, not
application secrets. Private keys/tokens belong in GitHub/environment secret stores;
never place AWS access keys in application containers. Private GHCR pulls may require
a narrowly scoped read-packages credential; public packages may not. Provision neither
until package visibility and the deployment method have been decided.

## Validation and reproducible commands

Run from the repository root unless stated. These commands do not deploy:

```bash
git diff --check
bash -n scripts/deploy.sh scripts/rollback.sh backend/scripts/start-api-prod.sh
(cd backend && npm ci && npm run lint:check && npm run build)
(cd backend && node scripts/verify-build.mjs && node scripts/verify-config.cjs)
(cd backend && npm test -- --runInBand)
(cd backend && npm audit --audit-level=high)
(cd frontend && npm ci && npm run type-check && npm run build)
docker compose -f docker-compose.yml config --quiet
# Use a private, filled config or temporary synthetic fixture. Never print config:
docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet
```

Validation performed for this change:

- Clean `npm ci` completed in backend and frontend after the dependency remediation
  described below; both package manifests and lockfiles are intentionally updated.
- Backend lint, TypeScript build, compiled output verification (main/worker plus
  seven migrations), and compiled configuration regression assertions passed.
  The assertions exercise Nest dependency injection without a Stripe key,
  disabled Stripe calls before networking, configured SDK construction, disabled
  billing initialization, disabled SMTP delivery and missing/short required env.
  Configured verification/reset/invitation/task-assignment email templates also
  passed real Nodemailer JSON message compilation without SMTP/network delivery.
- Frontend type check and full Next.js production build passed, including its
  lint/type stage and static page generation. No browser or backend integration test.
- Existing `npm test -- --runInBand` exited 0 with **no tests found**. This is not
  application test coverage; the separate configuration regression script ran.
- Official standalone Compose v2.39.4 (release checksum checked) parsed both files.
  Synthetic fixture checks verified three independent SHA tags, migration/API image
  agreement, shared Redis authentication, internal DB/Redis hosts, no production
  DB/Redis port publication, local loopback bindings and local frontend origin.
  Each required production setting was omitted in turn and correctly rejected;
  the unfilled production example was rejected. Resolved secrets were not printed.
- The initial inherited backend audit failed with 42 findings (3 low, 25 moderate,
  12 high, 2 critical). Following remediation, `npm audit --audit-level=high`
  passes for both applications: backend 29 findings (5 low, 24 moderate), frontend
  6 moderate findings, **zero high/critical findings in either**. The initial
  frontend baseline was 19 findings (7 moderate, 11 high, 1 critical).
  These counts describe the registry advisory snapshot at validation, not a guarantee
  of vulnerability-free software. No audit suppression, `--force`, or threshold change.
- Git ignore, attribution, secret-pattern, shell syntax and final diff checks are
  recorded in the PR. Current-tree pattern checks are not proof that all secrets
  are absent from the complete Git history.

Docker Engine is not installed locally. No application startup, migration,
authenticated Redis health probe, HTTP/WebSocket public routing, AWS permissions,
application registry publishing or job flow was exercised. Compose interpolation
validates configuration, not deployment. Initial configuration checks used Node 24;
dependency-remediation clean installs, backend lint/build/configuration checks and
frontend type-check/build were rerun with **Node 20.20.2**, matching CI/Docker's Node
20 target. Consult the PR checks for remote Actions results; local checks alone do
not establish remote CI success.

## Dependency audit remediation

The previous combined Lint & Security job passed lint but failed its backend audit;
Build and Docker Build & Push were skipped. This follow-up updates vulnerable
packages and retains the quality gate. Frontend lockfile auditing is now also a
step in that same job; it works without installing frontend dependencies there.

- Refresh compatible locked dependencies, including Express/body-parser/proxy-addr,
  Socket.IO's parser/Engine.IO/ws, Joi, BullMQ, TypeORM, Axios, Next.js and tooling.
  Raise direct minimums for the affected API adapter, Joi, BullMQ, Axios and Next.js.
- Upgrade Nodemailer 8 to **10.4.0**. Its bundled README/changelog specify Node 20+
  and bundled TypeScript types; remove redundant `@types/nodemailer`. The application
  uses supported CommonJS/createTransport/sendMail APIs. Version 9's stricter TLS
  verification is preserved; no certificate-verification bypass is introduced.
  Configured and disabled email paths are tested with synthetic inputs only;
  actual provider credentials and SMTP delivery remain unverified.
- Keep Next.js on **15.5.29** and align `eslint-config-next` to that version.
  Next 15 pins an older PostCSS; a **scoped, same-major** override of its PostCSS
  to `^8.5.32` removes the remaining high-severity advisory without a Next 16 migration.
  The clean production build tests that compatibility. Review/remove the override
  when a future Next release directly uses a sufficiently patched PostCSS.
- Update `brace-expansion` within its compatible version ranges. No blanket
  cross-major override of minimatch/glob and no forced framework downgrade/upgrade.

Residual findings: backend includes low/moderate deepmerge, glob and minimatch
chains through CLI/Jest/TypeScript lint tooling and **runtime TypeORM migration
file discovery**; frontend's six moderate findings are in TypeScript ESLint/minimatch
build tooling. Do not describe all residual backend findings as development-only.
Review these separately before final submission/deployment, particularly any use
of untrusted glob patterns or migration files. The `high` threshold is unchanged;
it permits these lower-severity reports and does not suppress them.

## Next phase dependencies and optional improvements

Complete dedicated frontend/worker Dockerfiles and build contexts; wire frontend
build-time origins; add frontend Compose service and reverse-proxy routing; validate
API/migrations/authenticated Redis and local runtime dependencies inside containers.
Publish all three images only after checks pass and test actual package permissions.
Review the residual lower-severity findings before final submission/deployment. Then implement the
real worker demonstration, HTTPS, restart/health policies, backups/restore, constrained
origins, OIDC/SSM or SSH deployment, rollback and CloudWatch with separately approved
AWS resources/costs. Record the actual walkthrough in less than 180 seconds.

Optional improvements: pin actions to reviewed commit SHAs, pin base/service images
to reviewed digests, rotate application secrets using a managed store, reduce runtime
secret exposure through Docker secrets where supported, and formalize separate local
and production Compose project names. Docker environment secrets are readable by
host/Docker administrators; Git ignores and private networking do not replace access
control. The repository UI/hosting integration state and existing external connections
need a separate settings review before future publishing.
