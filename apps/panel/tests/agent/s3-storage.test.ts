import { afterEach, expect, it, vi } from 'vitest';
import { validateBackupEndpoint } from '../../src/agent/s3-storage.js';
import type { S3Destination } from '../../src/shared/storage-target.js';
const destination:S3Destination={type:'s3',provider:'s3',endpoint:'https://127.0.0.1',region:'us-east-1',bucket:'backup-fixture',prefix:'backups',storageClass:'STANDARD',accessKeyId:'fixture',secretAccessKey:'fixture'};
afterEach(()=>vi.unstubAllEnvs());
it('rejects local, metadata, plain HTTP, userinfo, path, query and fragment endpoints',async()=>{
  for(const endpoint of ['https://127.0.0.1','https://169.254.169.254','https://10.0.0.1','https://[::1]','http://s3.amazonaws.com','https://username:secret@s3.amazonaws.com','https://s3.amazonaws.com/bucket','https://s3.amazonaws.com?secret=token','https://s3.amazonaws.com#fragment'])await expect(validateBackupEndpoint({...destination,endpoint})).rejects.toThrow();
});
it('permits only an exact explicitly configured loopback fixture origin',async()=>{
  vi.stubEnv('PANEL_BACKUP_TEST_ENDPOINTS','http://127.0.0.1:19000');
  expect((await validateBackupEndpoint({...destination,endpoint:'http://127.0.0.1:19000'})).addresses).toEqual([{address:'127.0.0.1',family:4}]);
  await expect(validateBackupEndpoint({...destination,endpoint:'http://127.0.0.1:19001'})).rejects.toThrow();
});
it('requires the actual account endpoint and supported storage class for R2',async()=>{
  await expect(validateBackupEndpoint({...destination,provider:'r2',endpoint:'https://example.com'})).rejects.toThrow('R2 account endpoint');
  await expect(validateBackupEndpoint({...destination,provider:'r2',endpoint:`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,storageClass:'GLACIER_IR'})).rejects.toThrow('STANDARD');
});
