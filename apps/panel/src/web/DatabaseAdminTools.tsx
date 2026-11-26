import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Database, ShieldCheck, Square, Wrench } from "lucide-react";
import type { EphemeralDbToolSession, PostgresMigrationResult } from "../shared/db-admin.js";
import type { Service } from "../shared/types.js";
import { api, errorMessage } from "./api.js";

export function DatabaseAdminTools({ service, canWrite }: { service: Service; canWrite: boolean }) {
  const client = useQueryClient();
  const [ttlMinutes, setTtlMinutes] = useState(15);
  const [credentials, setCredentials] = useState<{ url: string; username: string; password: string } | null>(null);
  const [targetName, setTargetName] = useState(`${service.name}-pg18`.slice(0, 63));
  const [migrationResult, setMigrationResult] = useState<PostgresMigrationResult | null>(null);

  const isDatabase = Boolean(service.kind && service.kind !== "app");
  const isPg17 = service.kind === "postgres" && service.image.startsWith("postgres:17");
  const isRunning = service.deployedRevision !== null && service.state === "running";

  const statusQuery = useQuery({
    queryKey: ["db-admin-tool", service.id],
    queryFn: ({ signal }) => api<EphemeralDbToolSession>(`/services/${service.id}/database/admin-tool`, { signal }),
    enabled: isDatabase && canWrite,
    retry: false,
  });

  const startMutation = useMutation({
    mutationFn: () =>
      api<EphemeralDbToolSession>(`/services/${service.id}/database/admin-tool`, {
        method: "POST",
        body: { ttlMinutes },
      }),
    onSuccess: (data) => {
      if (data.url && data.username && data.password) {
        setCredentials({ url: data.url, username: data.username, password: data.password });
      }
      void client.invalidateQueries({ queryKey: ["db-admin-tool", service.id] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => api(`/services/${service.id}/database/admin-tool`, { method: "DELETE" }),
    onSuccess: () => {
      setCredentials(null);
      void client.invalidateQueries({ queryKey: ["db-admin-tool", service.id] });
    },
  });

  const migrateMutation = useMutation({
    mutationFn: () =>
      api<PostgresMigrationResult>(`/services/${service.id}/database/migrate-postgres`, {
        method: "POST",
        body: { confirm: true, targetName: targetName.trim() || `${service.name}-pg18` },
      }),
    onSuccess: (result) => {
      setMigrationResult(result);
      void client.invalidateQueries({ queryKey: ["services", service.projectId] });
    },
  });

  if (!isDatabase || !canWrite) return null;

  const toolName =
    service.kind === "mongodb" ? "Mongo Express" : service.kind === "redis" ? "Redis Commander" : "Adminer";
  const active = statusQuery.data?.active === true;

  return (
    <>
      <section className="surface details-card" aria-label="Temporary database admin tool">
        <div className="card-heading">
          <Wrench size={19} aria-hidden="true" />
          <h3>Temporary admin UI ({toolName})</h3>
        </div>
        <p style={{ margin: "0 0 12px", opacity: 0.85 }}>
          Launch a short-lived, Basic-Auth protected {toolName} instance on the private project network. It automatically shuts down when the TTL expires.
        </p>

        {active && statusQuery.data ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div className="detail-row">
              <span>Status</span>
              <strong className="mono">Active until {statusQuery.data.expiresAt ? new Date(statusQuery.data.expiresAt).toLocaleTimeString() : "expiry"}</strong>
            </div>
            {statusQuery.data.url ? (
              <div className="detail-row">
                <span>URL</span>
                <a className="mono" href={statusQuery.data.url} target="_blank" rel="noreferrer">
                  {statusQuery.data.url} <ArrowUpRight size={13} aria-hidden="true" />
                </a>
              </div>
            ) : null}
            {credentials ? (
              <div className="info-notice" role="status">
                <ShieldCheck size={16} aria-hidden="true" />
                <span className="mono">
                  One-time Basic Auth credentials - user: <strong>{credentials.username}</strong> / password: <strong>{credentials.password}</strong>
                </span>
              </div>
            ) : null}
            <div>
              <button type="button" className="button" disabled={stopMutation.isPending} onClick={() => stopMutation.mutate()}>
                <Square size={14} aria-hidden="true" /> {stopMutation.isPending ? "Stopping..." : "Stop now"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Session TTL</span>
              <select value={ttlMinutes} onChange={(e) => setTtlMinutes(Number(e.target.value))} disabled={!isRunning || startMutation.isPending}>
                <option value={10}>10 minutes</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>60 minutes</option>
              </select>
            </label>
            <button
              type="button"
              className="button button-primary"
              disabled={!isRunning || startMutation.isPending}
              onClick={() => startMutation.mutate()}
            >
              {startMutation.isPending ? `Launching ${toolName}...` : `Launch ${toolName}`}
            </button>
          </div>
        )}
        {startMutation.error ? <div className="error-notice" role="alert">{errorMessage(startMutation.error)}</div> : null}
        {stopMutation.error ? <div className="error-notice" role="alert">{errorMessage(stopMutation.error)}</div> : null}
      </section>

      {isPg17 ? (
        <section className="surface details-card" aria-label="PostgreSQL 17 to 18 migration">
          <div className="card-heading">
            <Database size={19} aria-hidden="true" />
            <h3>Migrate to PostgreSQL 18</h3>
          </div>
          <p style={{ margin: "0 0 12px", opacity: 0.85 }}>
            Creates a new PostgreSQL 18 service, transfers a verified logical dump (<code>pg_dump</code> to <code>pg_restore</code>), and leaves this PostgreSQL 17 service intact as a safe fallback.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="mono"
              value={targetName}
              onChange={(e) => setTargetName(e.target.value)}
              pattern="[a-z0-9][a-z0-9-]*"
              maxLength={63}
              aria-label="Target PostgreSQL 18 service name"
              disabled={!isRunning || migrateMutation.isPending}
            />
            <button
              type="button"
              className="button button-primary"
              disabled={!isRunning || migrateMutation.isPending || !targetName.trim()}
              onClick={() => migrateMutation.mutate()}
            >
              {migrateMutation.isPending ? "Migrating to PostgreSQL 18..." : "Migrate to PostgreSQL 18"}
            </button>
          </div>
          {migrateMutation.error ? <div className="error-notice" role="alert">{errorMessage(migrateMutation.error)}</div> : null}
          {migrationResult ? (
            <div className="info-notice" role="status" style={{ marginTop: 10 }}>
              <ShieldCheck size={16} aria-hidden="true" />
              <span>
                Migrated {migrationResult.dumpSizeBytes} B (SHA-256 <code>{migrationResult.dumpSha256.slice(0, 12)}</code>) to{" "}
                <Link to="/services/$serviceId" params={{ serviceId: migrationResult.targetServiceId }}>
                  {migrationResult.targetServiceName}
                </Link>{" "}
                (PostgreSQL 18). This PG 17 service was kept unchanged.
              </span>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
