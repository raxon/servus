import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MetricsWindow, Service, ServiceMetricPoint, ServiceMetricsHistory } from "../shared/types.js";
import { api } from "./api.js";
import { FeatureError } from "./feature-ui.js";
import "./ServiceMetricsHistory.css";

const WINDOWS: { id: MetricsWindow; label: string }[] = [
  { id: "1h", label: "1h" },
  { id: "6h", label: "6h" },
  { id: "24h", label: "24h" },
];

const formatUtcTime = (iso: string) => {
  const date = new Date(iso);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
};

function MetricChart({
  title,
  unit,
  samples,
  valueOf,
  formatValue,
  stroke,
  minMax,
}: {
  title: string;
  unit: string;
  samples: ServiceMetricPoint[];
  valueOf: (sample: ServiceMetricPoint) => number | null;
  formatValue: (value: number) => string;
  stroke: string;
  minMax?: number;
}) {
  const width = 260;
  const height = 84;
  const padX = 4;
  const padY = 8;
  const values = samples
    .filter((sample) => sample.status === "ok")
    .map(valueOf)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const peak = values.length ? Math.max(...values) : 0;
  const latest = values.length ? values[values.length - 1]! : null;
  const scaleMax = Math.max(minMax ?? 1, peak * 1.15);
  const count = samples.length;
  const xFor = (index: number) =>
    count <= 1 ? width / 2 : padX + (index / (count - 1)) * (width - padX * 2);
  const yFor = (value: number) =>
    height - padY - (Math.min(value, scaleMax) / scaleMax) * (height - padY * 2);

  // Break line segments across gaps so missing data is never interpolated as zero.
  const segments: string[] = [];
  let current: string[] = [];
  const gapXs: number[] = [];
  const generationXs: number[] = [];
  let lastGeneration: string | null = null;
  samples.forEach((sample, index) => {
    const x = xFor(index);
    const val = sample.status === "ok" ? valueOf(sample) : null;
    if (sample.status === "gap" || val === null) {
      if (current.length) {
        segments.push(current.join(" "));
        current = [];
      }
      gapXs.push(x);
      return;
    }
    if (lastGeneration && sample.generation && sample.generation !== lastGeneration) {
      generationXs.push(x);
    }
    if (sample.generation) lastGeneration = sample.generation;
    current.push(`${x.toFixed(1)},${yFor(val).toFixed(1)}`);
  });
  if (current.length) segments.push(current.join(" "));

  return (
    <div className="metrics-chart-card">
      <div className="metrics-chart-top">
        <span className="metrics-chart-title">
          {title} ({unit})
        </span>
        <span className="metrics-chart-stat">
          {latest !== null ? formatValue(latest) : "Unavailable"}
        </span>
      </div>
      <svg
        className="metrics-chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${title} history in ${unit}. Latest: ${latest !== null ? formatValue(latest) : "unavailable"}. Peak: ${values.length ? formatValue(peak) : "unavailable"}.`}
      >
        <title>{`${title} (${unit})`}</title>
        <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="#e2e2e2" strokeWidth="1" />
        <line x1={padX} y1={padY} x2={width - padX} y2={padY} stroke="#eeeeee" strokeWidth="1" strokeDasharray="3 3" />
        {generationXs.map((x, index) => (
          <line
            key={`gen-${index}`}
            x1={x}
            y1={padY}
            x2={x}
            y2={height - padY}
            stroke="#6366f1"
            strokeWidth="1"
            strokeDasharray="2 2"
          />
        ))}
        {gapXs.map((x, index) => (
          <line
            key={`gap-${index}`}
            data-gap="true"
            x1={x}
            y1={padY}
            x2={x}
            y2={height - padY}
            stroke="#d97706"
            strokeWidth="2"
            strokeDasharray="3 2"
          />
        ))}
        {segments.map((points, index) =>
          points.includes(" ") ? (
            <polyline
              key={`seg-${index}`}
              fill="none"
              stroke={stroke}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={points}
            />
          ) : (
            <circle
              key={`pt-${index}`}
              cx={Number(points.split(",")[0])}
              cy={Number(points.split(",")[1])}
              r="3"
              fill={stroke}
            />
          ),
        )}
      </svg>
      <div className="metrics-chart-axis">
        <span>{samples.length ? formatUtcTime(samples[0]!.sampledAt) : "--"}</span>
        <span>Peak {values.length ? formatValue(peak) : "--"}</span>
        <span>{samples.length ? formatUtcTime(samples[samples.length - 1]!.sampledAt) : "--"}</span>
      </div>
    </div>
  );
}

export function ServiceMetricsHistoryPanel({ service }: { service: Service }) {
  const [window, setWindow] = useState<MetricsWindow>("1h");
  const history = useQuery({
    queryKey: ["service-metrics-history", service.id, window],
    queryFn: () =>
      api<ServiceMetricsHistory>(
        `/services/${service.id}/metrics/history?window=${window}`,
      ),
    refetchInterval: 30_000,
  });

  const samples = history.data?.samples ?? [];
  const gapCount = samples.filter((sample) => sample.status === "gap").length;
  const generations = new Set(
    samples
      .filter((sample) => sample.status === "ok" && sample.generation)
      .map((sample) => sample.generation!),
  );

  return (
    <div className="metrics-history" role="region" aria-label="Historical metrics">
      <div className="metrics-history-header">
        <h3>History ({window})</h3>
        <div
          className="metrics-window-group"
          role="group"
          aria-label="Metrics history range"
        >
          {WINDOWS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={window === option.id}
              onClick={() => setWindow(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <FeatureError error={history.error} />
      {history.isPending ? (
        <p className="feature-empty-copy">Loading historical samples...</p>
      ) : samples.length === 0 ? (
        <p className="feature-empty-copy">
          Samples are collected every minute while this service is running (up to 24h retained).
        </p>
      ) : (
        <>
          <div className="metrics-history-notes">
            <span>
              {samples.length} {samples.length === 1 ? "sample" : "samples"} (every{" "}
              {history.data?.intervalSeconds ?? 60}s)
            </span>
            {gapCount > 0 ? (
              <span className="metrics-history-gap-note">
                {gapCount} unavailable {gapCount === 1 ? "interval" : "intervals"} (gap)
              </span>
            ) : null}
            {generations.size > 1 ? (
              <span>Container generation changed ({generations.size} generations)</span>
            ) : null}
            {history.data?.truncated && history.data.earliestAvailableAt ? (
              <span>
                History capped; earliest sample at {formatUtcTime(history.data.earliestAvailableAt)}
              </span>
            ) : null}
          </div>
          <div className="metrics-charts-grid">
            <MetricChart
              title="CPU usage"
              unit="%"
              samples={samples}
              valueOf={(sample) => sample.cpuPercent}
              formatValue={(value) => `${value.toFixed(1)}%`}
              stroke="#1f7a4c"
              minMax={10}
            />
            <MetricChart
              title="Memory usage"
              unit="MiB"
              samples={samples}
              valueOf={(sample) =>
                sample.memoryBytes !== null ? sample.memoryBytes / (1024 * 1024) : null
              }
              formatValue={(value) => `${value.toFixed(1)} MiB`}
              stroke="#2563eb"
              minMax={16}
            />
            <MetricChart
              title="Running containers"
              unit="count"
              samples={samples}
              valueOf={(sample) => sample.containers}
              formatValue={(value) => `${Math.round(value)}`}
              stroke="#4f46e5"
              minMax={2}
            />
          </div>
        </>
      )}
    </div>
  );
}
