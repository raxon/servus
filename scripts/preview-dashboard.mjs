import { createDashboardPreviewServer } from '../tests/dashboard/fixture.mjs';

const server = await createDashboardPreviewServer({ port: 4183, banner: true });
console.log('Dashboard preview: http://127.0.0.1:4183 (sample data, read-only)');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
