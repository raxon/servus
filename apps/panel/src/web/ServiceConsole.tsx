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
  const ready = useRef(false);
  const handshakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      if (ready.current && socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: "input", data }));
    });
    const size = term.onResize(({ cols, rows }) => {
      if (ready.current && socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    return () => {
      generation.current++;
      ready.current = false;
      if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
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
    ready.current = false;
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
        `${protocol}//${location.host}/api/v1/services/${service.id}/console`,
      );
      socket.current?.close();
      socket.current = ws;
      handshakeTimer.current = setTimeout(() => {
        if (attempt !== generation.current || ready.current) return;
        setError(new Error("The console connection timed out. Try again."));
        ws.close();
      }, 10_000);
      ws.onopen = () => {
        if (attempt !== generation.current) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: "authenticate", ticket: result.ticket }));
      };
      ws.onmessage = async (event) => {
        if (attempt !== generation.current) return;
        if (!ready.current) {
          let message: unknown;
          try {
            message = typeof event.data === "string" ? JSON.parse(event.data) : null;
          } catch {
            message = null;
          }
          if (!message || typeof message !== "object" || !("type" in message) || message.type !== "ready") {
            setError(new Error("The console connection failed. Request a new connection to try again."));
            ws.close();
            return;
          }
          if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
          handshakeTimer.current = null;
          ready.current = true;
          setStatus("connected");
          terminal.current?.clear();
          fit.current?.fit();
          ws.send(JSON.stringify({ type: "resize", cols: terminal.current?.cols ?? 80, rows: terminal.current?.rows ?? 24 }));
          terminal.current?.focus();
          return;
        }
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
      ws.onclose = (event) => {
        if (attempt !== generation.current) return;
        if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
        handshakeTimer.current = null;
        if (event.code !== 1000 && event.code !== 1001)
          setError((current) => current ?? new Error(ready.current
            ? "The console connection ended unexpectedly. Try connecting again."
            : "The console connection failed. Request a new connection to try again."));
        ready.current = false;
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
