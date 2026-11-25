import type { DomainConfig } from '../shared/types.js';
import { httpsRedirectLabels, httpsRouteLabels } from './https-routing.js';

export function compileDomainRule(domain: Pick<DomainConfig, 'hostname' | 'pathPrefix'>): string {
  if (domain.pathPrefix && domain.pathPrefix !== '/') {
    return `Host(\`${domain.hostname}\`) && PathPrefix(\`${domain.pathPrefix}\`)`;
  }
  return `Host(\`${domain.hostname}\`)`;
}

/**
 * Compile deterministic Traefik Swarm labels for one domain route, including
 * optional path-prefix priority, strip-prefix, IP allow-list, basic auth,
 * redirect target and managed HTTPS routing.
 */
export function compileDomainLabels(
  serviceId: string,
  index: number,
  domain: DomainConfig,
  centralCertificate = false,
): Record<string, string> {
  const key = serviceId.replaceAll('-', '');
  const route = `${key}-${index}`;
  const hasPath = Boolean(domain.pathPrefix && domain.pathPrefix !== '/');
  const labels: Record<string, string> = {
    'traefik.enable': 'true',
    [`traefik.http.routers.${route}.rule`]: compileDomainRule(domain),
    [`traefik.http.routers.${route}.entrypoints`]: 'web',
    [`traefik.http.routers.${route}.service`]: route,
    [`traefik.http.services.${route}.loadbalancer.server.port`]: String(domain.port),
  };
  if (hasPath) {
    labels[`traefik.http.routers.${route}.priority`] = String(1000 + domain.pathPrefix!.length);
  }

  const routeMiddlewares: string[] = [];
  if (domain.ipAllowList?.length) {
    const mw = `${route}-ipallow`;
    labels[`traefik.http.middlewares.${mw}.ipallowlist.sourcerange`] = domain.ipAllowList.join(',');
    if (domain.trustedProxies?.depth !== undefined) {
      labels[`traefik.http.middlewares.${mw}.ipallowlist.ipstrategy.depth`] = String(domain.trustedProxies.depth);
    } else if (domain.trustedProxies?.excludedIps?.length) {
      labels[`traefik.http.middlewares.${mw}.ipallowlist.ipstrategy.excludedips`] = domain.trustedProxies.excludedIps.join(',');
    }
    routeMiddlewares.push(mw);
  }
  if (domain.basicAuth?.users.length) {
    const mw = `${route}-basicauth`;
    labels[`traefik.http.middlewares.${mw}.basicauth.users`] = domain.basicAuth.users.join(',');
    routeMiddlewares.push(mw);
  }
  if (domain.redirectTarget) {
    const mw = `${route}-redir`;
    const normalized = domain.redirectTarget.replace(/\/+$/, '');
    labels[`traefik.http.middlewares.${mw}.redirectregex.regex`] = '^https?://[^/]+(.*)';
    labels[`traefik.http.middlewares.${mw}.redirectregex.replacement`] = `${normalized}$1`;
    labels[`traefik.http.middlewares.${mw}.redirectregex.permanent`] = String(domain.redirectPermanent ?? true);
    routeMiddlewares.push(mw);
  } else if (domain.stripPrefix && hasPath) {
    const mw = `${route}-strip`;
    labels[`traefik.http.middlewares.${mw}.stripprefix.prefixes`] = domain.pathPrefix!;
    routeMiddlewares.push(mw);
  }

  if (domain.https) {
    Object.assign(labels, httpsRouteLabels(serviceId, index, domain.hostname, domain.port, centralCertificate, domain.pathPrefix));
    if (routeMiddlewares.length) {
      labels[`traefik.http.routers.${route}-https.middlewares`] = routeMiddlewares.join(',');
    }
  }
  if (domain.redirectHttps) {
    Object.assign(labels, httpsRedirectLabels(serviceId, index, domain.hostname, domain.port));
  } else if (routeMiddlewares.length) {
    labels[`traefik.http.routers.${route}.middlewares`] = routeMiddlewares.join(',');
  }
  return labels;
}
