import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, HardDrive, RefreshCw, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import type { DockerDiskUsage, DockerPruneResult, HostAuditEvent, HostExecResult } from "../shared/host-admin.js";
import { api, errorMessage } from "./api.js";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function HostAdminPanel() {
  const client = useQueryClient();
  const [danglingImages, setDanglingImages] = useState(true);
  const [unusedImages, setUnusedImages] = useState(false);
  const [buildCache, setBuildCache] = useState(true);
  const [stoppedContainers, setStoppedContainers] = useState(true);
  const [eventFilter, setEventFilter] = useState("");
  const [command, setCommand] = useState("docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const [consoleInput, setConsoleInput] = useState("");
  const [consoleStatus, setConsoleStatus] = useState<"idle" | "connecting" | "connected" | "closed">("idle");
  const wsRef = useRef<WebSocket | null>(null);

  const usageQuery = useQuery({
    queryKey: ["host-docker-usage"],
    queryFn: ({ signal }) => api<DockerDiskUsage>("/host/docker/usage", { signal }),
    retry: false,
  });

  const eventsQuery = useQuery({
    queryKey: ["host-events", eventFilter],
    queryFn: ({ signal }) =>
      api<{ events: HostAuditEvent[] }>(`/host/events?limit=50${eventFilter.trim() ? `&q=${encodeURIComponent(eventFilter.trim())}` : ""}`, { signal }),
    retry: false,
  });

  const pruneMutation = useMutation({
    mutationFn: () =>
      api<DockerPruneResult>("/host/docker/prune", {
        method: "POST",
        body: {
          ...(danglingImages ? { danglingImages: true } : {}),
          ...(unusedImages ? { unusedImages: true } : {}),
          ...(buildCache ? { buildCache: true } : {}),
          ...(stoppedContainers ? { stoppedContainers: true } : {}),
        },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["host-docker-usage"] });
      void client.invalidateQueries({ queryKey: ["host-metrics"] });
      void client.invalidateQueries({ queryKey: ["host-events"] });
    },
  });

  const execMutation = useMutation({
    mutationFn: (cmd: string) =>
      api<HostExecResult>("/host/console/exec", {
        method: "POST",
        body: { command: cmd, timeoutSeconds: 20 },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["host-events"] });
    },
  });

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  async function openInteractiveConsole() {
    wsRef.current?.close();
    setConsoleOpen(true);
    setConsoleStatus("connecting");
    setConsoleLines(["Connecting to administrator host shell..."]);
    try {
      const { ticket } = await api<{ ticket: string }>("/host/console-ticket", {
        method: "POST",
        body: { shell: "/bin/sh" },
      });
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/api/v1/host/console`);
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "authenticate", ticket }));
      });
      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as { type?: string; data?: string };
          if (msg.type === "ready") {
            setConsoleStatus("connected");
            setConsoleLines((prev) => [...prev, "Connected. Type commands below."]);
          } else if (msg.type === "output" && typeof msg.data === "string") {
            setConsoleLines((prev) => [...prev.slice(-200), msg.data!]);
          }
        } catch { /* ignore */ }
      });
      ws.addEventListener("close", () => {
        setConsoleStatus("closed");
      });
      ws.addEventListener("error", () => {
        setConsoleStatus("closed");
        setConsoleLines((prev) => [...prev, "Host console connection closed."]);
      });
    } catch (error) {
      setConsoleStatus("closed");
      setConsoleLines([errorMessage(error)]);
    }
  }

  function sendInteractiveLine() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !consoleInput) return;
    wsRef.current.send(JSON.stringify({ type: "input", data: `${consoleInput}\n` }));
    setConsoleLines((prev) => [...prev.slice(-200), `$ ${consoleInput}`]);
    setConsoleInput("");
  }

  const usage = usageQuery.data;
  const canPrune = danglingImages || unusedImages || buildCache || stoppedContainers;

  return (
    <section className="settings-group" id="host-administration" aria-labelledby="settings-host-admin-heading">
      <h2 id="settings-host-admin-heading">Host administration</h2>

      <section className="surface details-card" aria-label="Docker storage and cleanup">
        <div className="settings-card-header">
          <div className="settings-card-intro">
            <div className="card-heading">
              <HardDrive size={19} aria-hidden="true" />
              <h3>Docker disk usage &amp; cleanup</h3>
            </div>
            <p>Inspect Docker storage consumption and safely prune unused artifacts. Active volumes are never removed.</p>
          </div>
          <button type="button" className="button button-small" onClick={() => void usageQuery.refetch()} disabled={usageQuery.isFetching}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>

        {usageQuery.error ? <div className="error-notice" role="alert">{errorMessage(usageQuery.error)}</div> : null}
        {usage ? (
          <>
            <div className="detail-row">
              <span>Images ({usage.images.count})</span>
              <strong className="mono">{formatBytes(usage.images.totalSizeBytes)} ({formatBytes(usage.images.reclaimableBytes)} reclaimable)</strong>
            </div>
            <div className="detail-row">
              <span>Containers ({usage.containers.runningCount} running / {usage.containers.stoppedCount} stopped)</span>
              <strong className="mono">{formatBytes(usage.containers.totalSizeBytes)}</strong>
            </div>
            <div className="detail-row">
              <span>Volumes ({usage.volumes.count}, {usage.volumes.activeCount} active - protected)</span>
              <strong className="mono">{formatBytes(usage.volumes.totalSizeBytes)}</strong>
            </div>
            <div className="detail-row">
              <span>Build cache ({usage.buildCache.count} entries)</span>
              <strong className="mono">{formatBytes(usage.buildCache.totalSizeBytes)} ({formatBytes(usage.buildCache.reclaimableBytes)} reclaimable)</strong>
            </div>
            <div className="detail-row">
              <span>Total reclaimable</span>
              <strong className="mono">{formatBytes(usage.totalReclaimableBytes)}</strong>
            </div>
          </>
        ) : usageQuery.isPending ? <p role="status">Loading Docker storage...</p> : null}

        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <label className="checkbox-label"><input type="checkbox" checked={danglingImages} onChange={(e) => setDanglingImages(e.target.checked)} /> Dangling images (untagged layers)</label>
          <label className="checkbox-label"><input type="checkbox" checked={unusedImages} onChange={(e) => setUnusedImages(e.target.checked)} /> All unused images (not attached to any container)</label>
          <label className="checkbox-label"><input type="checkbox" checked={buildCache} onChange={(e) => setBuildCache(e.target.checked)} /> Docker BuildKit cache</label>
          <label className="checkbox-label"><input type="checkbox" checked={stoppedContainers} onChange={(e) => setStoppedContainers(e.target.checked)} /> Stopped containers</label>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
            <button type="button" className="button button-primary" disabled={!canPrune || pruneMutation.isPending} onClick={() => pruneMutation.mutate()}>
              <Trash2 size={15} aria-hidden="true" /> {pruneMutation.isPending ? "Pruning..." : "Prune selected"}
            </button>
            {pruneMutation.data ? (
              <span role="status" className="mono">
                Reclaimed {formatBytes(pruneMutation.data.totalReclaimedBytes)} ({pruneMutation.data.imagesDeleted} images, {pruneMutation.data.containersDeleted} containers)
              </span>
            ) : null}
          </div>
          {pruneMutation.error ? <div className="error-notice" role="alert">{errorMessage(pruneMutation.error)}</div> : null}
        </div>
      </section>

      <section className="surface details-card" aria-label="Host administrator console">
        <div className="settings-card-header">
          <div className="settings-card-intro">
            <div className="card-heading">
              <TerminalIcon size={19} aria-hidden="true" />
              <h3>Host administrator console</h3>
            </div>
            <p>Run bounded diagnostic commands or open an audited interactive shell session.</p>
          </div>
          <button type="button" className="button button-small" onClick={() => void openInteractiveConsole()}>
            <TerminalIcon size={14} aria-hidden="true" /> {consoleStatus === "connected" ? "Reconnect shell" : "Open live shell"}
          </button>
        </div>

        <form
          style={{ display: "grid", gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (command.trim() && !execMutation.isPending) execMutation.mutate(command.trim());
          }}
        >
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {["cat /proc/loadavg && head -n 3 /proc/meminfo", "df -h", "docker service ls", "docker ps --format 'table {{.Names}}\\t{{.Status}}'"].map((preset) => (
              <button key={preset} type="button" className="button button-small" onClick={() => { setCommand(preset); execMutation.mutate(preset); }}>
                {preset.startsWith("cat /proc") ? "load & mem" : `${preset.split(" ")[0]} ${preset.split(" ")[1] ?? ""}`}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="mono"
              style={{ flex: 1 }}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Enter diagnostic shell command..."
              aria-label="Host diagnostic command"
            />
            <button type="submit" className="button button-primary" disabled={execMutation.isPending || !command.trim()}>
              {execMutation.isPending ? "Running..." : "Run"}
            </button>
          </div>
          {execMutation.error ? <div className="error-notice" role="alert">{errorMessage(execMutation.error)}</div> : null}
          {execMutation.data ? (
            <pre className="mono" style={{ maxHeight: 240, overflow: "auto", padding: 10, borderRadius: 8, background: "var(--surface-muted, rgba(0,0,0,0.2))", fontSize: 12 }}>
              {execMutation.data.output || "(no output)"}
              {`\n[exit ${execMutation.data.exitCode} in ${execMutation.data.durationMs}ms${execMutation.data.truncated ? ", truncated" : ""}]`}
            </pre>
          ) : null}
        </form>

        {consoleOpen ? (
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong className="mono">Interactive shell ({consoleStatus})</strong>
              <button type="button" className="button button-small" onClick={() => { wsRef.current?.close(); setConsoleOpen(false); setConsoleStatus("idle"); }}>Close</button>
            </div>
            <pre className="mono" style={{ maxHeight: 220, overflow: "auto", padding: 10, borderRadius: 8, background: "var(--surface-muted, rgba(0,0,0,0.25))", fontSize: 12, whiteSpace: "pre-wrap" }}>
              {consoleLines.join("\n")}
            </pre>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="mono"
                style={{ flex: 1 }}
                value={consoleInput}
                disabled={consoleStatus !== "connected"}
                onChange={(e) => setConsoleInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendInteractiveLine(); } }}
                placeholder="Type command and press Enter..."
                aria-label="Interactive host shell input"
              />
              <button type="button" className="button" disabled={consoleStatus !== "connected" || !consoleInput} onClick={sendInteractiveLine}>Send</button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="surface details-card" aria-label="Host audit events">
        <div className="settings-card-header">
          <div className="settings-card-intro">
            <div className="card-heading">
              <Activity size={19} aria-hidden="true" />
              <h3>Host &amp; audit events</h3>
            </div>
            <p>Recent administrative and deployment events recorded by Servus.</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              placeholder="Filter operation or user..."
              aria-label="Filter host events"
            />
            <button type="button" className="button button-small" onClick={() => void eventsQuery.refetch()} disabled={eventsQuery.isFetching}>
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
        {eventsQuery.error ? <div className="error-notice" role="alert">{errorMessage(eventsQuery.error)}</div> : null}
        {eventsQuery.data?.events.length ? (
          <div style={{ maxHeight: 280, overflow: "auto" }}>
            {eventsQuery.data.events.map((ev) => (
              <div className="detail-row" key={ev.id}>
                <span>
                  <strong className="mono">{ev.operation}</strong>
                  <small style={{ display: "block", opacity: 0.75 }}>{ev.actorEmail ?? ev.actorId} · {ev.resourceId}</small>
                </span>
                <span className="mono" style={{ fontSize: 12 }}>{new Date(ev.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        ) : eventsQuery.isPending ? <p role="status">Loading host events...</p> : <p>No matching events found.</p>}
      </section>
    </section>
  );
}
