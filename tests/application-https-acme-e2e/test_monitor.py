import datetime
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[2] / 'deployment/application-tls/check_test_servus.py'
spec = importlib.util.spec_from_file_location('tls_monitor', path)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)
NOW = datetime.datetime(2026, 11, 15, tzinfo=datetime.timezone.utc)


class MonitorTest(unittest.TestCase):
    def test_healthy_and_expiring_certificate(self):
        with patch.object(monitor, 'systemctl', return_value=(0, 'success')):
            with patch.object(monitor, 'probe', return_value=(NOW + datetime.timedelta(days=22), 200)):
                self.assertEqual(monitor.check(NOW), [])
            with patch.object(monitor, 'probe', return_value=(NOW + datetime.timedelta(days=20), 200)):
                self.assertIn('less than 21 days', monitor.check(NOW)[0])

    def test_failed_service_and_bad_http_status(self):
        with patch.object(monitor, 'probe', return_value=(NOW + datetime.timedelta(days=30), 503)):
            with patch.object(monitor, 'systemctl', side_effect=[(0, ''), (1, ''), (0, 'exit-code')]):
                problems = monitor.check(NOW)
        self.assertTrue(any('HTTP 503' in item for item in problems))
        self.assertTrue(any('not active' in item for item in problems))
        self.assertTrue(any('exit-code' in item for item in problems))

    def test_unreachable_https_and_disabled_timer(self):
        with patch.object(monitor, 'probe', side_effect=OSError('unreachable')):
            with patch.object(monitor, 'systemctl', side_effect=[(1, ''), (0, ''), (0, 'success')]):
                problems = monitor.check(NOW)
        self.assertTrue(any('unreachable' in item for item in problems))
        self.assertTrue(any('not enabled' in item for item in problems))


if __name__ == '__main__':
    unittest.main()
