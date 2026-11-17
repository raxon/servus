import {createHmac} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  installationBackupApprovalMessage, installationBackupCancellationMessage, installationBackupInputSchema, signInstallationBackupApproval,signInstallationBackupCancellation,
} from '../../src/server/installation-backup-approval.js';

const fields = {operationId: '12345678-1234-4123-8123-123456789abc', actorId: '22345678-1234-4123-8123-123456789abc', issuedAt: 1794916800123, name: 'Kopia zażółć 🚀'};
const key = 'a'.repeat(64);

describe('installation backup administrator approval', () => {
  it('separates cancellation proofs from create proofs for the exact same UTF-8 identity',()=>{
    const message=installationBackupCancellationMessage(fields);
    expect(message).toBe(`servus-installation-backup-cancel-v1\0${fields.operationId}\0${fields.actorId}\0${fields.issuedAt}\0${fields.name}`);
    const proof=createHmac('sha256',Buffer.from(key,'hex')).update(message,'utf8').digest('hex');
    expect(proof).not.toBe(createHmac('sha256',Buffer.from(key,'hex')).update(installationBackupApprovalMessage(fields),'utf8').digest('hex'));
    const reference=execFileSync('python3',['-I','-c','import hashlib,hmac,json,sys;f=json.loads(sys.argv[1]);m="servus-installation-backup-cancel-v1\\0%s\\0%s\\0%s\\0%s"%(f["operationId"],f["actorId"],f["issuedAt"],f["name"]);print(hmac.new(bytes.fromhex(sys.argv[2]),m.encode("utf8"),hashlib.sha256).hexdigest())',JSON.stringify(fields),key],{encoding:'utf8'}).trim();
    expect(proof).toBe(reference);expect(()=>signInstallationBackupCancellation(fields,'/tmp/servus-untrusted-api-role-key')).toThrow();
    const module=fileURLToPath(new URL('../../../updater/installation-backups.py',import.meta.url));
    const checked=execFileSync('python3',['-I','-c',
      'import json,runpy,sys;m=runpy.run_path(sys.argv[1]);r=json.loads(sys.argv[2]);m["verify_approval"](r,sys.argv[3],now_ms=r["issuedAt"],purpose="cancel")\ntry:m["verify_approval"](r,sys.argv[3],now_ms=r["issuedAt"])\nexcept m["BackupError"]:pass\nelse:raise AssertionError("Cancellation proof accepted for submission")\nr["proof"]=sys.argv[4]\ntry:m["verify_approval"](r,sys.argv[3],now_ms=r["issuedAt"],purpose="cancel")\nexcept m["BackupError"]:pass\nelse:raise AssertionError("Submission proof accepted for cancellation")\nprint("ok")',
      module,JSON.stringify({...fields,version:1,proof}),key,createHmac('sha256',Buffer.from(key,'hex')).update(installationBackupApprovalMessage(fields),'utf8').digest('hex')],{encoding:'utf8'}).trim();
    expect(checked).toBe('ok');
  });
  it('matches a fixed UTF-8 HMAC vector and the actual Python verifier', () => {
    const message = installationBackupApprovalMessage(fields);
    expect(message).toBe(`servus-installation-backup-v1\0${fields.operationId}\0${fields.actorId}\0${fields.issuedAt}\0${fields.name}`);
    const proof = createHmac('sha256', Buffer.from(key, 'hex')).update(message, 'utf8').digest('hex');
    expect(proof).toBe('5563ac1b367b8bb3785478fe412bdd5bd6ccc74419ce513bb2eaf390137d9abd');
    const module = fileURLToPath(new URL('../../../updater/installation-backups.py', import.meta.url));
    const output = execFileSync('python3', ['-I', '-c',
      'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); r=json.loads(sys.argv[2]); print(json.dumps(m["verify_approval"](r,sys.argv[3],now_ms=r["issuedAt"]),ensure_ascii=False))',
      module, JSON.stringify({...fields, version: 1, proof}), key], {encoding: 'utf8'});
    expect(JSON.parse(output)).toEqual(fields);
  });

  it('accepts Unicode code points consistently and rejects controls, surrogates and untrimmed names', () => {
    const input = {operationId: fields.operationId, name: '🚀'.repeat(100)};
    expect(installationBackupInputSchema.parse(input)).toEqual(input);
    for (const name of ['', ' ', ' a', 'a ', '\u0085a', 'a\u0085', 'a\n', '\u007f', '\ud800', '\udfff', '🚀'.repeat(101)])
      expect(installationBackupInputSchema.safeParse({...input, name}).success).toBe(false);
    for (const operationId of ['../backup', fields.actorId.replace('-4123-', '-1123-'), fields.operationId.toUpperCase()])
      expect(installationBackupInputSchema.safeParse({...input, operationId}).success).toBe(false);
    expect(installationBackupInputSchema.safeParse({...input, snapshotPath: '/root/snapshots'}).success).toBe(false);
  });

  it('refuses an untrusted key path without exposing its contents', () => {
    expect(() => signInstallationBackupApproval(fields, '/tmp/servus-untrusted-api-role-key')).toThrow();
    expect(() => installationBackupApprovalMessage({...fields, issuedAt: NaN})).toThrow();
    expect(() => installationBackupApprovalMessage({...fields, actorId: '../other-role'})).toThrow();
  });
});
