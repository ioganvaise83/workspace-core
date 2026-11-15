// Registers built-in MCP integrations in the DSH profile at container start.
//
// THE BUG THIS REPLACES
// ---------------------
// The previous version appended a fenced text block to cordis.patch.yml and, when
// no integration had a token, emitted a literal `[]` *after* the user's entries:
//
//     - id: llm-pi-ai        # user entry
//       ...
//     # >>> workspace-core: managed integrations >>>
//     []
//     # <<< workspace-core: managed integrations <<<
//
// That is invalid YAML. A block sequence may not be followed by a flow sequence
// at the same level, so DSH failed with:
//
//     YAMLException: Unexpected flow-seq-start at node end at line 34, column 1
//
// `[]` is only legal when it is the *only* value in the document (comments may
// precede it). The rule enforced below: the empty-array placeholder is written
// only when the document has no entries at all, and it is removed before any
// entry is appended.
//
// HOW DSH READS THIS FILE (verified in @deepseek-ai/dsh 0.2.1-rc.3)
// -----------------------------------------------------------------
//   * The profile's own cordis.patch.yml is the documented user layer, loaded
//     automatically after every bundle layer (loadProfileDirectory).
//   * parsePatchList yaml.load()s the file with the entry-list schema, requires
//     a top-level array, and requires every element to be a mapping. Anything
//     else throws and aborts startup — which is why this file must never be
//     written unless it has been parsed successfully first.
//   * Loader patch entries: `- id:` overrides an existing plugin's config;
//     `- insert: [...]` adds new ones. A bare `- id:` for a plugin that does not
//     exist yet is a Loader warning, so new plugins must go through `insert:`.
//
// CONTRACT
// --------
//   * Never blocks harness startup: any failure is logged and exits 0.
//   * Idempotent: our own block and any stray mcp-* entries are removed before
//     writing, so repeated runs cannot duplicate registrations.
//   * User content outside the fence is preserved byte for byte.
//   * The new file is parsed and validated BEFORE it replaces the old one.
//   * The write is atomic (unique temp file + rename) and leaves a backup.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DSH_HOME = process.env.DSH_HOME || '/home/node/.dsh';
const PROFILE = process.env.DSH_PROFILE || 'web';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');
const STATE_DIR = path.join(DSH_HOME, 'bootstrap');
const REGISTRY = process.env.INTEGRATIONS_REGISTRY || '/workspace/core/integrations/registry.json';

const BEGIN = '# >>> workspace-core: managed integrations (generated, do not edit) >>>';
const END = '# <<< workspace-core: managed integrations <<<';

// A lone `[]` on its own line. Only meaningful when the document has no entries.
const EMPTY_ARRAY_LINE = /^[ \t]*\[\][ \t]*$/gm;

// Top-level list items, used to drop stray managed entries written by earlier
// versions of this script. A profile patch file is a flat sequence.
const TOP_ITEM = /^- /;

const log = (m) => process.stdout.write(`[bootstrap] ${m}\n`);

// --- YAML access -----------------------------------------------------------
// The harness image ships `yaml` (a DSH dependency) but not next to this
// script, so resolve it through the dsh package before falling back to a plain
// require. Validation is mandatory: without a parser we refuse to write.
function loadYaml() {
  const anchors = [
    'yaml',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml',
  ];
  for (const anchor of anchors) {
    try {
      return require(anchor);
    } catch {
      /* try the next anchor */
    }
  }
  try {
    const { createRequire } = require('node:module');
    const req = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
    return req('yaml');
  } catch {
    return null;
  }
}

function parseOrNull(yaml, text) {
  try {
    return { ok: true, value: yaml.parse(text) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

// Matches the checks DSH itself applies in parsePatchList.
function assertPatchShape(parsed) {
  if (!Array.isArray(parsed)) {
    return 'top-level value is not a YAML array';
  }
  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `entry ${i + 1} is not a mapping`;
    }
  }
  return null;
}

// --- Text surgery ----------------------------------------------------------

function stripBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start === -1) return text;
  const end = text.indexOf(END, start);
  if (end === -1) {
    // Unterminated fence: drop everything from the marker to the end.
    return text.slice(0, start);
  }
  let after = end + END.length;
  if (text[after] === '\n') after += 1;
  return text.slice(0, start) + text.slice(after);
}

// Split a patch file into top-level items (leading comment/blank preamble kept
// as its own chunk), so managed entries can be dropped as whole units.
function splitTopLevel(text) {
  const chunks = [];
  let preamble = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (TOP_ITEM.test(line)) {
      if (current) chunks.push(current);
      else if (preamble.length) { chunks.push({ preamble: preamble.join('\n') }); preamble = []; }
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) chunks.push(current);
  if (preamble.length) chunks.push({ preamble: preamble.join('\n') });
  return chunks;
}

// Ids declared anywhere inside one top-level item (bare `- id:`, inline `id:`,
// or nested under `insert:`).
function idsInChunk(chunk) {
  const ids = [];
  for (const line of chunk) {
    const m = /^\s*-?\s*id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

// Drop whole top-level items that belong to this bootstrap: a bare override or an
// `insert:` list consisting solely of managed ids. Runs before writing, which is
// what makes repeated runs non-duplicating and upgrades self-healing.
function stripManagedEntries(text, ids) {
  if (ids.size === 0) return text;
  const out = [];
  for (const chunk of splitTopLevel(text)) {
    if (!Array.isArray(chunk)) { out.push(chunk.preamble); continue; }
    const chunkIds = idsInChunk(chunk);
    const ours = chunkIds.length > 0 && chunkIds.every((id) => ids.has(id));
    if (ours) continue;
    out.push(chunk.join('\n'));
  }
  return out.join('\n');
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

// --- Registry --------------------------------------------------------------

function readToken(name) {
  const file = path.join(STATE_DIR, name);
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* reported below */
  }
  log(`WARNING: ${file} is missing or too short`);
  return null;
}

function loadRegistry() {
  const parsed = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const list = Array.isArray(parsed.integrations) ? parsed.integrations : [];
  return list.filter((e) => e && e.enabled !== false);
}

function renderBlock(ready) {
  if (ready.length === 0) {
    // `[]` must live INSIDE the fence: it is valid here only because nothing else
    // follows, and keeping it fenced means the next run removes it with the block
    // instead of leaving an orphan behind.
    return `${BEGIN}\n# No built-in integrations are currently registered.\n[]\n${END}\n`;
  }
  const out = [BEGIN, '- insert:'];
  for (const { entry: e, token } of ready) {
    out.push(`    - id: mcp-${e.id}`);
    out.push("      name: '@deepseek-ai/dsh-mcp-client'");
    out.push('      config:');
    out.push(`        serverName: ${q(e.serverName || e.id)}`);
    out.push('        transport: streamable-http');
    out.push(`        url: ${q(e.url)}`);
    out.push('        headers:');
    out.push(`          Authorization: ${q(`Bearer ${token}`)}`);
    out.push('        toolCallTimeoutMs: 120000');
    // A down or unconfigured integration must never stop the harness booting.
    out.push('        failOnStartupError: false');
    out.push('        reconnect:');
    out.push('          enabled: true');
    out.push('          maxAttempts: 3');
  }
  out.push(END);
  return `${out.join('\n')}\n`;
}

// Shipped layout, copied from @deepseek-ai/dsh-app-boot (initProfile). The
// profile must exist before the harness boots, otherwise DSH creates it from its
// own template *after* this script has run and the registration is lost.
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

// Bundles of the shipped `web` template; other profiles are left to DSH.
const PROFILE_BUNDLES = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
};

function ensureProfile() {
  if (fs.existsSync(PATCH_FILE)) return true;
  const bundles = PROFILE_BUNDLES[PROFILE];
  if (!bundles) {
    log(`no ${PATCH_FILE} and no template for profile ${JSON.stringify(PROFILE)}; nothing to do`);
    return false;
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const manifest = path.join(PROFILE_DIR, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, `${JSON.stringify({
      name: `dsh-profile-${PROFILE}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }, null, 2)}\n`);
  }
  fs.writeFileSync(PATCH_FILE, PROFILE_PATCH_TEMPLATE, { mode: 0o600 });
  const workspace = path.join(PROFILE_DIR, 'pnpm-workspace.yaml');
  if (!fs.existsSync(workspace)) fs.writeFileSync(workspace, PROFILE_PNPM_WORKSPACE);
  log(`created profile skeleton at ${PROFILE_DIR}`);
  return true;
}

// --- Main ------------------------------------------------------------------

function run() {
  const yaml = loadYaml();
  if (!yaml) {
    log('ERROR: no YAML parser available; leaving the profile untouched.');
    return;
  }

  // On a fresh dsh-home volume the profile does not exist yet. Create it from the
  // shipped template, otherwise DSH would create it later and overwrite nothing
  // we wrote — the registration would simply be missing.
  if (!ensureProfile()) return;

  const original = fs.readFileSync(PATCH_FILE, 'utf8');
  const entries = loadRegistry();
  const managedIds = new Set(entries.map((e) => `mcp-${e.id}`));

  // Collect registrable entries first: a missing token skips one integration
  // instead of writing an unusable Authorization header.
  const ready = [];
  for (const e of entries) {
    const token = readToken(e.tokenFile || `${e.id}-bridge.token`);
    if (!token) {
      log(`skipping ${e.id}: no bridge token`);
      continue;
    }
    ready.push({ entry: e, token });
  }
  const block = renderBlock(ready);

  // 1. Drop our fenced block and any stray managed entries, so a rerun cannot
  //    duplicate registrations and an upgrade from the buggy version self-heals.
  let base = stripManagedEntries(stripBlock(original), managedIds);

  // 2. Validate what remains. Our own block is removed first, so a file broken by
  //    an earlier version of this script (the `[]`-after-entries bug) is
  //    repairable rather than fatal. Only damage outside our fence is a reason to
  //    stop, because rewriting it would risk destroying the operator's content.
  const baseParsed = parseOrNull(yaml, base);
  if (!baseParsed.ok) {
    log(`ERROR: ${PATCH_FILE} is not valid YAML outside the managed block:`);
    log(`       ${baseParsed.error}`);
    log('Refusing to rewrite it. Fix or remove the file, then restart.');
    return;
  }
  const baseHasEntries = Array.isArray(baseParsed.value) && baseParsed.value.length > 0;

  // 3. A lone `[]` is only valid when nothing else is present. Remove it before
  //    appending entries — this is the exact case that used to corrupt the file.
  if (!baseHasEntries) {
    base = base.replace(EMPTY_ARRAY_LINE, '').replace(/\n{2,}$/, '\n');
  }

  let next;
  if (ready.length > 0) {
    next = `${base.replace(/\n*$/, '\n')}\n${block}`;
  } else if (baseHasEntries) {
    // Nothing to register, but the user has entries: just drop our block.
    next = base.replace(/\n*$/, '\n');
  } else {
    // Nothing at all: the block carries its own `[]`, which DSH accepts.
    next = `${base.replace(/\n*$/, '\n')}\n${block}`;
  }

  if (next === original) {
    log(`integration block already current in ${PATCH_FILE}`);
    return;
  }

  // 4. Validate the result exactly as DSH will before it replaces anything.
  const nextParsed = parseOrNull(yaml, next);
  if (!nextParsed.ok) {
    log(`ERROR: generated patch is invalid YAML, not writing: ${nextParsed.error}`);
    return;
  }
  const shapeError = assertPatchShape(nextParsed.value);
  if (shapeError) {
    log(`ERROR: generated patch has the wrong shape, not writing: ${shapeError}`);
    return;
  }
  const registered = nextParsed.value.filter(
    (e) => e && typeof e === 'object' && !Array.isArray(e) && Array.isArray(e.insert),
  ).flatMap((e) => e.insert).filter((e) => e && managedIds.has(e.id));
  const uniqueIds = new Set(registered.map((e) => e.id));
  if (registered.length !== uniqueIds.size) {
    log('ERROR: duplicate managed registrations detected, not writing.');
    return;
  }
  if (registered.length !== ready.length) {
    log(`ERROR: expected ${ready.length} managed entries, generated ${registered.length}, not writing.`);
    return;
  }

  // 5. Backup, then atomic replace.
  const backup = `${PATCH_FILE}.workspace-core.bak`;
  fs.writeFileSync(backup, original, { mode: 0o600 });

  const tmp = `${PATCH_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, PATCH_FILE);
  fs.chmodSync(PATCH_FILE, 0o600);

  log(`registered ${ready.length} integration(s) in ${PATCH_FILE}`);
  for (const { entry: e } of ready) log(`  - ${e.serverName || e.id} -> ${e.url}`);
  log(`backup: ${backup}`);
}

// Startup safety: a registration problem must never stop the harness.
try {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  run();
} catch (error) {
  log(`ERROR: bootstrap failed, harness startup continues: ${String(error && error.message ? error.message : error)}`);
}
process.exit(0);
