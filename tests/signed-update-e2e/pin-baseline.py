#!/usr/bin/env python3
"""Select the frozen baseline in a disposable fixture without bypassing verification."""
from pathlib import Path
import re
import sys


def pin(source, tag):
    if not re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', tag):
        raise ValueError('Invalid baseline release tag')
    installer = source / 'scripts/install.sh'
    discovery = source / 'apps/updater/discover-release.py'
    install_text = installer.read_text()
    discovery_text = discovery.read_text()
    # --source supplies a frozen bootstrap host tree in this fixture. It still
    # takes the normal signed bridge instead of building a local runtime image.
    branch = 'if [[ -z $source_dir && -z $image_ref && $ref_explicit == 0 && $ref == main ]]; then'
    selection = "if version is None or (published is not None and name not in published):"
    if install_text.count(branch) != 1 or discovery_text.count(selection) != 1:
        raise ValueError('Unsupported frozen installer or discovery source')
    installer.write_text(install_text.replace(branch, 'if [[ -z $image_ref && $ref_explicit == 0 && $ref == main ]]; then', 1))
    # Preserve repository identity, pagination, channel and commit validation.
    # Only the tag selection changes. The manifest and attestation are fetched
    # and verified by the original production components.
    discovery.write_text(discovery_text.replace(selection, f'if name != {tag!r} or version is None or (published is not None and name not in published):', 1))


if __name__ == '__main__':
    pin(Path(sys.argv[1]), sys.argv[2])
