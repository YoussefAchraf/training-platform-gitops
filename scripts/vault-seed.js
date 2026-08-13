#!/usr/bin/env node
// Seeds Vault with the real secret values from the three app repos' local
// .env files — the same values docker-compose already uses on this
// machine, so the OKD deployment behaves identically to local dev instead
// of silently drifting on a second, separately-typed set of secrets.
//
// Nothing here is committed with a real value: this script only ever reads
// secrets at run-time from .env files that are themselves gitignored in
// their own repos, and writes them straight into Vault over the network —
// no secret value is ever written to a file this repo tracks, and none are
// ever printed to stdout/stderr.
//
// Deliberately NOT a bash script: real .env values in this stack contain
// unquoted spaces (SMTP_PASS) and unquoted `*` glob characters
// (REPORT_JOB_CRON), which a naive `source`/`export` over those files
// mis-parses — a cron value like `*/10 * * * *` gets glob-expanded by the
// shell into literal filenames and executed as a command. Parsing KEY=VALUE
// lines as plain strings (no shell involved) avoids that class of bug
// entirely.
//
// Usage (from this repo's root, port-forwarded to the in-cluster Vault,
// e.g. `oc port-forward -n vault svc/vault 8200:8200`):
//
//   VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root node scripts/vault-seed.js
//
// Override BACKEND_REPO / CHATBOT_REPO if your checkout layout differs from
// this workspace's sibling-directory convention.
//
// Talks to Vault's KV-v2 HTTP API directly (Node's built-in fetch, 18+) —
// deliberately not the `vault` CLI. Real finding from an actual OKD deploy:
// the machine actually running this bootstrap had `oc` and `node` available
// but not a local `vault` binary, the same class of "assumed-available
// external tool" gap already found and fixed for `helm` in this same
// bootstrap sequence (see bootstrap/argocd-cluster-install.yaml's own
// header). Removing the dependency entirely, rather than documenting "make
// sure vault is installed first", is the fix that can't go stale.

'use strict';
const fs = require('fs');
const path = require('path');

const BACKEND_REPO = process.env.BACKEND_REPO || '../training-platform-backend';
const CHATBOT_REPO = process.env.CHATBOT_REPO || '../training-platform-chatbot-n8n';

for (const v of ['VAULT_ADDR', 'VAULT_TOKEN']) {
  if (!process.env[v]) {
    console.error(`Set ${v} first — see docs/runbook.md §6 (dev-mode default token is "root")`);
    process.exit(1);
  }
}

// Parses KEY=VALUE lines as plain text — no shell, no glob expansion, no
// command substitution. Strips comments/blank lines. Matches dotenv's own
// duplicate-key behavior (last occurrence in the file wins), which is also
// what training-platform-backend's own dotenv-based config loading does —
// this reads the same *effective* values the app itself would load.
function parseEnvFile(file) {
  if (!fs.existsSync(file)) {
    console.error(`Not found: ${file} — set the matching *_REPO override`);
    process.exit(1);
  }
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, if present — same as dotenv.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value; // later occurrence overwrites earlier — matches dotenv's own parsing
  }
  return out;
}

function requireKeys(env, keys, file) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`${file} is missing/empty: ${missing.join(', ')}`);
    process.exit(1);
  }
}

async function vaultKvPut(mountRelativePath, data) {
  // KV-v2's real API path always has "data/" between the mount and the
  // subpath (e.g. "training-platform/data/backend", matching what Vault
  // Agent's own annotations expect) — callers pass the shorter,
  // CLI-style path (mount/subpath, no "data/"); this function is the one
  // place that needs to know the difference. Same distinction the old
  // `vault kv put` wrapper handled automatically — confirmed on an
  // actual live cluster that getting this wrong silently writes the data
  // one level too deep, where Vault Agent never finds it.
  const slash = mountRelativePath.indexOf('/');
  const mount = mountRelativePath.slice(0, slash);
  const subpath = mountRelativePath.slice(slash + 1);
  const url = `${process.env.VAULT_ADDR}/v1/${mount}/data/${subpath}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Vault-Token': process.env.VAULT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vault API ${res.status} ${res.statusText} writing ${mount}/data/${subpath}: ${body}`);
  }
}

async function main() {
  console.log(`Reading ${BACKEND_REPO}/.env ...`);
  const backendEnv = parseEnvFile(path.join(BACKEND_REPO, '.env'));
  requireKeys(backendEnv, ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'JWT_SECRET', 'SMTP_USER', 'SMTP_PASS', 'VAPID_PRIVATE_KEY'], `${BACKEND_REPO}/.env`);

  // backend's own Vault path bundles everything its Deployment's Vault Agent
  // template (charts/backend/templates/deployment.yaml) reads in one `with
  // secret` block — including postgres_password and (backend's own)
  // redis_password, duplicated here rather than split across multiple Vault
  // reads. See docs/secrets-inventory.md.
  await vaultKvPut('training-platform/backend', {
    postgres_password: backendEnv.POSTGRES_PASSWORD,
    redis_password: backendEnv.REDIS_PASSWORD,
    jwt_secret: backendEnv.JWT_SECRET,
    smtp_user: backendEnv.SMTP_USER,
    smtp_password: backendEnv.SMTP_PASS,
    vapid_private_key: backendEnv.VAPID_PRIVATE_KEY,
  });
  console.log('  -> training-platform/data/backend written (6 keys)');

  // postgres's own dedicated path (charts/postgres/templates/statefulset.yaml,
  // vault.enabled) - deliberately the SAME POSTGRES_PASSWORD value just
  // written above for backend, not independently generated, so the two can
  // never drift apart again. Real finding from an actual OKD deploy: a
  // manually-created postgres-credentials Secret using a different,
  // separately-generated password than what backend/Vault expected cost
  // hours of debugging ("password authentication failed") before the two
  // were discovered to simply be different values that happened to both
  // look valid.
  await vaultKvPut('training-platform/postgres', {
    postgres_password: backendEnv.POSTGRES_PASSWORD,
  });
  console.log('  -> training-platform/data/postgres written (1 key, same value as backend\'s postgres_password)');

  console.log(`Reading ${CHATBOT_REPO}/.env ...`);
  const chatbotEnv = parseEnvFile(path.join(CHATBOT_REPO, '.env'));
  requireKeys(chatbotEnv, ['N8N_ENCRYPTION_KEY', 'N8N_OWNER_PASSWORD', 'AI_API_KEY', 'REDIS_PASSWORD'], `${CHATBOT_REPO}/.env`);

  // n8n's own Vault path, same bundling pattern — includes the CHATBOT
  // redis's password, a distinct value from backend's own redis_password
  // above (two separate redis instances, see ARCHITECTURE-PLAN.md §6).
  await vaultKvPut('training-platform/n8n', {
    n8n_encryption_key: chatbotEnv.N8N_ENCRYPTION_KEY,
    n8n_owner_password: chatbotEnv.N8N_OWNER_PASSWORD,
    n8n_ai_api_key: chatbotEnv.AI_API_KEY,
    redis_password: chatbotEnv.REDIS_PASSWORD,
  });
  console.log('  -> training-platform/data/n8n written (4 keys)');

  console.log('\nDone. Vault now holds the same secret values your local docker-compose');
  console.log('stacks already use. Next: create/confirm backend-role and n8n-role');
  console.log('(Kubernetes auth method bound to the backend/n8n ServiceAccounts) per');
  console.log('docs/runbook.md §6 before flipping vault.enabled: true.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
