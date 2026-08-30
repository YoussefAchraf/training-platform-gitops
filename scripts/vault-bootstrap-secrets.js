#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const readline = require('readline');

for (const v of ['VAULT_ADDR', 'VAULT_TOKEN']) {
  if (!process.env[v]) {
    console.error(`Set ${v} first — see docs/runbook.md §2 (get VAULT_TOKEN from the vault-init-keys Secret)`);
    process.exit(1);
  }
}

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

  const pgFromBackend = current.backend.postgres_password;
  const pgFromPostgres = current.postgres.postgres_password;
  if (pgFromBackend && pgFromPostgres && pgFromBackend !== pgFromPostgres) {
    console.error('training-platform/data/backend and training-platform/data/postgres already hold');
    console.error('DIFFERENT postgres_password values. Refusing to guess which is correct - this is');
    console.error('exactly the drift this script exists to prevent. Resolve by hand first, then re-run.');
    process.exit(1);
  }
  const postgresPasswordMissing = !pgFromBackend && !pgFromPostgres;

  const bucketBMissing = [];
  if (postgresPasswordMissing) bucketBMissing.push('postgres_password (shared by backend + postgres)');
  for (const [pathKey, spec] of Object.entries(FIELD_SPECS)) {
    for (const [field, kind] of Object.entries(spec.fields)) {
      if (field === 'postgres_password') continue;
      if (current[pathKey][field]) continue;
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
