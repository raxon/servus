"""Schema validation only; no privileged capture, coordinator, or host operations."""
import importlib.util
import base64
import os
import pathlib
import sqlite3
import tempfile
import unittest
from contextlib import ExitStack, closing, contextmanager
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('servus_backup_schema_v6', ROOT / 'apps/updater/backup.py')
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
V6_TABLES = {
    'api_tokens': {'id', 'user_id', 'project_id', 'name', 'token_hash', 'scope', 'created_at', 'expires_at', 'last_used_at', 'revoked_at'},
    'database_backup_settings': {'service_id', 'actor_id', 'enabled', 'cron', 'retention', 'last_tick', 'updated_at', 'destination_ref'},
    'database_backups': {'id', 'service_id', 'actor_id', 'name', 'status', 'trigger', 'idempotency_key', 'request_hash', 'created_at', 'finished_at', 'size', 'sha256', 'extension', 'error', 'owner_id', 'lease_until', 'destination_ref', 'object_key'},
    'two_factor_auth': {'user_id', 'pending_secret', 'pending_created_at', 'secret', 'recovery_hashes', 'last_counter', 'enabled_at', 'updated_at'},
    'compose_workloads': {'id', 'project_id', 'name', 'revision', 'deployed_revision', 'state', 'configuration', 'created_at', 'updated_at', 'last_error', 'deleted_at'},
    'compose_actions': {'id', 'workload_id', 'project_id', 'actor_id', 'type', 'status', 'revision', 'snapshot', 'request_hash', 'idempotency_key', 'created_at', 'updated_at', 'lease_until', 'worker_id', 'error', 'logs'},
    'compose_domains': {'hostname', 'workload_id'},
    'deployment_webhooks': {'service_id', 'actor_id', 'token_hash', 'secret', 'enabled', 'created_at'},
}
AGENT_COMPOSE_COLUMNS = {'id', 'workload_id', 'project_id', 'type', 'request_hash', 'state', 'process_group', 'snapshot', 'response', 'error', 'updated_at'}
SEALED_BYTES = base64.b64encode(bytes(28)).decode('ascii')
SEALED = 'enc:v1:' + SEALED_BYTES


class BackupSchemaV6Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='servus-backup-schema-')
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name)
        for name in ('secret-key', 'agent-token'):
            item = self.path / name
            item.write_text('a' * 64)
            item.chmod(0o600)
        for name in ('secrets', 'database-roots'):
            (self.path / name).mkdir(mode=0o700)
        self.directory = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.directory)
        self.real_connect = sqlite3.connect
        with self.database('agent.sqlite') as db:
            self.create_schema(db, backup.AGENT_SCHEMA)

    @contextmanager
    def database(self, name):
        with closing(self.real_connect(self.path / name)) as db:
            with db:
                yield db

    @staticmethod
    def create_schema(db, schema):
        for name, columns in schema.items():
            db.execute('CREATE TABLE ' + name + ' (' + ','.join(column + ' TEXT' for column in sorted(columns)) + ')')

    def panel(self, version):
        schema = {**backup.PANEL_SCHEMA}
        if version >= 5:
            schema['service_secret_refs'] = schema['service_secret_refs'] | {'purpose'}
        if version >= 6:
            schema.update(V6_TABLES)
        if version >= 7:
            schema.update(backup.PANEL_V7_ADDITIONS)
        with self.database('panel.sqlite') as db:
            self.create_schema(db, schema)
            db.execute('PRAGMA user_version=' + str(version))

    def execute(self, sql, parameters=()):
        with self.database('panel.sqlite') as db:
            db.execute(sql, parameters)

    def validate(self, expected_encrypted=None):
        real_file = backup._file
        real_child = backup._child_dir

        def connect(database_uri, **kwargs):
            # Map production's Linux descriptor paths into this private fixture.
            self.assertTrue(database_uri.startswith('file:/proc/self/fd/'))
            filename = database_uri.split('?', 1)[0].rsplit('/', 1)[1]
            self.assertIn(filename, ('panel.sqlite', 'agent.sqlite'))
            return self.real_connect(f'file:{self.path / filename}?mode=ro&immutable=1', **kwargs)

        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(backup.sqlite3, 'connect', side_effect=connect))
            # Keep file/mode/symlink checks, adapting only root ownership for a
            # non-root unit test. Encryption execution is outside this test.
            stack.enter_context(mock.patch.object(backup, '_file', side_effect=lambda directory, name, _owner, dev, **kwargs: real_file(directory, name, os.getuid(), dev, **kwargs)))
            stack.enter_context(mock.patch.object(backup, '_child_dir', side_effect=lambda directory, name, _owner, dev: real_child(directory, name, os.getuid(), dev)))
            verifier = stack.enter_context(mock.patch.object(backup, '_verify_node'))
            backup._validate_staging(self.directory, -1)
            verifier.assert_called_once_with(-1, 'a' * 64, expected_encrypted or [])

    def test_preserves_v4_and_v5_without_new_tables(self):
        for version in (4, 5):
            with self.subTest(version=version):
                self.panel(version)
                self.validate()
                (self.path / 'panel.sqlite').unlink()

    def test_accepts_exact_v6_additions(self):
        self.assertEqual(backup.PANEL_V6_ADDITIONS, V6_TABLES)
        self.panel(6)
        self.execute('INSERT INTO api_tokens(token_hash,scope) VALUES(?,?)', ('a' * 64, 'read'))
        self.execute('INSERT INTO api_tokens(token_hash,scope) VALUES(?,?)', ('b' * 64, 'deploy'))
        self.execute("INSERT INTO database_backups(status) VALUES('succeeded')")
        self.execute("INSERT INTO database_backups(status) VALUES('failed')")
        self.validate()

    def test_rejects_unrecognized_tables_and_columns(self):
        self.panel(6)
        for table in V6_TABLES:
            with self.subTest(table=table):
                self.execute('ALTER TABLE ' + table + ' ADD COLUMN unexpected TEXT')
                with self.assertRaisesRegex(backup.CaptureError, 'Unsupported database schema'):
                    self.validate()
                self.execute('ALTER TABLE ' + table + ' DROP COLUMN unexpected')
        self.execute('CREATE TABLE unexpected (value TEXT)')
        with self.assertRaisesRegex(backup.CaptureError, 'Unsupported database schema'):
            self.validate()

    def test_rejects_v6_with_a_missing_required_table(self):
        self.panel(6)
        for table, columns in V6_TABLES.items():
            with self.subTest(table=table):
                self.execute('DROP TABLE ' + table)
                with self.assertRaisesRegex(backup.CaptureError, 'Unsupported database schema'):
                    self.validate()
                with self.database('panel.sqlite') as db:
                    self.create_schema(db, {table: columns})

    def test_does_not_accept_new_tables_under_older_version_numbers(self):
        for version in (4, 5):
            with self.subTest(version=version):
                self.panel(version)
                with self.database('panel.sqlite') as db:
                    self.create_schema(db, V6_TABLES)
                with self.assertRaisesRegex(backup.CaptureError, 'Unsupported database schema'):
                    self.validate()
                (self.path / 'panel.sqlite').unlink()

    def test_rejects_future_schema_versions(self):
        self.panel(6)
        self.execute('PRAGMA user_version=9')
        with self.assertRaisesRegex(backup.CaptureError, 'Unsupported database schema'):
            self.validate()

    def test_rejects_invalid_token_hashes_and_scopes(self):
        self.panel(6)
        for token_hash, scope in (
            ('a' * 63, 'read'), ('a' * 65, 'read'), ('A' * 64, 'read'),
            ('srv_' + 'a' * 64, 'read'), ('g' * 64, 'read'), (None, 'read'),
            ('a' * 64, 'admin'), ('a' * 64, None),
        ):
            with self.subTest(token_hash=token_hash, scope=scope):
                self.execute('INSERT INTO api_tokens(token_hash,scope) VALUES(?,?)', (token_hash, scope))
                with self.assertRaisesRegex(backup.CaptureError, 'API token metadata is invalid'):
                    self.validate()
                self.execute('DELETE FROM api_tokens')

    def test_refuses_capture_while_a_database_backup_is_running(self):
        self.panel(6)
        self.execute("INSERT INTO database_backups(status) VALUES('running')")
        with self.assertRaisesRegex(backup.CaptureError, 'A database backup is still running'):
            self.validate()
        self.execute("UPDATE database_backups SET status='failed'")
        self.validate()

    def test_verifies_both_pending_and_active_authenticator_ciphertext(self):
        self.panel(6)
        self.execute('INSERT INTO two_factor_auth(pending_secret,secret) VALUES(?,?)', (SEALED, SEALED))
        self.validate([{'value': SEALED_BYTES, 'json': False}, {'value': SEALED_BYTES, 'json': False}])
        self.execute("UPDATE two_factor_auth SET pending_secret='plaintext-authenticator-key'")
        with self.assertRaisesRegex(backup.CaptureError, 'Encrypted inventory is invalid'):
            self.validate()

    def test_verifies_compose_configuration_and_snapshot_ciphertext(self):
        self.panel(6)
        self.execute('INSERT INTO compose_workloads(configuration) VALUES(?)', (SEALED,))
        self.execute("INSERT INTO compose_actions(snapshot,status) VALUES(?,'succeeded')", (SEALED,))
        self.validate([{'value': SEALED_BYTES, 'json': True}, {'value': SEALED_BYTES, 'json': True}])
        self.execute("UPDATE compose_actions SET status='running'")
        with self.assertRaisesRegex(backup.CaptureError, 'A Compose action is still running'):
            self.validate()
        self.execute("UPDATE compose_actions SET status='succeeded',snapshot='plaintext-compose-data'")
        with self.assertRaisesRegex(backup.CaptureError, 'Encrypted inventory is invalid'):
            self.validate()

    def test_accepts_only_exact_terminal_agent_compose_operations(self):
        self.assertEqual(backup.AGENT_COMPOSE_COLUMNS, AGENT_COMPOSE_COLUMNS)
        self.panel(6)
        with self.database('agent.sqlite') as db:
            self.create_schema(db, {'compose_operations': AGENT_COMPOSE_COLUMNS})
            ident = '12345678-1234-4123-8123-123456789abc'
            db.execute("INSERT INTO compose_operations(id,workload_id,project_id,type,state,snapshot) VALUES(?,?,?,'deploy','succeeded',?)", (ident, ident, ident, SEALED))
        self.validate([{'value': SEALED_BYTES, 'json': True}])
        for state in ('running', 'unknown'):
            with self.subTest(state=state):
                with self.database('agent.sqlite') as db:
                    db.execute('UPDATE compose_operations SET state=?', (state,))
                with self.assertRaises(backup.CaptureError):
                    self.validate()
        with self.database('agent.sqlite') as db:
            db.execute("UPDATE compose_operations SET state='failed'")
            db.execute('ALTER TABLE compose_operations ADD COLUMN unexpected TEXT')
        with self.assertRaisesRegex(backup.CaptureError, 'Unsupported database schema'):
            self.validate()

    def test_verifies_encrypted_deployment_webhook_secret(self):
        self.panel(6)
        self.execute('INSERT INTO deployment_webhooks(secret) VALUES(?)', (SEALED,))
        self.validate([{'value': SEALED_BYTES, 'json': False}])
        self.execute("UPDATE deployment_webhooks SET secret='plaintext-webhook-secret'")
        with self.assertRaisesRegex(backup.CaptureError, 'Encrypted inventory is invalid'):
            self.validate()

    def test_v7_preserves_v6_checks_and_fences_volume_work(self):
        self.panel(7)
        self.execute("INSERT INTO volume_backups(status) VALUES('succeeded')")
        self.validate()
        self.execute("UPDATE volume_backups SET status='running'")
        with self.assertRaisesRegex(backup.CaptureError,'application volume backup'):
            self.validate()
        self.execute("UPDATE volume_backups SET status='failed'")
        self.execute("INSERT INTO volume_restores(phase) VALUES('prepared')")
        with self.assertRaisesRegex(backup.CaptureError,'volume restore'):
            self.validate()
        self.execute("UPDATE volume_restores SET phase='cancelled'")
        self.validate()
        self.execute("INSERT INTO api_tokens(token_hash,scope) VALUES('invalid','read')")
        with self.assertRaisesRegex(backup.CaptureError,'API token'):
            self.validate()

    def test_v7_and_v8_share_the_exact_persisted_schema(self):
        for version in (7, 8):
            with self.subTest(version=version):
                self.panel(version)
                self.execute("INSERT INTO api_tokens(token_hash,scope) VALUES(?,'deploy')", ('a' * 64,))
                self.execute("INSERT INTO volume_restores(phase) VALUES('rolled_back')")
                self.validate()
                self.execute('ALTER TABLE volume_restores ADD COLUMN unexpected TEXT')
                with self.assertRaisesRegex(backup.CaptureError, 'Unsupported database schema'):
                    self.validate()
                (self.path / 'panel.sqlite').unlink()

    def add_redis_journal(self, phase='completed'):
        ident='a'*32
        service='12345678-1234-4123-8123-123456789abc'
        schema={**backup.AGENT_RESTORE_SCHEMA,'restore_retained_volumes':backup.AGENT_RETAINED_COLUMNS,
                'restore_volume_bindings':backup.AGENT_BINDING_COLUMNS,'redis_restore_plans':backup.AGENT_REDIS_PLAN_COLUMNS}
        with self.database('agent.sqlite') as db:
            self.create_schema(db,{name:columns for name,columns in schema.items() if name not in backup.AGENT_SCHEMA})
            db.execute('INSERT INTO restore_operations(id,service_id,kind,archive_sha256,phase,updated_at) VALUES(?,?,?,?,?,?)',
                       (ident,service,'redis','b'*64,'completed' if phase=='completed' else 'cancelled','2026-11-17T00:00:00.000Z'))
            db.execute('INSERT INTO redis_restore_plans(operation_id,service_id,sealed_plan,phase,updated_at) VALUES(?,?,?,?,?)',
                       (ident,service,SEALED,phase,'2026-11-17T00:00:00.000Z'))
        return ident,service

    def test_redis_plan_ciphertext_is_verified_with_its_operation_and_service_identity(self):
        self.panel(8)
        ident,service=self.add_redis_journal()
        self.validate([{'value':SEALED_BYTES,'json':True,'redis':{'operationId':ident,'serviceId':service}}])

    def test_redis_plan_requires_matching_terminal_redis_metadata(self):
        self.panel(8)
        ident,service=self.add_redis_journal()
        for phase in ('committing','rolling_back'):
            with self.subTest(phase=phase),self.database('agent.sqlite') as db:
                db.execute('UPDATE redis_restore_plans SET phase=?',(phase,))
                with self.assertRaisesRegex(backup.CaptureError,'Unresolved Redis restore plan'):
                    backup._agent_schema(db)
        with self.database('agent.sqlite') as db:
            db.execute("UPDATE redis_restore_plans SET phase='completed'")
            for statement in ("UPDATE restore_operations SET kind='postgres'",
                              "UPDATE restore_operations SET phase='cancelled'",
                              "UPDATE redis_restore_plans SET service_id='22345678-1234-4123-8123-123456789abc'",
                              "UPDATE redis_restore_plans SET operation_id='bad'",
                              "UPDATE redis_restore_plans SET sealed_plan='plaintext'",
                              "UPDATE redis_restore_plans SET updated_at='yesterday'"):
                with self.subTest(statement=statement):
                    db.execute('SAVEPOINT invalid_plan');db.execute(statement)
                    with self.assertRaisesRegex(backup.CaptureError,'Redis restore plan metadata is invalid'):
                        backup._agent_schema(db)
                    db.execute('ROLLBACK TO invalid_plan');db.execute('RELEASE invalid_plan')
            db.execute("UPDATE redis_restore_plans SET phase='rolled_back'")
            with self.assertRaisesRegex(backup.CaptureError,'Redis restore plan metadata is invalid'):
                backup._agent_schema(db)
            db.execute("UPDATE restore_operations SET phase='cancelled'")
            backup._agent_schema(db)

    def test_redis_plan_table_requires_bindings_and_retained_volume_schema(self):
        self.panel(8)
        self.add_redis_journal()
        with self.database('agent.sqlite') as db:
            db.execute('DROP TABLE restore_volume_bindings')
            with self.assertRaisesRegex(backup.CaptureError,'Unsupported database schema'):
                backup._agent_schema(db)

    def test_completed_redis_restore_cannot_omit_its_recovery_plan(self):
        self.panel(8)
        self.add_redis_journal()
        with self.database('agent.sqlite') as db:
            db.execute('DELETE FROM redis_restore_plans')
            with self.assertRaisesRegex(backup.CaptureError,'lacks a recovery plan'):
                backup._agent_schema(db)
            db.execute('DROP TABLE redis_restore_plans')
            with self.assertRaisesRegex(backup.CaptureError,'lacks a recovery plan'):
                backup._agent_schema(db)

    def test_volume_binding_requires_the_matching_completed_restore(self):
        self.panel(7)
        ident='12345678-1234-4123-8123-123456789abc'
        with self.database('agent.sqlite') as db:
            self.create_schema(db,backup.AGENT_VOLUME_SCHEMA)
            db.execute("INSERT INTO volume_restore_operations(id,service_id,mount_target,mount_name,candidate_volume,phase,sealed_plan) VALUES(?,?,?,'data',?,'completed',?)",(ident,ident,'/data','panel-volume-restore-'+ident,SEALED))
            db.execute("INSERT INTO volume_restore_bindings VALUES(?,?,?,?,?,?)",tuple({'created_at':'2026-11-17T00:00:00.000Z','mount_name':'data','mount_target':'/data','operation_id':ident,'service_id':ident,'volume_name':'panel-volume-restore-'+ident}[key] for key in sorted(backup.AGENT_VOLUME_SCHEMA['volume_restore_bindings'])))
        self.validate([{'value':SEALED_BYTES,'json':True}])
        with self.database('agent.sqlite') as db:
            db.execute("UPDATE volume_restore_bindings SET mount_target='/another'")
        with self.assertRaisesRegex(backup.CaptureError,'volume binding'):
            self.validate()


if __name__ == '__main__':
    unittest.main()
