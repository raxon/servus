#!/usr/bin/env python3
"""Read-only, secret-minimizing diagnostics for a Servus update incident."""
import json
import pathlib
import re
import sqlite3
import subprocess
import sys

STATE = pathlib.Path('/var/lib/servus-updater')
UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
PHASES = {'intent', 'snapshotting', 'snapshot_verified', 'switching', 'starting', 'completed', 'recovery_required'}
FAILURE = re.compile(r'^servus (?:maintenance failure phase=(?:maintenance_gate|drain|identity|stop|exclusive_gate|update)|drain failure role=(?:api|agent|worker) outcome=(?:uncertain|timeout|stopped|invalid_response|channel_error))$')
OPERATION_FAILURE = re.compile(r'^servus maintenance operation=([0-9a-f-]{36}) failure phase=(maintenance_gate|drain|identity|stop|exclusive_gate|update)$')


def diagnose(state=STATE, journal_output=''):
    result = {'maintenance': 'unavailable', 'operation_id': None, 'phase': 'unavailable',
              'snapshot_verified': None, 'events': []}
    try:
        marker = json.loads((state / 'maintenance' / 'maintenance.json').read_text())
        if isinstance(marker, dict) and marker.get('state') in {'intent', 'maintenance', 'drained', 'stopping', 'stopped_unverified', 'snapshotting', 'snapshot_verified', 'switching', 'starting', 'recovery_required'}:
            result['maintenance'] = marker['state']
            operation = marker.get('operationId')
            if isinstance(operation, str) and UUID.fullmatch(operation):
                result['operation_id'] = operation
    except (OSError, ValueError):
        pass
    if result['operation_id']:
        try:
            uri = (state / 'journal.sqlite').resolve().as_uri() + '?mode=ro'
            with sqlite3.connect(uri, uri=True) as db:
                row = db.execute('SELECT phase, backup_manifest_digest FROM update_transactions WHERE operation_id=?', (result['operation_id'],)).fetchone()
            if row and row[0] in PHASES:
                result['phase'] = row[0]
                result['snapshot_verified'] = bool(row[1])
        except (OSError, sqlite3.Error):
            pass
    # Never forward arbitrary logs: they may contain tokens, URLs or user data.
    for line in journal_output.splitlines():
        operation_failure = OPERATION_FAILURE.fullmatch(line)
        if ((FAILURE.fullmatch(line) or (operation_failure and operation_failure.group(1) == result['operation_id']))
                and line not in result['events']):
            result['events'].append(line)
    return result


def main():
    try:
        logs = subprocess.run(['/usr/bin/journalctl', '-u', 'servus-supervisor.service', '-n', '200', '--no-pager', '-o', 'cat'],
                              capture_output=True, text=True, timeout=10, check=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        logs = ''
    print(json.dumps(diagnose(journal_output=logs), indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
