import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cpu, HardDrive, MemoryStick, Server } from "lucide-react";
import type { HostMetrics } from "../shared/types.js";
import { api } from "./api.js";

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

interface TelemetrySample {
  cpuPct: number;
  memPct: number;
  diskPct: number;
  loadPct: number;
}

function Sparkline({
  values,
  color,
  max = 100,
}: {
  values: number[];
  color: string;
  max?: number;
}) {
  const gradId = useId().replaceAll(":", "");
  const series = values.length >= 2 ? values : [values[0] ?? 0, values[0] ?? 0];
  const width = 200;
  const height = 44;
  const ceiling = Math.max(max, ...series, 10);
  const step = width / Math.max(1, series.length - 1);

  const points = series.map((val, idx) => {
    const x = idx * step;
    const clamped = Math.max(0, Math.min(ceiling, val));
    const y = height - 4 - (clamped / ceiling) * (height - 10);
    return { x, y };
  });

  const linePath = points
    .map((pt, idx) => `${idx === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  return (
    <svg
      className="ep-sparkline-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HostSparklines() {
  const query = useQuery({
    queryKey: ["host-metrics-live"],
    queryFn: ({ signal }) => api<HostMetrics>("/host/metrics", { signal }),
    refetchInterval: 5_000,
    retry: false,
  });

  const [history, setHistory] = useState<TelemetrySample[]>([]);
  const data = query.data;

  useEffect(() => {
    if (!data || typeof data.memoryTotalBytes !== "number" || typeof data.diskTotalBytes !== "number") return;
    const cpuCount = Math.max(1, data.cpuCount || 1);
    const cpuPct = Math.min(100, Math.round((data.loadAverage1m / cpuCount) * 100));
    const memPct = data.memoryTotalBytes > 0 ? Math.round((data.memoryUsedBytes / data.memoryTotalBytes) * 100) : 0;
    const diskPct = data.diskTotalBytes > 0 ? Math.round((data.diskUsedBytes / data.diskTotalBytes) * 100) : 0;
    const loadPct = Math.min(100, Math.round((data.loadAverage5m / cpuCount) * 100));
    setHistory((prev) => {
      const seed = prev.length === 0 ? Array.from({ length: 8 }, () => ({ cpuPct, memPct, diskPct, loadPct })) : prev;
      return [...seed.slice(-23), { cpuPct, memPct, diskPct, loadPct }];
    });
  }, [data]);

  if (!data || typeof data.memoryTotalBytes !== "number" || typeof data.diskTotalBytes !== "number") {
    return null;
  }

  const cpuCount = Math.max(1, data.cpuCount || 1);
  const cpuPct = Math.min(100, Math.round((data.loadAverage1m / cpuCount) * 100));
  const memPct = data.memoryTotalBytes > 0 ? Math.round((data.memoryUsedBytes / data.memoryTotalBytes) * 100) : 0;
  const diskPct = data.diskTotalBytes > 0 ? Math.round((data.diskUsedBytes / data.diskTotalBytes) * 100) : 0;

  return (
    <section className="ep-telemetry-strip" aria-label="Server telemetry">
      <div className="ep-telemetry-card">
        <div className="ep-telemetry-head">
          <span className="ep-telemetry-label">
            <Cpu size={14} aria-hidden="true" />
            CPU
          </span>
          <strong className="ep-telemetry-value">{cpuPct}%</strong>
        </div>
        <div className="ep-telemetry-sub">
          {data.loadAverage1m.toFixed(2)} load · {cpuCount} {cpuCount === 1 ? "core" : "cores"}
        </div>
        <Sparkline values={history.map((s) => s.cpuPct)} color="#f59e0b" />
      </div>

      <div className="ep-telemetry-card">
        <div className="ep-telemetry-head">
          <span className="ep-telemetry-label">
            <MemoryStick size={14} aria-hidden="true" />
            Memory
          </span>
          <strong className="ep-telemetry-value">{memPct}%</strong>
        </div>
        <div className="ep-telemetry-sub">
          {formatGiB(data.memoryUsedBytes)} / {formatGiB(data.memoryTotalBytes)}
        </div>
        <Sparkline values={history.map((s) => s.memPct)} color="#3b82f6" />
      </div>

      <div className="ep-telemetry-card">
        <div className="ep-telemetry-head">
          <span className="ep-telemetry-label">
            <HardDrive size={14} aria-hidden="true" />
            Disk
          </span>
          <strong className="ep-telemetry-value">{diskPct}%</strong>
        </div>
        <div className="ep-telemetry-sub">
          {formatGiB(data.diskUsedBytes)} / {formatGiB(data.diskTotalBytes)}
        </div>
        <Sparkline values={history.map((s) => s.diskPct)} color="#10b981" />
      </div>

      <div className="ep-telemetry-card">
        <div className="ep-telemetry-head">
          <span className="ep-telemetry-label">
            <Server size={14} aria-hidden="true" />
            Uptime
          </span>
          <strong className="ep-telemetry-value">{formatUptime(data.uptimeSeconds)}</strong>
        </div>
        <div className="ep-telemetry-sub">
          Load 5m {data.loadAverage5m.toFixed(2)} · 15m {data.loadAverage15m.toFixed(2)}
        </div>
        <Sparkline values={history.map((s) => s.loadPct)} color="#06b6d4" />
      </div>
    </section>
  );
}
