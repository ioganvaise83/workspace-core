#!/usr/bin/env python3
"""Non-destructive host-level preflight check. Python standard library only."""
from pathlib import Path
import os
import sys

root = Path(__file__).resolve().parents[1]
env_file = root / '.env'
values = {}
if env_file.is_file():
    for line in env_file.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        values[k.strip()] = v.strip().strip('"').strip("'")
knowledge_raw = os.environ.get('KNOWLEDGE_PATH', values.get('KNOWLEDGE_PATH', '../workspace-knowledge'))
knowledge = Path(knowledge_raw).expanduser()
if not knowledge.is_absolute():
    knowledge = root / knowledge
knowledge = knowledge.resolve()
apps_raw = os.environ.get('APPS_PATH', values.get('APPS_PATH', '../workspace-apps'))
apps = Path(apps_raw).expanduser()
if not apps.is_absolute():
    apps = root / apps
apps = apps.resolve()

# Scripts are bind-mounted from the host into Linux containers, so a CRLF
# checkout breaks them at startup with a message that never mentions line
# endings ("set: Illegal option -" from dash). Detecting it here, before
# `docker compose up`, turns an opaque container failure into one clear line.
# Certificates and other binaries are excluded: only executed text is checked.
LINE_ENDING_SUFFIXES = {'.sh', '.py', '.cjs', '.dockerfile'}
crlf_files = []
for path in sorted(root.rglob('*')):
    if not path.is_file():
        continue
    rel = path.relative_to(root)
    if any(part in {'.git', 'node_modules', 'runtime', 'data'} for part in rel.parts):
        continue
    if path.suffix in LINE_ENDING_SUFFIXES or path.name == 'Dockerfile':
        try:
            if b'\r\n' in path.read_bytes():
                crlf_files.append(str(rel))
        except OSError:
            pass

checks = [
    ('Compose file', (root / 'compose.yaml').is_file()),
    ('.env exists', env_file.is_file()),
    ('Private knowledge directory', knowledge.is_dir()),
    ('Private knowledge AGENTS.md', (knowledge / 'AGENTS.md').is_file()),
    ('Private knowledge vehicle notes', (knowledge / 'knowledge' / 'vehicles').is_dir()),
    ('Applications directory', apps.is_dir()),
    ('Applications registry', (apps / 'registry.json').is_file()),
    ('Runtime workspace directory', (root / 'runtime' / 'workspace').is_dir()),
    ('LF line endings in scripts', not crlf_files),
]
for name, ok in checks:
    print(f"{'OK' if ok else 'MISSING'}  {name}")
if crlf_files:
    print()
    print('  CRLF is fatal for scripts executed inside Linux containers:')
    for rel in crlf_files:
        print(f'    {rel}')
    print('  Fix: sh scripts/check-line-endings.sh --fix')
    print('  Prevent: cp docs/gitattributes.txt .gitattributes')
print('Knowledge path:', knowledge)
print('Applications path:', apps)
print('Next: docker compose config && docker compose up -d')
sys.exit(0 if all(ok for _, ok in checks) else 1)
