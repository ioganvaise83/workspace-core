'use strict';

/**
 * Structural validation of the compose files and templates.
 *
 * Docker is not available inside the agent container, so `docker compose config`
 * cannot run here. This test parses the YAML and asserts the properties that
 * matter for safety, which is a different (and stricter) question than "would
 * compose accept it". It is NOT a substitute for running `docker compose config`
 * on the VM: the report says so explicitly.
 *
 * Run: node --test deploy/tests/compose.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Resolve the parser from the DSH installation: the repository has no
// package.json of its own, and adding one for a test would be disproportionate.
function loadYaml() {
  const candidates = [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml/dist/index.js',
    'yaml',
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* keep trying */
    }
  }
  throw new Error('no YAML parser available');
}

const YAML = loadYaml();
const ROOT = path.resolve(__dirname, '..', '..');
const IDENTITY = path.join(ROOT, 'deploy/identity/compose.yaml');
const SINGLE = path.join(ROOT, 'deploy/single-user/compose.yaml');
const BASE = path.join(ROOT, 'compose.yaml');

function load(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Parseability
// ---------------------------------------------------------------------------

test('identity compose parses', () => {
  const doc = load(IDENTITY);
  assert.ok(doc.services, 'has services');
  assert.ok(doc.services.postgres, 'has postgres');
  assert.ok(doc.services.keycloak, 'has keycloak');
});

test('single-user compose parses', () => {
  const doc = load(SINGLE);
  assert.ok(doc.services, 'has services');
  for (const name of ['nginx', 'oauth2-proxy', 'gateway']) {
    assert.ok(doc.services[name], `has ${name}`);
  }
});

test('base compose still parses and keeps its services', () => {
  const doc = load(BASE);
  assert.ok(doc.services.harness, 'harness present');
  assert.ok(doc.services['gmail-mcp'], 'gmail present');
  assert.ok(doc.services['mail-imap-mcp'], 'mail-imap present');
});

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

test('no service except nginx publishes a port', () => {
  const single = load(SINGLE);
  for (const [name, service] of Object.entries(single.services)) {
    if (name === 'nginx') continue;
    assert.equal(service.ports, undefined, `${name} must not publish ports`);
  }
  const identity = load(IDENTITY);
  assert.equal(identity.services.postgres.ports, undefined, 'postgres must not publish');
});

test('host services publish no ports', () => {
  const base = load(BASE);
  for (const name of ['gmail-mcp', 'mail-imap-mcp', 'mcp-token', 'mail-token']) {
    assert.equal(base.services[name].ports, undefined, `${name} must not publish ports`);
  }
});

test('nginx publishes only on a configured address, never a wildcard', () => {
  const single = load(SINGLE);
  const ports = single.services.nginx.ports;
  assert.ok(Array.isArray(ports) && ports.length === 1, 'exactly one published port');
  assert.match(ports[0], /^\$\{NGINX_BIND_ADDRESS/, 'address comes from configuration');
  assert.doesNotMatch(ports[0], /^0\.0\.0\.0/, 'must not bind the wildcard address');
});

test('identity keycloak binds loopback by default', () => {
  const identity = load(IDENTITY);
  const ports = identity.services.keycloak.ports;
  assert.ok(Array.isArray(ports) && ports.length === 1);
  assert.match(ports[0], /\$\{KC_BIND_ADDRESS:-127\.0\.0\.1\}/, 'defaults to loopback');
});

// ---------------------------------------------------------------------------
// Privileges
// ---------------------------------------------------------------------------

test('no service mounts the Docker socket', () => {
  for (const file of [IDENTITY, SINGLE, BASE]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /docker\.sock/, `${file} must not mount the Docker socket`);
  }
});

test('no service runs privileged', () => {
  for (const file of [IDENTITY, SINGLE]) {
    const doc = load(file);
    for (const [name, service] of Object.entries(doc.services)) {
      assert.notEqual(service.privileged, true, `${name} must not be privileged`);
    }
  }
});

test('every single-user service drops all capabilities', () => {
  const doc = load(SINGLE);
  for (const [name, service] of Object.entries(doc.services)) {
    assert.ok(Array.isArray(service.cap_drop), `${name} declares cap_drop`);
    assert.ok(service.cap_drop.includes('ALL'), `${name} drops ALL`);
  }
});

test('cap_add, when present, names specific capabilities', () => {
  const doc = load(SINGLE);
  const added = doc.services.nginx.cap_add ?? [];
  assert.ok(!added.includes('ALL'), 'nginx must not re-add ALL');
  assert.ok(!added.includes('SYS_ADMIN'), 'nginx must not request SYS_ADMIN');
  assert.ok(added.length <= 5, 'capability set stays small');
});

test('no-new-privileges is set everywhere', () => {
  for (const file of [IDENTITY, SINGLE]) {
    const doc = load(file);
    for (const [name, service] of Object.entries(doc.services)) {
      const opts = service.security_opt ?? [];
      assert.ok(opts.includes('no-new-privileges:true'), `${name} sets no-new-privileges`);
    }
  }
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test('every secret is a file reference, never an inline value', () => {
  for (const file of [IDENTITY, SINGLE]) {
    const doc = load(file);
    const secrets = doc.secrets ?? {};
    for (const [name, secret] of Object.entries(secrets)) {
      assert.ok(secret.file, `${name} is a file secret`);
      assert.equal(secret.environment, undefined, `${name} is not an environment secret`);
    }
  }
});

test('secret paths are outside the repository or clearly host-provided', () => {
  const doc = load(SINGLE);
  for (const [name, secret] of Object.entries(doc.secrets)) {
    const value = secret.file;
    // Either a variable (set by the owner in .env) or an absolute host path.
    assert.ok(
      value.startsWith('${SECRETS_DIR') || value.startsWith('/'),
      `${name} must come from SECRETS_DIR or an absolute host path, got ${value}`,
    );
  }
});

test('oauth2-proxy config has no inline secret values', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'deploy/single-user/oauth2-proxy/oauth2-proxy.cfg'), 'utf8');
  assert.match(cfg, /client_secret_file\s*=/, 'client secret comes from a file');
  assert.match(cfg, /cookie_secret_file\s*=/, 'cookie secret comes from a file');
  assert.doesNotMatch(cfg, /^client_secret\s*=/m, 'no inline client secret');
  assert.doesNotMatch(cfg, /^cookie_secret\s*=/m, 'no inline cookie secret');
});

// ---------------------------------------------------------------------------
// Required configuration is demanded, not defaulted silently
// ---------------------------------------------------------------------------

test('security-critical variables fail closed when unset', () => {
  const text = fs.readFileSync(SINGLE, 'utf8');
  for (const variable of [
    'NGINX_BIND_ADDRESS',
    'DSH_HOSTNAME',
    'SECRETS_DIR',
    'TLS_DIR',
    'GATEWAY_ALLOWED_AUTHORITIES',
    'GATEWAY_ALLOWED_SUBJECTS',
  ]) {
    assert.match(
      text,
      new RegExp(`\\$\\{${variable}:[?]`),
      `${variable} must use the fail-closed \${VAR:?} form`,
    );
  }
});

test('the app network is external so the base project is not cloned', () => {
  const doc = load(SINGLE);
  assert.equal(doc.networks.app.external, true, 'app network is external');
});

// ---------------------------------------------------------------------------
// nginx template invariants
// ---------------------------------------------------------------------------

test('nginx template keeps auth_request on the application location', () => {
  const template = fs.readFileSync(path.join(ROOT, 'deploy/single-user/nginx/nginx.conf.template'), 'utf8');
  const httpsBlock = template.slice(template.indexOf('listen ${NGINX_HTTPS_PORT} ssl'));
  const appLocation = httpsBlock.slice(httpsBlock.indexOf('location / {'));
  const body = appLocation.slice(0, appLocation.indexOf('\n        }'));
  assert.match(body, /auth_request \/oauth2\/auth/, 'application location authenticates');
});


test('nginx log format cannot capture a query string', () => {
  const template = fs.readFileSync(path.join(ROOT, 'deploy/single-user/nginx/nginx.conf.template'), 'utf8');
  const format = template.slice(template.indexOf('log_format dsh_safe'), template.indexOf(';', template.indexOf('log_format dsh_safe')));
  for (const forbidden of ['$request_uri', '$args', '$http_cookie', '$http_authorization']) {
    assert.ok(!format.includes(forbidden), `log format must not include ${forbidden}`);
  }
  assert.ok(format.includes('$uri'), 'log format keeps the path for diagnostics');
});

// ---------------------------------------------------------------------------
// Identity assumptions
// ---------------------------------------------------------------------------

test('the OIDC issuer is configurable, so a corporate IdP can replace Keycloak', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'deploy/single-user/oauth2-proxy/oauth2-proxy.cfg'), 'utf8');
  assert.match(cfg, /^oidc_issuer_url\s*=\s*"https:\/\//m, 'issuer is an explicit URL');
  assert.match(cfg, /insecure_oidc_skip_issuer_verification\s*=\s*false/, 'issuer verification is on');
});

test('no email-domain admission is configured', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'deploy/single-user/oauth2-proxy/oauth2-proxy.cfg'), 'utf8');
  assert.match(cfg, /^email_domains\s*=\s*\[\]/m, 'email_domains is empty');
});

test('realm template disables self-registration', () => {
  const realm = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/identity/config/personal-ai-realm.json'), 'utf8'));
  assert.equal(realm.registrationAllowed, false, 'self-registration is off');
  assert.equal(realm.resetPasswordAllowed, false, 'self-service password reset is off');
  assert.equal(realm.bruteForceProtected, true, 'brute-force protection is on');
  assert.equal(realm.clients[0].publicClient, false, 'client is confidential');
  assert.equal(realm.clients[0].directAccessGrantsEnabled, false, 'no password grant');
  assert.equal(realm.clients[0].standardFlowEnabled, true, 'authorization code flow is on');
});

// ---------------------------------------------------------------------------
// Realm import wiring
// ---------------------------------------------------------------------------

test('realm placeholders are supplied to the Keycloak container', () => {
  const realm = fs.readFileSync(path.join(ROOT, 'deploy/identity/config/personal-ai-realm.json'), 'utf8');
  const placeholders = [...realm.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]);
  assert.ok(placeholders.length > 0, 'the template actually uses placeholders');

  const compose = fs.readFileSync(IDENTITY, 'utf8');
  for (const name of new Set(placeholders)) {
    assert.match(
      compose,
      new RegExp(`^\\s*${name}:`, 'm'),
      `${name} is referenced by the realm template but not passed to Keycloak`,
    );
  }
});

test('Keycloak imports the realm instead of requiring manual console work', () => {
  const doc = load(IDENTITY);
  assert.ok(
    doc.services.keycloak.command.includes('--import-realm'),
    'Keycloak starts with --import-realm',
  );
  const volumes = doc.services.keycloak.volumes.join(' ');
  assert.match(volumes, /:\/opt\/keycloak\/data\/import:ro/, 'import directory is mounted read-only');
});

// ---------------------------------------------------------------------------
// Header hygiene — regression guards for finding F-1
// ---------------------------------------------------------------------------

const NGINX_TEMPLATE = path.join(ROOT, 'deploy/single-user/nginx/nginx.conf.template');
const HYGIENE = path.join(ROOT, 'deploy/single-user/nginx/proxy-hygiene.conf');

/**
 * Split an nginx config into `location` blocks with their bodies. A tiny parser is
 * enough: our template uses consistent indentation and one level of nesting.
 */
function locationBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)location\s+(.+?)\s*\{/);
    if (!match) continue;
    const indent = match[1].length;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (new RegExp(`^\\s{${indent}}\\}`).test(line)) break;
      body.push(line);
    }
    blocks.push({ selector: match[2], body: body.join('\n') });
  }
  return blocks;
}

test('header clears live in the include, not scattered across locations', () => {
  const hygiene = fs.readFileSync(HYGIENE, 'utf8');
  for (const header of [
    'X-Auth-Request-User',
    'X-Auth-Request-Email',
    'X-Auth-Request-Groups',
    'X-Forwarded-User',
    'X-Forwarded-Email',
    'Authorization',
  ]) {
    assert.match(hygiene, new RegExp(`proxy_set_header ${header}\\s+""`), `${header} is cleared in the include`);
  }
});

test('every proxying location includes the hygiene file', () => {
  // This is the check that would have caught F-1: nginx drops all inherited
  // proxy_set_header directives as soon as a location sets one of its own, so a
  // location without the include silently loses every clear.
  const template = fs.readFileSync(NGINX_TEMPLATE, 'utf8');
  const blocks = locationBlocks(template);
  assert.ok(blocks.length >= 4, `expected several locations, found ${blocks.length}`);

  for (const { selector, body } of blocks) {
    const proxies = /\bproxy_pass\b/.test(body);
    if (!proxies) continue;
    assert.match(
      body,
      /include \/etc\/nginx\/dsh\/proxy-hygiene\.conf;/,
      `location ${selector} proxies upstream but does not include the hygiene file`,
    );
  }
});

test('no location sets a header the hygiene file clears, without also including it', () => {
  const template = fs.readFileSync(NGINX_TEMPLATE, 'utf8');
  const clearedHeaders = [
    'X-Auth-Request-User',
    'X-Auth-Request-Email',
    'X-Forwarded-User',
    'X-Forwarded-Email',
    'Authorization',
  ];
  for (const { selector, body } of locationBlocks(template)) {
    const sets = clearedHeaders.filter((header) => new RegExp(`proxy_set_header ${header}\\b`).test(body));
    if (sets.length === 0) continue;
    assert.match(
      body,
      /include \/etc\/nginx\/dsh\/proxy-hygiene\.conf;/,
      `location ${selector} sets ${sets.join(', ')} but does not include the clears`,
    );
  }
});

test('the server block itself sets no proxy_set_header', () => {
  // A server-level proxy_set_header would be inherited only by locations that set
  // none — precisely the trap of F-1. Keeping the server block free of them makes
  // the include the single mechanism.
  const template = fs.readFileSync(NGINX_TEMPLATE, 'utf8');
  const httpsBlock = template.slice(template.indexOf('listen ${NGINX_HTTPS_PORT} ssl'));
  const serverBody = httpsBlock.slice(0, httpsBlock.indexOf('location = /oauth2/auth'));
  // Strip comments: this file documents the trap by naming the directive.
  const directives = serverBody
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(
    directives,
    /\bproxy_set_header\b/,
    "the server block must not set proxy_set_header; put it in the hygiene include",
  );
});

test('the application location forwards the browser Host', () => {
  // Finding F-2: without this, nginx sends `Host: dsh_gateway`, the gateway
  // refuses with 421, and a widened allowlist would bind the cookie to a name the
  // browser never uses.
  const template = fs.readFileSync(NGINX_TEMPLATE, 'utf8');
  // There are two `location /` blocks: the plain-HTTP redirect and the
  // application. The application one is the one that proxies.
  const app = locationBlocks(template).find(
    (block) => block.selector === '/' && /proxy_pass/.test(block.body),
  );
  assert.ok(app, 'the application location exists');
  assert.match(app.body, /proxy_set_header Host \$host;/, 'Host must be propagated to the gateway');
});

test('auth_request has timeouts so a hung proxy fails closed quickly', () => {
  const template = fs.readFileSync(NGINX_TEMPLATE, 'utf8');
  const auth = locationBlocks(template).find((block) => block.selector === '= /oauth2/auth');
  assert.ok(auth, 'the auth subrequest location exists');
  assert.match(auth.body, /proxy_read_timeout\s+\d+s;/, 'a read timeout bounds the subrequest');
  assert.match(auth.body, /internal;/, 'clients cannot call the subrequest directly');
});

// ---------------------------------------------------------------------------
// Gateway cookie delivery — regression guards for finding F-3
// ---------------------------------------------------------------------------

test('the gateway sends Set-Cookie to the browser', () => {
  // Finding F-3: DSH emits no Set-Cookie on an ordinary request, so a gateway
  // that only forwards the minted cookie upstream leaves the browser with no
  // session at all.
  const source = fs.readFileSync(path.join(ROOT, 'deploy/single-user/gateway/server.js'), 'utf8');
  assert.match(source, /'set-cookie'/, 'the gateway writes a set-cookie response header');
  assert.match(source, /function sessionCookie/, 'a session cookie builder exists');
  assert.match(source, /HttpOnly/, 'the cookie is HttpOnly');
  assert.match(source, /Secure/, 'the cookie is Secure');
  assert.match(source, /SameSite=Strict/, 'the cookie is SameSite=Strict');
});

test('the gateway never forwards a client bearer token upstream', () => {
  const source = fs.readFileSync(path.join(ROOT, 'deploy/single-user/gateway/server.js'), 'utf8');
  assert.match(source, /delete headers(\.|\[')authorization/, 'Authorization is stripped');
  assert.match(source, /delete headers(\.|\[')proxy/, 'Proxy is stripped');
});

test('the gateway requires its shared secret on both HTTP and upgrade paths', () => {
  const source = fs.readFileSync(path.join(ROOT, 'deploy/single-user/gateway/server.js'), 'utf8');
  const occurrences = source.match(/x-dsh-gateway-secret/g) ?? [];
  assert.ok(occurrences.length >= 2, 'both the request handler and the upgrade handler check it');
});
