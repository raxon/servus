#!/usr/bin/python3 -I
"""Check the real Docker pull/inspect path using a synthetic verified journal.

The published v0.1.4 image predates bundled installation files, so extraction
must fail closed; this test does not substitute for a new signed release test.
Run only against an isolated Docker host with network access to GHCR.
"""
import importlib.util
import os
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if os.geteuid() != 0:
        raise SystemExit('Linux root is required')
    updater = load('updater', 'apps/updater/servus-updater.py')
    extractor = load('extractor', 'apps/updater/extract-install.py')
    prepare = load('prepare', 'apps/updater/prepare-verified.py')
    operation_id = '12345678-1234-4123-8123-123456789abc'
    digest = 'sha256:466654f228cf3adb4e13369ce85b047458fa7eb64e20c46c222df2326c293370'
    config = 'sha256:c709335f56dfa7e47c79ff6661e9c59776054a878c317fe2b3abea92c7f87298'
    commit = 'dd585c65805ba432b880c661ea140ae69f7a9984'
    with tempfile.TemporaryDirectory(prefix='servus-prepare-e2e-', dir='/run') as directory:
        staging = pathlib.Path(directory) / 'staging'
        staging.mkdir(mode=0o700)
        journal = updater.Journal(pathlib.Path(directory))
        try:
            journal.submit(operation_id, commit, digest, 'v0.1.4')
            attempt = journal.claim()
            # This fixture records a synthetic result: actual attestation has a separate test.
            journal.finish(attempt, 'verified', config)
            try:
                prepare.prepare_verified(journal, operation_id, str(staging), extractor)
            except extractor.ExtractionError:
                pass
            else:
                raise AssertionError('Old release unexpectedly has installation files')
            assert journal.db.execute('SELECT status FROM preparations').fetchone()[0] == 'recovery_required'
            assert not list(staging.iterdir())
            image = subprocess.check_output(['/usr/bin/docker', 'image', 'inspect', '--platform=linux/amd64', '--format', '{{.Id}}', 'ghcr.io/raxon/servus@' + digest], env=extractor.ENV, text=True).strip()
            assert image in (digest, config)
            print('Actual GHCR pull and identity passed; old bundle refused and operation requires recovery')
        finally:
            journal.close()


if __name__ == '__main__':
    main()
