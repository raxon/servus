export type MetricsWindow = '1h' | '6h' | '24h';

export interface ServiceMetricPoint {
  sampledAt: string;
  status: 'ok' | 'gap';
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  containers: number | null;
  generation: string | null;
}

export interface ServiceMetricsHistory {
  serviceId: string;
  window: MetricsWindow;
  intervalSeconds: number;
  retentionHours: number;
  earliestAvailableAt: string | null;
  truncated: boolean;
  samples: ServiceMetricPoint[];
}

export const METRICS_WINDOW_MS: Record<MetricsWindow, number> = {
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

export interface HostMetrics {
  sampledAt: string;
  cpuCount: number;
  loadAverage1m: number;
  loadAverage5m: number;
  loadAverage15m: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryFreeBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  diskAvailableBytes: number;
  uptimeSeconds: number;
}
