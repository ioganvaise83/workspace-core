'use strict';

/**
 * Offline test suite for the gateway and for the DSH cookie contract.
 *
 * Two kinds of test live here, and the difference matters:
 *
 *  - `unit`   — pure logic of the gateway (cookie minting, cookie stripping,
 *               secret comparison, config validation). No network.
 *  - `contract` — the gateway's cookie is presented to a REAL DSH binary running
 *               on loopback. This is the only honest proof that the format is
 *               right, because the format is owned by DSH, not by us.
 *
 * The contract tier is skipped unless DSH_INTEGRATION_BASE_URL is set, so the
 * suite stays runnable without side effects. It is still classified "offline":
 * it runs on a workstation against a local DSH, not on the corporate VM.
 *
 * Run:
 *   node --test deploy/tests/gateway.test.js
 *   DSH_INTEGRATION_BASE_URL=http://127.0.0.1:3199 \
 *   DSH_INTEGRATION_AUTHORITY=dsh.corp.example \
 *   DSH_INTEGRATION_SECRET_FILE=/tmp/dsh-seed/.credentials.yaml \
 *   node --test deploy/tests/gateway.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const gateway = require('../single-user/gateway/server.js');

function randomSecret() {
  return gateway.encodeBase64Url(crypto.randomBytes(32));
}

// ---------------------------------------------------------------------------
// unit: cookie minting
// ---------------------------------------------------------------------------

test('dshCookie produces the shape DSH verifies', () => {
  const secret = gateway.decodeBase64Url(randomSecret());
  const { name, value, payload } = gateway.dshCookie(secret, 'dsh.corp.example', 3600, 1000);

  const expectedName = 'dsh-auth-' + gateway.encodeBase64Url(crypto.createHash('sha256').update('dsh.corp.example').digest());
  assert.equal(name, expectedName, 'cookie name is derived from the authority');

  const parts = value.split('.');
  assert.equal(parts.length, 3, 'value has version, body and signature');
  assert.equal(parts[0], 'v1', 'version prefix is v1');

  assert.equal(payload.authority, 'dsh.corp.example');
  assert.equal(payload.issuedAt, 1000);
  assert.equal(payload.expiresAt, 1000 + 3600 * 1000);

  const expectedSignature = gateway.encodeBase64Url(crypto.createHmac('sha256', secret).update(parts[1]).digest());
  assert.equal(parts[2], expectedSignature, 'signature covers the exact body');
});

test('dshCookie binds the signature to the authority', () => {
  const secret = gateway.decodeBase64Url(randomSecret());
  const a = gateway.dshCookie(secret, 'a.example', 3600, 1000);
  const b = gateway.dshCookie(secret, 'b.example', 3600, 1000);
  assert.notEqual(a.name, b.name, 'different authority, different cookie name');
  assert.notEqual(a.value, b.value, 'and a different signed body');
});

test('dshCookie rejects a secret that is not 32 bytes', () => {
  assert.throws(() => gateway.dshCookie(Buffer.alloc(16), 'a.example', 3600));
});

test('a tampered body fails verification with the same algorithm DSH uses', () => {
  const secret = gateway.decodeBase64Url(randomSecret());
  const { value } = gateway.dshCookie(secret, 'dsh.corp.example', 3600, 1000);
  const [version, , signature] = value.split('.');
  const forgedBody = gateway.encodeBase64Url(Buffer.from(JSON.stringify({ version: 1, authority: 'dsh.corp.example', issuedAt: 1, expiresAt: 9e15 }), 'utf8'));
  const expected = gateway.encodeBase64Url(crypto.createHmac('sha256', secret).update(forgedBody).digest());
  assert.notEqual(`${version}.${forgedBody}.${signature}`, `${version}.${forgedBody}.${expected}`, 'a forged body needs a new signature');
});

// ---------------------------------------------------------------------------
// unit: cookie hygiene
// ---------------------------------------------------------------------------

test('stripDshCookies removes every dsh-auth cookie and keeps the rest', () => {
  const input = '_oauth2_proxy=abc; dsh-auth-AAA=one; theme=dark; dsh-auth-BBB=two';
  const output = gateway.stripDshCookies(input);
  assert.equal(output, '_oauth2_proxy=abc; theme=dark');
});

test('stripDshCookies is safe on empty and missing headers', () => {
  assert.equal(gateway.stripDshCookies(undefined), '');
  assert.equal(gateway.stripDshCookies(''), '');
  assert.equal(gateway.stripDshCookies('  ;  '), '');
});

test('stripDshCookies does not eat a lookalike prefix', () => {
  const output = gateway.stripDshCookies('notdsh-auth-x=1; dsh-auth-real=2');
  assert.equal(output, 'notdsh-auth-x=1');
});

// ---------------------------------------------------------------------------
// unit: secret comparison
// ---------------------------------------------------------------------------

test('secretMatches compares without leaking length decisions', () => {
  assert.equal(gateway.secretMatches('same', 'same'), true);
  assert.equal(gateway.secretMatches('same', 'diff'), false);
  assert.equal(gateway.secretMatches('short', 'longer-value'), false);
  assert.equal(gateway.secretMatches(undefined, 'value'), false);
});

// ---------------------------------------------------------------------------
// unit: base64url canonicality
// ---------------------------------------------------------------------------

test('decodeBase64Url accepts canonical values only', () => {
  const canonical = gateway.encodeBase64Url(crypto.randomBytes(32));
  assert.notEqual(gateway.decodeBase64Url(canonical), undefined);
  assert.equal(gateway.decodeBase64Url(canonical + '='), undefined, 'padding is not canonical');
  assert.equal(gateway.decodeBase64Url('not base64url!'), undefined);
});

// ---------------------------------------------------------------------------
// unit: handler admission
// ---------------------------------------------------------------------------

function fakeConfig(overrides = {}) {
  return {
    upstream: new URL('http://127.0.0.1:1'),
    listenHost: '127.0.0.1',
    listenPort: 1,
    allowedAuthorities: ['dsh.corp.example'],
    allowedSubjects: ['11111111-2222-3333-4444-555555555555'],
    cookieSecret: crypto.randomBytes(32),
    proxySharedSecret: 'shared-secret',
    cookieMaxAgeSeconds: 3600,
    issuer: 'https://id.corp.example/realms/personal-ai',
    ...overrides,
  };
}

function callHandler(config, headers) {
  return new Promise((resolve) => {
    const server = http.createServer(gateway.createHandler(config));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const request = http.request({ host: '127.0.0.1', port, path: '/', headers }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => {
          server.close();
          resolve({ status: response.statusCode, body, headers: response.headers });
        });
      });
      request.on('error', () => {
        server.close();
        resolve({ status: 0, body: '', headers: {} });
      });
      request.end();
    });
  });
}

test('handler refuses a caller without the proxy secret', async () => {
  const result = await callHandler(fakeConfig(), { host: 'dsh.corp.example' });
  assert.equal(result.status, 403);
});

test('handler refuses a request with no authenticated subject', async () => {
  const result = await callHandler(fakeConfig(), { host: 'dsh.corp.example', 'x-dsh-gateway-secret': 'shared-secret' });
  assert.equal(result.status, 401);
});

test('handler refuses an authenticated subject that is not allowlisted', async () => {
  const result = await callHandler(fakeConfig(), {
    host: 'dsh.corp.example',
    'x-dsh-gateway-secret': 'shared-secret',
    'x-auth-request-user': '99999999-0000-0000-0000-000000000000',
  });
  assert.equal(result.status, 403);
});

test('handler refuses a Host that is not an allowed authority', async () => {
  const result = await callHandler(fakeConfig(), {
    host: 'attacker.example',
    'x-dsh-gateway-secret': 'shared-secret',
    'x-auth-request-user': '11111111-2222-3333-4444-555555555555',
  });
  assert.equal(result.status, 421);
});

test('handler refuses a wrong proxy secret even with a valid subject', async () => {
  const result = await callHandler(fakeConfig(), {
    host: 'dsh.corp.example',
    'x-dsh-gateway-secret': 'wrong',
    'x-auth-request-user': '11111111-2222-3333-4444-555555555555',
  });
  assert.equal(result.status, 403);
});

// ---------------------------------------------------------------------------
// contract: the minted cookie is accepted by a real DSH
// ---------------------------------------------------------------------------

const integrationBase = process.env.DSH_INTEGRATION_BASE_URL;
const integrationAuthority = process.env.DSH_INTEGRATION_AUTHORITY;
const integrationSecretFile = process.env.DSH_INTEGRATION_SECRET_FILE;

test('contract: real DSH accepts the gateway-minted cookie', { skip: integrationBase === undefined }, async () => {
  const document = fs.readFileSync(integrationSecretFile, 'utf8');
  const secret = gateway.decodeBase64Url(document.match(/secret: ([A-Za-z0-9_-]+)/)[1]);
  assert.ok(secret && secret.byteLength === 32, 'secret file carries 32 bytes');

  const { name, value } = gateway.dshCookie(secret, integrationAuthority, 600);
  const status = await new Promise((resolve) => {
    const request = http.request(
      { host: '127.0.0.1', port: new URL(integrationBase).port, path: '/', headers: { host: integrationAuthority, cookie: `${name}=${value}` } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', () => resolve(0));
    request.end();
  });
  assert.equal(status, 200, 'DSH accepts the cookie minted by the gateway');
});

test('contract: real DSH rejects the same cookie for another authority', { skip: integrationBase === undefined }, async () => {
  const document = fs.readFileSync(integrationSecretFile, 'utf8');
  const secret = gateway.decodeBase64Url(document.match(/secret: ([A-Za-z0-9_-]+)/)[1]);
  const { name, value } = gateway.dshCookie(secret, integrationAuthority, 600);
  const status = await new Promise((resolve) => {
    const request = http.request(
      { host: '127.0.0.1', port: new URL(integrationBase).port, path: '/', headers: { host: 'other.example', cookie: `${name}=${value}` } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', () => resolve(0));
    request.end();
  });
  assert.equal(status, 401, 'a cookie is bound to its authority');
});
