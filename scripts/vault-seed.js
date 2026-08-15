#!/usr/bin/env node
// Seeds Vault with the real secret values for this stack, decrypted
// in-memory from a single SOPS+age encrypted file committed inside THIS
// repo (environments/local-okd/app-secrets.sops.env) — no other repo
// needs to be checked out locally to bootstrap Vault anymore. Replaces
// the old two-sibling-repo .env read: checking out
// training-platform-backend and training-platform-chatbot-n8n just to
// seed Vault made this repo not self-sufficient.
//
// Nothing here is committed with a real PLAINTEXT value: the committed
// file is SOPS+age ciphertext (every value individually AES256_GCM
// encrypted, key names stay in cleartext for readable diffs — see
// .sops.yaml). This script decrypts it straight into memory over a child
// process pipe and writes the result straight into Vault over the
// network — no plaintext secret value is ever written to a file this
// repo tracks, and none are ever printed to stdout/stderr.
//
// Deliberately still NOT shell-parsed for the actual KEY=VALUE text:
// real values in this stack contain unquoted spaces (SMTP_PASS) and
// unquoted `*` glob characters (a cron-style value elsewhere in this
// stack), which a naive `source`/`export` mis-parses. Parsing KEY=VALUE
// lines as plain strings (no shell involved) avoids that class of bug
// entirely — same reasoning as before, just now applied to sops's
// decrypted stdout instead of a file read directly off disk.
//
// Shells out to the `sops` binary (execFileSync, never a shell — see
// decryptDotenv() below) to decrypt, matching the established
// assumed-installed-external-tool pattern already used for oc/helm/argocd
// in this repo's bootstrap sequence (see docs/runbook.md) — not
// vendored, not an npm dependency (scripts/package.json stays at zero
// runtime deps by design).
//
// Usage (from this repo's root, port-forwarded to the in-cluster Vault,
// e.g. `oc port-forward -n vault svc/vault 8200:8200`):
//
//   VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root node scripts/vault-seed.js
//
// Requires `sops` on PATH and this machine's age private key at its
// default lookup path (%AppData%\sops\age\keys.txt on Windows) or
// SOPS_AGE_KEY_FILE pointed at it — see docs/runbook.md §2 for the
// one-time setup. Override SECRETS_FILE if you ever need to point this
// at a different encrypted file.
//
// Talks to Vault's KV-v2 HTTP API directly (Node's built-in fetch, 18+)
// — deliberately not the `vault` CLI. Real finding from an actual OKD
// deploy: the machine actually running this bootstrap had `oc` and
// `node` available but not a local `vault` binary, the same class of
// "assumed-available external tool" gap already found and fixed for
// `helm` in this same bootstrap sequence (see
// bootstrap/argocd-cluster-install.yaml's own header). Removing the
// dependency entirely, rather than documenting "make sure vault is
// installed first", is the fix that can't go stale.

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SECRETS_FILE = process.env.SECRETS_FILE
  || path.join(__dirname, '..', 'environments', 'local-okd', 'app-secrets.sops.env');

for (const v of ['VAULT_ADDR', 'VAULT_TOKEN']) {
  if (!process.env[v]) {
    console.error(`Set ${v} first — see docs/runbook.md §2 (dev-mode default token is "root")`);
    process.exit(1);
  }
}

// Shells out to `sops` via execFileSync — never exec()/a shell, so a
// value containing `*` or spaces can never be glob-expanded or
// re-tokenized (this call only ever passes a fixed, hardcoded args
// array; no secret value ever flows through argv here, only a file
// path). sops reads the local age private key automatically (default OS
// lookup path, or SOPS_AGE_KEY_FILE) — nothing about the key's location
// is hardcoded here. stderr is inherited so sops's own diagnostics (no
// matching creation rule, missing key file, wrong recipient) print
// directly instead of being swallowed into a caught exception.
//
// --output-type dotenv is load-bearing here (decrypting to stdout has no
// filename to infer format from); --input-type dotenv is technically
// redundant since the file's own .env extension already implies it, but
// kept for clarity — see getsops/sops#1168 on why extension, not the
// flag, wins when the two would ever disagree.
function decryptDotenv(file) {
  if (!fs.existsSync(file)) {
    console.error(`Not found: ${file} — see docs/runbook.md §2 to create it, or set SECRETS_FILE`);
    process.exit(1);
  }
  try {
    return execFileSync(
      'sops',
      ['-d', '--input-type', 'dotenv', '--output-type', 'dotenv', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error("'sops' not found on PATH — see docs/runbook.md §2 for the install steps.");
    } else {
      console.error(`sops decrypt failed for ${file} — is your age key at %AppData%\\sops\\age\\keys.txt`);
      console.error('(or SOPS_AGE_KEY_FILE) the one .sops.yaml was encrypted for? See docs/runbook.md §2.');
    }
    process.exit(1);
  }
}

// Parses KEY=VALUE lines as plain text — no shell, no glob expansion, no
// command substitution. Strips comments/blank lines. Matches dotenv's
// own duplicate-key behavior (last occurrence wins). Operates on the
// already-decrypted text sops handed back on its stdout, not a file read
// directly off disk — same parsing as before this change, new source.
function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
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
  // place that needs to know the difference. Confirmed on an actual live
  // cluster that getting this wrong silently writes the data one level
  // too deep, where Vault Agent never finds it.
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
  console.log(`Decrypting ${SECRETS_FILE} ...`);
  const appEnv = parseDotenv(decryptDotenv(SECRETS_FILE));
  requireKeys(appEnv, [
    'POSTGRES_PASSWORD', 'BACKEND_REDIS_PASSWORD', 'JWT_SECRET',
    'SMTP_USER', 'SMTP_PASS', 'VAPID_PRIVATE_KEY',
    'N8N_ENCRYPTION_KEY', 'N8N_OWNER_PASSWORD', 'N8N_AI_API_KEY',
    'CHATBOT_REDIS_PASSWORD',
  ], SECRETS_FILE);

  // backend's own Vault path bundles everything its Deployment's Vault
  // Agent template (charts/backend/templates/deployment.yaml) reads in
  // one `with secret` block — including postgres_password and (backend's
  // own) redis_password, duplicated here rather than split across
  // multiple Vault reads. See docs/secrets-inventory.md.
  await vaultKvPut('training-platform/backend', {
    postgres_password: appEnv.POSTGRES_PASSWORD,
    redis_password: appEnv.BACKEND_REDIS_PASSWORD,
    jwt_secret: appEnv.JWT_SECRET,
    smtp_user: appEnv.SMTP_USER,
    smtp_password: appEnv.SMTP_PASS,
    vapid_private_key: appEnv.VAPID_PRIVATE_KEY,
  });
  console.log('  -> training-platform/data/backend written (6 keys)');

  // postgres's own dedicated path (charts/postgres/templates/statefulset.yaml,
  // vault.enabled) — deliberately the SAME POSTGRES_PASSWORD value just
  // written above for backend, not independently generated, so the two
  // can never drift apart again. Real finding from an actual OKD deploy:
  // backend and postgres each independently having their own
  // postgres_password, generated at different times, cost hours of
  // debugging ("password authentication failed") before the two were
  // discovered to simply be different values that happened to both look
  // valid.
  await vaultKvPut('training-platform/postgres', {
    postgres_password: appEnv.POSTGRES_PASSWORD,
  });
  console.log('  -> training-platform/data/postgres written (1 key, same value as backend\'s postgres_password)');

  // n8n's own Vault path, same bundling pattern — includes the CHATBOT
  // redis's password, a distinct value from backend's own redis_password
  // above (two separate redis instances, see ARCHITECTURE-PLAN.md §6).
  await vaultKvPut('training-platform/n8n', {
    n8n_encryption_key: appEnv.N8N_ENCRYPTION_KEY,
    n8n_owner_password: appEnv.N8N_OWNER_PASSWORD,
    n8n_ai_api_key: appEnv.N8N_AI_API_KEY,
    redis_password: appEnv.CHATBOT_REDIS_PASSWORD,
  });
  console.log('  -> training-platform/data/n8n written (4 keys)');

  console.log('\nDone. Vault now holds the values decrypted from');
  console.log('environments/local-okd/app-secrets.sops.env. Next: create/confirm');
  console.log('backend-role and n8n-role (Kubernetes auth method bound to the');
  console.log('backend/n8n ServiceAccounts) per docs/runbook.md §2 before flipping');
  console.log('vault.enabled: true.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
