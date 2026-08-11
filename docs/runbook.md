# Runbook — bootstrapping training-platform on a local OKD cluster

Vault-first build order: **all of backend's and chatbot's secrets are
Vault-delivered by default** (`vault.enabled: true` in both
`environments/local-okd/backend-values.yaml` and `chatbot-values.yaml` —
no plain-Secret fallback in normal operation). That means Vault has to
exist and have its roles configured *before* backend or chatbot can start
successfully, which reorders ARCHITECTURE-PLAN.md §9's original sequence.
Postgres is the one exception — it always uses its own plain bootstrap
Secret; no Vault role is defined for the datastore itself, only for the
apps that consume it (frontend has no secrets of its own at all — see
below).

Nothing in this repo has been applied to a cluster yet — this is the
sequence to actually do it.

## 0. Before touching the cluster

```sh
oc get storageclass
```

Confirm a StorageClass exists (and note its name — the default is fine if
`oc get storageclass` shows one marked `(default)`). Every PVC in this repo
(`postgres`, `backend-redis`, `chatbot-redis`, `n8n`, `prometheus`,
`alertmanager`, `grafana`) needs one. If a chart's `*-values.yaml` leaves
`storageClassName: ""` and there's no cluster default, the PVC will sit
`Pending` forever — set it explicitly in the relevant
`environments/local-okd/*-values.yaml` file first.

## 1. Bootstrap ArgoCD (chicken-and-egg step)

```sh
oc apply -f bootstrap/00-namespace.yaml

# ArgoCD's CRDs + controller need to exist before it can manage its own
# Helm release — one-time upstream install:
oc apply -k https://github.com/argoproj/argo-cd/manifests/cluster-install?ref=stable -n argocd

oc apply -f bootstrap/01-argocd-install.yaml   # from here on, ArgoCD manages its own upgrades via git
oc apply -f bootstrap/02-root-app.yaml         # app-of-apps root — creates the 6 child Applications
```

Confirm: `oc get applications -n argocd` should list `postgres`, `backend`,
`chatbot`, `frontend`, `vault`, `monitoring`, all owned by `root-app`.
`vault` carries `sync-wave: "-1"` (backend/chatbot are wave `0`) — ArgoCD
will apply and wait for Vault to be Healthy before it even attempts
backend/chatbot, but the one-time Vault auth/role setup below is still a
manual step ArgoCD can't do for you.

## 2. Deploy and configure Vault FIRST

```sh
oc create secret generic postgres-credentials -n training-platform \
  --from-literal=postgres-password='<a real strong password>'   # postgres never uses Vault, see docs/secrets-inventory.md

argocd app sync vault   # or let the automated sync pick it up once step 1 is done
```

Once the Vault pod is up (dev mode — auto-unsealed, no manual unseal step
needed, root token is the upstream chart's well-known dev default):

```sh
oc port-forward -n vault svc/vault 8200:8200 &
export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=root
```

1. Enable the Kubernetes auth method and create `backend-role`/`n8n-role`
   bound to the `backend`/`n8n` ServiceAccounts + `training-platform`
   namespace, per ARCHITECTURE-PLAN.md §5.
2. Seed both Vault paths straight from your real local `.env` files —
   don't hand-type `vault kv put` commands, `scripts/vault-seed.js` does
   both `training-platform/data/backend` and `training-platform/data/n8n`
   in one run and never writes a secret value to any file this repo
   tracks:
   ```sh
   node scripts/vault-seed.js
   ```
   (Run it from this repo's root — it expects the app repos as sibling
   directories, override `BACKEND_REPO`/`CHATBOT_REPO` if yours differ.)

## 3. Sync postgres + backend (the OKD arbitrary-UID smoke test)

```sh
argocd app sync postgres
argocd app sync backend
```

Watch:

```sh
oc get pods -n training-platform -w
oc logs -n training-platform deploy/backend
```

Backend's pod should pick up a Vault Agent Injector sidecar automatically
(`vault.enabled: true` is already the default) — confirm with
`oc describe pod -n training-platform -l app.kubernetes.io/name=backend`
that an extra `vault-agent` init/sidecar container is present, and that
`DATABASE_URL`/`REDIS_URL`/`JWT_SECRET`/etc. actually reached the app (no
"undefined" env errors in the logs). If the pod never gets the sidecar,
double check `backend-role` in Vault is actually bound to the `backend`
ServiceAccount + `training-platform` namespace (step 2.1) — a missing or
misconfigured role is the most common cause, not a chart bug.

If `backend`'s pod fails with an `EACCES`/permission error on `/app/.pm2`,
the group-0 fix from training-platform-backend PR #73/#74 either isn't in
the image tag you pinned in `environments/local-okd/backend-values.yaml`,
or needs re-verifying — see CHANGES-PLAN.md §1.1 for how it was originally
verified. If `postgres`'s pod fails with a data-directory permission error,
the StatefulSet's `fsGroup: 999` (charts/postgres/values.yaml) isn't taking
effect under your cluster's specific SCC — as a fallback, grant the
`anyuid` SCC to its ServiceAccount:

```sh
oc adm policy add-scc-to-user anyuid -z default -n training-platform
```

(Documented as the fallback ARCHITECTURE-PLAN.md §4 already calls out —
weakens isolation slightly, prefer getting `fsGroup` working first.)

## 4. Sync chatbot

Set `n8n.image.tag` and `metricsExporter.image.tag` in
`environments/local-okd/chatbot-values.yaml` to real published tags first
— `ghcr.io/youssefachraf/training-platform-chatbot-n8n` and
`ghcr.io/youssefachraf/training-platform-chatbot-n8n-metrics-exporter`,
`sha-<short>` tags from their own `docker-publish*.yml` runs, never
floating `latest`. The n8n image bakes in `entrypoint.sh`, `bootstrap.js`,
and all 5 workflow JSONs itself (no ConfigMap/bind-mount needed). The
metrics-exporter image must be built from a commit that includes its
Dockerfile's Vault-env-sourcing fix (`if [ -f /vault/secrets/env ]; then . /vault/secrets/env; fi`)
— without it, `N8N_OWNER_PASSWORD` won't reach the process even though
Vault Agent successfully injects the file.

```sh
argocd app sync chatbot
```

Same verification as backend: confirm the Vault Agent sidecar is present
and n8n/metrics-exporter actually got their secrets, not silent
`undefined`s.

## 5. Rebuild + sync frontend

Frontend has no secrets of its own — nothing here goes through Vault.
The frontend image **must be rebuilt** before this step —
`environments/local-okd/frontend-values.yaml`'s `image.tag` is a
placeholder. From `training-platform-frontend`:

```sh
docker build \
  --build-arg VITE_API_URL=https://api-training-platform.apps-crc.testing \
  --build-arg VITE_CHATBOT_WEBHOOK_URL=https://n8n-training-platform.apps-crc.testing/webhook/chatbot/message \
  --build-arg VITE_VAPID_PUBLIC_KEY=BNS64Kb9w84XhbJsqcwhqOt0djB-cwlZNXKNdgPmAlpcraWkSMfsNgkTzkyuBbA7L5Hq4C52Jcm9yWV8fLOhu58 \
  # ^ must stay identical to backend-values.yaml's VAPID_PUBLIC_KEY — this is
  # the public half of the pair, safe to hardcode, unlike VAPID_PRIVATE_KEY
  -t ghcr.io/youssefachraf/training-platform-frontend:local-okd \
  .
docker push ghcr.io/youssefachraf/training-platform-frontend:local-okd
```

Update `environments/local-okd/frontend-values.yaml`'s `image.tag` to
match, then `argocd app sync frontend`.

## 6. Monitoring (last — additive observability)

```sh
oc create secret generic grafana-admin-credentials -n monitoring --from-literal=admin-user=admin --from-literal=admin-password='<a real strong password>'
oc adm policy add-scc-to-user hostaccess -z prometheus-node-exporter -n monitoring
argocd app sync monitoring
```

The `add-scc-to-user hostaccess` grant is required — see the comment in
`charts/monitoring/values.yaml` on why node-exporter's DaemonSet won't
schedule under the default `restricted-v2` SCC otherwise.

## Disaster recovery: falling back off Vault temporarily

If Vault itself is down and you need backend/chatbot running anyway, flip
`vault.enabled: false` in the relevant `environments/local-okd/*-values.yaml`
and create the plain bootstrap Secret from the matching
`*-secrets.example.yaml` template instead. This is a fallback path, not
the normal one — flip back to `true` once Vault's available again.

## Re-sync / day-2

Every future change is `git push` to this repo's `main` branch. ArgoCD
picks it up on its own polling interval (default 3 minutes) or immediately
via a configured webhook. **Never** run `helm upgrade` or `argocd app sync`
from this repo's own CI, if/when that CI gets added — see
ARCHITECTURE-PLAN.md §3/§7.
