# Runbook — bootstrapping training-platform on a local OKD cluster

Follows the build order in ARCHITECTURE-PLAN.md §9. Nothing in this repo
has been applied to a cluster yet — this is the sequence to actually do it.

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

## 2. Create the out-of-band Secrets (before syncing postgres/backend)

Each app chart references an `existingSecret`/`existingSecretName` that
this repo deliberately never creates via Helm. Run the `oc create secret`
commands from each `environments/local-okd/*-secrets.example.yaml` file now
— see docs/secrets-inventory.md for the full key list. Do this for
`postgres-credentials` and `backend-credentials` at minimum before step 3.

## 3. Sync postgres + backend (build order step 2 — riskiest unknown first)

Either let ArgoCD's automated sync pick these up (it will, once step 1 is
done), or force it:

```sh
argocd app sync postgres
argocd app sync backend
```

**This is the OKD arbitrary-UID smoke test.** Watch:

```sh
oc get pods -n training-platform -w
oc logs -n training-platform deploy/backend
```

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

## 4. Create chatbot secrets, sync chatbot

Before syncing, set `n8n.image.tag` in `environments/local-okd/chatbot-values.yaml`
to a real published tag from `training-platform-chatbot-n8n`'s
`docker-publish-n8n.yml` runs (`ghcr.io/youssefachraf/training-platform-chatbot-n8n`,
`sha-<short>` tags) — that image now bakes in `entrypoint.sh`, `bootstrap.js`,
and all 5 workflow JSONs itself (no ConfigMap/bind-mount needed anymore,
unlike this repo's original scaffold).

```sh
# oc create secret ... chatbot-credentials, per environments/local-okd/chatbot-secrets.example.yaml
argocd app sync chatbot
```

If `metrics-exporter`'s pod fails under `runAsNonRoot: true` (it has no
`USER` directive in its Dockerfile — unverified, see the build plan), drop
that constraint for this one Deployment
(`charts/chatbot/templates/metrics-exporter-deployment.yaml`) as a
stopgap and file a follow-up in the chatbot-n8n repo to add a `USER`
directive properly.

## 5. Rebuild + sync frontend

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

## 6. Vault cutover (build order step 5)

```sh
oc create secret generic grafana-admin-credentials -n monitoring --from-literal=...   # if not already done
argocd app sync vault
```

Once the Vault pod is up (dev mode — auto-unsealed, no manual unseal step
needed, root token is the upstream chart's well-known dev default):

1. Enable the Kubernetes auth method and create `backend-role`/`n8n-role`
   bound to the `backend`/`n8n` ServiceAccounts + `training-platform`
   namespace, per ARCHITECTURE-PLAN.md §5.
2. Seed both Vault paths straight from your real local `.env` files —
   don't hand-type `vault kv put` commands, `scripts/vault-seed.js` does
   both `training-platform/data/backend` and `training-platform/data/n8n`
   in one run and never writes a secret value to any file this repo
   tracks:
   ```sh
   oc port-forward -n vault svc/vault 8200:8200 &
   VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root node scripts/vault-seed.js
   ```
   (Run it from this repo's root — it expects the app repos as sibling
   directories, override `BACKEND_REPO`/`CHATBOT_REPO` if yours differ.)
3. Flip `vault.enabled: true` in `environments/local-okd/backend-values.yaml`,
   `argocd app sync backend`, confirm the pod picks up the Vault Agent
   sidecar and starts cleanly.
4. Only once that's proven working end-to-end, repeat for `n8n-role` /
   `chatbot-values.yaml`. Leave `postgres` and both redis StatefulSets on
   their plain Secrets — ARCHITECTURE-PLAN.md §5 doesn't define Vault roles
   for the datastores themselves, only their consumers.
5. Known open item: `charts/chatbot`'s `metrics-exporter-deployment.yaml`
   has a NOTE comment about its Dockerfile not sourcing
   `/vault/secrets/env` — resolve that in the metrics-exporter Dockerfile
   before flipping `vault.enabled` for chatbot, or `N8N_OWNER_PASSWORD`
   silently won't reach the process.

## 7. Monitoring (build order step 6, last)

```sh
oc adm policy add-scc-to-user hostaccess -z prometheus-node-exporter -n monitoring
argocd app sync monitoring
```

The `add-scc-to-user hostaccess` grant is required — see the comment in
`charts/monitoring/values.yaml` on why node-exporter's DaemonSet won't
schedule under the default `restricted-v2` SCC otherwise.

## Re-sync / day-2

Every future change is `git push` to this repo's `main` branch. ArgoCD
picks it up on its own polling interval (default 3 minutes) or immediately
via a configured webhook. **Never** run `helm upgrade` or `argocd app sync`
from this repo's own CI, if/when that CI gets added — see
ARCHITECTURE-PLAN.md §3/§7.
