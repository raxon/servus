#!/usr/bin/python3
"""Reconcile a stopped, pre-switch policy attempt after its artifacts are fenced.

The caller must hold the updater and installation locks, stop both services,
confirm that all recorded Docker probes have been removed, and quarantine the
candidate files before invoking this journal operation. This is an operator-only
primitive, not an API endpoint or a substitute for those external checks.
"""
import json
import os
import re
import sqlite3


class ReconciliationError(Exception):
    pass


def reconcile(db, operation_id):
    """Requeue one exact attempt without discarding its journal evidence."""
    if not isinstance(operation_id, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', operation_id):
        raise ReconciliationError('Invalid operation identity')
    db.execute('BEGIN IMMEDIATE')
    try:
        row = db.execute("SELECT o.status,o.attempt_id,o.attempt_nonce,o.config_digest,p.attempt_id,p.attempt_nonce,p.preparation_id,p.status,p.staging_path FROM operations o JOIN preparations p ON p.operation_id=o.id WHERE o.id=?", (operation_id,)).fetchone()
        if (not row or row[0] != 'verified' or row[1:3] != row[4:6] or row[7] != 'recovery_required' or
                not isinstance(row[1], str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', row[1]) or
                not isinstance(row[2], str) or not re.fullmatch(r'[a-f0-9]{64}', row[2]) or
                not isinstance(row[3], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', row[3]) or
                not isinstance(row[6], str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', row[6]) or
                not isinstance(row[8], str) or not os.path.isabs(row[8]) or os.path.normpath(row[8]) != row[8] or
                not re.fullmatch(r'servus-install-[a-f0-9]{32}', os.path.basename(row[8]))):
            raise ReconciliationError('Attempt does not match a verified staged preparation')
        if (db.execute("SELECT 1 FROM operations WHERE status IN ('accepted','verifying','recovery_required') LIMIT 1").fetchone() or
                db.execute("SELECT 1 FROM preparations WHERE operation_id != ? AND status IN ('preparing','prepared','recovery_required') LIMIT 1", (operation_id,)).fetchone() or
                db.execute("SELECT 1 FROM apply_requests WHERE operation_id != ? AND state != 'completed' LIMIT 1", (operation_id,)).fetchone()):
            raise ReconciliationError('Another operation is active')
        if db.execute("SELECT state FROM apply_requests WHERE operation_id=?", (operation_id,)).fetchone() != ('recovery_required',):
            raise ReconciliationError('Apply request is not awaiting recovery')
        if db.execute("SELECT 1 FROM update_transactions WHERE phase != 'completed' LIMIT 1").fetchone() or db.execute('SELECT 1 FROM update_transactions WHERE operation_id=?', (operation_id,)).fetchone():
            raise ReconciliationError('Update switching may have started')
        if db.execute("SELECT 1 FROM extraction_probes WHERE status != 'removed' LIMIT 1").fetchone():
            raise ReconciliationError('Extraction probes are not reconciled')
        if not db.execute("SELECT 1 FROM extraction_probes WHERE operation_id=? AND attempt_id=? AND attempt_nonce=? AND preparation_id=? AND purpose='prepare' AND status='removed'", (operation_id, row[1], row[2], row[6])).fetchone():
            raise ReconciliationError('Staged extraction evidence is missing')
        if db.execute("SELECT 1 FROM policy_approvals WHERE operation_id=? OR state IN ('candidate','activating','recovery_required')", (operation_id,)).fetchone():
            raise ReconciliationError('A candidate policy was already recorded')
        probe = db.execute('SELECT attempt_id,attempt_nonce,preparation_id,project,config_digest,state FROM policy_probes WHERE operation_id=?', (operation_id,)).fetchone()
        if (not probe or probe[:3] != (row[1], row[2], row[6]) or probe[5] != 'removed' or
                not isinstance(probe[3], str) or not re.fullmatch(r'servusprobe[a-f0-9]{32}', probe[3]) or
                not isinstance(probe[4], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', probe[4])):
            raise ReconciliationError('Policy probe is not reconciled')
        db.execute('CREATE TABLE IF NOT EXISTS policy_reconciliations (operation_id TEXT NOT NULL, preparation_id TEXT NOT NULL, probe_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
        db.execute('INSERT INTO policy_reconciliations(operation_id,preparation_id,probe_json) VALUES (?,?,?)', (operation_id, row[6], json.dumps(probe, separators=(',', ':'))))
        if db.execute('DELETE FROM policy_probes WHERE operation_id=? AND state=?', (operation_id, 'removed')).rowcount != 1:
            raise ReconciliationError('Policy probe changed')
        if db.execute("UPDATE preparations SET status='prepared' WHERE operation_id=? AND status='recovery_required'", (operation_id,)).rowcount != 1:
            raise ReconciliationError('Preparation changed')
        if db.execute("UPDATE apply_requests SET state='requested' WHERE operation_id=? AND state='recovery_required'", (operation_id,)).rowcount != 1:
            raise ReconciliationError('Apply request changed')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
