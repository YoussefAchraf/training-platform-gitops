# training-platform-gitops

GitOps repository for **training-platform** — a B2B training-delivery
management SaaS. This repo is the single source of truth for how the
platform's backend, frontend, chatbot, database, secrets management, and
observability stack are deployed to Kubernetes/OpenShift, via ArgoCD's
app-of-apps pattern. Today it runs against a locally-installed **OKD**
cluster (CRC); the same charts are designed to carry over to a real
**OpenShift** cluster with environment-level changes only — see
[OKD → OpenShift migration](#okd--openshift-migration).

No manifest in this repo is ever applied by hand. Aside from one true
chicken-and-egg bootstrap step (installing ArgoCD itself), every change here
reaches the cluster the same way: `git push` → ArgoCD notices → ArgoCD
reconciles. This repo's own CI never runs `helm upgrade`, `oc apply`, or
`argocd app sync` — it only validates.

---

## Contents

- [The platform](#the-platform)
- [Repository layout](#repository-layout)
- [Architecture](#architecture)
- [Technologies used](#technologies-used)
- [Deployment topology](#deployment-topology)
- [Secrets architecture](#secrets-architecture)
- [CI/CD pipeline](#cicd-pipeline)
- [Security policy enforcement](#security-policy-enforcement)
- [Bootstrapping a fresh cluster](#bootstrapping-a-fresh-cluster)
- [Day-2 operations](#day-2-operations)
- [OKD → OpenShift migration](#okd--openshift-migration)
- [Creating a SuperAdmin account](#creating-a-superadmin-account)
- [Creating a Developer account](#creating-a-developer-account)
- [Git workflow](#git-workflow)

---

## The platform

Four roles — **Sales**, **Manager**, **Instructor**, **SuperAdmin** — manage
a pipeline: providers → trainings → client sessions → instructor assignment
→ attendee QR feedback surveys → auto-generated PDF/NPS reports. An optional
AI chat widget, backed by an n8n workflow stack, gives each role a
role-scoped assistant. A fifth role, **Developer**, sits outside that
pipeline entirely — no chat agent, no self-signup, no bypass of the other
roles' authorization checks — and exists only to read feedback reports the
other four roles submit and publish feature announcements back to them.

The platform is four independently-versioned repositories:

| Repo | What it is |
|---|---|
| `training-platform-backend` | REST API — Node.js/TypeScript/Express, Clean Architecture, PostgreSQL, Redis |
| `training-platform-frontend` | React 19 + TypeScript SPA, installable PWA with push notifications |
| `training-platform-chatbot-n8n` | An n8n workflow stack: one routing "trunk" workflow feeding four role-specific agents, each wired to its own tool subset |
| `training-platform-gitops` | **This repo** — turns the three above into one GitOps-deployed stack |

Each app repo builds and publishes its own container image to GHCR on merge
to `main`; this repo only ever references an already-published image tag —
it never builds or pushes one itself.

---

## Repository layout

```
bootstrap/               applied by hand, once — creates the OKD projects,
                          installs ArgoCD itself, and the root "app of apps"
                          Application that owns everything else from then on

argocd/apps/              one ArgoCD Application per deployable unit —
                          backend, frontend, chatbot, postgres, vault,
                          monitoring, monitoring-routes, kube-green,
                          kube-green-sleepinfo — each syncs, rolls back, and
                          reports health independently

charts/                   Helm charts:
                            first-party: backend, frontend, postgres, chatbot
                              (chatbot bundles n8n + its own redis +
                              metrics-exporter as one logical unit)
                            thin wrappers around upstream charts: vault
                              (hashicorp/vault), monitoring
                              (kube-prometheus-stack), kube-green
                            plain manifest directories (no Chart.yaml, not
                              Helm charts): kube-green-sleepinfo,
                              monitoring-routes' Route split

environments/local-okd/   non-secret value overrides for this one
                          environment, plus *-secrets.example.yaml
                          templates (real secret files are gitignored,
                          never committed — see Secrets architecture)

policy/security.rego      OPA policy, enforced in CI against every
                          first-party chart's rendered output

scripts/                  vault-bootstrap-secrets.js — the only application
                          code in this repo

.github/workflows/        CI: validation only, never deployment
```

A new target environment (a second local cluster, staging, a real
OpenShift cluster) is a new `environments/<name>/` directory plus a
`targetRevision`/`valueFiles` change in `argocd/apps/*.yaml` — the charts
themselves don't change per environment.

---

## Architecture

### App-of-apps, not one flat chart

Applying **one file** (`bootstrap/02-root-app.yaml`) bootstraps everything
else. ArgoCD reads `argocd/apps/` in this repo and creates one child
`Application` per file; each syncs, rolls back, and reports health
independently from then on. If one Application's sync fails, it doesn't
block any other Application's sync.

```
bootstrap/02-root-app.yaml (root-app)
  └── watches argocd/apps/*.yaml
        ├── vault.yaml              (sync-wave -1)
        ├── backend.yaml            (sync-wave  0, waits for vault Healthy)
        ├── chatbot.yaml            (sync-wave  0, waits for vault Healthy)
        ├── postgres.yaml           (sync-wave  0, waits for vault Healthy)
        ├── frontend.yaml           (sync-wave  1)
        ├── kube-green.yaml         (sync-wave  0)
        ├── kube-green-sleepinfo.yaml (sync-wave 1, waits for kube-green Healthy)
        ├── monitoring.yaml         (sync-wave  2, last — additive observability)
        └── monitoring-routes.yaml  (sync-wave  3, waits for monitoring's Services to exist)
```

`sync-wave` is ArgoCD's own ordering mechanism: a later wave is never even
attempted until every Application in an earlier wave is `Healthy`. This
replaces what would otherwise be a human manually applying things in the
right order.

### Why Routes for monitoring got split into their own chart

`charts/monitoring`'s Application uses `ServerSideApply=true` — required
because `kube-prometheus-stack`'s CRDs carry OpenAPI schemas far past
Kubernetes' 262144-byte `last-applied-configuration` annotation limit under
plain client-side apply. But `ServerSideApply=true` applies to every
resource in that Application, and ArgoCD cannot resolve an OpenAPI schema
for OpenShift's own `Route` type (an aggregated API type, not a CRD) under
structured-merge-diff — every sync of a Route inside that Application
produced a permanent `ComparisonError`. `charts/monitoring-routes` exists
solely so Grafana's and Prometheus's Route objects sync under ArgoCD's
normal (non-SSA) path instead.

### Why the frontend is the only externally-reachable service

Only the frontend has an OpenShift `Route`. Backend and n8n (the chatbot)
are reachable only inside the cluster, over their `ClusterIP` Services —
the frontend's own nginx reverse-proxies `/api/` to backend and one exact
webhook path to n8n. The database is never reachable outside the cluster
either way. This means `VITE_API_URL`/`VITE_CHATBOT_WEBHOOK_URL` are
same-origin relative paths baked into the frontend image's own defaults,
not environment-specific hostnames — the frontend image no longer needs
rebuilding just because a Route hostname changes.

---

## Technologies used

| Layer | Technology | Role in this repo |
|---|---|---|
| Packaging | **Helm 3** | Every chart under `charts/`; two are thin wrappers pinning an upstream chart as a dependency (Vault, kube-prometheus-stack, kube-green) rather than reimplementing them |
| Delivery | **ArgoCD** (app-of-apps) | Pulls from this repo's `main` on its own polling/webhook schedule and reconciles the cluster to match — the only thing that ever actually applies a manifest after the one-time bootstrap |
| Platform | **OKD** (locally, via CRC) → **OpenShift** (production target) | Route objects instead of Ingress, SCC-based arbitrary-UID pod security instead of a fixed UID, Projects layered on Namespaces |
| Secrets | **HashiCorp Vault** (Agent Sidecar Injector) | Secrets are never stored as Kubernetes `Secret` objects for backend/chatbot/postgres — a mutating webhook injects a sidecar that authenticates via each pod's own ServiceAccount and writes secrets to a file inside the pod |
| Database | **PostgreSQL 16 (alpine)** | StatefulSet + PVC, first-party chart (not the Bitnami/CloudNativePG chart — a single instance with no HA requirement doesn't need one) |
| Cache/queues | **Redis 7 (alpine)**, ×2 | One dedicated instance for backend (refresh tokens, rate limiting), one dedicated instance for the chatbot (rate limiting, FAQ cache) — deliberately not shared |
| Chatbot | **n8n** | Self-contained image (workflow JSON + entrypoint baked in by the app repo's own Dockerfile), plus a purpose-built `metrics-exporter` sidecar service for token/cost metrics n8n's own built-in metrics don't cover |
| Observability | **kube-prometheus-stack** (Prometheus, Alertmanager, Grafana, kube-state-metrics, node-exporter) | Trimmed replica counts and resource requests for a single-node install; two custom Grafana dashboards (`pod-health-dashboard`, `chatbot-metrics-dashboard`) sideloaded as labeled ConfigMaps |
| Cost control | **kube-green** | A `SleepInfo` custom resource scales the app tier to zero overnight and on weekends on this always-on local cluster |
| Policy | **OPA / conftest** (`policy/security.rego`) | Enforces this repo's own OKD-specific rules (no fixed UID, no `emptyDir` for stateful data, Routes not Ingress, TLS-terminated Routes, resource requests/limits present) against every first-party chart's rendered output, in CI |
| Manifest validation | **kubeconform** | `helm template \| kubeconform -strict` against the real Kubernetes/OpenShift API schema for every first-party chart |
| IaC scanning | **checkov**, **kube-linter** | Misconfiguration scanning of every rendered manifest (report-only) |
| SCA | **Trivy** | Scans the upstream base images this repo chooses (`postgres:16-alpine`, `redis:7-alpine`) — the app images themselves are already scanned in their own source repos before publish |
| SAST | **Semgrep** | Community ruleset including Kubernetes/YAML rules (report-only) |
| Secret scanning | **gitleaks** | Every push and PR, full history on PRs |
| Live validation | A **`kind`** cluster under Pod Security Admission `restricted` | The closest static CI can get to OKD's own restricted SCC — actually deploys `charts/postgres` and confirms the pod reaches `Ready`, not just that its YAML parses |
| SAST (this repo's own code) | **CodeQL** | Scoped to `scripts/*.js`, the only application code this repo has |

---

## Deployment topology

**App tier** (`training-platform` project):

| Pod | Replicas | Reached via |
|---|---|---|
| `frontend` | 1 | OKD Route (the only externally-reachable service) |
| `backend` | 1 | internal Service only, through the frontend's reverse proxy |
| `postgres` | 1 (StatefulSet) | internal Service only |
| `backend-redis` | 1 (StatefulSet) | internal Service only |
| `n8n` | 1 | internal Service only, through the frontend's reverse proxy (webhook path only, not the editor UI) |
| `chatbot-redis` | 1 (StatefulSet) | internal Service only |
| `metrics-exporter` | 1 | internal Service only, scraped by Prometheus |

**Platform tier:**

| Component | Namespace |
|---|---|
| ArgoCD | `argocd` |
| Vault (persistent, self-unsealing) + Agent Injector | `vault` |
| kube-prometheus-stack | `monitoring` |
| kube-green controller | `kube-green` |

All pod-to-pod traffic stays on the cluster network via `ClusterIP`
Services (`postgres:5432`, `backend-redis:6379`, `chatbot-redis:6379`,
`backend:4000`, `n8n:5678`). The only externally-reachable objects are the
frontend's Route and, when their hostnames are set, Grafana's and
Prometheus's Routes for admin access.

Every StatefulSet uses a real `PersistentVolumeClaim`, never `emptyDir` —
enforced by `policy/security.rego` — so a pod restart never loses data. The
one narrow exception the policy allows is a volume named `*-cache` (n8n's
build cache directory), which is genuinely safe to lose on restart and
can't use a PVC anyway, since the image bakes its cache directory's
ownership in a way that's incompatible with a persistent, pre-owned volume
under an arbitrary runtime UID.

### OKD's arbitrary-UID model

OKD's default `restricted-v2` Security Context Constraint assigns each pod
a **random UID** from a namespace-allocated range — it does not let a
container insist on running as a specific fixed UID. Every chart in this
repo leaves `runAsUser`/`fsGroup` unset for exactly this reason, letting
OKD assign both; a hardcoded value in either field is rejected outright by
the SCC. This is enforced in two places: `policy/security.rego`'s CI check,
and `.github/workflows/dast.yml`, which deploys `charts/postgres` for real
against a `kind` cluster running Pod Security Admission `restricted` (the
closest a plain `kind` cluster gets to OKD's own model) and confirms the
pod actually reaches `Ready`.

Upstream charts that don't follow this convention (Vault, kube-prometheus-
stack, ArgoCD's own Helm chart) get their conflicting `securityContext`
fields explicitly nulled out in this repo's values overrides — an empty
map (`{}`) is not sufficient (Helm's default deep-merge treats it as
"nothing to add," leaving the subchart's own hardcoded default in place);
each key has to be nulled individually.

---

## Secrets architecture

Secrets are delivered by **Vault's Agent Sidecar Injector**, not native
Kubernetes `Secret` objects. A mutating admission webhook injects an init
container into each pod that authenticates using the pod's own
ServiceAccount (Vault's Kubernetes auth method — no static credential
anywhere), fetches the secret, and writes it to a file inside the pod
before the app container starts. The secret value is never persisted to
`etcd` as a `Secret` object.

### Vault, made durable

Vault runs with real persistent file storage on a PVC and a self-managed
init/unseal/auth-bootstrap sidecar (`vault-bootstrap`,
`charts/vault/values.yaml`) — not dev-mode. On first-ever boot, the
sidecar:

1. Runs `vault operator init` (1-of-1 Shamir — no multi-operator quorum
   need at this scale) and writes the unseal key + root token to a
   `vault-init-keys` Kubernetes Secret.
2. Enables the Kubernetes auth method, the KV-v2 secrets mount, and one
   policy + role per consuming app (`backend-role`, `n8n-role`,
   `postgres-role`), each scoped to that app's own ServiceAccount and
   namespace.
3. Enables a `file` audit device, writing to the same PVC Vault's own
   storage already uses (`/vault/data/vault-audit.log`) — a durable,
   tamper-evident "who read/wrote this secret, and when" record.

On every subsequent boot (including a plain cluster restart), the sidecar
reads the same Secret and unseals automatically — no manual recovery step.
The sidecar only ever rebuilds Vault's *structure*; it never touches secret
*values*.

**Vault's file audit device is fail-closed**: if it can't write, Vault
stops serving all requests, not just logging. If Vault ever refuses every
request outright, check `vault audit list` and disk usage on `/vault/data`
first.

### Getting real secret values in: `scripts/vault-bootstrap-secrets.js`

No secrets file — encrypted or not — is ever committed to this repo. Real
values reach Vault by running this script directly against Vault's own
HTTP API:

```sh
oc port-forward -n vault svc/vault 8200:8200 &
export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=$(oc get secret vault-init-keys -n vault -o jsonpath='{.data.root_token}' | base64 -d)
node scripts/vault-bootstrap-secrets.js
```

It only ever fills in what's actually missing — safe to re-run against an
already-seeded Vault. Every value it handles falls into one of three
categories:

| Category | Fields | Behavior |
|---|---|---|
| **Freely regenerate** | `jwt_secret` | Generated the moment it's missing, no prompt — nothing else depends on a specific value, rotating it only invalidates existing sessions |
| **Init-once, pinned-after** | `postgres_password` (shared by backend + postgres), both redis passwords, `n8n_encryption_key`, `n8n_owner_password` | Only safe to freely generate on a genuinely fresh install — each is tied to an external store (a data directory, a PVC) that only reads it once. The script asks one combined "is this a fresh install?" question; a "no" prompts for the existing value instead of generating a new, desynced one |
| **External, human-supplied** | `smtp_user`, `smtp_password`, `n8n_ai_api_key`, `vapid_private_key` | Real third-party credentials nothing on this machine can invent — always a masked, typed prompt. `vapid_private_key`'s prompt is explicit that it wants the *existing* value: its public half is already baked into the deployed frontend image, so a freshly generated pair would break every live browser push subscription |

`postgres_password` is written to both `training-platform/data/backend`
and `training-platform/data/postgres` from the same source value in the
same run, with a hard-fail check if the two paths are ever already
disagreeing — this is what makes the two independently drifting apart
(each ending up with its own, different password) something the script
actively detects rather than something that can happen silently.

### Full secret inventory

| Key | Consumed by | Vault path | Notes |
|---|---|---|---|
| `postgres_password` | postgres, backend | `training-platform/data/postgres`, `training-platform/data/backend` | same value, both paths |
| `redis_password` (backend's) | backend | `training-platform/data/backend` | composes backend's `REDIS_URL`; `backend-redis` itself always reads a plain bootstrap Secret |
| `jwt_secret` | backend | `training-platform/data/backend` | signs/verifies access tokens |
| `smtp_user` / `smtp_password` | backend | `training-platform/data/backend` | approval-notification emails |
| `vapid_private_key` | backend | `training-platform/data/backend` | web push; the public half is not secret |
| `n8n_encryption_key` | n8n | `training-platform/data/n8n` | encrypts n8n's stored credentials at rest |
| `n8n_owner_password` | n8n, metrics-exporter | `training-platform/data/n8n` | n8n editor login |
| `n8n_ai_api_key` | n8n | `training-platform/data/n8n` | the LLM provider key |
| `redis_password` (chatbot's) | n8n | `training-platform/data/n8n` | distinct instance/value from backend's own |

Non-secrets (`CLIENT_URL`, `PORT`, `SMTP_HOST`, Route hosts, image tags,
`VAPID_PUBLIC_KEY`) live in plain `values.yaml` /
`environments/local-okd/*-values.yaml` — Vault is deliberately not used for
values that don't need it.

### Disaster recovery / fallback path

Every app chart with secrets has a `vault.enabled` flag. If Vault is ever
down and the app needs to run anyway, set the flag to `false` and create
the matching plain bootstrap Secret from that app's
`*-secrets.example.yaml` template in `environments/local-okd/` — a
fallback path, not the normal one.

If Vault's own storage is ever lost while the systems it protects (postgres's
data directory, the redis Secrets, n8n's PVC) survive, `vault-bootstrap-
secrets.js` will hit its fresh-install prompt for every init-once value —
answer **no**, and re-supply the real existing values by hand instead of
generating new ones that would desync from what's already in use.
Recovering `smtp_user`/`smtp_password`/`n8n_ai_api_key`/`vapid_private_key`
in this scenario always requires a human who separately recorded them —
true of any real deployment, not a gap specific to this one.

---

## CI/CD pipeline

This repo's CI **only validates** — it never deploys. `.github/workflows/`:

| Workflow | Trigger | What it does |
|---|---|---|
| `verify.yml` | called by every push/PR workflow | `lint`, `secret-scan`, `sast`, `k8s-sast`, `policy`, `sca` — see below |
| `dast.yml` | called on PRs into `dev`/`main`, and after every merge to `main` | deploys `charts/postgres` to a real `kind` cluster under PSA `restricted` and confirms the pod reaches `Ready` |
| `codeql.yml` | push/PR to `main`/`dev`, weekly | SAST on `scripts/*.js`, the only application code here |
| `on-feature-push.yml` | push to `feature/**` | runs `verify`, opens a PR into `dev` once green |
| `on-pull-request.yml` | PR into `dev` or `main` | runs `verify` + `dast` |
| `on-main-merge.yml` | push to `main` | runs `verify` + `dast` again, post-merge |
| `promote-dev-to-main.yml` | manual dispatch | opens (never auto-merges) a `dev` → `main` PR |
| `scheduled-base-image-scan.yml` | weekly + manual dispatch | the real, durable Trivy monitoring for third-party base images (see below) |

### `verify.yml`'s jobs

| Job | What it checks |
|---|---|
| `lint` | `helm lint` on every chart, `helm template \| kubeconform -strict` against every first-party chart |
| `secret-scan` | `gitleaks`, full history |
| `sast` | Semgrep, community ruleset (report-only) |
| `k8s-sast` | `kube-linter` (report-only) + `checkov` (report-only) against every chart's rendered output |
| `policy` | `conftest` against `policy/security.rego` — **hard-fail**, this repo's own enforced rules |
| `sca` | Trivy against `postgres:16-alpine` / `redis:7-alpine` — see below |

### Why the base-image scan is report-only in `verify.yml` but hard-fails on a schedule

`postgres:16-alpine` and `redis:7-alpine` are official upstream images this
repo doesn't build (no Dockerfile of its own for either) and has no direct
ability to patch. A fresh CRITICAL/HIGH finding in one of them means only
"upstream hasn't republished a fix yet" — something outside this repo's own
patch cadence, but until `verify.yml`'s `sca` job was made non-blocking, a
single such finding blocked *every* unrelated PR repo-wide, sometimes for
days at a time, regardless of what that PR actually changed.

The fix: `verify.yml`'s `sca` job runs with `continue-on-error: true` — the
Trivy scan still runs, findings still appear in full in the job's own log,
but a finding no longer blocks a merge gate for content this repo can't
directly fix. The real, durable monitoring for these two images now lives
in `scheduled-base-image-scan.yml` instead — the identical scan, on a
weekly schedule (plus on-demand via `workflow_dispatch`), with no
`continue-on-error` — a real finding there **should** show as a red run,
since there's no unrelated PR being protected. A failed scheduled workflow
run shows in the Actions tab and (GitHub's default behavior for a repo you
own) sends an email — durable visibility without needing to also stand up
a separate issue-filing integration.

`gosu` (a tiny privilege-drop helper bundled inside the official postgres
image) is the one component that *is* excluded via `skip-files` in both
workflows, rather than handled as report-only — a narrower, different kind
of exception. Every CVE ever found in it so far traces back to Go stdlib
code paths (`net/http`, TLS, URL/XML parsing) that exist in the binary only
because Go statically links the whole stdlib in, not because `gosu` itself
ever executes them — its entire job is dropping root privilege and
exec'ing one command once at container startup. That reasoning doesn't
depend on which CVE number is current, so excluding the file is durable;
`openssl`, by contrast, is genuinely used by postgres for real TLS, so it
gets the report-only treatment instead of a blanket exclusion — a finding
there could actually matter.

---

## Security policy enforcement

`policy/security.rego`, run via `conftest` in CI against every first-party
chart's rendered manifests:

- No fixed, non-arbitrary `runAsUser` or `fsGroup` on a Deployment or
  StatefulSet (breaks OKD's arbitrary-UID SCC model).
- Every container sets both `resources.requests` and `resources.limits`.
- Every container sets `securityContext.allowPrivilegeEscalation: false`.
- No `emptyDir` for a Deployment/StatefulSet's volumes, except a volume
  named `*-cache`.
- No `Ingress` objects and no `Service` of type `LoadBalancer` — this repo
  uses OpenShift `Route` objects exclusively for external access.
- Every `Route` sets a `tls` block — no plaintext external traffic.

---

## Bootstrapping a fresh cluster

Condensed from the full local runbook; local-cluster-specific, see
[OKD → OpenShift migration](#okd--openshift-migration) for what changes
on real OpenShift.

```sh
# 0. Confirm a StorageClass exists — every PVC in this repo needs one
oc get storageclass

# 1. Bootstrap ArgoCD (the one chicken-and-egg step)
oc apply -f bootstrap/00-namespace.yaml
oc apply -f bootstrap/argocd-cluster-install.yaml -n argocd --server-side --force-conflicts
oc apply -f bootstrap/01-argocd-install.yaml
oc apply -f bootstrap/02-root-app.yaml

# 2. Vault deploys first (sync-wave -1) — create the two plain redis
#    bootstrap Secrets postgres/backend/chatbot need unconditionally
oc create secret generic backend-credentials  -n training-platform --from-literal=REDIS_PASSWORD='<strong password>'
oc create secret generic chatbot-credentials  -n training-platform --from-literal=REDIS_PASSWORD='<a different strong password>'
argocd app sync vault    # or let automated sync pick it up

# Get the real root token (randomly generated at init, never a known default)
oc port-forward -n vault svc/vault 8200:8200 &
export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=$(oc get secret vault-init-keys -n vault -o jsonpath='{.data.root_token}' | base64 -d)

# Fill in real secret values — see Secrets architecture above
node scripts/vault-bootstrap-secrets.js

# 3. postgres + backend
argocd app sync postgres
argocd app sync backend

# 4. chatbot — pin real image tags in environments/local-okd/chatbot-values.yaml first
argocd app sync chatbot

# 5. frontend — pin a real image tag in environments/local-okd/frontend-values.yaml first
argocd app sync frontend

# 6. monitoring (last, additive) — Grafana's admin Secret has to exist first
oc create namespace monitoring
oc create secret generic grafana-admin-credentials -n monitoring \
  --from-literal=admin-user=admin --from-literal=admin-password='<strong password>'
# auto-syncs on its own from here
```

Everything after step 1 auto-syncs on ArgoCD's own schedule once its
prerequisite Secret/values exist — the `argocd app sync` calls above just
avoid waiting for the next polling interval.

---

## Day-2 operations

Every future change is `git push` to `main`. ArgoCD picks it up on its own
polling interval (default ~3 minutes) or immediately via a configured
webhook. **Nothing in this repo's CI ever runs `helm upgrade` or
`argocd app sync`** — reintroducing that would silently turn this back
into push-based deployment and defeat the reason to use ArgoCD at all.

**Force an immediate re-sync** without waiting for the polling interval:

```sh
oc annotate application <name> -n argocd argocd.argoproj.io/refresh=hard --overwrite
```

**Rotating a secret value**: re-run `scripts/vault-bootstrap-secrets.js`
after clearing (or intentionally overwriting) the relevant key in Vault —
it only ever fills in what's missing, so an existing value has to be
explicitly rotated via `vault kv patch`, not by re-running the script alone.

**Falling back off Vault temporarily**: see
[Disaster recovery / fallback path](#disaster-recovery--fallback-path)
above.

---

## OKD → OpenShift migration

OKD is not a different product from OpenShift — it's the upstream
community distribution OpenShift Container Platform (OCP) is built from.
Same core APIs (`oc`, `Route`, SCCs, Operators via OLM), same Helm charts,
same ArgoCD Applications. Nothing in this repo depends on an OKD-only
feature, so **none of the charts, Applications, or policy in this repo
need to change** to run on real OpenShift. What changes is entirely
environment-level configuration — the same reason this repo already keeps
everything environment-specific under `environments/<name>/` rather than
inside the charts themselves.

### What's identical between OKD and OpenShift

- `Route` objects, SCC-based arbitrary-UID pod security, Projects layered
  on Namespaces, the Vault Agent Injector pattern, ArgoCD's own app-of-apps
  mechanism, every OPA policy rule in `policy/security.rego`.

### What genuinely changes per environment

| Area | Local OKD (today) | Real OpenShift |
|---|---|---|
| Storage | `kubevirt.io.hostpath-provisioner` (CRC-only) | A real StorageClass for the target platform (AWS EBS, Azure Disk, GCE PD, ODF/Ceph, NFS, etc.) — every PVC's `storageClassName` needs a real value for that cluster |
| DNS / Route hosts | `*.apps-crc.testing` wildcard | The target cluster's real ingress domain |
| Cluster access | `crc` CLI, local admin credentials | Real `oc login` credentials for the target cluster |
| Sizing | Single-node, CPU/memory capped by the local VM | Multi-node — real `resources.requests`/`limits` sized for actual expected load, not a local sandbox |
| Subscription / control plane | None — OKD is free | See below |
| Image registry access | GHCR pull secret already present locally | The same GHCR pull secret (or a mirrored/private registry) needs to exist on the new cluster too |

### Choosing an OpenShift target

| Option | What it means | Trade-off |
|---|---|---|
| **Self-managed OCP** | Install Red Hat's OpenShift Container Platform yourself (on-prem or on cloud infrastructure you provision) | Needs a Red Hat account, a pull secret, and an active subscription; you own the control plane |
| **Managed OpenShift** (ROSA on AWS, ARO on Azure, OpenShift Dedicated) | Red Hat (or the cloud provider, jointly) runs and patches the control plane for you | Simpler operationally; billed per node/hour on top of the underlying cloud infrastructure cost |
| **OpenShift Developer Sandbox** | Red Hat's free, time-boxed, shared multi-tenant cluster — one namespace, no cluster-admin | See below — this one needs real architectural exceptions, not just new values |

The first two give you a real cluster you administer, so this repo's own
charts and Applications transfer with only new environment-level values.
Developer Sandbox is different enough to call out on its own.

### Developer Sandbox specifically

Confirmed directly against a real Sandbox account (`oc auth can-i create
clusterrole` → `no`, no OpenShift GitOps operator available): you get exactly
one namespace and zero cluster-admin rights. Several pieces of this repo's
architecture assume cluster-admin, so they can't come along unmodified:

| Piece | Why it doesn't fit | What replaces it |
|---|---|---|
| Self-installed ArgoCD (`bootstrap/`) | Needs cluster-scoped CRDs (`Application`, `AppProject`) | Direct `helm upgrade --install`, run by hand or from a script — `scripts/deploy-sandbox.sh` |
| Vault's Agent Injector | Needs a cluster-scoped `MutatingWebhookConfiguration` | The plain-`Secret` fallback every chart already has (`vault.enabled: false`) |
| `charts/monitoring` (kube-prometheus-stack) | ~10 CRDs need cluster-admin; node-exporter needs `hostNetwork`/`hostPID`, which a shared cluster's SCC won't grant regardless | Not deployed on this target |
| `charts/kube-green` | Own CRD needs cluster-admin | Not deployed on this target — Sandbox already auto-reclaims idle environments on its own |
| Multiple namespaces (`vault`, `argocd`, `monitoring`, `kube-green`, `training-platform`) | Sandbox gives you one fixed, pre-named namespace | Everything goes in that one namespace |

What's actually deployed there: `backend`, `frontend`, `chatbot`, `postgres`
only — none of these are cluster-scoped and none bring their own CRDs, so
they're unaffected otherwise. `environments/openshift-sandbox/` holds their
values (secrets via the plain-`Secret` fallback, using the matching
`*-secrets.example.yaml` templates in that same directory); the frontend
chart only creates a `Route` when `route.host` is set, so the practical
bootstrap order is: deploy without a Route, run `oc expose svc/frontend` to
get OpenShift's own auto-generated hostname, then write that real hostname
back into `frontend-values.yaml`.

This is the one deployment path in this repo that's push-based rather than
GitOps — a direct, deliberate exception forced by the platform itself
having no cluster-admin path to install ArgoCD, not a gap in this repo's
own design.

### Migration checklist

1. **Provision the target cluster** (self-managed or managed) and confirm
   `oc login` works against it.
2. **Confirm the real StorageClass name**: `oc get storageclass`.
3. **Create the new environment directory**:
   `environments/openshift-prod/` (or whatever name fits), copying every
   file from `environments/local-okd/` as a starting point.
4. **Update every `storageClassName: ""`** across the new environment's
   values files to the real StorageClass from step 2 (`postgres`,
   `backend-redis`, `chatbot-redis`, `n8n`, `prometheus`, `alertmanager`,
   `grafana`).
5. **Update every Route hostname** (`frontend-values.yaml`'s `route.host`,
   `monitoring-routes-values.yaml`'s two hosts) to real hostnames under the
   new cluster's ingress domain.
6. **Update `argocd/apps/*.yaml`**'s `helm.valueFiles` entries to point at
   the new environment's directory (or, more commonly, add a second set of
   `Application` manifests under a new `argocd/apps-openshift-prod/`
   directory pointed at a different `targetRevision`/branch, so both
   environments can be managed from the same repo without one blocking the
   other).
7. **Re-size `resources.requests`/`limits`** in the new environment's
   values files for real expected load — the values in
   `environments/local-okd/` are deliberately trimmed for a single-node,
   CPU/memory-capped local VM and are almost certainly too small for
   production traffic.
8. **Re-run the bootstrap sequence** ([above](#bootstrapping-a-fresh-cluster))
   against the new cluster — ArgoCD, Vault, and every secret get
   initialized fresh on the new cluster; Vault's root token and unseal key
   will be different from the local cluster's.
9. **Point the app repos' CI-published image pull secret** at the new
   cluster (same GHCR image tags this repo already references — no image
   rebuild needed for the migration itself).
10. **Confirm every pod actually reaches `Ready`** under the new cluster's
    real SCC assignment before considering the migration complete — the
    arbitrary-UID handling this repo already relies on should carry over
    unchanged, but it's worth confirming on the real target rather than
    assuming.

Nothing above requires touching `charts/*` — every step is either
provisioning the new cluster or filling in a new `environments/` directory,
exactly the separation this repo's layout was built for.

---

## Creating a SuperAdmin account

SuperAdmin is a structural role, not a self-service signup. The backend
repo ships `scripts/seedSuperAdmin.ts` for this, but **it cannot be run
inside the deployed pod as-is**: the production Dockerfile's runtime stage
only copies `dist/` (compiled from `src/**/*.ts` — `tsconfig.json`'s
`include` never touches `scripts/`) and strips `npm`/`npx` entirely to
shrink the image. There's no compiled `dist/scripts/seedSuperAdmin.js` to
run and nothing to run it with. Confirmed twice against a live cluster, not
assumed.

The reliable path instead: hash the password with the backend pod's own
`bcrypt` (guarantees the exact same hashing the app itself would use), then
insert the row directly via SQL, using the pod's own `PasswordHasher`
settings (`bcrypt`, 10 salt rounds) and the `roles` table already seeded by
migrations.

```sh
EMAIL="admin@yourdomain.com"
FIRSTNAME="Ada"
LASTNAME="Admin"
NEW_PASS=$(openssl rand -base64 24 | tr -d '=+/')   # or supply your own, 12+ chars

HASH=$(oc exec -n training-platform deploy/backend -c backend -- node -e \
  "require('bcrypt').hash(process.argv[1], 10).then(h=>console.log(h))" "$NEW_PASS")

oc exec -n training-platform postgres-0 -- psql -U postgres -d training_platform -c "
INSERT INTO users (firstname, lastname, email, password_hash, role_id, status, has_seen_tour, created_at, updated_at)
SELECT '$FIRSTNAME', '$LASTNAME', '$EMAIL', '$HASH', id, 'approved', false, now(), now()
FROM roles WHERE name = 'SuperAdmin';
"

echo "email: $EMAIL"
echo "password: $NEW_PASS"   # only place this is ever shown — save it now
```

### Verify

Don't just trust the insert — confirm with a real login call against the
dedicated endpoint:

```sh
oc exec -n training-platform deploy/backend -c backend -- node -e "
const http = require('http');
const data = JSON.stringify({email: process.argv[1], password: process.argv[2]});
const req = http.request({host:'127.0.0.1',port:4000,path:'/auth/admin-login',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}}, res => { console.log('HTTP', res.statusCode); res.on('data',()=>{}); });
req.on('error', e => console.log('error', e.message));
req.write(data); req.end();
" "$EMAIL" "$NEW_PASS"
```

Should print `HTTP 200`. Then log in for real at the frontend's dedicated
`/superadmin/login` route (not the regular signup/login flow). A SuperAdmin
account structurally bypasses every per-endpoint role check rather than
being granted a permission list — treat the credential with the same care
as Vault's own root token.

### On a migrated OpenShift cluster

The exact same procedure applies — `oc exec` works identically against any
OpenShift cluster once `oc login` targets it. The only difference is which
cluster your `oc` context currently points at; confirm with
`oc whoami --show-context` before running the commands above against a
production target.

## Creating a Developer account

Same structural-role, no-self-signup shape as SuperAdmin, and the same
production-image constraint applies (`scripts/seedDeveloper.ts` can't run
inside the deployed pod either) — so the same direct-SQL approach, just
against the `Developer` role row and its own dedicated login endpoint:

```sh
EMAIL="developer@yourdomain.com"
FIRSTNAME="Dev"
LASTNAME="User"
NEW_PASS=$(openssl rand -base64 24 | tr -d '=+/')

HASH=$(oc exec -n training-platform deploy/backend -c backend -- node -e \
  "require('bcrypt').hash(process.argv[1], 10).then(h=>console.log(h))" "$NEW_PASS")

oc exec -n training-platform postgres-0 -- psql -U postgres -d training_platform -c "
INSERT INTO users (firstname, lastname, email, password_hash, role_id, status, has_seen_tour, created_at, updated_at)
SELECT '$FIRSTNAME', '$LASTNAME', '$EMAIL', '$HASH', id, 'approved', false, now(), now()
FROM roles WHERE name = 'Developer';
"

echo "email: $EMAIL"
echo "password: $NEW_PASS"
```

Verify the same way, against `/auth/developer-login` instead of
`/auth/admin-login`. Log in for real at the frontend's `/developer/login`
route to reach the feedback inbox and feature-announcement dashboard.

---

## Git workflow

`main` (protected) / `dev` (protected), feature branches off `dev`,
PR-gated. Promotion from `dev` to `main` is a deliberate, non-automatic
step — `promote-dev-to-main.yml` opens a `dev` → `main` PR on manual
dispatch and never auto-merges it; merge only after confirming CI is green
and reviewing what's actually going out.

Image tag bumps for backend/frontend/chatbot are opened automatically as a
PR into `dev` whenever the corresponding app repo publishes a new image —
review and merge like any other PR, then promote to `main` when ready to
deploy.
