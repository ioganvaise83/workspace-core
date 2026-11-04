#!/usr/bin/env python3
"""Read-only Git status for the private knowledge repo."""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parents[1]
values = {}
env = root / '.env'
if env.exists():
    for line in env.read_text(encoding='utf-8').splitlines():
        if '=' in line and not line.strip().startswith('#'):
            k,v = line.split('=',1)
            values[k.strip()] = v.strip().strip('"').strip("'")
path = Path(os.getenv('KNOWLEDGE_PATH', values.get('KNOWLEDGE_PATH', '../workspace-knowledge'))).expanduser()
if not path.is_absolute(): path = root / path
path = path.resolve()
if not (path / '.git').exists():
    raise SystemExit(f'Not a cloned Git repository: {path}')
print('Knowledge:', path)
subprocess.run(['git','-C',str(path),'status','--short','--branch'], check=True)
