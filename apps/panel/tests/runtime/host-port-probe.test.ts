import { expect, it, vi } from 'vitest';
import type Docker from 'dockerode';
import { hostTcpPortAvailable, tcpPortListening } from '../../src/agent/host-port-probe.js';

const header='  sl  local_address rem_address   st tx_queue rx_queue';
const listening='  0: 00000000:01BB 00000000:0000 0A 00000000:00000000';
const connected='  1: 0100007F:0050 0100007F:1234 01 00000000:00000000';
it('detects listening IPv4 and IPv6 sockets without confusing established connections',()=>{
  expect(tcpPortListening(`${header}\n${listening}\n${connected}`,443)).toBe(true);
  expect(tcpPortListening(`${header}\n${listening}\n${connected}`,80)).toBe(false);
  expect(tcpPortListening(`${header}\n  0: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A`,443)).toBe(true);
  expect(()=>tcpPortListening('not a socket table',443)).toThrow();
  expect(()=>tcpPortListening(`${header}\ncorrupt`,443)).toThrow();
});
it('runs a restricted host-network helper and fails closed on unknown results',async()=>{
  const helper={start:vi.fn(async()=>{}),wait:vi.fn(async()=>({StatusCode:0})),remove:vi.fn(async()=>{})};
  const docker={createContainer:vi.fn(async()=>helper)} as unknown as Docker;
  const image='sha256:'+'a'.repeat(64);
  expect(await hostTcpPortAvailable(docker,image,443)).toBe(true);
  expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({Image:image,User:'65534:65534',HostConfig:expect.objectContaining({NetworkMode:'host',ReadonlyRootfs:true,CapDrop:['ALL']})}));
  helper.wait.mockResolvedValueOnce({StatusCode:42});expect(await hostTcpPortAvailable(docker,image,443)).toBe(false);
  helper.wait.mockResolvedValueOnce({StatusCode:43});await expect(hostTcpPortAvailable(docker,image,443)).rejects.toThrow();
  expect(helper.remove).toHaveBeenCalledTimes(3);
});
