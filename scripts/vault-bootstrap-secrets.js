#!/usr/bin/env node
// Gets real secret values into Vault WITHOUT ever writing them to a file —
// no encrypted file committed to this repo, no plaintext file on disk
// either. Replaces the old scripts/vault-seed.js, which decrypted a
// SOPS+age file (environments/local-okd/app-secrets.sops.env) committed in
// git. That file is gone now, on purpose: a secrets file living in git
// history forever is exactly the risk real companies design around, not
// how big of a lock it has. See docs/secrets-inventory.md for the reasoning
// and the full field-by-field table this script implements.
//
// Every value this script handles falls into one of three buckets:
//
//   A) freely regenerate — nothing else depends on a specific value
//      (jwt_secret). Auto-generated the moment it's missing, no questions
//      asked.
//   B) init-once, pinned-after — safe to freely (re)generate ONLY if the
//      external system consuming it is ALSO being freshly initialized
//      right now (postgres_password, both redis passwords,
//      n8n_encryption_key, n8n_owner_password). Generating one of these on
//      an already-initialized system silently desyncs Vault's copy from
//      what's actually enforced elsewhere — this repo already hit exactly
//      that bug once (backend and postgres independently getting different
//      postgres_password values). Gated behind one combined y/N prompt.
//   C) external, human-supplied — real third-party credentials nothing on
//      this machine can invent (smtp_user, smtp_password, n8n_ai_api_key).
//      Always a masked, typed-in prompt. vapid_private_key is the same
//      mechanism but never auto-generated even on a fresh install — its
//      public half is already baked into a deployed frontend image and
//      backend-values.yaml, so a NEW keypair would break every existing
//      browser push subscription.
//
// Nothing typed in ever touches disk: prompted values live only in this
// process's memory and go straight to Vault's HTTP API. Nothing already
// present in Vault is ever touched — this script only ever fills in
// missing keys, so it's safe to re-run against an already-seeded Vault
// (confirm with `vault kv metadata get` before/after — current_version
// should be unchanged if nothing was actually missing).
//
// Usage (from this repo's root, port-forwarded to the in-cluster Vault,
// e.g. `oc port-forward -n vault svc/vault 8200:8200`):
//
//   VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=<root token> node scripts/vault-bootstrap-secrets.js
//
// Get VAULT_TOKEN from: oc get secret vault-init-keys -n vault -o jsonpath='{.data.root_token}' | base64 -d
//
// Talks to Vault's KV-v2 HTTP API directly (Node's built-in fetch, 18+) and
// uses only Node's own `crypto`/`readline` — zero runtime dependencies,
// same constraint scripts/package.json already states.

'use strict';
const crypto = require('crypto');
const readline = require('readline');

for (const v of ['VAULT_ADDR', 'VAULT_TOKEN']) {
  if (!process.env[v]) {
    console.error(`Set ${v} first — see docs/runbook.md §2 (get VAULT_TOKEN from the vault-init-keys Secret)`);
    process.exit(1);
  }
}

// Field classification per Vault path. 'linked' (postgres_password) is
// handled separately in main() since it's shared, byte-for-byte, across
// two paths — see docs/secrets-inventory.md on why that's deliberate.
const FIELD_SPECS = {
  backend: {
    vaultPath: 'training-platform/backend',
    fields: {
      postgres_password: 'linked',
      redis_password: 'generated-pinned',
      jwt_secret: 'generated-free',
      smtp_user: 'prompted',
      smtp_password: 'prompted',
      vapid_private_key: 'prompted-vapid',
    },
  },
  postgres: {
    vaultPath: 'training-platform/postgres',
    fields: { postgres_password: 'linked' },
  },
  n8n: {
    vaultPath: 'training-platform/n8n',
    fields: {
      n8n_encryption_key: 'generated-pinned',
      n8n_owner_password: 'generated-pinned',
      n8n_ai_api_key: 'prompted',
      redis_password: 'generated-pinned',
    },
  },
};

// KV-v2's real API path always has "data/" between the mount and the
// subpath — same split logic the old vault-seed.js used.
function splitMount(mountRelativePath) {
  const slash = mountRelativePath.indexOf('/');
  return [mountRelativePath.slice(0, slash), mountRelativePath.slice(slash + 1)];
}

async function vaultKvGet(mountRelativePath) {
  const [mount, subpath] = splitMount(mountRelativePath);
  const url = `${process.env.VAULT_ADDR}/v1/${mount}/data/${subpath}`;
  const res = await fetch(url, { headers: { 'X-Vault-Token': process.env.VAULT_TOKEN } });
  if (res.status === 404) return {};
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vault API ${res.status} ${res.statusText} reading ${mount}/data/${subpath}: ${body}`);
  }
  const body = await res.json();
  // A soft-deleted-but-not-destroyed KV-v2 version has data: null - treat
  // exactly like "nothing here yet", same as a genuine 404.
  return (body.data && body.data.data) || {};
}

async function vaultKvPut(mountRelativePath, data) {
  const [mount, subpath] = splitMount(mountRelativePath);
  const url = `${process.env.VAULT_ADDR}/v1/${mount}/data/${subpath}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'X-Vault-Token': process.env.VAULT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vault API ${res.status} ${res.statusText} writing ${mount}/data/${subpath}: ${body}`);
  }
}

// base64url, not plain base64: these values get interpolated RAW into
// DATABASE_URL/REDIS_URL connection strings and into single-quoted
// shell-rendered env by the Vault Agent templates in charts/backend,
// charts/postgres, charts/chatbot. Plain base64's alphabet includes `+`,
// `/`, and `=` padding, any of which could corrupt a connection-string URL
// or break out of a single-quoted shell value. base64url's alphabet
// (A-Za-z0-9-_, no padding) has none of those characters, so it's safe in
// both contexts by construction.
function generate() {
  return crypto.randomBytes(32).toString('base64url');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let muted = false;
const realWriteToOutput = rl._writeToOutput.bind(rl);
rl._writeToOutput = (stringToWrite) => {
  if (muted) rl.output.write('*');
  else realWriteToOutput(stringToWrite);
};

function confirm(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(/^y(es)?$/i.test(answer.trim())));
  });
}

// Standard dependency-free Node trick for masked input: the prompt text
// itself is written synchronously by rl.question() before `muted` flips to
// true, so only the characters the user types afterward get starred out.
// Falls back to plain (visible) input when stdin isn't a TTY - e.g. piped
// input in a test harness - since there's nothing to mask in that case and
// masking would just corrupt the read.
function promptSecret(label) {
  return new Promise((resolve) => {
    const query = `  ${label}: `;
    rl.question(query, (answer) => {
      muted = false;
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer.trim());
    });
    if (process.stdin.isTTY) muted = true;
  });
}

async function main() {
  const current = {
    backend: await vaultKvGet(FIELD_SPECS.backend.vaultPath),
    postgres: await vaultKvGet(FIELD_SPECS.postgres.vaultPath),
    n8n: await vaultKvGet(FIELD_SPECS.n8n.vaultPath),
  };

  // Resolve the linked postgres_password first, across both its paths,
  // with a hard-fail drift check - this is what makes the exact incident
  // this repo already hit once (backend and postgres independently having
  // DIFFERENT postgres_password values) detectable instead of reproducible.
  const pgFromBackend = current.backend.postgres_password;
  const pgFromPostgres = current.postgres.postgres_password;
  if (pgFromBackend && pgFromPostgres && pgFromBackend !== pgFromPostgres) {
    console.error('training-platform/data/backend and training-platform/data/postgres already hold');
    console.error('DIFFERENT postgres_password values. Refusing to guess which is correct - this is');
    console.error('exactly the drift this script exists to prevent. Resolve by hand first, then re-run.');
    process.exit(1);
  }
  const postgresPasswordMissing = !pgFromBackend && !pgFromPostgres;

  // Collect every Bucket-B field that's missing, across all paths, plus
  // postgres_password itself if missing - one combined confirmation covers
  // all of them, since they share the same "is this a fresh install"
  // question.
  const bucketBMissing = [];
  if (postgresPasswordMissing) bucketBMissing.push('postgres_password (shared by backend + postgres)');
  for (const [pathKey, spec] of Object.entries(FIELD_SPECS)) {
    for (const [field, kind] of Object.entries(spec.fields)) {
      if (field === 'postgres_password') continue;
      if (current[pathKey][field]) continue; // already set - never touched
      if (kind === 'generated-pinned') bucketBMissing.push(`${field} (${pathKey})`);
    }
  }

  let freshInstall = false;
  if (bucketBMissing.length > 0) {
    console.log('The following values are missing and are tied to already-initialized systems');
    console.log('(postgres\'s own data directory, backend-credentials/chatbot-credentials Secrets,');
    console.log('n8n\'s PVC) - generating a NEW value for any of these while that system already has');
    console.log('data would desync Vault from what\'s actually in use there:');
    for (const item of bucketBMissing) console.log(`  - ${item}`);
    freshInstall = await confirm('\nIs this a genuinely fresh install - is EVERY one of those stores also empty right now? [y/N] ');
    console.log(freshInstall
      ? 'Generating fresh values for all of the above.\n'
      : 'Will ask for each existing value instead.\n');
  }

  const staged = { backend: {}, postgres: {}, n8n: {} };

  if (postgresPasswordMissing) {
    const value = freshInstall ? generate() : await promptSecret('postgres_password (the EXISTING value already in use)');
    staged.backend.postgres_password = value;
    staged.postgres.postgres_password = value;
  }

  for (const [pathKey, spec] of Object.entries(FIELD_SPECS)) {
    for (const [field, kind] of Object.entries(spec.fields)) {
      if (field === 'postgres_password') continue;
      if (current[pathKey][field]) continue;
      if (kind === 'generated-free') {
        staged[pathKey][field] = generate();
      } else if (kind === 'generated-pinned') {
        staged[pathKey][field] = freshInstall
          ? generate()
          : await promptSecret(`${field} (${pathKey}, the EXISTING value already in use)`);
      } else if (kind === 'prompted') {
        staged[pathKey][field] = await promptSecret(`${field} (${pathKey})`);
      } else if (kind === 'prompted-vapid') {
        staged[pathKey][field] = await promptSecret(
          `${field} - paste the EXISTING private key, do NOT generate a new one (its public half is already deployed; a new pair breaks every live push subscription)`,
        );
      }
    }
  }

  rl.close();

  for (const [pathKey, spec] of Object.entries(FIELD_SPECS)) {
    const stagedFields = staged[pathKey];
    if (Object.keys(stagedFields).length === 0) {
      console.log(`${spec.vaultPath}: already complete, nothing to write.`);
      continue;
    }
    const merged = { ...current[pathKey], ...stagedFields };
    await vaultKvPut(spec.vaultPath, merged);
    console.log(`${spec.vaultPath}: wrote ${Object.keys(stagedFields).length} key(s) — ${Object.keys(stagedFields).join(', ')}`);
  }

  console.log('\nDone. No secret value was printed above.');
  console.log('Retrieve one later with: vault kv get -field=<key> training-platform/<backend|postgres|n8n>');
}

main().catch((err) => {
  rl.close();
  console.error(err.message);
  process.exit(1);
});
