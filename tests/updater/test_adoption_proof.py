import fcntl
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor


def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/filename)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


adoption=load('adoption_proof','adoption-proof.py')
policy=load('adoption_policy','runtime-policy.py')
updater=load('adoption_updater','servus-updater.py')


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class AdoptionProofTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.install=self.root/'install';self.install.mkdir(mode=0o700);(self.install/'install.lock').touch(mode=0o600)
        self.state=self.root/'state';self.state.mkdir(mode=0o700)
        self.op,self.attempt,self.prep=(str(uuid.uuid4()) for _ in range(3))
        self.root_digest='sha256:'+'a'*64;self.config_digest='sha256:'+'b'*64;self.nonce='c'*64
        self.parent=str(self.root/'migrations');self.snapshot=str(self.root/'snapshot');self.digest='sha256:'+'d'*64
        self.active_env=str(self.root/'active.env');self.policy_path=str(self.root/'policy');self.accepted=str(self.root/'accepted.env')
        self.approved=SimpleNamespace(install_dir=str(self.install),data_dir=os.path.join(self.parent,'restore-'+self.op),image_reference='ghcr.io/raxon/servus@'+self.root_digest)
        self.daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=(self.policy_path,self.accepted,self.approved)))
        self.restore=SimpleNamespace(verify_staged=mock.Mock(return_value=(123,456)))
        self.quiet=SimpleNamespace(ensure_host_namespaces=mock.Mock(),ensure_no_uid_writers=mock.Mock(),ensure_no_open_data=mock.Mock())
        self.journal=updater.Journal(self.state)
        self.journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT,state TEXT)')
        self.journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(self.op,'e'*40,self.root_digest,'v1.0.0','verified',self.attempt,self.nonce,self.config_digest))
        self.journal.db.execute('INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)',(self.op,self.attempt,self.nonce,self.prep,'prepared'))
        self.journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?,?)',(self.op,self.attempt,self.nonce,self.prep,self.root_digest,self.config_digest,self.policy_path,self.accepted,self.active_env,'active'))
        self.type_patch=mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace);self.type_patch.start()

    def tearDown(self):self.type_patch.stop();self.journal.close();self.temp.cleanup()
    def record(self,**kwargs):
        return adoption.record(self.journal,self.op,self.active_env,self.snapshot,self.digest,self.parent,object(),-1,supervisor,self.daemon,policy,object(),self.restore,self.quiet,**kwargs)
    def verify(self,fd):
        return adoption.verify(self.journal,self.op,self.active_env,object(),-1,supervisor,self.daemon,object(),self.restore,self.quiet,install_lock=fd)
    def lock(self):
        fd=os.open(self.install/'install.lock',os.O_RDONLY);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);return fd

    def test_records_exact_release_and_rechecks_snapshot_under_lock(self):
        fd=self.lock()
        try:
            self.assertEqual(self.record(inherited_lock=fd),(123,456))
            self.assertEqual(self.verify(fd),(123,456))
            self.assertEqual(self.journal.db.execute('SELECT state,root_digest,snapshot_digest FROM initial_adoptions').fetchone(),('ready',self.root_digest,self.digest))
            self.assertEqual(self.restore.verify_staged.call_count,2)
            self.assertEqual(self.quiet.ensure_no_uid_writers.call_count,4)
            with self.assertRaises(adoption.AdoptionError):self.record(inherited_lock=fd)
        finally:os.close(fd)

    def test_changed_staged_identity_and_release_are_rejected(self):
        fd=self.lock()
        try:
            self.record(inherited_lock=fd);self.restore.verify_staged.return_value=(123,999)
            with self.assertRaises(adoption.AdoptionError):self.verify(fd)
            self.restore.verify_staged.return_value=(123,456)
            self.journal.db.execute('UPDATE operations SET digest=? WHERE id=?',('sha256:'+'f'*64,self.op))
            with self.assertRaises(adoption.AdoptionError):self.verify(fd)
        finally:os.close(fd)

    def test_wrong_lock_or_unexcluded_writer_is_rejected_without_record(self):
        other=self.root/'other';other.touch(mode=0o600);fd=os.open(other,os.O_RDONLY)
        try:
            with self.assertRaises(policy.PolicyError):self.record(inherited_lock=fd)
        finally:os.close(fd)
        self.quiet.ensure_no_uid_writers.side_effect=RuntimeError('writer present')
        with self.assertRaises(RuntimeError):self.record()
        self.assertFalse(self.journal.db.execute("SELECT 1 FROM sqlite_master WHERE name='initial_adoptions'").fetchone())

    def test_verification_requires_same_live_exclusive_lock(self):
        self.record()
        fd=os.open(self.install/'install.lock',os.O_RDONLY)
        try:
            with self.assertRaises((adoption.AdoptionError,supervisor.SupervisorError)):self.verify(fd)
        finally:os.close(fd)
        other=self.root/'other';other.touch(mode=0o600);fd=os.open(other,os.O_RDONLY)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(adoption.AdoptionError):self.verify(fd)
        finally:os.close(fd)

    def test_consumed_or_concurrently_changed_evidence_is_not_reused(self):
        fd=self.lock()
        try:
            self.record(inherited_lock=fd)
            self.journal.db.execute("UPDATE initial_adoptions SET state='consumed'")
            with self.assertRaises(adoption.AdoptionError):self.verify(fd)
            self.journal.db.execute("UPDATE initial_adoptions SET state='ready'")
            def changed(*_args):
                self.journal.db.execute("UPDATE initial_adoptions SET state='recovery_required'")
                return (123,456)
            self.restore.verify_staged.side_effect=changed
            with self.assertRaises(adoption.AdoptionError):self.verify(fd)
        finally:os.close(fd)

    def test_refuses_pending_extraction_or_started_generation(self):
        self.journal.db.execute('CREATE TABLE initial_generations(operation_id TEXT,phase TEXT)')
        self.journal.db.execute("INSERT INTO initial_generations VALUES(?,'started')",(self.op,))
        with self.assertRaises(adoption.AdoptionError):self.record()
        self.assertFalse(self.journal.db.execute("SELECT 1 FROM sqlite_master WHERE name='initial_adoptions'").fetchone())
        self.journal.db.execute('DELETE FROM initial_generations')
        self.journal.db.execute("INSERT INTO extraction_probes VALUES(?,?,?,?,?,?,'intent')",('fixture',self.op,self.attempt,self.nonce,self.prep,'prepare'))
        with self.assertRaises(adoption.AdoptionError):self.record()

    def test_existing_or_overlapping_data_path_is_rejected(self):
        self.approved.data_dir=self.snapshot
        with self.assertRaises(adoption.AdoptionError):self.record()
        self.restore.verify_staged.assert_not_called()


if __name__=='__main__':unittest.main()
