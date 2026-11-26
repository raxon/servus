import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, Box, Database, HardDrive, RefreshCw, Zap } from "lucide-react";
import type { Project, Service, ServiceMetrics } from "../shared/types.js";
import type { DockerDiskUsage, HostAuditEvent } from "../shared/host-admin.js";
import { api, errorMessage } from "./api.js";
import { HostSparklines } from "./HostSparklines.js";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function ServiceMonitorRow({ project, service }: { project: Project; service: Service }) {
  const metrics = useQuery({
    queryKey: ["service-metrics", service.id],
    queryFn: ({ signal }) => api<ServiceMetrics>(`/services/${service.id}/metrics`, { signal }),
    enabled: service.state === "running",
    refetchInterval: 10_000,
    retry: false,
  });

  const data = metrics.data;
  const memPct =
    data && data.memoryLimitBytes > 0
      ? `${((data.memoryBytes / data.memoryLimitBytes) * 100).toFixed(1)}%`
      : "—";

  return (
    <tr>
      <td>
        <Link to="/services/$serviceId" params={{ serviceId: service.id }} className="ep-monitor-service-link">
          <span className={`ep-dot status-dot-${service.state}`} aria-hidden="true" />
          <span className="ep-monitor-service-icon" aria-hidden="true">
            {service.kind === "redis" ? (
              <Zap size={14} />
            ) : service.kind && service.kind !== "app" ? (
              <Database size={14} />
            ) : (
              <Box size={14} />
            )}
          </span>
          <span className="ep-monitor-project-name">{project.name}</span>
          <span className="ep-monitor-sep">/</span>
          <strong>{service.name}</strong>
        </Link>
      </td>
      <td>
        <span className={`badge status-${service.state}`}>
          <span className="status-dot" />
          {service.state.replaceAll("_", " ")}
        </span>
      </td>
      <td className="mono">{data ? `${data.cpuPercent.toFixed(1)}%` : "0.0%"}</td>
      <td className="mono">{data ? formatBytes(data.memoryBytes) : "0 B"}</td>
      <td className="mono">{memPct}</td>
      <td className="mono">{data ? formatBytes(data.networkRxBytes) : "0 B"}</td>
      <td className="mono">{data ? formatBytes(data.networkTxBytes) : "0 B"}</td>
    </tr>
  );
}

export function MonitorPage({ projects, admin }: { projects: Project[]; admin: boolean }) {
  const [tab, setTab] = useState<"services" | "events" | "storage">("services");

  const serviceQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["services", project.id],
      queryFn: () => api<Service[]>(`/projects/${project.id}/services`),
      refetchInterval: 5_000,
    })),
  });

  const eventsQuery = useQuery({
    queryKey: ["monitor-host-events"],
    queryFn: ({ signal }) => api<{ events: HostAuditEvent[] }>("/host/events?limit=60", { signal }),
    enabled: admin && tab === "events",
    refetchInterval: 10_000,
    retry: false,
  });

  const usageQuery = useQuery({
    queryKey: ["host-docker-usage"],
    queryFn: ({ signal }) => api<DockerDiskUsage>("/host/docker/usage", { signal }),
    enabled: admin && tab === "storage",
    retry: false,
  });

  const rows = projects.flatMap((project, idx) => {
    const raw = serviceQueries[idx]?.data;
    return (Array.isArray(raw) ? raw : []).map((service) => ({ project, service }));
  });

  return (
    <div className="ep-page">
      <header className="ep-page-header">
        <h1>Monitor</h1>
      </header>

      <HostSparklines />

      <div className="ep-framed-card">
        <div className="ep-framed-head">
          <div className="ep-segmented" role="tablist" aria-label="Monitor views">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "services"}
              className={tab === "services" ? "is-active" : ""}
              onClick={() => setTab("services")}
            >
              Services
            </button>
            {admin ? (
              <>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "events"}
                  className={tab === "events" ? "is-active" : ""}
                  onClick={() => setTab("events")}
                >
                  Docker Events
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "storage"}
                  className={tab === "storage" ? "is-active" : ""}
                  onClick={() => setTab("storage")}
                >
                  Storage
                </button>
              </>
            ) : null}
          </div>
          {tab === "storage" && admin ? (
            <div className="ep-framed-head-actions">
              <button
                type="button"
                className="button button-small"
                onClick={() => void usageQuery.refetch()}
                disabled={usageQuery.isFetching}
              >
                <RefreshCw size={13} aria-hidden="true" /> Refresh
              </button>
              <Link to="/settings" hash="host-administration" className="button button-small">
                Cleanup &amp; Console
              </Link>
            </div>
          ) : null}
        </div>

        <div className="ep-framed-body">
          {tab === "services" ? (
            rows.length ? (
              <div className="ep-table-wrap">
                <table className="ep-data-table">
                  <thead>
                    <tr>
                      <th>Project / Service</th>
                      <th>Status</th>
                      <th>CPU %</th>
                      <th>Memory</th>
                      <th>Memory %</th>
                      <th>Network In</th>
                      <th>Network Out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ project, service }) => (
                      <ServiceMonitorRow key={service.id} project={project} service={service} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="ep-empty-inline">
                <Activity size={20} aria-hidden="true" />
                <span>No services deployed yet. Create a service inside any project to monitor live resource usage.</span>
              </div>
            )
          ) : tab === "events" ? (
            eventsQuery.error ? (
              <div className="error-notice" role="alert">{errorMessage(eventsQuery.error)}</div>
            ) : eventsQuery.isPending ? (
              <p className="servus-help">Loading host events…</p>
            ) : Array.isArray(eventsQuery.data?.events) && eventsQuery.data.events.length ? (
              <div className="ep-events-feed">
                {eventsQuery.data.events.map((ev) => (
                  <div key={ev.id} className="ep-event-row">
                    <div>
                      <strong className="mono">{ev.operation}</strong>
                      <small>{ev.actorEmail ?? "system"} · {ev.resourceId.slice(0, 12)}</small>
                    </div>
                    <time className="mono">{new Date(ev.createdAt).toLocaleString()}</time>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ep-empty-inline">
                <Activity size={20} aria-hidden="true" />
                <span>No recent host events recorded.</span>
              </div>
            )
          ) : usageQuery.error ? (
            <div className="error-notice" role="alert">{errorMessage(usageQuery.error)}</div>
          ) : usageQuery.data?.images && usageQuery.data?.containers && usageQuery.data?.volumes && usageQuery.data?.buildCache ? (
            <div className="host-storage-kpis" style={{ marginBottom: 0 }}>
              <div className="host-storage-kpi">
                <span>Images ({usageQuery.data.images.count})</span>
                <strong className="mono">{formatBytes(usageQuery.data.images.totalSizeBytes)}</strong>
                <small>{formatBytes(usageQuery.data.images.reclaimableBytes)} reclaimable</small>
              </div>
              <div className="host-storage-kpi">
                <span>Containers</span>
                <strong className="mono">{formatBytes(usageQuery.data.containers.totalSizeBytes)}</strong>
                <small>{usageQuery.data.containers.runningCount} running · {usageQuery.data.containers.stoppedCount} stopped</small>
              </div>
              <div className="host-storage-kpi">
                <span>Volumes ({usageQuery.data.volumes.count})</span>
                <strong className="mono">{formatBytes(usageQuery.data.volumes.totalSizeBytes)}</strong>
                <small>{usageQuery.data.volumes.activeCount} active (protected)</small>
              </div>
              <div className="host-storage-kpi">
                <span>Build cache ({usageQuery.data.buildCache.count})</span>
                <strong className="mono">{formatBytes(usageQuery.data.buildCache.totalSizeBytes)}</strong>
                <small>{formatBytes(usageQuery.data.buildCache.reclaimableBytes)} reclaimable</small>
              </div>
            </div>
          ) : (
            <div className="ep-empty-inline">
              <HardDrive size={20} aria-hidden="true" />
              <span>Loading Docker storage usage…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
