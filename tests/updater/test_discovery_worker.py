import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('discovery_updater', ROOT / 'apps/updater/servus-updater.py')
updater = importlib.util.module_from_spec(spec); spec.loader.exec_module(updater)


class DiscoveryWorkerTest(unittest.TestCase):
    def worker(self, output):
        def launch(_current, _channel):
            return subprocess.Popen([sys.executable, '-c', 'import sys;sys.stdout.write(sys.argv[1])', output], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return updater.DiscoveryWorker(launch)

    def finish(self, worker):
        deadline = time.monotonic() + 3
        while worker.process is not None and time.monotonic() < deadline:
            worker.tick(); time.sleep(.01)
        self.assertIsNone(worker.process)

    def test_discovery_runs_asynchronously_and_caches_valid_candidate(self):
        value = {'status':'candidate','verified':False,'tag':'v1.2.3','commit':'a'*40,'digest':'sha256:'+'b'*64}
        worker = self.worker(json.dumps(value))
        self.assertEqual(worker.request('v1.0.0'), {'status':'checking'})
        self.finish(worker)
        self.assertEqual(worker.request('v1.0.0'), value)
        self.assertEqual(worker.request('v1.0.1'), {'status':'checking'})
        worker.close()

    def test_rejects_untrusted_or_malformed_results(self):
        for value in ('{"status":"candidate","status":"candidate"}', json.dumps({'status':'candidate','verified':True,'tag':'v1.2.3','commit':'a'*40,'digest':'sha256:'+'b'*64}), json.dumps({'status':'ahead','current':'v0.1.0','latest':'v1.0.0','extra':'secret'})):
            with self.subTest(value=value):
                worker = self.worker(value); worker.request('v1.0.0'); self.finish(worker)
                self.assertEqual(worker.request('v1.0.0'), {'status':'unavailable'})

    def test_only_stable_version_and_exact_request_fields_are_accepted(self):
        worker = self.worker('{}')
        for current in ('unknown','v1.2.3-beta','v01.2.3','v1.2.3\n'):
            with self.subTest(current=current), self.assertRaises(updater.ProtocolError): worker.request(current)
        with self.assertRaises(updater.ProtocolError): updater.process(None, {'version':1,'action':'discover','current':'v1.0.0','url':'https://invalid'}, discovery=worker)
        with self.assertRaises(updater.ProtocolError): updater.process(None, {'version':1,'action':'discover','current':'v1.0.0'})

    def test_timed_out_discovery_is_terminated_and_does_not_block_retry(self):
        worker = updater.DiscoveryWorker(lambda _, channel: subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'], stdout=subprocess.PIPE))
        worker.request('v1.0.0')
        worker.started -= 51
        worker.tick()
        self.assertIsNone(worker.process)
        self.assertEqual(worker.request('v1.0.0'), {'status':'unavailable'})
        with mock.patch.object(updater.time, 'monotonic', return_value=worker.finished + 31):
            self.assertEqual(worker.request('v1.0.0'), {'status':'checking'})
        worker.close()


if __name__ == '__main__': unittest.main()
