import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Globe2, ScanLine } from "lucide-react";
import type { ConnectionInfo, Service } from "../shared/types.js";
import { databasePortAllowed, normalizedDatabaseAccess } from "../shared/database-access.js";
import { api } from "./api.js";
import { FeatureError, useServiceSave } from "./feature-ui.js";
import "./DatabaseExternalAccess.css";

export function DatabaseExternalAccess({ service, connection, canManage, canReveal, password }: {
  service: Service;
  connection?: ConnectionInfo;
  canManage: boolean;
  canReveal: boolean;
  password?: string;
}) {
  const headingId = useId();
  const saved = normalizedDatabaseAccess(service.databaseAccess);
  const deployed = connection?.externalAccess?.deployed;
  const host = connection?.externalAccess?.host;
  const pending = saved.enabled
    ? !deployed?.enabled || saved.publishedPort !== deployed.publishedPort
    : deployed?.enabled === true;
  const status = !connection && service.deployedRevision !== null ? "Unavailable"
    : !deployed?.enabled ? "Private"
    : service.state === "stopped" ? "Stopped"
    : connection?.runtimeVerified ? "Published" : "Last deployed";

  return <section className="database-external-access" aria-labelledby={headingId}>
    <div className="database-external-heading">
      <h3 id={headingId}><Globe2 size={17} aria-hidden="true" />External access</h3>
      <span className="database-access-status" data-live={status === "Published"}>{status}</span>
    </div>
    {canManage && <ExternalAccessForm key={service.id} service={service} headingId={headingId} />}
    {pending && <p className="database-access-pending" role="status">{saved.enabled ? `TCP port ${saved.publishedPort} saved.` : "Private access saved."} Deploy to apply the change.</p>}
    {deployed?.enabled && <>
      <div className="detail-row"><span>External host</span><strong className="mono">{host ?? "Server hostname or IP"}</strong></div>
      <div className="detail-row"><span>Published port</span><strong className="mono">{deployed.publishedPort}</strong></div>
      {host && connection && canReveal && <DatabaseConnectionString label="External connection URL" kind={service.kind} connection={connection} host={host} port={deployed.publishedPort} password={password} />}
    </>}
    {connection?.runtimeVerified === false && deployed?.enabled && <p className="feature-helper">Live port mapping could not be verified.</p>}
  </section>;
}

export function DatabaseConnectionString({ label, kind, connection, host, port, password }: {
  label: string;
  kind: Service["kind"];
  connection: ConnectionInfo;
  host: string;
  port: number;
  password?: string;
}) {
  const scheme = kind === "postgres" ? "postgresql" : kind === "redis" ? "redis" : "mysql";
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = password === undefined ? undefined : `${scheme}://${encodeURIComponent(connection.user)}:${encodeURIComponent(password)}@${address}:${port}/${encodeURIComponent(connection.database)}`;
  return <label className="database-connection-string">{label}
    <input className="mono" type={url ? "text" : "password"} value={url ?? "************"} readOnly autoComplete="off" spellCheck={false} onFocus={event => { if (url) event.currentTarget.select(); }} />
  </label>;
}

type AccessDraft = { enabled: boolean; port: string; revision: number };

function ExternalAccessForm({ service, headingId }: { service: Service; headingId: string }) {
  const id = useId();
  const current = normalizedDatabaseAccess(service.databaseAccess);
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [validationError, setValidationError] = useState("");
  const portInput = useRef<HTMLInputElement>(null);
  const value = draft ?? { enabled: current.enabled, port: current.enabled ? String(current.publishedPort) : "", revision: service.revision };
  const { enabled, port } = value;
  const save = useServiceSave(service, value.revision);
  const suggest = useMutation({
    mutationFn: () => api<{ port: number }>(`/services/${service.id}/database-port-suggestion`),
  });
  useEffect(() => {
    if (!("switch" in HTMLInputElement.prototype)) void import("input-switch-polyfill");
  }, []);
  const publishedPort = Number(port);
  const changed = enabled !== current.enabled || (enabled && current.enabled && publishedPort !== current.publishedPort);

  function clearValidation() {
    portInput.current?.setCustomValidity("");
    setValidationError("");
    save.reset();
  }

  function update(update: Partial<Pick<AccessDraft, "enabled" | "port">>) {
    clearValidation();
    suggest.reset();
    setDraft({ ...value, ...update });
  }

  return (
    <form className="database-access-form" aria-labelledby={headingId} method="post" action={`/api/v1/services/${service.id}`} onSubmit={(event) => {
      event.preventDefault();
      if (!changed || save.isPending || suggest.isPending) return;
      if (enabled && !databasePortAllowed(publishedPort)) {
        const message = "Choose a different port. This one is reserved for Servus or Docker.";
        setValidationError(message);
        portInput.current?.setCustomValidity(message);
        portInput.current?.reportValidity();
        return;
      }
      save.mutate({ databaseAccess: enabled ? { enabled: true, publishedPort } : { enabled: false } }, {
        onSuccess: () => {
          setDraft(null);
          suggest.reset();
        },
      });
    }}>
      <label className="database-access-toggle">
        <span>Expose database over TCP</span>
        <input type="checkbox" name="enabled" role="switch" {...{ switch: "" }} checked={enabled}
          disabled={save.isPending} onChange={(event) => update({ enabled: event.target.checked })} />
      </label>
      {enabled && <div className="database-access-port">
        <label htmlFor={`${id}-port`}>External port</label>
        <div className="database-access-port-controls">
          <input id={`${id}-port`} name="publishedPort" ref={portInput} type="number" inputMode="numeric"
            min={1024} max={65535} step={1} required value={port} placeholder="1024–65535"
            disabled={save.isPending} onChange={(event) => update({ port: event.target.value })}
            aria-invalid={validationError ? true : undefined}
            aria-describedby={`${id}-port-help${validationError ? ` ${id}-port-error` : ""}`} />
          <button className="button button-small" type="button" disabled={suggest.isPending || save.isPending} onClick={() => {
            clearValidation();
            suggest.mutate(undefined, {
              onSuccess: ({ port: available }) => setDraft({ ...value, port: String(available) }),
            });
          }}>
            <ScanLine size={16} aria-hidden="true" />
            {suggest.isPending ? "Checking ports…" : "Suggest free port"}
          </button>
        </div>
        <p className="feature-helper" id={`${id}-port-help`}>Use a TCP port from 1024 to 65535. Allow only trusted IPs in the server firewall.</p>
        {suggest.isSuccess ? <p className="feature-helper" role="status">Port {suggest.data.port} was free when checked.</p> : null}
        {validationError ? <p className="database-access-error" id={`${id}-port-error`} role="alert">{validationError}</p> : null}
        <FeatureError error={suggest.error} />
      </div>}
      <FeatureError error={save.error} />
      {(changed || save.isPending || save.error) && <div className="database-access-actions">
        <button type="button" className="button button-small" disabled={save.isPending} onClick={() => {
          clearValidation();
          suggest.reset();
          setDraft(null);
        }}>Discard</button>
        <button type="submit" className="button button-primary button-small" disabled={!changed || save.isPending || suggest.isPending}>{save.isPending ? "Saving…" : "Save access"}</button>
      </div>}
    </form>
  );
}
