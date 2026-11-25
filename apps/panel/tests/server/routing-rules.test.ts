import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeServiceInput, validateConfiguration } from '../../src/server/configuration.js';
import { Store } from '../../src/server/store.js';
import { compileDomainLabels, compileDomainRule } from '../../src/agent/route-labels.js';
import { redirectedRouteHostnames, routeHostnames } from '../../src/agent/runtime.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

const SERVICE_ID = '12345678-1234-4123-8123-123456789abc';
const BCRYPT_ENTRY = 'ops:$2y$10$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMN';

describe('Traefik routing rules and middleware configuration', () => {
  it('validates path prefixes, stripPrefix, IP allow-lists, htpasswd basic auth and redirects', () => {
    const normalized = normalizeServiceInput({
      name: 'gateway',
      image: 'nginx:alpine',
      domains: [
        {
          hostname: 'app.example.com',
          port: 3000,
          primary: true,
          https: true,
          pathPrefix: '/api/v1',
          stripPrefix: true,
          ipAllowList: ['203.0.113.0/24', '2001:db8::/32', '198.51.100.7'],
          basicAuth: { users: [BCRYPT_ENTRY] },
        },
        {
          hostname: 'app.example.com',
          port: 8080,
          pathPrefix: '/',
        },
        {
          hostname: 'old.example.com',
          port: 80,
          redirectTarget: 'https://app.example.com',
          redirectPermanent: true,
        },
      ],
    });
    expect(normalized.domains).toHaveLength(3);
  });

  it('rejects unsafe path prefixes, invalid CIDRs, plaintext basic auth and conflicting redirect rules', () => {
    expect(() => normalizeServiceInput({
      name: 'bad-path', image: 'nginx:alpine',
      domains: [{ hostname: 'a.example.com', port: 80, pathPrefix: '/api/../secret' }],
    })).toThrow();
    expect(() => normalizeServiceInput({
      name: 'bad-strip', image: 'nginx:alpine',
      domains: [{ hostname: 'a.example.com', port: 80, pathPrefix: '/', stripPrefix: true }],
    })).toThrow(/Strip prefix/);
    expect(() => normalizeServiceInput({
      name: 'bad-cidr', image: 'nginx:alpine',
      domains: [{ hostname: 'a.example.com', port: 80, ipAllowList: ['203.0.113.1/33'] }],
    })).toThrow();
    expect(() => normalizeServiceInput({
      name: 'plaintext-auth', image: 'nginx:alpine',
      domains: [{ hostname: 'a.example.com', port: 80, basicAuth: { users: ['admin:plaintextpassword'] } }],
    })).toThrow();
    expect(() => normalizeServiceInput({
      name: 'bad-redir-var', image: 'nginx:alpine',
      domains: [{ hostname: 'a.example.com', port: 80, redirectTarget: 'https://evil.example.com/$1' }],
    })).toThrow();
    expect(() => normalizeServiceInput({
      name: 'dup-route', image: 'nginx:alpine',
      domains: [
        { hostname: 'a.example.com', port: 80, pathPrefix: '/api' },
        { hostname: 'a.example.com', port: 81, pathPrefix: '/api' },
      ],
    })).toThrow(/Domain routes must be unique/);
    expect(() => validateConfiguration({
      domains: [{ hostname: 'a.example.com', port: 80, pathPrefix: '/api', stripPrefix: true, redirectTarget: 'https://b.example.com' }],
    })).toThrow(/cannot be combined/);
  });

  it('compiles deterministic Traefik rules, priority ordering and middleware chains', () => {
    const apiLabels = compileDomainLabels(SERVICE_ID, 0, {
      hostname: 'app.example.com',
      port: 4000,
      https: true,
      redirectHttps: true,
      pathPrefix: '/api/v1',
      stripPrefix: true,
      ipAllowList: ['203.0.113.0/24', '198.51.100.4'],
      basicAuth: { users: [BCRYPT_ENTRY] },
    });
    const shortLabels = compileDomainLabels(SERVICE_ID, 1, {
      hostname: 'app.example.com',
      port: 3000,
      pathPrefix: '/a',
    });
    const redirectLabels = compileDomainLabels(SERVICE_ID, 2, {
      hostname: 'legacy.example.com',
      port: 80,
      redirectTarget: 'https://app.example.com/',
      redirectPermanent: false,
    });

    const key = SERVICE_ID.replaceAll('-', '');
    expect(compileDomainRule({ hostname: 'app.example.com', pathPrefix: '/api/v1' }))
      .toBe('Host(`app.example.com`) && PathPrefix(`/api/v1`)');
    expect(Number(apiLabels[`traefik.http.routers.${key}-0.priority`]))
      .toBeGreaterThan(Number(shortLabels[`traefik.http.routers.${key}-1.priority`]));
    expect(apiLabels[`traefik.http.routers.${key}-0-https.rule`])
      .toBe('Host(`app.example.com`) && PathPrefix(`/api/v1`)');
    expect(apiLabels[`traefik.http.routers.${key}-0-https.middlewares`])
      .toBe(`${key}-0-ipallow,${key}-0-basicauth,${key}-0-strip`);
    // HTTP router uses HTTPS redirect middleware cleanly when redirectHttps is enabled
    expect(apiLabels[`traefik.http.routers.${key}-0.middlewares`])
      .toBe(`${key}-0-redirect`);
    expect(apiLabels[`traefik.http.middlewares.${key}-0-ipallow.ipallowlist.sourcerange`])
      .toBe('203.0.113.0/24,198.51.100.4');
    expect(apiLabels[`traefik.http.middlewares.${key}-0-strip.stripprefix.prefixes`]).toBe('/api/v1');
    expect(redirectLabels[`traefik.http.middlewares.${key}-2-redir.redirectregex.replacement`])
      .toBe('https://app.example.com$1');
    expect(redirectLabels[`traefik.http.middlewares.${key}-2-redir.redirectregex.permanent`]).toBe('false');

    // routeHostnames and redirectedRouteHostnames handle PathPrefix rules cleanly
    const combinedSpec = { Labels: { ...apiLabels, ...shortLabels, ...redirectLabels } };
    expect(routeHostnames(combinedSpec)).toEqual(['app.example.com', 'legacy.example.com']);
    expect([...redirectedRouteHostnames(combinedSpec)]).toEqual(['app.example.com']);
  });

  it('prevents cross-project hostname collision while permitting multiple paths on one service', () => {
    const dir = mkdtempSync(join(tmpdir(), 'servus-route-store-'));
    const store = new Store(dir);
    cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const admin = store.setup('admin@example.test', 'hash');
    const p1 = store.createProject('p1');
    const p2 = store.createProject('p2');
    store.createService(p1.id, normalizeServiceInput({
      name: 'multi-path',
      image: 'nginx:alpine',
      domains: [
        { hostname: 'shared.example.com', port: 3000, primary: true, pathPrefix: '/' },
        { hostname: 'shared.example.com', port: 4000, pathPrefix: '/api', stripPrefix: true },
      ],
    }), admin.id);

    expect(() => store.createService(p2.id, normalizeServiceInput({
      name: 'hijack',
      image: 'nginx:alpine',
      domains: [{ hostname: 'shared.example.com', port: 80, pathPrefix: '/other' }],
    }), admin.id)).toThrow(/already exists|reserved/i);
  });
});
