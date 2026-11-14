#!/usr/bin/python3 -I
"""Invoke the internal capture primitive on explicitly mounted fixture volumes."""
import importlib.util
import os
import sys

if os.geteuid() != 0 or not sys.flags.isolated:
    raise SystemExit('An isolated root fixture is required')
spec = importlib.util.spec_from_file_location('servus_backup_fixture', '/fixture/backup.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_database_to_temp = module._database_to_temp
def fixture_database_to_temp(source, name, *args):
    try:
        return original_database_to_temp(source, name, *args)
    except BaseException:
        print(f'Fixture SQLite capture failed: {name}', file=sys.stderr, flush=True)
        raise
module._database_to_temp = fixture_database_to_temp
original_reader = module._reader
def fixture_reader(*args):
    try:
        return original_reader(*args)
    except BaseException as exc:
        detail = str(exc) if isinstance(exc, module.CaptureError) else f'errno={getattr(exc, "errno", None)} sqlite={getattr(exc, "sqlite_errorname", None)}'
        if isinstance(exc, module.sqlite3.Error):
            messages = ('unable to open database file', 'attempt to write a readonly database', 'disk I/O error')
            detail += f' reason={str(exc) if str(exc) in messages else "other"}'
        print(f'Fixture reader failed: {type(exc).__name__}: {detail}', file=sys.stderr, flush=True)
        raise
module._reader = fixture_reader
source = os.open('/fixture-source', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
destination = os.open('/fixture-staging', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
node = os.open('/usr/local/bin/node', os.O_RDONLY | os.O_NOFOLLOW)
try:
    manifest = module._capture_quiescent(source, destination, node, source_uid=1000, reader_gid=65534)
    if not {'panel.sqlite', 'agent.sqlite', 'secret-key', 'agent-token'}.issubset(manifest['files']):
        raise RuntimeError('Capture is incomplete')
    print('PASS control-plane capture')
finally:
    for fd in (source, destination, node): os.close(fd)
