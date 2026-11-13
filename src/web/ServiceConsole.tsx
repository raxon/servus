import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal as BrowserTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plug, Unplug } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { ContainerInfo, Service } from "../shared/types.js";
import { api, errorMessage } from "./api.js";
import { FeatureError } from "./feature-ui.js";

export default function ServiceConsole({ service }: { service: Service }) {
  const target = useRef<HTMLDivElement>(null);
  const terminal = useRef<BrowserTerminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const generation = useRef(0);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [error, setError] = useState<Error | null>(null);
  const containers = useQuery({
    queryKey: ["containers", service.id],
    queryFn: () => api<ContainerInfo[]>(`/services/${service.id}/containers`),
    refetchInterval: status === "connected" ? false : 5_000,
  });
  const containerId = selected || containers.data?.[0]?.id || "";

  useEffect(() => {
    if (!target.current) return;
    const term = new BrowserTerminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      scrollback: 3_000,
      theme: {
        background: "#fcfcfc",
        foreground: "#343434",
        cursor: "#4a8b65",
        selectionBackground: "#d5eadf",
      },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(target.current);
    terminal.current = term;
    fit.current = addon;
    term.writeln("Select a running container, then connect to open /bin/sh.");
    const resize = () => {
      try {
        addon.fit();
      } catch {
        /* The terminal may be temporarily hidden during layout. */
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(target.current);
    const frame = requestAnimationFrame(resize);
    const input = term.onData((data) => {
      if (socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: "input", data }));
    });
    const size = term.onResize(({ cols, rows }) => {
      if (socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    return () => {
      generation.current++;
      socket.current?.close();
      socket.current = null;
      observer.disconnect();
      cancelAnimationFrame(frame);
      input.dispose();
      size.dispose();
      term.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, []);

  async function connect() {
    const attempt = ++generation.current;
    setError(null);
    setStatus("connecting");
    try {
      const result = await api<{ ticket: string }>(
        `/services/${service.id}/console-ticket`,
        { method: "POST", body: { containerId, shell: "/bin/sh" } },
      );
      if (attempt !== generation.current) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${protocol}//${location.host}/api/v1/services/${service.id}/console?ticket=${encodeURIComponent(result.ticket)}`,
      );
      socket.current?.close();
      socket.current = ws;
      ws.onopen = () => {
        if (attempt !== generation.current) {
          ws.close();
          return;
        }
        setStatus("connected");
        terminal.current?.clear();
        fit.current?.fit();
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.current?.cols ?? 80,
            rows: terminal.current?.rows ?? 24,
          }),
        );
        terminal.current?.focus();
      };
      ws.onmessage = async (event) => {
        if (attempt !== generation.current) return;
        const value =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof Blob
              ? await event.data.text()
              : "";
        if (attempt === generation.current) terminal.current?.write(value);
      };
      ws.onerror = () => {
        if (attempt === generation.current)
          setError(
            new Error(
              "The console connection failed. Request a new connection to try again.",
            ),
          );
      };
      ws.onclose = () => {
        if (attempt !== generation.current) return;
        setStatus("disconnected");
        terminal.current?.writeln("\r\n[Console disconnected]");
        socket.current = null;
      };
    } catch (reason) {
      if (attempt === generation.current) {
        setError(new Error(errorMessage(reason)));
        setStatus("disconnected");
      }
    }
  }

  return (
    <section className="surface console-card">
      <div className="feature-panel-heading">
        <div>
          <h2>Container console</h2>
          <p>Interactive /bin/sh session with a single-use connection grant.</p>
        </div>
        <span
          className={`badge ${status === "connected" ? "status-running" : "status-stopped"}`}
        >
          <span className="status-dot" />
          {status}
        </span>
      </div>
      <div className="console-controls">
        <label>
          Container
          <select
            value={containerId}
            onChange={(event) => setSelected(event.target.value)}
            disabled={status !== "disconnected"}
          >
            {!containers.data?.length ? (
              <option value="">No running containers</option>
            ) : (
              containers.data.map((container) => (
                <option key={container.id} value={container.id}>
                  {container.name} ({container.id.slice(0, 12)})
                </option>
              ))
            )}
          </select>
        </label>
        {status === "connected" ? (
          <button
            className="button"
            type="button"
            onClick={() => socket.current?.close()}
          >
            <Unplug size={16} />
            Disconnect
          </button>
        ) : (
          <button
            className="button button-primary"
            type="button"
            disabled={!containerId || status === "connecting"}
            onClick={() => void connect()}
          >
            <Plug size={16} />
            {status === "connecting" ? "Connecting..." : "Connect"}
          </button>
        )}
      </div>
      <FeatureError error={containers.error ?? error} />
      <div
        className="console-viewport"
        ref={target}
        aria-label="Interactive container terminal"
      />
      <p className="feature-helper">
        Commands run inside the selected container with its configured user.
        Closing this tab disconnects the shell.
      </p>
    </section>
  );
}
