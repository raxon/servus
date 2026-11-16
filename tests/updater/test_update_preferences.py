import importlib.util
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('update_policy', ROOT / 'apps/updater/servus-updater.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
CANDIDATE = {'status':'candidate','tag':'v1.0.1','commit':'a'*40,'digest':'sha256:'+'b'*64,'verified':False}


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        def private_file(path, name):
            return os.open(path / name, os.O_CREAT | os.O_RDWR, 0o600)
        self.patch = mock.patch.object(u, 'private_file', side_effect=private_file)
        self.patch.start()
        self.prefs = u.UpdatePreferences(self.path)
        self.journal = mock.Mock()
        self.journal.db = sqlite3.connect(':memory:')
        self.journal.db.executescript("CREATE TABLE policy_approvals(operation_id TEXT,state TEXT); CREATE TABLE operations(id TEXT,tag TEXT,status TEXT); INSERT INTO operations VALUES('old','v1.0.0','verified'); INSERT INTO policy_approvals VALUES('old','active');")
        self.discovery = mock.Mock()
        self.discovery.request.return_value = CANDIDATE
        self.runner = u.AutomaticUpdates(self.prefs,self.journal,self.discovery)
        self.busy = mock.patch.object(u.LegacyRecoveryJournal,'update_busy',return_value=False)
        self.busy.start()
        self.window = mock.patch.object(u.AutomaticUpdates,'scheduled_date',return_value='2026-11-15')
        self.window.start()

    def tearDown(self):
        self.window.stop(); self.busy.stop(); self.prefs.close(); self.journal.db.close(); self.patch.stop(); self.temp.cleanup()

    def tick(self):
        self.runner.next_tick = 0
        self.runner.tick()

    def test_defaults_persistence_and_validation(self):
        self.assertEqual(self.prefs.get(),{'automatic':False,'channel':'production','installTime':'02:00','timeZone':'Europe/Warsaw','lastAutomaticUpdate':None})
        self.prefs.set(True,'beta','03:30','Europe/Warsaw')
        self.prefs.close(); self.prefs = u.UpdatePreferences(self.path)
        self.assertEqual(self.prefs.get()['installTime'],'03:30')
        for automatic, channel, hour, zone in [(1,'beta','02:00','UTC'),(True,'other','02:00','UTC'),(True,'beta','25:00','UTC'),(True,'beta','02:00','invalid/zone')]:
            with self.assertRaises(u.ProtocolError): self.prefs.set(automatic,channel,hour,zone)

    def test_protocol_uses_saved_channel_and_blocks_preferences_when_apply_disabled(self):
        payload={'version':1,'action':'set_preferences','automatic':True,'channel':'beta','installTime':'02:00','timeZone':'Europe/Warsaw'}
        with self.assertRaises(u.ProtocolError):
            u.process(self.journal,payload,preferences=self.prefs)
        self.assertEqual(u.process(self.journal,payload,preferences=self.prefs,allow_apply=True)['channel'],'beta')
        u.process(self.journal,{'version':1,'action':'discover','current':'v1.0.0'},preferences=self.prefs,discovery=self.discovery)
        self.discovery.request.assert_called_once_with('v1.0.0','beta')

    def test_disabled_outside_schedule_and_busy_do_not_submit(self):
        self.tick(); self.discovery.request.assert_not_called()
        self.prefs.set(True,'production','02:00','Europe/Warsaw')
        with mock.patch.object(u.AutomaticUpdates,'scheduled_date',return_value=None): self.tick()
        self.discovery.request.assert_not_called()
        with mock.patch.object(u.LegacyRecoveryJournal,'update_busy',return_value=True): self.tick()
        self.discovery.request.assert_not_called()
        self.journal.submit.assert_not_called()

    def test_pipeline_requires_verification_and_never_retries_failed_version(self):
        self.prefs.set(True,'beta','02:00','Europe/Warsaw')
        self.tick()
        self.discovery.request.assert_called_once_with('v1.0.0','beta')
        self.tick()
        self.journal.submit.assert_called_once()
        self.journal.status.return_value={'status':'accepted'}
        self.tick(); self.journal.claim_preparation.assert_not_called(); self.journal.request_apply.assert_not_called()
        self.journal.status.return_value={'status':'verification_failed'}
        self.tick()
        self.assertEqual(self.prefs.get()['lastAutomaticUpdate']['stage'],'attention')
        self.runner = u.AutomaticUpdates(self.prefs,self.journal,self.discovery)
        self.tick()
        self.journal.submit.assert_called_once()

    def test_successful_pipeline_uses_existing_preparation_and_application(self):
        self.prefs.set(True,'production','02:00','Europe/Warsaw')
        self.tick(); self.tick()
        self.journal.status.return_value={'status':'verified'}
        self.tick()
        self.journal.preparation_status.return_value=None
        self.tick(); self.journal.claim_preparation.assert_called_once()
        self.journal.preparation_status.return_value={'status':'prepared'}
        self.tick()
        self.journal.request_apply.return_value={'status':'completed'}
        self.tick()
        self.assertEqual(self.prefs.get()['lastAutomaticUpdate']['stage'],'completed')
        self.runner = u.AutomaticUpdates(self.prefs,self.journal,self.discovery)
        self.tick(); self.journal.submit.assert_called_once()


class ScheduleTest(unittest.TestCase):
    def test_local_time_window_and_dst(self):
        policy={'installTime':'02:00','timeZone':'Europe/Warsaw'}
        for instant, expected in [('2026-11-15T00:59:59+00:00',None),('2026-11-15T01:00:00+00:00','2026-11-15'),('2026-11-15T01:05:00+00:00',None),('2026-03-29T01:00:00+00:00','2026-03-29'),('2026-10-25T00:00:00+00:00','2026-10-25'),('2026-10-25T01:00:00+00:00',None)]:
            self.assertEqual(u.AutomaticUpdates.scheduled_date(policy,datetime.fromisoformat(instant)),expected)


if __name__ == '__main__': unittest.main()
