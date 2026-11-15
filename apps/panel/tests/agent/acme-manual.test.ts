import { expect, it } from 'vitest';
import { ManualDns01Provider } from '../../src/agent/acme/manual.js';

it('requires the operator to add and remove the exact TXT value', async () => {
  const provider = new ManualDns01Provider();
  const challenge = {operationId:'a'.repeat(32),identifier:'*.Example.com',value:Buffer.alloc(32,7).toString('base64url')};
  const result = await provider.present(challenge);
  expect(result).toEqual({status:'manual_action_required',record:{operationId:challenge.operationId,name:'_acme-challenge.example.com',value:challenge.value}});
  await expect(provider.remove(result.record)).resolves.toEqual({status:'manual_action_required'});
  await expect(provider.remove({...result.record,name:'_acme-challenge.example.com.'})).rejects.toMatchObject({code:'invalid_input'});
});
