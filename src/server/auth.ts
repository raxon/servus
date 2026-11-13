import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, value] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !value) return false;
  const key = await derive(password, salt, 64) as Buffer;
  const expected = Buffer.from(value,'hex');
  return key.length === expected.length && timingSafeEqual(key,expected);
}
