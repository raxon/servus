import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const at = '2026-11-16T08:00:00.000Z';
export function dashboardFixture() {
  const projects = [['production', 'Production'], ['staging', 'Staging'], ['internal', 'Internal tools']].map(([id, name]) => ({ id, name, description: '', serviceCount: id === 'production' ? 4 : id === 'staging' ? 3 : 2, canWrite: true, createdAt: at }));
  const services = [
    ['api', 'production', 'api', 'app', 'failed'],
    ['website', 'production', 'website', 'app', 'running'],
    ['postgres', 'production', 'postgres', 'postgres', 'running'],
    ['redis', 'production', 'redis', 'redis', 'running'],
    ['staging-api', 'staging', 'api-staging', 'app', 'deploying'],
    ['staging-db', 'staging', 'postgres-staging', 'postgres', 'running'],
    ['worker', 'staging', 'background-worker-staging', 'app', 'stopped'],
    ['docs', 'internal', 'documentation', 'app', 'running'],
    ['workflows', 'internal', 'automation-workflows', 'app', 'running'],
  ].map(([id, projectId, name, kind, state]) => ({ id, projectId, name, kind, state,
    image: kind === 'postgres' ? 'postgres:17' : kind === 'redis' ? 'redis:7' : 'nginx:alpine',
    port: kind === 'postgres' ? 5432 : kind === 'redis' ? 6379 : 80, hostname: '', domains: [], source: { type: 'image' },
    replicas: 1, revision: id === 'website' ? 3 : 2, deployedRevision: 2, environment: [], mounts: [], resources: { cpu: 1, memoryMb: 512 },
    createdAt: at, updatedAt: at, lastError: state === 'failed' ? 'Database connection refused. Container exited with code 1.' : null,
  }));
  return { projects, services, unavailableProject: null, member: false };
}

export async function createDashboardPreviewServer({ port = 0, fixture = dashboardFixture(), banner = false } = {}) {
  const root = fileURLToPath(new URL('../../apps/panel', import.meta.url));
  const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: port !== 0 }, plugins: [{
    name: 'read-only-dashboard-preview',
    transformIndexHtml() {
      return banner ? [{ tag: 'div', attrs: { role: 'note', style: 'position:fixed;bottom:10px;left:50%;translate:-50% 0;z-index:90;white-space:nowrap;background:#272c29;color:#fff;padding:7px 14px;border-radius:999px;font:11px system-ui;box-shadow:0 2px 12px #0002;pointer-events:none' }, children: 'Sample data · Read-only preview', injectTo: 'body' }] : [];
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        const send = (value, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
        if (req.method !== 'GET') return send({ error: { code: 'READ_ONLY_PREVIEW', message: 'This preview is read-only. No service changes were made.' } }, 403);
        const path = new URL(req.url, 'http://localhost').pathname.replace('/api/v1', '');
        if (path === '/auth/session') return send({ user: { id: 'preview', email: 'demo@example.test', role: fixture.member ? 'member' : 'admin', createdAt: at }, csrfToken: 'sample-data-preview' });
        if (path === '/projects') return send(fixture.projects);
        if (path === '/updates') return send({ applyAvailable: false });
        if (path === '/runtime') return send({ online: true, cpus: 4, memoryBytes: 8589934592, swarmState: 'active', ingressPort: 18080 });
        if (path === '/actions' || path.endsWith('/actions')) return send([]);
        const projectId = path.match(/^\/projects\/([^/]+)\/services$/)?.[1];
        if (projectId) return projectId === fixture.unavailableProject ? send({ error: { code: 'SAMPLE_UNAVAILABLE', message: 'Service data unavailable.' } }, 503) : send(fixture.services.filter(service => service.projectId === projectId));
        const match = path.match(/^\/services\/([^/]+)(.*)$/);
        if (match) {
          const service = fixture.services.find(item => item.id === match[1]);
          if (!service) return send({ error: { code: 'NOT_FOUND', message: 'Sample service not found.' } }, 404);
          if (!match[2]) return send(service);
          if (match[2] === '/logs') return send({ lines: service.state === 'failed' ? ['[08:00:01] Starting application', '[08:00:02] Database connection refused', '[08:00:02] Container exited with code 1'] : ['[08:00:01] Service ready'] });
          if (match[2] === '/metrics') return send({ cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 536870912, networkRxBytes: 0, networkTxBytes: 0, containers: service.state === 'running' ? 1 : 0 });
          if (match[2] === '/configuration-changes') return send({ status: 'available', sections: ['Environment'], deployedPrimaryDomain: null });
          if (match[2] === '/containers') return send([]);
        }
        return send({ error: { code: 'PREVIEW_UNAVAILABLE', message: 'This section is unavailable in the dashboard preview.' } }, 404);
      });
    },
  }] });
  await server.listen();
  return server;
}
