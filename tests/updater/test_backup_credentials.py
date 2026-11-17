"""Verify encrypted source records with real Node crypto, without host privileges."""
import base64
import importlib.util
import json
import pathlib
import shutil
import subprocess
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location('servus_backup_credentials',ROOT/'apps/updater/backup.py')
backup=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
NODE=shutil.which('node')
SERVICE='12345678-1234-4123-8123-123456789abc'


@unittest.skipUnless(NODE,'Node is required to validate encrypted credentials')
class EncryptedCredentialTest(unittest.TestCase):
    def payload(self,record,metadata):
        script="""const {createCipheriv}=require('node:crypto');let text='';process.stdin.on('data',v=>text+=v);process.stdin.on('end',()=>{const record=JSON.parse(text),iv=Buffer.alloc(12,7),key=Buffer.alloc(32,3),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('panel-secret-v1'));const data=Buffer.concat([cipher.update(JSON.stringify(record)),cipher.final()]);process.stdout.write(JSON.stringify({key:key.toString('hex'),value:Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64')}));});"""
        result=json.loads(subprocess.check_output([NODE,'-e',script],input=json.dumps(record),text=True,cwd=ROOT,timeout=10))
        return {'key':result['key'],'sealed':[{'value':result['value'],'json':False,**metadata}]}

    def verify(self,payload):
        return subprocess.run([NODE,'-e',backup.NODE_VERIFY],input=json.dumps(payload),text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=ROOT,timeout=10)

    def registry(self):
        return {'kind':'registry-credential-v1','serviceId':SERVICE,'server':'registry.example.com:5443','username':'fixture-user','password':'synthetic-fixture-password'}

    def test_registry_requires_the_same_service_host_account_and_image(self):
        record=self.registry()
        requirements={'registry':{'serviceId':SERVICE,'requirements':[{'server':record['server'],'username':record['username'],'image':record['server']+'/team/app:1'}]}}
        result=self.verify(self.payload(record,requirements));self.assertEqual((result.returncode,result.stdout,result.stderr),(0,'ok',''))
        for field,value in (('serviceId','22345678-1234-4123-8123-123456789abc'),('server','other.example.com'),('username','other-user'),('password','')):
            with self.subTest(field=field):
                changed={**record,field:value};result=self.verify(self.payload(changed,requirements));self.assertNotEqual(result.returncode,0);self.assertEqual(result.stderr,'')

    def ssh_record(self):
        # This is a disposable generated keypair, never a user's deployment key.
        script="const {utils}=require('ssh2');const k=utils.generateKeyPairSync('ed25519',{comment:'snapshot-fixture'});process.stdout.write(JSON.stringify(k));"
        generated=json.loads(subprocess.check_output([NODE,'-e',script],text=True,cwd=ROOT,timeout=10))
        public=generated['public']
        return {'kind':'git-ssh-v1','serviceId':SERVICE,'repository':'ssh://git@git.example.com/team/app.git','privateKey':generated['private'],'publicKey':public,'knownHosts':'git.example.com ssh-ed25519 '+public.split(' ')[1]+'\n'}

    def test_ssh_verifies_keypair_host_and_exact_saved_binding(self):
        record=self.ssh_record()
        requirements={'ssh':{'serviceId':SERVICE,'requirements':[{key:record[key] for key in ('repository','knownHosts','publicKey')}]}}
        result=self.verify(self.payload(record,requirements));self.assertEqual((result.returncode,result.stdout,result.stderr),(0,'ok',''))
        other=self.ssh_record()
        malformed_private=record['privateKey'].replace('-----BEGIN OPENSSH PRIVATE KEY-----\n','-----BEGIN OPENSSH PRIVATE KEY-----\n?')
        for field,value in (('privateKey',other['privateKey']),('privateKey',malformed_private),('repository','ssh://git@other.example.com/team/app.git'),('knownHosts',record['knownHosts'].replace('git.example.com','*')),('publicKey',other['publicKey'])):
            with self.subTest(field=field):
                result=self.verify(self.payload({**record,field:value},requirements));self.assertNotEqual(result.returncode,0);self.assertEqual(result.stderr,'')

    def test_same_service_references_cannot_change_purpose(self):
        refs=set();owners={'reference':SERVICE};purposes={'reference':'environment'}
        config={'registry':{'server':'registry.example.com','username':'user','secretRef':'reference'}}
        with self.assertRaisesRegex(backup.CaptureError,'invalid owner or purpose'):
            backup._config_references(config,refs,SERVICE,owners,purposes,{}, {}, {},'registry.example.com/team/app')
        config={'source':{'type':'git','repository':'ssh://git@git.example.com/team/app.git','ssh':{'knownHosts':'fixture','publicKey':'fixture','secretRef':'reference'}}}
        with self.assertRaisesRegex(backup.CaptureError,'invalid owner or purpose'):
            backup._config_references(config,refs,SERVICE,owners,purposes,{}, {}, {},'alpine')


if __name__=='__main__':unittest.main()
