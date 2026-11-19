// Tests for the platform-level wiring: registry, bootstrap and compose.
//
// These cover the "does it register correctly, and does it still work when
// nothing is configured" requirements, which are properties of the platform
// files rather than of the server process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const CORE = path.resolve(import.meta.dirname, '..', '..', '..');
const REGISTRY = path.join(CORE, 'integrations', 'registry.json');
const BOOTSTRAP = path.join(CORE, 'scripts', 'bootstrap-integrations.cjs');
const COMPOSE = path.join(CORE, 'compose.yaml');
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client/package.json');
const yaml = require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml');

/** @returns {string} fresh temp dir */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-platform-'));
}

/**
 * Build a fake DSH home with a profile and the given token names.
 *
 * @param {string} dir
 * @param {string[]} tokens file names to mint
 * @param {string} [patchContents] initial cordis.patch.yml
 */
function fakeDshHome(dir, tokens, patchContents = '[]\n') {
  const profile = path.join(dir, 'profiles', 'web');
  const bootstrap = path.join(dir, 'bootstrap');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), patchContents);
  for (const token of tokens) {
    fs.writeFileSync(path.join(bootstrap, token), 'a'.repeat(64));
  }
}

/**
 * Run the bootstrap script against a fake DSH home.
 *
 * @param {string} dshHome
 * @param {string} [registry]
 * @returns {string} stdout
 */
function runBootstrap(dshHome, registry = REGISTRY) {
  return execFileSync(process.execPath, [BOOTSTRAP], {
    env: { ...process.env, DSH_HOME: dshHome, INTEGRATIONS_REGISTRY: registry },
    encoding: 'utf8',
  });
}

test('the registry declares mail-imap with a unique serverName and its own token', () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const entries = registry.integrations;
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'integration ids must be unique');

  const imap = entries.find((entry) => entry.id === 'mail-imap');
  assert.ok(imap, 'mail-imap must be registered');
  assert.equal(imap.enabled, true);
  assert.equal(imap.serverName, 'mail-imap');
  assert.equal(imap.url, 'http://mail-imap-mcp:8765/mcp');
  assert.equal(imap.tokenFile, 'mail-bridge.token');

  // Separate tokens: a leak in one integration must not open the other.
  const gmail = entries.find((entry) => entry.id === 'gmail');
  assert.ok(gmail, 'gmail must still be registered');
  assert.notEqual(gmail.tokenFile, imap.tokenFile);

  // Unique namespaces, which is what keeps mcp__gmail__* and mcp__mail-imap__* apart.
  const serverNames = entries.map((entry) => entry.serverName);
  assert.equal(new Set(serverNames).size, serverNames.length);
});

test('bootstrap registers both integrations without duplicating them', () => {
  const dir = tempDir();
  try {
    fakeDshHome(dir, ['gmail-bridge.token', 'mail-bridge.token']);
    runBootstrap(dir);
    const first = fs.readFileSync(path.join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');

    // Re-running is the normal case: every container start does it.
    runBootstrap(dir);
    runBootstrap(dir);
    const third = fs.readFileSync(path.join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');

    assert.equal(third, first, 'repeated registration must be byte-identical');
    assert.equal((third.match(/id: mcp-gmail/g) ?? []).length, 1);
    assert.equal((third.match(/id: mcp-mail-imap/g) ?? []).length, 1);

    // The result must be a valid DSH patch list.
    const parsed = yaml.parse(third);
    assert.ok(Array.isArray(parsed));
    const insert = parsed.find((entry) => Array.isArray(entry.insert));
    assert.deepEqual(
      insert.insert.map((entry) => entry.id).sort(),
      ['mcp-gmail', 'mcp-mail-imap'],
    );
    for (const entry of insert.insert) {
      assert.equal(entry.config.transport, 'streamable-http');
      assert.equal(entry.config.failOnStartupError, false, 'a down integration must not block the harness');
      assert.match(entry.config.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the mail token only Gmail is registered, and the harness still boots', () => {
  const dir = tempDir();
  try {
    // Deliberately omit mail-bridge.token: an unconfigured IMAP integration.
    fakeDshHome(dir, ['gmail-bridge.token']);
    runBootstrap(dir);
    const patch = fs.readFileSync(path.join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /id: mcp-gmail/);
    assert.doesNotMatch(patch, /id: mcp-mail-imap/);
    // Valid YAML is what keeps the harness starting.
    assert.ok(Array.isArray(yaml.parse(patch)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restoring the mail token re-registers IMAP without disturbing Gmail', () => {
  const dir = tempDir();
  try {
    fakeDshHome(dir, ['gmail-bridge.token', 'mail-bridge.token']);
    runBootstrap(dir);
    const withBoth = fs.readFileSync(path.join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');

    fs.rmSync(path.join(dir, 'bootstrap', 'mail-bridge.token'));
    runBootstrap(dir);
    const withOne = fs.readFileSync(path.join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    assert.match(withOne, /id: mcp-gmail/);
    assert.doesNotMatch(withOne, /id: mcp-mail-imap/);

    fs.writeFileSync(path.join(dir, 'bootstrap', 'mail-bridge.token'), 'b'.repeat(64));
    runBootstrap(dir);
    const restored = fs.readFileSync(path.join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    assert.equal((restored.match(/id: mcp-mail-imap/g) ?? []).length, 1);
    assert.match(restored, /id: mcp-gmail/);
    // Gmail's token is unchanged by the IMAP cycle.
    assert.match(withBoth, /Authorization: 'Bearer a{64}'/);
    assert.match(restored, /Authorization: 'Bearer a{64}'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-written profile entry survives registration untouched', () => {
  const dir = tempDir();
  try {
    const userPatch = [
      '# my own settings',
      '- id: llm-pi-ai',
      '  config:',
      '    provider: routerai',
      '    model: deepseek-v4.1',
      '# end',
      '',
    ].join('\n');
    fakeDshHome(dir, ['gmail-bridge.token', 'mail-bridge.token'], userPatch);
    runBootstrap(dir);
    const patch = fs.readFileSync(path.join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /# my own settings/);
    assert.match(patch, /provider: routerai/);
    assert.match(patch, /model: deepseek-v4\.1/);
    assert.match(patch, /# end/);
    assert.ok(Array.isArray(yaml.parse(patch)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty registry produces a valid, bootable profile', () => {
  const dir = tempDir();
  const registryFile = path.join(dir, 'registry.json');
  try {
    fs.writeFileSync(registryFile, JSON.stringify({ version: 1, integrations: [] }));
    fakeDshHome(dir, ['gmail-bridge.token', 'mail-bridge.token']);
    runBootstrap(dir, registryFile);
    const patch = fs.readFileSync(path.join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    assert.deepEqual(yaml.parse(patch), [], 'an empty patch list is valid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compose defines the IMAP service with the required hardening', () => {
  const compose = yaml.parse(fs.readFileSync(COMPOSE, 'utf8'));
  const service = compose.services['mail-imap-mcp'];
  assert.ok(service, 'mail-imap-mcp service must exist');

  // No host port: reachable only on the compose network.
  assert.equal(service.ports, undefined, 'no published ports');
  assert.deepEqual(service.expose, ['8765']);

  assert.equal(service.read_only, true);
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.ok(service.mem_limit, 'a memory limit bounds a decompression bomb');
  assert.ok(service.pids_limit);

  // Credentials come from bind mounts, never from the environment.
  const env = service.environment ?? {};
  for (const [key, value] of Object.entries(env)) {
    assert.doesNotMatch(String(value), /password|secret/i, `${key} must not carry a secret`);
  }
  const mounts = service.volumes.join(' ');
  assert.match(mounts, /:\/config:ro/, 'the account list is mounted read-only');
  assert.match(mounts, /:\/run\/secrets\/mail-imap:ro/, 'the password files are mounted read-only');
  assert.match(mounts, /dsh-home:\/dsh-home:ro/, 'the bridge token is mounted read-only');
});

test('compose keeps Gmail and the harness intact', () => {
  const compose = yaml.parse(fs.readFileSync(COMPOSE, 'utf8'));
  const gmail = compose.services['gmail-mcp'];
  assert.ok(gmail, 'gmail-mcp must still exist');
  // Gmail's own contract: its token, its OAuth mount, its allowlist entrypoint.
  assert.equal(gmail.environment.GMAIL_BRIDGE_TOKEN_FILE, '/dsh-home/bootstrap/gmail-bridge.token');
  assert.equal(gmail.read_only, true);
  assert.equal(gmail.ports, undefined);

  // The harness keeps its loopback-only publish and does not depend on health.
  const harness = compose.services.harness;
  assert.deepEqual(harness.ports, ['127.0.0.1:${DSH_PORT:-3080}:3080']);
  for (const [name, condition] of Object.entries(harness.depends_on)) {
    assert.notEqual(condition.condition, 'service_healthy', `${name} must not gate startup on health`);
  }
});

test('the approval directory is mounted writable and NOT into the harness', () => {
  const compose = yaml.parse(fs.readFileSync(COMPOSE, 'utf8'));
  const service = compose.services['mail-imap-mcp'];
  const mounts = service.volumes.join(' ');
  // The server must be able to record plans and approvals...
  assert.match(mounts, /:\/state(?![:\w])/, 'the approval directory must be mounted');
  assert.doesNotMatch(mounts, /:\/state:ro/, 'the approval directory must be writable');
  assert.equal(service.environment.MAIL_APPROVAL_DIR, '/state/approvals');

  // ...and the harness must NOT see it, or the agent could approve itself.
  const harnessMounts = compose.services.harness.volumes.join(' ');
  assert.doesNotMatch(harnessMounts, /:\/state/, 'the harness must not mount the approval directory');
  assert.doesNotMatch(harnessMounts, /mail-imap\/state/, 'the harness must not mount the approval path from the host');
});

test('the harness has no docker socket, so it cannot act on other containers', () => {
  const compose = yaml.parse(fs.readFileSync(COMPOSE, 'utf8'));
  const text = JSON.stringify(compose.services.harness);
  assert.equal(text.includes('docker.sock'), false, 'a docker socket would let the agent approve its own plans');
});

test('a separate one-shot service mints the IMAP token', () => {
  const compose = yaml.parse(fs.readFileSync(COMPOSE, 'utf8'));
  const mailToken = compose.services['mail-token'];
  assert.ok(mailToken, 'mail-token service must exist so the token precedes its reader');
  assert.equal(mailToken.environment.TOKEN_NAME, 'mail-bridge.token');
  assert.equal(mailToken.restart, 'no', 'a one-shot service must not restart in a loop');
  // It shares the proven script rather than duplicating minting logic.
  assert.ok(mailToken.volumes.some((volume) => volume.includes('init-token.sh')));
});

test('no compose file references a literal password', () => {
  const text = fs.readFileSync(COMPOSE, 'utf8');
  // Any assignment of a password-looking value would fail this.
  assert.doesNotMatch(text, /(PASSWORD|PASSWD|SECRET)=\S+/);
  // The only password-ish tokens allowed are documentation words.
  for (const line of text.split('\n')) {
    if (/password/i.test(line)) {
      assert.match(line, /^\s*#|passwordFile|password file|app password|passwords/i, `unexpected password mention: ${line}`);
    }
  }
});
