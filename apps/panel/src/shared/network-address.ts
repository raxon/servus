import { BlockList, isIP } from 'node:net';

const deniedV4 = new BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],
  ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) deniedV4.addSubnet(address,prefix,'ipv4');
const globalV6 = new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
const deniedV6 = new BlockList();
for (const [address,prefix] of [['2001::',32],['2001:db8::',32],['2002::',16]] as const) deniedV6.addSubnet(address,prefix,'ipv6');

export function isPrivateAddress(value: string): boolean {
  const family=isIP(value);
  return family===4 ? deniedV4.check(value,'ipv4') : family===6 ? !globalV6.check(value,'ipv6')||deniedV6.check(value,'ipv6') : true;
}
