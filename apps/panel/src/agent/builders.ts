import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, closeSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import * as tar from 'tar';
import type { SourceBuilder } from '../shared/types.js';

export type DetectedStack = 'node' | 'python' | 'go' | 'rust' | 'php' | 'static';

export interface GeneratedBuildPlan {
  builder: Exclude<SourceBuilder, 'dockerfile'>;
  stack: DetectedStack;
  dockerfilePath: string;
  dockerfileContent: string;
  summary: string;
}

const MAX_UPLOAD_ENTRIES = 10_000;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function detectNodeDockerfile(contextDir: string, port: number): { content: string; summary: string } {
  const pkg = readJsonSafe(join(contextDir, 'package.json')) ?? {};
  const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, unknown>;
  const hasBuild = typeof scripts.build === 'string' && scripts.build.trim().length > 0;
  const hasStart = typeof scripts.start === 'string' && scripts.start.trim().length > 0;
  const mainEntry = typeof pkg.main === 'string' && pkg.main.trim() ? pkg.main.trim() : 'index.js';

  const hasBun = existsSync(join(contextDir, 'bun.lockb')) || existsSync(join(contextDir, 'bun.lock'));
  const hasPnpm = existsSync(join(contextDir, 'pnpm-lock.yaml'));
  const hasYarn = existsSync(join(contextDir, 'yarn.lock'));

  if (hasBun) {
    const startCmd = hasStart ? '["bun", "run", "start"]' : `["bun", "${mainEntry.replace(/"/g, '')}"]`;
    return {
      summary: `Bun application (${hasBuild ? 'with build step' : 'direct run'})`,
      content: [
        'FROM oven/bun:1-alpine',
        'WORKDIR /app',
        'COPY package.json bun.lock* ./',
        'RUN bun install --frozen-lockfile || bun install',
        'COPY . .',
        ...(hasBuild ? ['RUN bun run build'] : []),
        `ENV PORT=${port} HOST=0.0.0.0`,
        `EXPOSE ${port}`,
        `CMD ${startCmd}`,
      ].join('\n') + '\n',
    };
  }

  const installLines = hasPnpm
    ? ['RUN corepack enable', 'COPY package.json pnpm-lock.yaml ./', 'RUN pnpm install --frozen-lockfile || pnpm install']
    : hasYarn
      ? ['RUN corepack enable', 'COPY package.json yarn.lock ./', 'RUN yarn install --frozen-lockfile || yarn install']
      : ['COPY package.json package-lock.json* ./', 'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi'];

  const runPrefix = hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : 'npm';
  const buildLines = hasBuild ? [`RUN ${runPrefix} run build`] : [];

  // Static Vite / SPA projects with a build script and no start script can be served by nginx if dist/ is produced.
  const hasVite = existsSync(join(contextDir, 'vite.config.ts')) || existsSync(join(contextDir, 'vite.config.js')) || existsSync(join(contextDir, 'vite.config.mjs'));
  if (hasBuild && !hasStart && hasVite) {
    return {
      summary: `Node.js (${runPrefix}) static Vite build served with nginx`,
      content: [
        'FROM node:22-alpine AS builder',
        'WORKDIR /app',
        ...installLines,
        'COPY . .',
        ...buildLines,
        'FROM nginx:alpine',
        'COPY --from=builder /app/dist /usr/share/nginx/html',
        'RUN printf "server { listen 80; root /usr/share/nginx/html; index index.html; location / { try_files \\$uri \\$uri/ /index.html; } }\\n" > /etc/nginx/conf.d/default.conf',
        'EXPOSE 80',
      ].join('\n') + '\n',
    };
  }

  const startCmd = hasStart
    ? `["${runPrefix}", "run", "start"]`
    : `["node", "${mainEntry.replace(/"/g, '')}"]`;

  return {
    summary: `Node.js (${runPrefix}${hasBuild ? ', build + start' : ''})`,
    content: [
      'FROM node:22-alpine',
      'WORKDIR /app',
      ...installLines,
      'COPY . .',
      ...buildLines,
      `ENV NODE_ENV=production PORT=${port} HOST=0.0.0.0`,
      `EXPOSE ${port}`,
      `CMD ${startCmd}`,
    ].join('\n') + '\n',
  };
}

function detectPythonDockerfile(contextDir: string, port: number): { content: string; summary: string } {
  const hasRequirements = existsSync(join(contextDir, 'requirements.txt'));
  const hasPyproject = existsSync(join(contextDir, 'pyproject.toml'));
  const reqText = hasRequirements ? readFileSync(join(contextDir, 'requirements.txt'), 'utf8').toLowerCase() : '';
  const pyText = hasPyproject ? readFileSync(join(contextDir, 'pyproject.toml'), 'utf8').toLowerCase() : '';
  const deps = `${reqText}\n${pyText}`;

  let cmd = `["python", "app.py"]`;
  if (deps.includes('uvicorn') || deps.includes('fastapi')) {
    const entry = existsSync(join(contextDir, 'main.py')) ? 'main:app' : 'app:app';
    cmd = `["uvicorn", "${entry}", "--host", "0.0.0.0", "--port", "${port}"]`;
  } else if (deps.includes('gunicorn')) {
    const entry = existsSync(join(contextDir, 'wsgi.py')) ? 'wsgi:app' : existsSync(join(contextDir, 'main.py')) ? 'main:app' : 'app:app';
    cmd = `["gunicorn", "--bind", "0.0.0.0:${port}", "${entry}"]`;
  } else if (existsSync(join(contextDir, 'main.py'))) {
    cmd = '["python", "main.py"]';
  } else if (existsSync(join(contextDir, 'server.py'))) {
    cmd = '["python", "server.py"]';
  }

  const installLines = hasRequirements
    ? ['COPY requirements.txt ./', 'RUN pip install --no-cache-dir -r requirements.txt']
    : hasPyproject
      ? ['COPY pyproject.toml ./', 'RUN pip install --no-cache-dir .']
      : [];

  return {
    summary: 'Python 3.12 application',
    content: [
      'FROM python:3.12-slim',
      'WORKDIR /app',
      'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1',
      ...installLines,
      'COPY . .',
      `ENV PORT=${port}`,
      `EXPOSE ${port}`,
      `CMD ${cmd}`,
    ].join('\n') + '\n',
  };
}

function detectGoDockerfile(port: number): { content: string; summary: string } {
  return {
    summary: 'Go multi-stage static binary',
    content: [
      'FROM golang:1.23-alpine AS builder',
      'WORKDIR /app',
      'COPY go.mod go.sum* ./',
      'RUN go mod download',
      'COPY . .',
      'RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .',
      'FROM alpine:3.21',
      'WORKDIR /app',
      'RUN apk add --no-cache ca-certificates',
      'COPY --from=builder /app/server /app/server',
      `ENV PORT=${port}`,
      `EXPOSE ${port}`,
      'CMD ["/app/server"]',
    ].join('\n') + '\n',
  };
}

function detectRustDockerfile(port: number): { content: string; summary: string } {
  return {
    summary: 'Rust multi-stage release binary',
    content: [
      'FROM rust:1.83-alpine AS builder',
      'RUN apk add --no-cache musl-dev',
      'WORKDIR /app',
      'COPY . .',
      'RUN cargo build --release && cp "$(find target/release -maxdepth 1 -type f -executable | head -n 1)" /app/server',
      'FROM alpine:3.21',
      'WORKDIR /app',
      'RUN apk add --no-cache ca-certificates',
      'COPY --from=builder /app/server /app/server',
      `ENV PORT=${port}`,
      `EXPOSE ${port}`,
      'CMD ["/app/server"]',
    ].join('\n') + '\n',
  };
}

function detectPhpDockerfile(contextDir: string): { content: string; summary: string } {
  const hasComposer = existsSync(join(contextDir, 'composer.json'));
  const hasPublic = existsSync(join(contextDir, 'public')) && statSync(join(contextDir, 'public')).isDirectory();
  return {
    summary: `PHP 8.3 Apache application${hasComposer ? ' (Composer)' : ''}`,
    content: [
      'FROM php:8.3-apache',
      'WORKDIR /var/www/html',
      'RUN a2enmod rewrite',
      ...(hasPublic ? ['RUN sed -ri -e "s!/var/www/html!/var/www/html/public!g" /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf'] : []),
      'COPY . .',
      ...(hasComposer ? ['COPY --from=composer:2 /usr/bin/composer /usr/bin/composer', 'RUN composer install --no-dev --optimize-autoloader --no-interaction'] : []),
      'EXPOSE 80',
    ].join('\n') + '\n',
  };
}

function detectStaticDockerfile(): { content: string; summary: string } {
  return {
    summary: 'Static HTML/CSS/JS site (nginx)',
    content: [
      'FROM nginx:alpine',
      'COPY . /usr/share/nginx/html',
      'RUN printf "server { listen 80; root /usr/share/nginx/html; index index.html; location / { try_files \\$uri \\$uri/ /index.html; } }\\n" > /etc/nginx/conf.d/default.conf',
      'EXPOSE 80',
    ].join('\n') + '\n',
  };
}

/**
 * Detect application runtime stack and synthesize a clean Dockerfile for
 * auto / railpack / nixpacks / buildpacks builder modes.
 */
export function generateBuilderDockerfile(
  contextDir: string,
  workspaceDir: string,
  builder: Exclude<SourceBuilder, 'dockerfile'>,
  port = 80,
): GeneratedBuildPlan {
  let stack: DetectedStack;
  let generated: { content: string; summary: string };

  if (existsSync(join(contextDir, 'package.json'))) {
    stack = 'node';
    generated = detectNodeDockerfile(contextDir, port);
  } else if (
    existsSync(join(contextDir, 'requirements.txt')) ||
    existsSync(join(contextDir, 'pyproject.toml')) ||
    existsSync(join(contextDir, 'Pipfile'))
  ) {
    stack = 'python';
    generated = detectPythonDockerfile(contextDir, port);
  } else if (existsSync(join(contextDir, 'go.mod'))) {
    stack = 'go';
    generated = detectGoDockerfile(port);
  } else if (existsSync(join(contextDir, 'Cargo.toml'))) {
    stack = 'rust';
    generated = detectRustDockerfile(port);
  } else if (existsSync(join(contextDir, 'composer.json')) || existsSync(join(contextDir, 'index.php'))) {
    stack = 'php';
    generated = detectPhpDockerfile(contextDir);
  } else if (existsSync(join(contextDir, 'index.html'))) {
    stack = 'static';
    generated = detectStaticDockerfile();
  } else {
    throw new Error(
      `Could not detect a supported application runtime for ${builder} builder. Add a Dockerfile or include package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, composer.json, index.php or index.html.`,
    );
  }

  const header = `# Generated by Servus (${builder} builder profile, detected stack: ${stack})\n`;
  const content = `${header}${generated.content}`;
  const dockerfilePath = join(workspaceDir, `Dockerfile.servus-${builder}`);
  writeFileSync(dockerfilePath, content, { mode: 0o600 });

  return {
    builder,
    stack,
    dockerfilePath,
    dockerfileContent: content,
    summary: generated.summary,
  };
}

export function hasGzipMagicBytes(filePath: string): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(2);
    const bytes = readSync(fd, header, 0, 2, 0);
    return bytes === 2 && header[0] === 0x1f && header[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

/**
 * Safely extract a gzipped tar archive into destination directory, rejecting
 * path traversal, symlinks/hardlinks, device files and zip-bomb sizes.
 * If the archive wraps everything in a single top-level folder, unwrap it.
 */
export async function extractSourceArchive(archivePath: string, destinationDir: string): Promise<void> {
  if (!existsSync(archivePath) || !hasGzipMagicBytes(archivePath)) {
    throw new Error('Uploaded source archive is missing or not a valid .tar.gz file.');
  }
  const staging = join(destinationDir, '__extract');
  mkdirSync(staging, { recursive: true, mode: 0o700 });

  let entries = 0;
  let totalBytes = 0;
  let unsafeError: Error | undefined;

  await tar.list({
    file: archivePath,
    onReadEntry: (entry) => {
      if (unsafeError) return;
      entries++;
      if (entries > MAX_UPLOAD_ENTRIES) {
        unsafeError = new Error(`Uploaded archive exceeds the maximum of ${MAX_UPLOAD_ENTRIES} entries.`);
        return;
      }
      const rawPath = entry.path;
      const cleaned = normalize(rawPath).replace(/\\/g, '/');
      if (
        !rawPath ||
        rawPath.includes('\0') ||
        isAbsolute(rawPath) ||
        cleaned.startsWith('/') ||
        cleaned === '..' ||
        cleaned.startsWith('../') ||
        cleaned.split('/').includes('..')
      ) {
        unsafeError = new Error('Uploaded archive contains an unsafe path.');
        return;
      }
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        unsafeError = new Error(`Uploaded archive contains an unsupported entry type (${entry.type}).`);
        return;
      }
      totalBytes += entry.size ?? 0;
      if (totalBytes > MAX_EXTRACTED_BYTES) {
        unsafeError = new Error('Uploaded archive exceeds the 256 MiB extracted size limit.');
      }
    },
  });

  if (unsafeError) throw unsafeError;
  if (entries === 0) throw new Error('Uploaded source archive is empty.');

  await tar.extract({
    file: archivePath,
    cwd: staging,
    strict: true,
    preserveOwner: false,
    filter: (_path, entry) => {
      const kind = 'type' in entry ? entry.type : '';
      return kind === 'File' || kind === 'Directory';
    },
  });

  // Unwrap single top-level directory if present (like GitHub/git archive tarballs)
  const topLevel = readdirSync(staging).filter((name) => name !== '__MACOSX');
  const sourceRoot =
    topLevel.length === 1 && statSync(join(staging, topLevel[0]!)).isDirectory()
      ? join(staging, topLevel[0]!)
      : staging;

  for (const name of readdirSync(sourceRoot)) {
    const src = join(sourceRoot, name);
    const dst = join(destinationDir, name);
    const rel = relative(resolve(destinationDir), resolve(dst));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Uploaded archive contains an unsafe destination path.');
    }
    renameSync(src, dst);
  }
}
