#!/usr/bin/env python3
"""Pin only release discovery in the disposable legacy installation fixture."""
from pathlib import Path
import re
import sys

path=Path(sys.argv[1]);tag=sys.argv[2];commit=sys.argv[3]
if not re.fullmatch(r'v\d+\.\d+\.\d+',tag) or not re.fullmatch(r'[a-f0-9]{40}',commit):
    raise SystemExit('Invalid fixture release')
source=path.read_text();needle='def _find_latest(transport):\n'
if source.count(needle)!=1:raise SystemExit('Unsupported discovery fixture')
version=tuple(map(int,tag[1:].split('.')))
path.write_text(source.replace(needle,needle+'    return '+repr((version,tag,commit))+'\n',1))
