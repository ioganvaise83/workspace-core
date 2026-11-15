#!/usr/bin/env node
// Validates and synchronises the workspace-apps registry.
//
// WHAT IT IS
// ----------
// `registry.json` is the source of truth for where an application lives and what
// state it is in. `app.yaml` inside each application describes its technical
// details. The two can drift: an application is renamed, a directory is deleted,
// a status changes in the manifest but not in the registry. This script finds
// that drift and, on request, repairs the registry.
//
// DESIGN CONSTRAINTS
// ------------------
//   * No database, no embeddings, no server. A manifest scan and a JSON compare.
//   * Read-only by default. `check` reports and exits non-zero on problems;
//     `sync` writes, and only after validating the result parses.
//   * Never deletes an entry silently. An entry whose directory vanished is
//     reported and, in `sync`, marked — not removed. Removal is a human decision,
//     because a missing directory is often a moved or unmounted volume rather
//     than a deleted project.
//   * Never invents data. Fields absent from app.yaml stay absent.
//
// USAGE
// -----
//   node apps-registry.cjs check [--root DIR] [--json]
//   node apps-registry.cjs sync  [--root DIR] [--dry-run] [--json]
//   node apps-registry.cjs list  [--root DIR] [--json]
//
// Exit codes: 0 clean, 1 problems found, 2 usage or internal error.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// --- YAML access (same strategy as bootstrap-integrations.cjs) --------------

function loadYaml() {
  const anchors = [
    'yaml',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml',
  ];
  for (const anchor of anchors) {
    try {
      return require(anchor);
    } catch {
      /* next */
    }
  }
  try {
    const { createRequire } = require('node:module');
    return createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')('yaml');
  } catch {
    return null;
  }
}

// --- Constants --------------------------------------------------------------

const STATUSES = new Set(['planned', 'active', 'paused', 'completed', 'archived']);
const TYPES = new Set([
  'web-app', 'desktop-app', 'api-service', 'cli-tool', 'library', 'fullstack',
]);
const REQUIRED_FIELDS = ['id', 'name', 'status', 'type', 'purpose'];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// --- Helpers ----------------------------------------------------------------

const problems = [];
const warnings = [];
const notes = [];

const addProblem = (code, message) => problems.push({ code, message });
const addWarning = (code, message) => warnings.push({ code, message });

function parseArgs(argv) {
  // `--help` may appear before or after the command, so the first argument is
  // classified rather than assumed to be a command. A leading flag is not a
  // command; the default remains `check`.
  const args = { command: null, root: null, dryRun: false, json: false };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; }
    else if (a === '--root') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--root requires a directory argument');
      }
      args.root = value;
      i += 1;
    }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--json') { args.json = true; }
    else if (a.startsWith('-')) { throw new Error(`unknown argument: ${a}`); }
    else { positional.push(a); }
  }

  if (positional.length > 1) {
    throw new Error(`unexpected extra argument: ${positional[1]}`);
  }
  args.command = positional[0] || 'check';
  if (args.help) args.command = 'help';
  return args;
}

// The registry root is the directory containing this script's repo: either
// /workspace/apps inside the harness, or ../workspace-apps on the host.
function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.APPS_ROOT) return path.resolve(process.env.APPS_ROOT);
  // Inside the harness, apps live at /workspace/apps.
  if (fs.existsSync('/workspace/apps/registry.json')) return '/workspace/apps';
  // On the host the script lives in workspace-core/scripts.
  return path.resolve(__dirname, '..', '..', 'workspace-apps');
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

// --- Manifest validation ----------------------------------------------------

function validateManifest(manifest, file, absPath) {
  const rel = file;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    addProblem('manifest-not-object', `${rel}: top level must be a mapping`);
    return null;
  }

  for (const field of REQUIRED_FIELDS) {
    const value = manifest[field];
    if (value === undefined || value === null || value === '') {
      addProblem('manifest-missing-field', `${rel}: missing required field "${field}"`);
    }
  }

  if (manifest.id !== undefined && !ID_PATTERN.test(String(manifest.id))) {
    addProblem(
      'manifest-bad-id',
      `${rel}: id "${manifest.id}" must be lowercase letters, digits and hyphens, starting with a letter or digit`,
    );
  }

  if (manifest.status !== undefined && !STATUSES.has(manifest.status)) {
    addProblem(
      'manifest-bad-status',
      `${rel}: status "${manifest.status}" is not one of ${[...STATUSES].join(', ')}`,
    );
  }

  if (manifest.type !== undefined && !TYPES.has(manifest.type)) {
    addProblem(
      'manifest-bad-type',
      `${rel}: type "${manifest.type}" is not one of ${[...TYPES].join(', ')}`,
    );
  }

  // Secrets must never appear in a manifest: check for value-shaped keys.
  const text = fs.readFileSync(absPath, 'utf8');
  const secretish = /^\s*(api[_-]?key|password|secret|token|client_secret|refresh_token)\s*:\s*\S+/im;
  if (secretish.test(text)) {
    addProblem(
      'manifest-secret',
      `${rel}: looks like it contains a secret value; keep only variable NAMES (see docs/app-development.md)`,
    );
  }

  return manifest;
}

// --- Scan -------------------------------------------------------------------

function scanApps(root) {
  const appsDir = path.join(root, 'apps');
  const found = [];

  if (!fs.existsSync(appsDir)) {
    notes.push({ code: 'no-apps-dir', message: `no apps/ directory at ${appsDir}; nothing to scan` });
    return found;
  }

  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      addWarning('stray-file', `apps/${entry.name}: not a directory, ignored`);
      continue;
    }
    const dir = path.join(appsDir, entry.name);
    const manifestFile = path.join(dir, 'app.yaml');

    if (!fs.existsSync(manifestFile)) {
      addProblem('missing-manifest', `apps/${entry.name}: no app.yaml`);
      continue;
    }

    let manifest;
    try {
      const yaml = loadYaml();
      if (!yaml) throw new Error('no YAML parser available');
      manifest = yaml.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch (error) {
      addProblem('manifest-parse', `apps/${entry.name}/app.yaml: ${error.message}`);
      continue;
    }

    const validated = validateManifest(manifest, `apps/${entry.name}/app.yaml`, manifestFile);
    if (!validated) continue;

    // Directory name and manifest id must agree, otherwise the registry would
    // point at a path that does not match the project identity.
    if (validated.id && validated.id !== entry.name) {
      addProblem(
        'id-mismatch',
        `apps/${entry.name}: manifest id is "${validated.id}" but the directory is "${entry.name}"`,
      );
    }

    // README is part of the contract.
    if (!fs.existsSync(path.join(dir, 'README.md'))) {
      addWarning('missing-readme', `apps/${entry.name}: no README.md`);
    }

    found.push({
      id: validated.id || entry.name,
      dirName: entry.name,
      relPath: `apps/${entry.name}`,
      manifest: validated,
    });
  }

  // Duplicate ids across the tree.
  const seen = new Map();
  for (const app of found) {
    if (seen.has(app.id)) {
      addProblem(
        'duplicate-id',
        `id "${app.id}" is used by both apps/${seen.get(app.id)}/ and apps/${app.dirName}/`,
      );
    } else {
      seen.set(app.id, app.dirName);
    }
  }

  return found;
}

// --- Registry validation ----------------------------------------------------

function validateRegistry(registry, file) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    addProblem('registry-not-object', `${file}: top level must be a JSON object`);
    return [];
  }
  if (!Array.isArray(registry.apps)) {
    addProblem('registry-no-apps', `${file}: "apps" must be an array`);
    return [];
  }

  const seen = new Set();
  for (const [i, entry] of registry.apps.entries()) {
    const where = `registry.json apps[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      addProblem('registry-bad-entry', `${where}: must be an object`);
      continue;
    }
    if (!entry.id) addProblem('registry-missing-id', `${where}: missing "id"`);
    if (!entry.path) addProblem('registry-missing-path', `${where}: missing "path"`);
    if (entry.id && seen.has(entry.id)) {
      addProblem('registry-duplicate-id', `${where}: duplicate id "${entry.id}"`);
    }
    if (entry.id) seen.add(entry.id);
    if (entry.status && !STATUSES.has(entry.status)) {
      addProblem('registry-bad-status', `${where}: status "${entry.status}" is invalid`);
    }
    if (entry.path) {
      const abs = path.resolve(root, entry.path);
      if (!fs.existsSync(abs)) {
        addProblem('registry-path-missing', `${where}: path "${entry.path}" does not exist`);
      }
    }
  }
  return registry.apps;
}

// --- Commands ---------------------------------------------------------------

let root = '/';

function buildEntry(app) {
  const m = app.manifest;
  return {
    id: app.id,
    name: m.name || app.id,
    summary: typeof m.purpose === 'string' ? m.purpose.trim().split('\n')[0].trim() : '',
    path: app.relPath,
    type: m.type || 'web-app',
    stack: Array.isArray(m.stack && m.stack.languages) ? m.stack.languages : [],
    status: m.status || 'planned',
    created: m.created || null,
    updated: m.updated || null,
    readme: `${app.relPath}/README.md`,
    manifest: `${app.relPath}/app.yaml`,
    knowledge: (m.knowledge && m.knowledge.exists === true && m.knowledge.path) || null,
  };
}

function cmdCheck(registry, apps) {
  const registryById = new Map((registry.apps || []).map((e) => [e.id, e]));
  const scannedById = new Map(apps.map((a) => [a.id, a]));

  for (const app of apps) {
    if (!registryById.has(app.id)) {
      addProblem(
        'not-in-registry',
        `apps/${app.dirName}: has a manifest but no registry entry (run: sync)`,
      );
    }
  }
  for (const entry of registry.apps || []) {
    if (!scannedById.has(entry.id)) {
      addProblem(
        'registry-orphan',
        `registry.json: "${entry.id}" points at "${entry.path}" but no manifest was found there`,
      );
    } else if (entry.status !== scannedById.get(entry.id).manifest.status) {
      addWarning(
        'status-drift',
        `"${entry.id}": registry says "${entry.status}", manifest says "${scannedById.get(entry.id).manifest.status}" (run: sync)`,
      );
    }
  }
  return { apps, registry };
}

function cmdSync(registry, apps, dryRun) {
  const merged = [];
  const byId = new Map();

  for (const app of apps) {
    const entry = buildEntry(app);
    if (byId.has(entry.id)) {
      addProblem('duplicate-id', `cannot sync: duplicate id "${entry.id}"`);
      continue;
    }
    byId.set(entry.id, entry);
    merged.push(entry);
  }

  // Preserve registry entries whose directory disappeared: mark, do not delete.
  for (const existing of registry.apps || []) {
    if (byId.has(existing.id)) continue;
    if (fs.existsSync(path.resolve(root, existing.path))) {
      addProblem(
        'registry-orphan',
        `"${existing.id}": path "${existing.path}" exists but has no app.yaml`,
      );
      continue;
    }
    addWarning(
      'registry-orphan-kept',
      `"${existing.id}": directory "${existing.path}" is missing; entry kept unchanged (remove it by hand after confirming)`,
    );
    merged.push(existing);
  }

  merged.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const next = {
    ...registry,
    updated: new Date().toISOString().slice(0, 10),
    apps: merged,
  };

  const before = JSON.stringify(registry.apps || [], null, 2);
  const after = JSON.stringify(next.apps, null, 2);
  const changed = before !== after;

  if (!changed) {
    notes.push({ code: 'no-change', message: 'registry already matches the manifests; nothing to write' });
    return next;
  }
  if (dryRun) {
    notes.push({ code: 'dry-run', message: 'dry run: registry would change, nothing written' });
    return next;
  }

  const file = path.join(root, 'registry.json');
  const text = `${JSON.stringify(next, null, 2)}\n`;
  // Validate before writing: a registry that cannot be parsed is worse than a stale one.
  JSON.parse(text);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
  notes.push({ code: 'updated', message: `registry updated: ${merged.length} entries` });
  return next;
}

// --- Main -------------------------------------------------------------------

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`apps-registry: ${error.message}\n`);
    return 2;
  }

  if (args.command === 'help') {
    process.stdout.write(
      'usage: apps-registry.cjs <check|sync|list> [--root DIR] [--dry-run] [--json]\n',
    );
    return 0;
  }

  if (!['check', 'sync', 'list'].includes(args.command)) {
    process.stderr.write(`apps-registry: unknown command "${args.command}"\n`);
    return 2;
  }

  if (!loadYaml()) {
    process.stderr.write('apps-registry: no YAML parser found; cannot read manifests\n');
    return 2;
  }

  root = resolveRoot(args.root);
  const registryFile = path.join(root, 'registry.json');

  if (!fs.existsSync(registryFile)) {
    process.stderr.write(`apps-registry: no registry.json at ${registryFile}\n`);
    return 2;
  }

  let registry;
  try {
    registry = readJson(registryFile);
  } catch (error) {
    process.stderr.write(`apps-registry: registry.json is not valid JSON: ${error.message}\n`);
    return 2;
  }

  const apps = scanApps(root);
  let result = { apps, registry };

  if (args.command === 'check') {
    validateRegistry(registry, 'registry.json');
    // Compare manifests against the registry: unregistered apps, orphans, drift.
    cmdCheck(registry, apps);
  } else if (args.command === 'sync') {
    validateRegistry(registry, 'registry.json');
    const synced = cmdSync(registry, apps, args.dryRun);
    result = { apps, registry: synced };
  }

  const output = {
    root,
    command: args.command,
    apps: result.apps.map((a) => ({
      id: a.id,
      path: a.relPath,
      status: a.manifest.status,
      type: a.manifest.type,
    })),
    registryEntries: (result.registry.apps || []).length,
    problems,
    warnings,
    notes,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`\n workspace-apps registry: ${args.command}\n`);
    process.stdout.write(` root: ${root}\n`);
    process.stdout.write(` applications found: ${apps.length}\n`);
    for (const a of output.apps) {
      process.stdout.write(`   - ${a.id} [${a.status}] ${a.path}\n`);
    }
    process.stdout.write(` registry entries: ${output.registryEntries}\n`);
    for (const n of notes) process.stdout.write(` note: ${n.message}\n`);
    for (const w of warnings) process.stdout.write(` WARN ${w.code}: ${w.message}\n`);
    for (const p of problems) process.stdout.write(` FAIL ${p.code}: ${p.message}\n`);
    process.stdout.write(
      problems.length === 0 ? ' result: OK\n\n' : ` result: ${problems.length} problem(s)\n\n`,
    );
  }

  return problems.length === 0 ? 0 : 1;
}

process.exit(main());
