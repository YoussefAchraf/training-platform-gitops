# Secrets inventory

Every secret key this stack needs, which Secret/pod consumes it, and its
Vault path — **`vault.enabled: true` is now the default for backend and
chatbot** (ARCHITECTURE-PLAN.md §5), not a future migration. Frontend has
no secrets of its own at all. Source of truth — if this disagrees with a
chart's `values.yaml` comments, this file wins.

Nothing here is committed with a real value anywhere in this repo.
`scripts/vault-seed.js` populates both Vault paths below directly from the
app repos' real (gitignored) `.env` files — see docs/runbook.md §2. Each
`environments/local-okd/*-secrets.example.yaml` file is a
disaster-recovery fallback only (`vault.enabled: false`, plain bootstrap
Secret) — not the normal path, see docs/runbook.md's "Disaster recovery"
section.

**Vault path layout, exactly as implemented** (not one path per secret —
each consumer's Vault Agent template does a single `with secret "..."`
read, so each consumer's own path bundles everything it needs, including
values that are also independently true elsewhere — e.g. `postgres_password`
lives inside `training-platform/data/backend` because that's the one Vault
read backend's Deployment does, not because postgres itself reads from
there):

| Key | Bootstrap Secret (fallback only) | Consumed by | Vault path (default path) | Notes |
|---|---|---|---|---|
| `postgres-password` | `postgres-credentials` (training-platform ns) | postgres | *(not migrated — postgres always reads its plain bootstrap Secret, no Vault role defined for the datastore itself)* | |
| `DATABASE_URL` | `backend-credentials` | backend, migrate Job | composed by backend's Vault template from `training-platform/data/backend`'s `postgres_password` | full connection string — backend never reads a raw password |
| `REDIS_URL` | `backend-credentials` | backend | composed by backend's Vault template from `training-platform/data/backend`'s `redis_password` | full connection string, points at `backend-redis` |
| `REDIS_PASSWORD` (backend's) | `backend-credentials` | backend-redis (StatefulSet) | `training-platform/data/backend` → key `redis_password` | must match the password embedded in this same Secret's `REDIS_URL`; backend-redis itself always reads the plain bootstrap Secret (no Vault role for the datastore), so this key only feeds backend's own `REDIS_URL` composition once `vault.enabled: true` |
| `JWT_SECRET` | `backend-credentials` | backend | `training-platform/data/backend` → key `jwt_secret` | signs/verifies access tokens |
| `SMTP_USER` | `backend-credentials` | backend | `training-platform/data/backend` → key `smtp_user` | |
| `SMTP_PASS` | `backend-credentials` | backend | `training-platform/data/backend` → key `smtp_password` | approval-notification emails |
| `VAPID_PRIVATE_KEY` | `backend-credentials` | backend | `training-platform/data/backend` → key `vapid_private_key` | `VAPID_PUBLIC_KEY` is **not** secret — set as a plain, real value in `environments/local-okd/backend-values.yaml` and hardcoded in the frontend rebuild command in docs/runbook.md (must match exactly) |
| `N8N_ENCRYPTION_KEY` | `chatbot-credentials` | n8n | `training-platform/data/n8n` → key `n8n_encryption_key` | encrypts n8n's stored credentials at rest |
| `N8N_OWNER_PASSWORD` | `chatbot-credentials` | n8n, metrics-exporter | `training-platform/data/n8n` → key `n8n_owner_password` | editor login; metrics-exporter reuses it to call n8n's REST API — requires an image built from training-platform-chatbot-n8n PR #7/#8's Dockerfile fix (sources `/vault/secrets/env`) |
| `AI_API_KEY` | `chatbot-credentials` | n8n | `training-platform/data/n8n` → key `n8n_ai_api_key` | the LLM provider key |
| `REDIS_PASSWORD` (chatbot's) | `chatbot-credentials` | chatbot-redis (StatefulSet) | `training-platform/data/n8n` → key `redis_password` | **distinct instance/value from backend's own `redis_password` above** — chatbot-redis itself always reads the plain bootstrap Secret too, same reasoning as backend-redis |
| `admin-password` | `grafana-admin-credentials` (monitoring ns) | grafana | not migrated to Vault — monitoring stack isn't part of the app-tier Vault rollout in ARCHITECTURE-PLAN.md §9 | `admin-user` alongside it, also not secret-sensitive but kept in the same Secret for convenience |

## Deliberately NOT secret, NOT in Vault

Everything else the apps need (`CLIENT_URL`, `PORT`, `SMTP_HOST`,
`N8N_WEBHOOK_URL`, `VAPID_PUBLIC_KEY`, image tags, Route hosts, etc.) is
plain `values.yaml` / `environments/local-okd/*-values.yaml` — see
ARCHITECTURE-PLAN.md §5's closing note on why non-secrets don't belong in
Vault either. `VAPID_PUBLIC_KEY` is already filled in with its real value
(safe — that's the point of a public key) in
`environments/local-okd/backend-values.yaml` and the frontend rebuild
command in `docs/runbook.md`, so both stay a matched pair without a manual
copy step.

## CI-only values — not part of this inventory

The app repos' own `.env.example` files list a few CI-only throwaway
credentials (GitHub Actions test-container passwords). Those have nothing
to do with this cluster's runtime secrets and are intentionally excluded
here — see ARCHITECTURE-PLAN.md §5's closing paragraph.
