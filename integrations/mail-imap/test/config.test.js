// Tests for configuration loading and endpoint resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadAccounts, resolveEndpoint, describeAccount, maskLogin, PROVIDERS } from '../src/config.js';

/** @returns {string} a fresh temp directory */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-config-'));
}

test('missing accounts file is an empty configuration, not an error', () => {
  const dir = tempDir();
  const loaded = loadAccounts(path.join(dir, 'does-not-exist.json'));
  assert.deepEqual(loaded.accounts, []);
  assert.deepEqual(loaded.errors, []);
});

test('empty account list loads as zero accounts', () => {
  const dir = tempDir();
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: [] }));
  const loaded = loadAccounts(file);
  assert.equal(loaded.accounts.length, 0);
  assert.equal(loaded.errors.length, 0);
});

test('one account loads with a secret file, and the password is not enumerable', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.secret'), 'app-password-value\n');
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'yandex-personal-1', provider: 'yandex', user: 'someone@yandex.ru', passwordFile: 'a.secret' },
      ],
    }),
  );
  const { accounts, errors } = loadAccounts(file);
  assert.equal(errors.length, 0);
  assert.equal(accounts.length, 1);
  const account = accounts[0];
  assert.equal(account.id, 'yandex-personal-1');
  assert.equal(account.host, PROVIDERS.yandex.host);
  assert.equal(account.port, 993);
  // Present, correct, and invisible to serialisation.
  assert.equal(account.password, 'app-password-value');
  assert.equal(Object.keys(account).includes('password'), false);
  assert.equal(JSON.stringify(account).includes('app-password-value'), false);
});

test('three accounts load independently', () => {
  const dir = tempDir();
  for (const id of ['yandex-personal-1', 'yandex-personal-2', 'mailru-personal']) {
    fs.writeFileSync(path.join(dir, `${id}.secret`), `secret-${id}\n`);
  }
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'yandex-personal-1', provider: 'yandex', user: 'a@yandex.ru', passwordFile: 'yandex-personal-1.secret' },
        { id: 'yandex-personal-2', provider: 'yandex', user: 'b@yandex.ru', passwordFile: 'yandex-personal-2.secret' },
        { id: 'mailru-personal', provider: 'mailru', user: 'c@mail.ru', passwordFile: 'mailru-personal.secret' },
      ],
    }),
  );
  const { accounts, errors } = loadAccounts(file);
  assert.equal(errors.length, 0);
  assert.deepEqual(accounts.map((a) => a.id), ['yandex-personal-1', 'yandex-personal-2', 'mailru-personal']);
  assert.equal(accounts[2].host, 'imap.mail.ru');
});

test('a broken account does not block the others', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'good.secret'), 'good-secret\n');
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'good', provider: 'yandex', user: 'a@yandex.ru', passwordFile: 'good.secret' },
        { id: 'missing-secret', provider: 'yandex', user: 'b@yandex.ru', passwordFile: 'nope.secret' },
        { id: 'bad-provider', provider: 'unknown-provider', user: 'c@example.com', password: 'x' },
      ],
    }),
  );
  const { accounts, errors } = loadAccounts(file);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, 'good');
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map((e) => e.id).sort(), ['bad-provider', 'missing-secret']);
  // The error text names the file but never its (absent) content.
  assert.match(errors.find((e) => e.id === 'missing-secret').message, /not readable/);
});

test('a provider with no default endpoint requires an explicit host and port', () => {
  assert.throws(() => resolveEndpoint({ provider: 'custom', secure: true }), /set host and port explicitly/);
  const resolved = resolveEndpoint({ provider: 'custom', host: 'imap.example.com', port: 993, secure: true });
  assert.deepEqual(resolved, { host: 'imap.example.com', port: 993, secure: true });
});

test('an unknown provider is refused rather than guessed from the address', () => {
  assert.throws(() => resolveEndpoint({ provider: 'somewhere', user: 'a@somewhere.example', secure: true }), /unknown provider/);
});

test('cleartext IMAP is refused', () => {
  assert.throws(() => resolveEndpoint({ provider: 'yandex', secure: false }), /secure must stay true/);
});

test('the same provider resolves every account to the trusted table, not the domain part', () => {
  const first = resolveEndpoint({ provider: 'yandex', user: 'a@yandex.ru', secure: true });
  const second = resolveEndpoint({ provider: 'yandex', user: 'b@yandex.com', secure: true });
  assert.deepEqual(first, second);
  assert.equal(first.host, 'imap.yandex.ru');
});

test('both password forms in one entry is rejected', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.secret'), 'x\n');
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'both', provider: 'yandex', user: 'a@yandex.ru', passwordFile: 'a.secret', password: 'plain' },
      ],
    }),
  );
  const { accounts, errors } = loadAccounts(file);
  assert.equal(accounts.length, 0);
  assert.equal(errors.length, 1);
});

test('duplicate account ids keep the first entry and report the second', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.secret'), 'x\n');
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'dup', provider: 'yandex', user: 'a@yandex.ru', passwordFile: 'a.secret' },
        { id: 'dup', provider: 'mailru', user: 'b@mail.ru', passwordFile: 'a.secret' },
      ],
    }),
  );
  const { accounts, errors } = loadAccounts(file);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider, 'yandex');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /duplicate account id/);
});

test('invalid JSON reports a file-level error with no accounts', () => {
  const dir = tempDir();
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, '{ this is not json');
  const { accounts, errors } = loadAccounts(file);
  assert.equal(accounts.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not valid JSON/);
});

test('an empty secret file is refused', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'empty.secret'), '');
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: [{ id: 'e', provider: 'yandex', user: 'a@yandex.ru', passwordFile: 'empty.secret' }],
    }),
  );
  const { accounts, errors } = loadAccounts(file);
  assert.equal(accounts.length, 0);
  assert.match(errors[0].message, /empty/);
});

test('describeAccount never exposes the password or the full login', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 's'), 'super-secret-password\n');
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'acc', provider: 'yandex', user: 'ivan.petrov@yandex.ru', passwordFile: 's', displayName: 'Ivan' },
      ],
    }),
  );
  const { accounts } = loadAccounts(file);
  const description = describeAccount(accounts[0]);
  const serialised = JSON.stringify(description);
  assert.equal(serialised.includes('super-secret-password'), false);
  assert.equal(serialised.includes('ivan.petrov@yandex.ru'), false);
  assert.equal(description.user_masked, 'iv***@yandex.ru');
});

test('the committed accounts.example.json is a valid, loadable configuration', () => {
  // Guards a real failure mode: an example that the strict schema rejects would
  // leave an owner who copied it verbatim with zero accounts and no clear error.
  const source = path.resolve(import.meta.dirname, '..', 'accounts.example.json');
  const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));

  // No comment-style keys: the schema is strict, so they are a load error.
  for (const key of Object.keys(parsed)) {
    assert.equal(key.startsWith('//'), false, `unexpected comment key in example: ${key}`);
  }
  assert.equal(parsed.accounts.length, 4, 'the example documents the four planned accounts');
  // One of them is the Gmail IMAP account, which uses OAuth rather than a password.
  const gmail = parsed.accounts.find((account) => account.provider === 'gmail');
  assert.ok(gmail, 'the example must include the Gmail account');
  assert.equal(gmail.authType, 'xoauth2');
  assert.ok(gmail.oauth.clientFile && gmail.oauth.tokenFile);

  // Make each secret path resolvable in a temp dir, then load it for real.
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    const local = JSON.parse(JSON.stringify(parsed));
    fs.mkdirSync(path.join(dir, 'oauth'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'oauth', 'gmail-imap-client.json'), JSON.stringify({ installed: { client_id: 'id', client_secret: 'secret' } }));
    fs.writeFileSync(path.join(dir, 'oauth', 'gmail-imap-token.json'), JSON.stringify({ refresh_token: 'r', scope: 'https://mail.google.com/' }));
    local.accounts.forEach((account, index) => {
      if (account.oauth) {
        account.oauth = {
          clientFile: path.join(dir, 'oauth', 'gmail-imap-client.json'),
          tokenFile: path.join(dir, 'oauth', 'gmail-imap-token.json'),
        };
        return;
      }
      const name = `secret-${index}`;
      fs.writeFileSync(path.join(dir, 'secrets', name), `placeholder-${index}\n`);
      account.passwordFile = path.join(dir, 'secrets', name);
    });
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, JSON.stringify(local));
    const { accounts, errors } = loadAccounts(file);
    assert.deepEqual(errors, [], 'the example must load without errors');
    assert.equal(accounts.length, 4);
    // Providers come from the trusted table, not from the example's addresses.
    const hosts = accounts.map((account) => account.host).sort();
    assert.deepEqual(hosts, ['imap.gmail.com', 'imap.mail.ru', 'imap.yandex.ru', 'imap.yandex.ru']);
    for (const account of accounts) assert.equal(account.port, 993);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maskLogin handles short and address-like logins without revealing them', () => {
  assert.equal(maskLogin('ab'), '***');
  assert.equal(maskLogin('ivan@example.com'), 'iv***@example.com');
  assert.equal(maskLogin('a@example.com'), 'a***@example.com');
  assert.equal(maskLogin('verylonglocalpart@example.com'), 've***@example.com');
});
