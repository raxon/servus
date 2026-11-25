import { useQuery } from '@tanstack/react-query';
import { HardDrive } from 'lucide-react';
import type { HostMetrics } from '../shared/types.js';
import { api } from './api.js';

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function HostMetricsCard() {
  const query = useQuery({
    queryKey: ['host-metrics'],
    queryFn: ({ signal }) => api<HostMetrics>('/host/metrics', { signal }),
    refetchInterval: 30_000,
    retry: false,
  });

  const data = query.data;
  if (!data || typeof data.memoryTotalBytes !== 'number' || typeof data.diskTotalBytes !== 'number') {
    return null;
  }

  const memoryPct = data.memoryTotalBytes > 0 ? Math.round((data.memoryUsedBytes / data.memoryTotalBytes) * 100) : 0;
  const diskPct = data.diskTotalBytes > 0 ? Math.round((data.diskUsedBytes / data.diskTotalBytes) * 100) : 0;

  return (
    <section className="surface details-card" aria-label="Host resources">
      <div className="card-heading">
        <HardDrive size={19} />
        <h3>Host resources</h3>
      </div>
      <div className="detail-row">
        <span>CPU load (1 / 5 / 15m)</span>
        <strong className="mono">
          {[data.loadAverage1m, data.loadAverage5m, data.loadAverage15m].map((v) => v.toFixed(2)).join(' / ')} ({data.cpuCount} cores)
        </strong>
      </div>
      <div className="detail-row">
        <span>Memory used</span>
        <strong className="mono">
          {formatGiB(data.memoryUsedBytes)} / {formatGiB(data.memoryTotalBytes)} ({memoryPct}%)
        </strong>
      </div>
      <div className="detail-row">
        <span>Data disk used</span>
        <strong className="mono">
          {formatGiB(data.diskUsedBytes)} / {formatGiB(data.diskTotalBytes)} ({diskPct}%)
        </strong>
      </div>
      <div className="detail-row">
        <span>Disk available</span>
        <strong className="mono">{formatGiB(data.diskAvailableBytes)}</strong>
      </div>
      <div className="detail-row">
        <span>Uptime</span>
        <strong className="mono">{formatUptime(data.uptimeSeconds)}</strong>
      </div>
    </section>
  );
}
