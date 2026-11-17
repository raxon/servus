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
# Fixture-only validation exception. The orchestrator creates a genuine failed
# operation and checks a later successful operation against the live Swarm.
# This is not the production backup validation policy.
failed_id = os.environ.get('SERVUS_FIXTURE_FAILED_ID', '')
if not module.UUID.fullmatch(failed_id):
    raise SystemExit('A synthetic failed operation identity is required')
original_validation = module._validate_staging
original_connect = module.sqlite3.connect

def fixture_validation(dest_fd, node_fd):
    for name, query in (
        ('panel.sqlite', "SELECT id FROM actions WHERE status='failed'"),
        ('panel.sqlite', "SELECT action_id FROM jobs WHERE status='failed'"),
        ('agent.sqlite', "SELECT id FROM operations WHERE state='failed'"),
    ):
        with original_connect(f'file:/proc/self/fd/{dest_fd}/{name}?mode=ro', uri=True) as db:
            if db.execute(query).fetchall() != [(failed_id,)]:
                raise module.CaptureError('Fixture failed operation does not match')
    class Connection:
        def __init__(self, raw): self.raw = raw
        def __enter__(self): self.raw.__enter__(); return self
        def __exit__(self, *args): return self.raw.__exit__(*args)
        def execute(self, sql, *args):
            mapping = {
                "SELECT 1 FROM jobs WHERE status != 'succeeded' OR status IS NULL LIMIT 1":
                    "SELECT 1 FROM jobs WHERE (status != 'succeeded' OR status IS NULL) AND NOT (status IS 'failed' AND action_id=?) LIMIT 1",
                "SELECT 1 FROM actions WHERE status != 'succeeded' OR status IS NULL LIMIT 1":
                    "SELECT 1 FROM actions WHERE (status != 'succeeded' OR status IS NULL) AND NOT (status IS 'failed' AND id=?) LIMIT 1",
                "SELECT 1 FROM operations WHERE state != 'succeeded' OR state IS NULL LIMIT 1":
                    "SELECT 1 FROM operations WHERE (state != 'succeeded' OR state IS NULL) AND NOT (state IS 'failed' AND id=?) LIMIT 1",
            }
            return self.raw.execute(mapping[sql], (failed_id,)) if sql in mapping else self.raw.execute(sql, *args)
    def fixture_connect(*args, **kwargs): return Connection(original_connect(*args, **kwargs))
    module.sqlite3.connect = fixture_connect
    try: original_validation(dest_fd, node_fd)
    finally: module.sqlite3.connect = original_connect
# Capture the fixture bytes without using the production semantic validator.
# This test-only override is scoped to this disposable Python process. The
# production validator remains unchanged and still rejects historical failures.
module._validate_staging = lambda _dest_fd, _node_fd: None
source = os.open('/fixture-source', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
destination = os.open('/fixture-staging', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
node = os.open('/usr/local/bin/node', os.O_RDONLY | os.O_NOFOLLOW)
try:
    manifest = module._capture_quiescent(source, destination, node, source_uid=1000, reader_gid=65534)
    if not {'panel.sqlite', 'agent.sqlite', 'secret-key', 'agent-token'}.issubset(manifest['files']):
        raise RuntimeError('Capture is incomplete')
    try:
        original_validation(destination, node)
    except module.CaptureError as error:
        if str(error) != 'Unresolved panel jobs require recovery':
            raise
    else:
        raise RuntimeError('Production validation unexpectedly accepted the failed operation')
    fixture_validation(destination, node)
    print('PASS raw fixture control-plane capture and test-only validation')
finally:
    for fd in (source, destination, node): os.close(fd)
