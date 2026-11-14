import hashlib
import importlib.util
import json
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
adoption=load('prepared_adoption','adoption-proof.py')
runtime=load('prepared_runtime','runtime-policy.py')
updater=load('prepared_updater','servus-updater.py')

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class PreparedMigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.state=self.root/'state';self.state.mkdir(mode=0o700);self.policies=self.root/'policies';self.policies.mkdir(mode=0o700)
        self.op,self.prep,self.attempt=(str(uuid.uuid4()) for _ in range(3));self.nonce='a'*64
        self.digest='sha256:'+'b'*64;self.config='sha256:'+'c'*64
        self.active=self.root/'active.env';env=('SERVUS_IMAGE=ghcr.io/raxon/servus@'+self.digest+'\n').encode();self.active.write_bytes(env);self.active.chmod(0o600)
        self.snapshot=self.policies/('env-'+self.prep+'.env');self.snapshot.write_bytes(env);self.snapshot.chmod(0o600)
        self.candidate=self.policies/('candidate-'+self.prep+'.json')
        self.candidate.write_text(json.dumps({'version':1,'policy':{'image_reference':'ghcr.io/raxon/servus@'+self.digest}}));self.candidate.chmod(0o600)
        self.db=updater.Journal(self.state)
        self.db.db.executescript('''CREATE TABLE policy_approvals(operation_id TEXT,state TEXT,policy_path TEXT,source_env_path TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,candidate_path TEXT,candidate_digest TEXT,accepted_env_path TEXT,env_digest TEXT);
        CREATE TABLE policy_probes(operation_id TEXT,preparation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,config_digest TEXT,state TEXT);''')
        env_digest='sha256:'+hashlib.sha256(env).hexdigest();candidate_digest='sha256:'+hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        self.db.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(self.op,'d'*40,self.digest,'v1.0.0','verified',self.attempt,self.nonce,self.config))
        self.db.db.execute('INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)',(self.op,self.attempt,self.nonce,self.prep,'prepared'))
        self.db.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(self.op,'candidate',None,str(self.active),self.attempt,self.nonce,self.prep,self.digest,self.config,str(self.candidate),candidate_digest,str(self.snapshot),env_digest))
        self.db.db.execute("INSERT INTO policy_probes VALUES(?,?,?,?,?,'removed')",(self.op,self.prep,self.attempt,self.nonce,env_digest))
    def tearDown(self):self.db.close();self.temp.cleanup()
    def resolve(self):
        with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace):
            return adoption.prepared_binding(self.db,self.op,str(self.active),str(self.policies),supervisor,runtime)
    def test_prepared_binding_matches_future_active_policy_identity(self):
        path,snapshot,approved,binding=self.resolve()
        self.assertEqual(path,str(self.policies/('policy-'+self.op+'.json')))
        self.assertEqual(snapshot,str(self.snapshot))
        self.assertEqual(approved.image_reference,'ghcr.io/raxon/servus@'+self.digest)
        self.assertEqual(binding,(self.prep,self.attempt,self.nonce,self.digest,self.config))
    def test_rejects_changed_policy_environment_and_probe(self):
        original=self.candidate.read_bytes();self.candidate.write_text('{}')
        with self.assertRaises(adoption.AdoptionError):self.resolve()
        self.candidate.write_bytes(original);self.active.write_text('SERVUS_IMAGE=changed\n')
        with self.assertRaises(adoption.AdoptionError):self.resolve()
        self.active.write_bytes(self.snapshot.read_bytes());self.db.db.execute("UPDATE policy_probes SET state='intent'")
        with self.assertRaises(adoption.AdoptionError):self.resolve()
    def test_rejects_conflicting_active_policy(self):
        self.db.db.execute("INSERT INTO policy_approvals(operation_id,state) VALUES(?,'active')",(str(uuid.uuid4()),))
        with self.assertRaises(adoption.AdoptionError):self.resolve()

if __name__=='__main__':unittest.main()
