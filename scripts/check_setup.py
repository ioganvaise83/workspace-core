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
checks = [
    ('Compose file', (root / 'compose.yaml').is_file()),
    ('.env exists', env_file.is_file()),
    ('Private knowledge directory', knowledge.is_dir()),
    ('Private knowledge AGENTS.md', (knowledge / 'AGENTS.md').is_file()),
    ('Private knowledge vehicle notes', (knowledge / 'knowledge' / 'vehicles').is_dir()),
    ('Runtime workspace directory', (root / 'runtime' / 'workspace').is_dir()),
]
for name, ok in checks:
    print(f"{'OK' if ok else 'MISSING'}  {name}")
print('Knowledge path:', knowledge)
print('Next: docker compose config && docker compose up -d')
sys.exit(0 if all(ok for _, ok in checks) else 1)
