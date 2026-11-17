import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Store } from './store.js';

const PAGE_SIZE = 50;
const MAX_PAGE = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const owner = z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/);
const repositoryName = z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/).refine(value => value !== '.' && value !== '..');
const branchName = z.string().min(1).max(255).regex(/^[^\x00-\x1f\x7f]+$/);
const query = z.object({ page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1) }).strict();
const repository = z.object({
  name: repositoryName, owner: z.object({ login: owner }), default_branch: branchName, private: z.boolean(),
});

export interface GithubRepository {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

interface GithubRepositoriesOptions {
  store: Store;
  administrator: (request: FastifyRequest) => unknown;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The shared GitHub token stays on the server and is sent only to GitHub's API. */
export function registerGithubRepositories(app: FastifyInstance, options: GithubRepositoriesOptions) {
  const fetchGithub = options.fetch ?? fetch;
  const rateLimit = { max: 30, timeWindow: '1 minute' };
  const connection = () => {
    const current = options.store.vault.githubConnection();
    if (!current) throw new AppError('GITHUB_NOT_CONNECTED', 'Configure the GitHub connection in Settings first', 409);
    return current;
  };

  async function read(request: FastifyRequest, path: string, page: number) {
    options.administrator(request);
    const selected = connection();
    const url = new URL(path, 'https://api.github.com');
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    if (path === '/user/repos') {
      url.searchParams.set('sort', 'pushed');
      url.searchParams.set('affiliation', 'owner,collaborator,organization_member');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
    timer.unref();
    try {
      const response = await fetchGithub(url, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json', authorization: `Bearer ${selected.token}`,
          'x-github-api-version': '2022-11-28', 'user-agent': 'Servus',
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new AppError('GITHUB_AUTHENTICATION_FAILED', 'GitHub rejected the saved access token. Update the connection in Settings.', 502);
        if (response.status === 403 || response.status === 429) throw new AppError('GITHUB_ACCESS_LIMITED', 'GitHub denied the request. Check token permissions and API rate limits.', 503);
        if (response.status === 404) throw new AppError('GITHUB_REPOSITORY_NOT_FOUND', 'The repository is unavailable to the saved GitHub connection', 404);
        throw new AppError('GITHUB_UNAVAILABLE', 'GitHub is temporarily unavailable', 503);
      }
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
        await response.body?.cancel();
        throw new AppError('GITHUB_RESPONSE_INVALID', 'GitHub returned an invalid response', 502);
      }
      if (!response.body) throw new AppError('GITHUB_RESPONSE_INVALID', 'GitHub returned an invalid response', 502);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new AppError('GITHUB_RESPONSE_INVALID', 'GitHub returned an invalid response', 502);
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      options.administrator(request);
      const current = connection();
      if (current.token !== selected.token || current.username !== selected.username)
        throw new AppError('GITHUB_CONNECTION_CHANGED', 'The GitHub connection changed. Reload the repository list.', 409);
      // Never follow a URL supplied through GitHub's pagination headers.
      const nextPage = page < MAX_PAGE && /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*(?:;|,|$))/.test(response.headers.get('link') ?? '') ? page + 1 : null;
      return { value, nextPage };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) throw new AppError('GITHUB_TIMEOUT', 'GitHub did not respond in time', 504);
      throw new AppError('GITHUB_UNAVAILABLE', 'Could not read the GitHub repository list', 503);
    } finally { clearTimeout(timer); }
  }

  app.get('/api/v1/integrations/github/repositories', { config: { rateLimit } }, async request => {
    options.administrator(request);
    const { page } = query.parse(request.query);
    const result = await read(request, '/user/repos', page);
    const parsed = z.array(repository).max(PAGE_SIZE).safeParse(result.value);
    if (!parsed.success) throw new AppError('GITHUB_RESPONSE_INVALID', 'GitHub returned an invalid repository list', 502);
    const repositories: GithubRepository[] = parsed.data.map(item => ({
      owner: item.owner.login, name: item.name, fullName: `${item.owner.login}/${item.name}`,
      defaultBranch: item.default_branch, private: item.private,
    }));
    return { repositories, page, nextPage: result.nextPage };
  });

  app.get('/api/v1/integrations/github/repositories/:owner/:repo/branches', { config: { rateLimit } }, async request => {
    options.administrator(request);
    const { page } = query.parse(request.query);
    const params = z.object({ owner, repo: repositoryName }).strict().parse(request.params);
    const result = await read(request, `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/branches`, page);
    const parsed = z.array(z.object({ name: branchName })).max(PAGE_SIZE).safeParse(result.value);
    if (!parsed.success) throw new AppError('GITHUB_RESPONSE_INVALID', 'GitHub returned an invalid branch list', 502);
    return { branches: parsed.data.map(item => item.name), page, nextPage: result.nextPage };
  });
}
