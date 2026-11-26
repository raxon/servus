import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Readable } from 'node:stream';
import { Client as SshClient, type SFTPWrapper } from 'ssh2';
import { isPrivateAddress } from '../shared/network-address.js';
import type {
  DropboxDestination,
  FtpDestination,
  GdriveDestination,
  RemoteBackupDestination,
  SftpDestination,
} from '../shared/storage-target.js';

export async function validateRemoteBackupHost(host: string): Promise<void> {
  const clean = host.trim().toLowerCase();
  if (!clean || clean === 'localhost' || clean.endsWith('.localhost') || clean === 'metadata.google.internal') {
    throw new Error('Remote backup storage must target a public address.');
  }
  const allowed = (process.env.PANEL_BACKUP_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(clean)) return;
  const literal = isIP(clean);
  if (literal) {
    if (isPrivateAddress(clean)) throw new Error('Remote backup storage cannot target private network addresses.');
    return;
  }
  const records = await lookup(clean, { all: true });
  if (!records.length || records.some((r) => isPrivateAddress(r.address))) {
    throw new Error('Remote backup storage host resolved to a private network address.');
  }
}

export async function validateRemoteDestination(dest: Exclude<RemoteBackupDestination, { type: 's3' }>): Promise<void> {
  if (dest.type === 'sftp' || dest.type === 'ftp') {
    await validateRemoteBackupHost(dest.host);
  }
}

async function readStreamToBuffer(input: Readable, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error('Backup stream exceeds transfer limit.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// --- SFTP (via ssh2) ---
async function withSftp<T>(dest: SftpDestination, task: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  await validateRemoteBackupHost(dest.host);
  return new Promise<T>((resolve, reject) => {
    const conn = new SshClient();
    let settled = false;
    const done = (err?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      conn.end();
      if (err) reject(err);
      else resolve(value as T);
    };
    conn.on('error', (err) => done(err));
    conn.on('ready', () => {
      conn.sftp(async (err, sftp) => {
        if (err) return done(err);
        try {
          const result = await task(sftp);
          done(undefined, result);
        } catch (taskErr) {
          done(taskErr instanceof Error ? taskErr : new Error(String(taskErr)));
        }
      });
    });
    conn.connect({
      host: dest.host,
      port: dest.port,
      username: dest.username,
      ...(dest.password ? { password: dest.password } : {}),
      ...(dest.privateKey ? { privateKey: dest.privateKey } : {}),
      readyTimeout: 15_000,
    });
  });
}

function remoteJoin(prefix: string, key: string): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  const cleanKey = key.replace(/^\/+/, '');
  return cleanPrefix ? `${cleanPrefix}/${cleanKey}` : cleanKey;
}

async function sftpMkdirP(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  const parts = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    await new Promise<void>((resolve) => {
      sftp.mkdir(current, () => resolve());
    });
  }
}

export async function sftpUpload(dest: SftpDestination, objectKey: string, input: Readable): Promise<void> {
  const data = await readStreamToBuffer(input);
  const fullPath = remoteJoin(dest.path, objectKey);
  const dir = fullPath.split('/').slice(0, -1).join('/');
  await withSftp(dest, async (sftp) => {
    if (dir) await sftpMkdirP(sftp, dir);
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(fullPath, { mode: 0o600 });
      ws.once('error', reject);
      ws.once('close', () => resolve());
      ws.end(data);
    });
  });
}

export async function sftpDownload(dest: SftpDestination, objectKey: string): Promise<Buffer> {
  const fullPath = remoteJoin(dest.path, objectKey);
  return withSftp(dest, async (sftp) => {
    return new Promise<Buffer>((resolve, reject) => {
      const rs = sftp.createReadStream(fullPath);
      const chunks: Buffer[] = [];
      rs.on('data', (c: Buffer) => chunks.push(c));
      rs.once('error', reject);
      rs.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

export async function sftpDelete(dest: SftpDestination, objectKey: string): Promise<void> {
  const fullPath = remoteJoin(dest.path, objectKey);
  await withSftp(dest, async (sftp) => {
    await new Promise<void>((resolve) => sftp.unlink(fullPath, () => resolve()));
  });
}

// --- FTP / FTPS (minimal RFC 959 / 4217 PASV client over Node net/tls) ---
async function ftpExchange(dest: FtpDestination, action: 'put' | 'get' | 'delete', objectKey: string, payload?: Buffer): Promise<Buffer | void> {
  await validateRemoteBackupHost(dest.host);
  const socket: Socket = dest.tls
    ? tlsConnect({ host: dest.host, port: dest.port, servername: dest.host, timeout: 15_000 })
    : netConnect({ host: dest.host, port: dest.port, timeout: 15_000 });

  let buf = '';
  const readResp = (): Promise<{ code: number; text: string }> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error) => { socket.off('data', onData); reject(err); };
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        for (let i = 0; i < lines.length - 1; i++) {
          const m = /^(\d{3}) (.*)$/.exec(lines[i]!);
          if (m) {
            buf = lines.slice(i + 1).join('\n');
            socket.off('data', onData);
            socket.off('error', onError);
            resolve({ code: Number(m[1]), text: m[2]! });
            return;
          }
        }
      };
      socket.on('data', onData);
      socket.once('error', onError);
    });

  const cmd = async (line: string) => {
    socket.write(`${line}\r\n`);
    return readResp();
  };

  try {
    const greet = await readResp();
    if (greet.code >= 400) throw new Error(`FTP greeting failed (${greet.code})`);
    const userRes = await cmd(`USER ${dest.username}`);
    if (userRes.code >= 400) throw new Error(`FTP USER rejected (${userRes.code})`);
    const passRes = await cmd(`PASS ${dest.password}`);
    if (passRes.code >= 400) throw new Error(`FTP authentication failed (${passRes.code})`);
    await cmd('TYPE I');
    if (dest.tls) {
      await cmd('PBSZ 0');
      await cmd('PROT P');
    }
    const targetPath = remoteJoin(dest.path, objectKey);
    if (action === 'delete') {
      await cmd(`DELE ${targetPath}`);
      await cmd('QUIT');
      return;
    }
    const pasv = await cmd('PASV');
    const match = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv.text);
    if (!match) throw new Error('FTP server did not return a valid PASV endpoint.');
    const dataPort = Number(match[5]) * 256 + Number(match[6]);
    const dataSocket: Socket = dest.tls
      ? tlsConnect({ host: dest.host, port: dataPort, servername: dest.host, timeout: 15_000 })
      : netConnect({ host: dest.host, port: dataPort, timeout: 15_000 });

    if (action === 'put') {
      const dir = targetPath.split('/').slice(0, -1).join('/');
      if (dir) await cmd(`MKD ${dir}`);
      const stor = await cmd(`STOR ${targetPath}`);
      if (stor.code >= 400) { dataSocket.destroy(); throw new Error(`FTP STOR rejected (${stor.code})`); }
      await new Promise<void>((resolve, reject) => {
        dataSocket.once('error', reject);
        dataSocket.end(payload ?? Buffer.alloc(0), () => resolve());
      });
      await readResp();
      await cmd('QUIT');
      return;
    }

    const retr = await cmd(`RETR ${targetPath}`);
    if (retr.code >= 400) { dataSocket.destroy(); throw new Error(`FTP RETR rejected (${retr.code})`); }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      dataSocket.on('data', (c: Buffer) => chunks.push(c));
      dataSocket.once('error', reject);
      dataSocket.once('end', () => resolve());
    });
    await readResp();
    await cmd('QUIT');
    return Buffer.concat(chunks);
  } finally {
    socket.destroy();
  }
}

// --- Google Drive API v3 ---
async function gdriveToken(dest: GdriveDestination): Promise<string> {
  if (dest.accessToken) return dest.accessToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: dest.refreshToken!,
      client_id: dest.clientId!,
      client_secret: dest.clientSecret!,
    }),
  });
  if (!res.ok) throw new Error(`Google Drive OAuth token refresh failed (${res.status})`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Google Drive OAuth response missing access_token');
  return data.access_token;
}

export async function gdriveUpload(dest: GdriveDestination, filename: string, input: Readable): Promise<string> {
  const token = await gdriveToken(dest);
  const data = await readStreamToBuffer(input);
  const boundary = `servus_${Date.now().toString(16)}`;
  const meta = JSON.stringify({ name: filename, parents: [dest.folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Google Drive upload failed (${res.status})`);
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error('Google Drive upload returned no file ID');
  return json.id;
}

export async function gdriveDownload(dest: GdriveDestination, fileId: string): Promise<Buffer> {
  const token = await gdriveToken(dest);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Google Drive download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function gdriveDelete(dest: GdriveDestination, fileId: string): Promise<void> {
  const token = await gdriveToken(dest);
  await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
}

// --- Dropbox API v2 ---
async function dropboxToken(dest: DropboxDestination): Promise<string> {
  if (dest.accessToken) return dest.accessToken;
  const basic = Buffer.from(`${dest.appKey}:${dest.appSecret}`).toString('base64');
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: dest.refreshToken! }),
  });
  if (!res.ok) throw new Error(`Dropbox OAuth token refresh failed (${res.status})`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Dropbox OAuth response missing access_token');
  return data.access_token;
}

export async function dropboxUpload(dest: DropboxDestination, objectKey: string, input: Readable): Promise<string> {
  const token = await dropboxToken(dest);
  const data = await readStreamToBuffer(input);
  const fullPath = `/${remoteJoin(dest.path, objectKey)}`;
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'dropbox-api-arg': JSON.stringify({ path: fullPath, mode: 'overwrite', autorename: false, mute: true }),
    },
    body: new Uint8Array(data),
  });
  if (!res.ok) throw new Error(`Dropbox upload failed (${res.status})`);
  return fullPath;
}

export async function dropboxDownload(dest: DropboxDestination, fullPath: string): Promise<Buffer> {
  const token = await dropboxToken(dest);
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'dropbox-api-arg': JSON.stringify({ path: fullPath }),
    },
  });
  if (!res.ok) throw new Error(`Dropbox download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function dropboxDelete(dest: DropboxDestination, fullPath: string): Promise<void> {
  const token = await dropboxToken(dest);
  await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: fullPath }),
  });
}

export async function ftpUpload(dest: FtpDestination, objectKey: string, input: Readable): Promise<void> {
  const data = await readStreamToBuffer(input);
  await ftpExchange(dest, 'put', objectKey, data);
}

export async function ftpDownload(dest: FtpDestination, objectKey: string): Promise<Buffer> {
  const result = await ftpExchange(dest, 'get', objectKey);
  if (!result) throw new Error('FTP download returned empty payload.');
  return result;
}

export async function ftpDelete(dest: FtpDestination, objectKey: string): Promise<void> {
  await ftpExchange(dest, 'delete', objectKey);
}
