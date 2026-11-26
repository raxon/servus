import { useEffect, useId, useRef, useState } from "react";
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
  const id = useId();
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
      api<{ events: HostAuditEvent[] }>(
        `/host/events?limit=50${eventFilter.trim() ? `&q=${encodeURIComponent(eventFilter.trim())}` : ""}`,
        { signal },
      ),
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
          <div className="host-storage-kpis">
            <div className="host-storage-kpi">
              <span>Images ({usage.images.count})</span>
              <strong className="mono">{formatBytes(usage.images.totalSizeBytes)}</strong>
              <small>{formatBytes(usage.images.reclaimableBytes)} reclaimable</small>
            </div>
            <div className="host-storage-kpi">
              <span>Containers</span>
              <strong className="mono">{formatBytes(usage.containers.totalSizeBytes)}</strong>
              <small>{usage.containers.runningCount} running · {usage.containers.stoppedCount} stopped</small>
            </div>
            <div className="host-storage-kpi">
              <span>Volumes ({usage.volumes.count})</span>
              <strong className="mono">{formatBytes(usage.volumes.totalSizeBytes)}</strong>
              <small>{usage.volumes.activeCount} active (protected)</small>
            </div>
            <div className="host-storage-kpi">
              <span>Build cache ({usage.buildCache.count})</span>
              <strong className="mono">{formatBytes(usage.buildCache.totalSizeBytes)}</strong>
              <small>{formatBytes(usage.buildCache.reclaimableBytes)} reclaimable</small>
            </div>
            <div className="host-storage-kpi">
              <span>Total reclaimable</span>
              <strong className="mono">{formatBytes(usage.totalReclaimableBytes)}</strong>
              <small>Safe to prune</small>
            </div>
          </div>
        ) : usageQuery.isPending ? (
          <p className="servus-help" role="status">Loading Docker storage...</p>
        ) : null}

        <div className="servus-subpanel">
          <div className="servus-option-grid">
            <label className="servus-option-tile">
              <input type="checkbox" checked={danglingImages} onChange={(e) => setDanglingImages(e.target.checked)} />
              <span>Dangling images (untagged layers)</span>
            </label>
            <label className="servus-option-tile">
              <input type="checkbox" checked={unusedImages} onChange={(e) => setUnusedImages(e.target.checked)} />
              <span>All unused images (not attached to containers)</span>
            </label>
            <label className="servus-option-tile">
              <input type="checkbox" checked={buildCache} onChange={(e) => setBuildCache(e.target.checked)} />
              <span>Docker BuildKit cache</span>
            </label>
            <label className="servus-option-tile">
              <input type="checkbox" checked={stoppedContainers} onChange={(e) => setStoppedContainers(e.target.checked)} />
              <span>Stopped containers</span>
            </label>
          </div>
          <div className="servus-inline-row">
            <button type="button" className="button button-primary" disabled={!canPrune || pruneMutation.isPending} onClick={() => pruneMutation.mutate()}>
              <Trash2 size={15} aria-hidden="true" />
              {pruneMutation.isPending ? "Pruning..." : "Prune selected"}
            </button>
            {pruneMutation.data ? (
              <span role="status" className="servus-help mono">
                Reclaimed {formatBytes(pruneMutation.data.totalReclaimedBytes)} ({pruneMutation.data.imagesDeleted} images, {pruneMutation.data.containersDeleted} containers)
              </span>
            ) : null}
          </div>
          {pruneMutation.error ? <div className="error-notice" role="alert" style={{ margin: 0 }}>{errorMessage(pruneMutation.error)}</div> : null}
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
          className="module-card-fields"
          onSubmit={(e) => {
            e.preventDefault();
            if (command.trim() && !execMutation.isPending) execMutation.mutate(command.trim());
          }}
        >
          <div className="host-preset-bar">
            {["cat /proc/loadavg && head -n 3 /proc/meminfo", "df -h", "docker service ls", "docker ps --format 'table {{.Names}}\\t{{.Status}}'"].map((preset) => (
              <button
                key={preset}
                type="button"
                className="button button-small"
                onClick={() => {
                  setCommand(preset);
                  execMutation.mutate(preset);
                }}
              >
                {preset.startsWith("cat /proc") ? "load & mem" : `${preset.split(" ")[0]} ${preset.split(" ")[1] ?? ""}`}
              </button>
            ))}
          </div>

          <div className="servus-inline-row">
            <input
              id={`${id}-cmd`}
              className="servus-input mono"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Enter diagnostic shell command..."
              aria-label="Host diagnostic command"
              spellCheck={false}
            />
            <button type="submit" className="button button-primary" disabled={execMutation.isPending || !command.trim()}>
              {execMutation.isPending ? "Running..." : "Run"}
            </button>
          </div>

          {execMutation.error ? <div className="error-notice" role="alert" style={{ margin: 0 }}>{errorMessage(execMutation.error)}</div> : null}
          {execMutation.data ? (
            <div className="servus-terminal-box">
              <div className="servus-terminal-head">
                <span className="mono">Diagnostic output</span>
                <span className="mono">
                  exit {execMutation.data.exitCode} · {execMutation.data.durationMs}ms{execMutation.data.truncated ? " · truncated" : ""}
                </span>
              </div>
              <pre className="servus-terminal-pre">{execMutation.data.output || "(no output)"}</pre>
            </div>
          ) : null}
        </form>

        {consoleOpen ? (
          <div className="servus-subpanel" style={{ marginTop: 14 }}>
            <div className="servus-terminal-box">
              <div className="servus-terminal-head">
                <strong className="mono">Interactive shell ({consoleStatus})</strong>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => {
                    wsRef.current?.close();
                    setConsoleOpen(false);
                    setConsoleStatus("idle");
                  }}
                >
                  Close
                </button>
              </div>
              <pre className="servus-terminal-pre">{consoleLines.join("\n")}</pre>
            </div>
            <div className="servus-inline-row">
              <input
                className="servus-input mono"
                value={consoleInput}
                disabled={consoleStatus !== "connected"}
                onChange={(e) => setConsoleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    sendInteractiveLine();
                  }
                }}
                placeholder="Type command and press Enter..."
                aria-label="Interactive host shell input"
                spellCheck={false}
              />
              <button type="button" className="button" disabled={consoleStatus !== "connected" || !consoleInput} onClick={sendInteractiveLine}>
                Send
              </button>
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
          <div className="servus-inline-row">
            <input
              className="servus-input"
              style={{ width: 220, flex: "0 1 220px", minHeight: 38 }}
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              placeholder="Filter operation or user..."
              aria-label="Filter host events"
            />
            <button type="button" className="button button-small" onClick={() => void eventsQuery.refetch()} disabled={eventsQuery.isFetching} aria-label="Refresh host events">
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
        {eventsQuery.error ? <div className="error-notice" role="alert">{errorMessage(eventsQuery.error)}</div> : null}
        {eventsQuery.data?.events.length ? (
          <div className="host-events-list">
            {eventsQuery.data.events.map((ev) => (
              <div className="detail-row" key={ev.id}>
                <span style={{ minWidth: 0 }}>
                  <strong className="mono">{ev.operation}</strong>
                  <small className="host-event-meta">
                    {ev.actorEmail ?? ev.actorId} · {ev.resourceId}
                  </small>
                </span>
                <span className="host-event-time mono">{new Date(ev.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        ) : eventsQuery.isPending ? (
          <p className="servus-help" role="status">Loading host events...</p>
        ) : (
          <div className="settings-empty">
            <Activity size={18} aria-hidden="true" />
            <div>
              <strong>No matching events</strong>
              <p>Try clearing the filter or run an administrative action to see new audit entries.</p>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
