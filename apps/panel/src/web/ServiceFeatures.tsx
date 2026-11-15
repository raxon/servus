import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Box,
  Check,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  Folder,
  GitBranch,
  Globe2,
  HardDrive,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type {
  Action,
  ActionDetail,
  ConnectionInfo,
  ContainerInfo,
  DomainConfig,
  EnvironmentVariable,
  MountConfig,
  Project,
  Service,
  ServiceLogs,
  ServiceMetrics,
  SourceConfig,
} from "../shared/types.js";
import { api, errorMessage } from "./api.js";
import { DatabaseRestore } from "./DatabaseRestore.js";
import { combineEnvironment, formatEnvironment } from "./environment.js";
import { TerminalBoundary } from "./TerminalBoundary.js";
import {
  FeatureError,
  FeatureLoading,
  FeatureModal,
  SaveFooter,
  useServiceSave,
} from "./feature-ui.js";

const Console = lazy(() => import("./ServiceConsole.js"));
export type ServiceTab =
  | "overview"
  | "source"
  | "deployments"
  | "environment"
  | "domains"
  | "storage"
  | "resources"
  | "logs"
  | "console";
export const serviceTabs: { id: ServiceTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "source", label: "Source" },
  { id: "deployments", label: "Deployments" },
  { id: "environment", label: "Environment" },
  { id: "domains", label: "Domains" },
  { id: "storage", label: "Storage" },
  { id: "resources", label: "Resources" },
  { id: "logs", label: "Logs" },
  { id: "console", label: "Console" },
];

export function ServiceConfigurationPanel({
  service,
  tab,
  admin,
}: {
  service: Service;
  tab: ServiceTab;
  admin: boolean;
}) {
  if (tab === "source") return <SourcePanel service={service} />;
  if (tab === "environment") return <EnvironmentPanel service={service} />;
  if (tab === "domains") return <DomainsPanel service={service} />;
  if (tab === "storage")
    return <StoragePanel service={service} admin={admin} />;
  if (tab === "resources") return <ResourcesPanel service={service} />;
  if (tab === "logs") return <RuntimeLogs service={service} />;
  if (tab === "console")
    return (
      <TerminalBoundary key={service.id}>
        <Suspense
          fallback={
            <div className="surface loading-surface">
              <FeatureLoading label="Loading terminal" />
            </div>
          }
        >
          <Console service={service} />
        </Suspense>
      </TerminalBoundary>
    );
  return null;
}

function SourcePanel({ service }: { service: Service }) {
  const current = service.source ?? { type: "image" };
  const [type, setType] = useState<SourceConfig["type"]>(current.type);
  const [image, setImage] = useState(service.image);
  const [repository, setRepository] = useState(
    current.type === "git" ? current.repository : "",
  );
  const existingCredential = current.type === "git" ? current.credential : undefined;
  const [privateGit, setPrivateGit] = useState(Boolean(existingCredential));
  const [gitUsername, setGitUsername] = useState(existingCredential?.username ?? "");
  const [gitToken, setGitToken] = useState("");
  const [branch, setBranch] = useState(
    current.type === "git" ? current.branch : "main",
  );
  const [context, setContext] = useState(
    current.type === "git" ? current.context : ".",
  );
  const [dockerfile, setDockerfile] = useState(
    current.type === "git" ? current.dockerfile : "Dockerfile",
  );
  const save = useServiceSave(service);
  const isDatabase = service.kind && service.kind !== "app";
  return (
    <form
      className="surface configuration-card"
      onChange={() => save.reset()}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({
          image,
          source:
            type === "image"
              ? { type }
              : { type, repository, branch, context, dockerfile, ...(privateGit ? { credential: gitToken ? {username:gitUsername,token:gitToken} : {username:gitUsername,secretRef:existingCredential?.secretRef} } : {}) },
        }, { onSuccess: () => setGitToken("") });
      }}
    >
      <div className="configuration-intro">
        <div className="card-heading">
          <GitBranch size={19} />
          <h2>Application source</h2>
        </div>
        <p>
          Choose an image or build a Dockerfile from a Git repository.
        </p>
      </div>
      <fieldset className="configuration-fields" disabled={save.isPending}>
        <label>
          Source type
          <select
            value={type}
            onChange={(event) =>
              setType(event.target.value as SourceConfig["type"])
            }
            disabled={!!isDatabase}
          >
            <option value="image">Docker image</option>
            <option value="git">Git repository</option>
          </select>
        </label>
        {type === "image" ? (
          <label>
            Docker image
            <input
              className="mono"
              value={image}
              onChange={(event) => setImage(event.target.value)}
              required
              placeholder="nginx:alpine"
            />
            <small>
              Use a version tag or immutable digest for reproducible
              deployments.
            </small>
          </label>
        ) : (
          <>
            <label>
              Repository URL
              <input
                type="url"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="https://github.com/organization/application.git"
                required
              />
              <small>
                Use an HTTPS URL without credentials.
              </small>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={privateGit} onChange={(event) => setPrivateGit(event.target.checked)} />
              Private repository
            </label>
            {privateGit ? <>
              <label>Git username<input value={gitUsername} onChange={(event) => setGitUsername(event.target.value)} autoComplete="off" required /></label>
              <label>Access token<input type="password" value={gitToken} onChange={(event) => setGitToken(event.target.value)} autoComplete="new-password" required={!existingCredential?.secretRef || (current.type === "git" && (repository !== current.repository || gitUsername !== existingCredential.username))} /><small>{existingCredential?.secretRef ? "Leave empty to keep the saved token." : "The token is encrypted on this installation."}</small></label>
            </> : null}
            <label>
              Branch or ref
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                required
                placeholder="main"
              />
            </label>
            <div className="form-grid">
              <label>
                Build context
                <input
                  className="mono"
                  value={context}
                  onChange={(event) => setContext(event.target.value)}
                  required
                  placeholder="."
                />
                <small>Relative to the repository root.</small>
              </label>
              <label>
                Dockerfile
                <input
                  className="mono"
                  value={dockerfile}
                  onChange={(event) => setDockerfile(event.target.value)}
                  required
                  placeholder="Dockerfile"
                />
                <small>Relative to the build context.</small>
              </label>
            </div>
            <div className="info-notice">
              <FileCode2 size={17} />
              <span>
                Each deployment resolves the ref, checks out its commit and
                builds a new image. Build output appears in Deployments.
              </span>
            </div>
          </>
        )}
        <FeatureError error={save.error} />
      </fieldset>
      <SaveFooter pending={save.isPending} saved={save.isSuccess} />
    </form>
  );
}

interface SecretRow {
  id: string;
  name: string;
  secretRef?: string;
  value: string;
  replace: boolean;
}
const secretRows = (variables: EnvironmentVariable[] = []): SecretRow[] =>
  variables
    .filter((entry) => entry.secret || entry.secretRef)
    .map((entry) => ({
      id: crypto.randomUUID(),
      name: entry.name,
      secretRef: entry.secretRef,
      value: "",
      replace: !entry.secretRef,
    }));

function EnvironmentPanel({ service }: { service: Service }) {
  const [text, setText] = useState(
    formatEnvironment(service.environment ?? []),
  );
  const [secrets, setSecrets] = useState<SecretRow[]>(() =>
    secretRows(service.environment),
  );
  const [validation, setValidation] = useState<Error | null>(null);
  const save = useServiceSave(service);
  const update = (id: string, patch: Partial<SecretRow>) =>
    setSecrets((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  return (
    <form
      className="surface configuration-card feature-wide"
      onChange={() => {
        save.reset();
        setValidation(null);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const entries = secrets.map((row) => ({
            name: row.name,
            secret: true,
            ...(row.replace
              ? { value: row.value }
              : { secretRef: row.secretRef }),
          }));
          const environment = combineEnvironment(text, entries);
          save.mutate(
            { environment },
            {
              onSuccess: (value) => {
                setSecrets(secretRows(value.environment));
                setText(formatEnvironment(value.environment ?? []));
              },
            },
          );
        } catch (error) {
          setValidation(
            error instanceof Error
              ? error
              : new Error("Invalid environment variables."),
          );
        }
      }}
    >
      <div className="configuration-intro">
        <div className="card-heading">
          <FileCode2 size={19} />
          <h2>Environment variables</h2>
        </div>
        <p>
          Save variables for the next deployment. Stored secret values are never
          returned to this editor.
        </p>
      </div>
      <fieldset
        className="configuration-fields feature-full-width"
        disabled={save.isPending}
      >
        <label>
          Variables
          <textarea
            className="mono environment-editor"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={9}
            spellCheck={false}
            placeholder={"APP_ENV=production\nPORT=3000"}
          />
          <small>
            One KEY=value per line. Blank lines and # comments are allowed. No
            variable expansion or export prefix. Double-quoted values support
            JSON escapes such as {String.raw`\n`}. Raw multiline blocks are not
            supported.
          </small>
        </label>
        <div className="feature-section-heading">
          <div>
            <h3>Encrypted secrets</h3>
            <p>
              Keep an existing value, explicitly replace it, or remove its row.
            </p>
          </div>
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              setSecrets((rows) => [
                ...rows,
                { id: crypto.randomUUID(), name: "", value: "", replace: true },
              ])
            }
          >
            <Plus size={15} />
            Add secret
          </button>
        </div>
        {secrets.length ? (
          <div className="secret-rows">
            {secrets.map((row) => (
              <div className="secret-row" key={row.id}>
                <div className="secret-row-fields">
                  <label>
                    Variable name
                    <input
                      className="mono"
                      value={row.name}
                      onChange={(event) =>
                        update(row.id, { name: event.target.value })
                      }
                      placeholder="API_KEY"
                      pattern="[A-Za-z_][A-Za-z0-9_]*"
                      required
                    />
                  </label>
                  <label>
                    {row.secretRef && !row.replace
                      ? "Saved value"
                      : "Secret value"}
                    <input
                      type="password"
                      value={row.value}
                      onChange={(event) =>
                        update(row.id, { value: event.target.value })
                      }
                      disabled={!row.replace}
                      autoComplete="new-password"
                      placeholder={
                        row.secretRef && !row.replace
                          ? "Stored encrypted"
                          : "Enter a secret value"
                      }
                      required={!row.secretRef}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button remove-row"
                    aria-label={`Remove secret ${row.name || "row"}`}
                    onClick={() =>
                      setSecrets((rows) =>
                        rows.filter((item) => item.id !== row.id),
                      )
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
                {row.secretRef ? (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={row.replace}
                      onChange={(event) =>
                        update(row.id, {
                          replace: event.target.checked,
                          value: "",
                        })
                      }
                    />
                    Replace the stored value
                  </label>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="feature-empty-copy">
            No encrypted environment secrets configured.
          </p>
        )}
        <FeatureError error={validation ?? save.error} />
      </fieldset>
      <SaveFooter pending={save.isPending} saved={save.isSuccess} />
    </form>
  );
}

function DomainsPanel({ service }: { service: Service }) {
  const [domains, setDomains] = useState<(DomainConfig & { rowId: string })[]>(
    () =>
      (
        service.domains ?? [
          { hostname: service.hostname, port: service.port, primary: true },
        ]
      ).map((domain) => ({ ...domain, rowId: crypto.randomUUID() })),
  );
  const save = useServiceSave(service);
  const update = (id: string, patch: Partial<DomainConfig>) =>
    setDomains((rows) =>
      rows.map((row) => (row.rowId === id ? { ...row, ...patch } : row)),
    );
  return (
    <form
      className="surface configuration-card feature-wide"
      onChange={() => save.reset()}
      onSubmit={(event) => {
        event.preventDefault();
        const clean = domains.map(({ rowId, ...domain }) => domain);
        const primary = clean.find((domain) => domain.primary) ?? clean[0];
        save.mutate({
          domains: clean,
          ...(primary
            ? { hostname: primary.hostname, port: primary.port }
            : {}),
        });
      }}
    >
      <div className="configuration-intro">
        <div className="card-heading">
          <Globe2 size={19} />
          <h2>Domains</h2>
        </div>
        <p>
          Route HTTP hostnames to this service. Select one primary hostname for
          the Open app action.
        </p>
      </div>
      <fieldset
        className="configuration-fields feature-full-width"
        disabled={save.isPending}
      >
        {domains.map((row) => (
          <div className="domain-editor-row" key={row.rowId}>
            <label className="domain-primary">
              <input
                type="radio"
                name="primary-domain"
                checked={!!row.primary}
                onChange={() =>
                  setDomains((rows) =>
                    rows.map((item) => ({
                      ...item,
                      primary: item.rowId === row.rowId,
                    })),
                  )
                }
              />
              <span>Primary</span>
            </label>
            <label>
              Hostname
              <input
                value={row.hostname}
                onChange={(event) =>
                  update(row.rowId, { hostname: event.target.value })
                }
                placeholder="web.localhost"
                required
                autoCapitalize="none"
              />
            </label>
            <label>
              Container port
              <input
                type="number"
                min={1}
                max={65535}
                value={row.port}
                onChange={(event) =>
                  update(row.rowId, { port: Number(event.target.value) })
                }
                required
              />
            </label>
            <button
              type="button"
              className="icon-button remove-row"
              aria-label={`Remove domain ${row.hostname || "row"}`}
              onClick={() =>
                setDomains((rows) => {
                  const next = rows.filter((item) => item.rowId !== row.rowId);
                  if (!next.some((item) => item.primary) && next[0])
                    next[0] = { ...next[0], primary: true };
                  return next;
                })
              }
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button-small"
          disabled={!!service.kind && service.kind !== "app"}
          onClick={() =>
            setDomains((rows) => [
              ...rows,
              {
                rowId: crypto.randomUUID(),
                hostname: "",
                port: service.port,
                primary: rows.length === 0,
              },
            ])
          }
        >
          <Plus size={15} />
          Add domain
        </button>
        {!domains.length ? (
          <div className="info-notice">
            <Globe2 size={17} />
            <span>
              {service.kind && service.kind !== "app"
                ? "Managed databases use private TCP connections and do not expose HTTP domains."
                : "No public HTTP routes will be exposed after deployment."}
            </span>
          </div>
        ) : null}
        <FeatureError error={save.error} />
      </fieldset>
      <SaveFooter pending={save.isPending} saved={save.isSuccess} />
    </form>
  );
}

function StoragePanel({
  service,
  admin,
}: {
  service: Service;
  admin: boolean;
}) {
  const [mounts, setMounts] = useState<(MountConfig & { rowId: string })[]>(
    () =>
      (service.mounts ?? []).map((mount) => ({
        ...mount,
        rowId: crypto.randomUUID(),
      })),
  );
  const save = useServiceSave(service);
  const update = (id: string, patch: Partial<MountConfig>) =>
    setMounts((rows) =>
      rows.map((row) => (row.rowId === id ? { ...row, ...patch } : row)),
    );
  return (
    <form
      className="surface configuration-card feature-wide"
      onChange={() => save.reset()}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({
          mounts: mounts.map(({ rowId, ...mount }) =>
            mount.type === "file"
              ? { ...mount, content: mount.content ?? "", readOnly: true }
              : mount,
          ),
        });
      }}
    >
      <div className="configuration-intro">
        <div className="card-heading">
          <HardDrive size={19} />
          <h2>Persistent storage</h2>
        </div>
        <p>
          Managed volumes survive container replacement. File mounts contain the
          saved text. Host bind paths require administrator access.
        </p>
      </div>
      <fieldset
        className="configuration-fields feature-full-width"
        disabled={save.isPending}
      >
        {mounts.map((row) => (
          <div className="mount-editor" key={row.rowId}>
            <div className="feature-section-heading">
              <h3>
                {row.type === "volume"
                  ? "Managed volume"
                  : row.type === "file"
                    ? "Configuration file"
                    : "Host bind mount"}
              </h3>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove mount ${row.name || "row"}`}
                onClick={() =>
                  setMounts((rows) =>
                    rows.filter((item) => item.rowId !== row.rowId),
                  )
                }
              >
                <Trash2 size={17} />
              </button>
            </div>
            <div className="form-grid">
              <label>
                Type
                <select
                  value={row.type}
                  onChange={(event) =>
                    update(row.rowId, {
                      type: event.target.value as MountConfig["type"],
                      readOnly: event.target.value === "file",
                    })
                  }
                >
                  <option value="volume">Managed volume</option>
                  <option value="file">Text file</option>
                  <option value="bind" disabled={!admin}>
                    Host bind mount
                  </option>
                </select>
              </label>
              <label>
                Name
                <input
                  value={row.name}
                  onChange={(event) =>
                    update(row.rowId, { name: event.target.value })
                  }
                  required
                  pattern="[a-z0-9][a-z0-9-]*"
                  placeholder="data"
                />
              </label>
            </div>
            <label>
              Container target
              <input
                className="mono"
                value={row.target}
                onChange={(event) =>
                  update(row.rowId, { target: event.target.value })
                }
                required
                pattern="/.*"
                placeholder="/app/data"
              />
            </label>
            {row.type === "file" ? (
              <label>
                File contents
                <textarea
                  className="mono file-editor"
                  rows={7}
                  value={row.content ?? ""}
                  onChange={(event) =>
                    update(row.rowId, { content: event.target.value })
                  }
                  spellCheck={false}
                />
                <small>
                  File content is visible to users who can read this service
                  configuration. Use encrypted environment variables for
                  secrets.
                </small>
              </label>
            ) : null}
            {row.type === "bind" ? (
              <label>
                Approved host source
                <input
                  className="mono"
                  value={row.source ?? ""}
                  onChange={(event) =>
                    update(row.rowId, { source: event.target.value })
                  }
                  required
                  pattern="/.*"
                  placeholder="/var/lib/panel/mounts/data"
                  disabled={!admin}
                />
                <small>
                  The agent applies its allowed-root policy. Docker socket and
                  protected system paths are blocked.
                </small>
              </label>
            ) : null}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={row.type === "file" || !!row.readOnly}
                disabled={row.type === "file"}
                onChange={(event) =>
                  update(row.rowId, { readOnly: event.target.checked })
                }
              />
              Read-only inside the container
            </label>
          </div>
        ))}
        {!mounts.length ? (
          <p className="feature-empty-copy">
            No mounts configured. Data written only inside the container is
            replaced with the container.
          </p>
        ) : null}
        <button
          type="button"
          className="button button-small"
          onClick={() =>
            setMounts((rows) => [
              ...rows,
              {
                rowId: crypto.randomUUID(),
                type: "volume",
                name: "",
                target: "",
                readOnly: false,
              },
            ])
          }
        >
          <Plus size={15} />
          Add mount
        </button>
        <FeatureError error={save.error} />
      </fieldset>
      <SaveFooter pending={save.isPending} saved={save.isSuccess} />
    </form>
  );
}

function ResourcesPanel({ service }: { service: Service }) {
  const [cpu, setCpu] = useState(service.resources?.cpu ?? 1);
  const [memoryMb, setMemoryMb] = useState(service.resources?.memoryMb ?? 256);
  const [replicas, setReplicas] = useState(service.replicas);
  const save = useServiceSave(service);
  const database = !!service.kind && service.kind !== "app";
  return (
    <form
      className="surface configuration-card"
      onChange={() => save.reset()}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ replicas, resources: { cpu, memoryMb } });
      }}
    >
      <div className="configuration-intro">
        <div className="card-heading">
          <Settings2 size={19} />
          <h2>Resources and replicas</h2>
        </div>
        <p>
          Limit the resources available to each replica. Deploy after saving to
          apply the new limits.
        </p>
      </div>
      <fieldset className="configuration-fields" disabled={save.isPending}>
        <div className="form-grid">
          <label>
            CPU limit
            <input
              type="number"
              min={0.1}
              max={64}
              step={0.1}
              value={cpu}
              onChange={(event) => setCpu(Number(event.target.value))}
              required
            />
            <small>1 CPU means one logical processor.</small>
          </label>
          <label>
            Memory limit (MiB)
            <input
              type="number"
              min={32}
              max={131072}
              step={1}
              value={memoryMb}
              onChange={(event) => setMemoryMb(Number(event.target.value))}
              required
            />
          </label>
        </div>
        <label>
          Replicas
          <input
            type="number"
            min={1}
            max={database ? 1 : 5}
            value={replicas}
            onChange={(event) => setReplicas(Number(event.target.value))}
            required
            disabled={database}
          />
          {database ? (
            <small>
              Managed database services run one replica with local persistent
              storage.
            </small>
          ) : (
            <small>
              Each replica receives the configured CPU and memory limit.
            </small>
          )}
        </label>
        <FeatureError error={save.error} />
      </fieldset>
      <SaveFooter pending={save.isPending} saved={save.isSuccess} />
    </form>
  );
}

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
      : bytes >= 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${Math.round(bytes)} B`;

export function ServiceMetricsPanel({ service }: { service: Service }) {
  const enabled = service.state === "running";
  const metrics = useQuery({
    queryKey: ["service-metrics", service.id],
    queryFn: () => api<ServiceMetrics>(`/services/${service.id}/metrics`),
    enabled,
    refetchInterval: 3_000,
  });
  return (
    <section className="surface metrics-card">
      <div className="card-heading">
        <Activity size={18} />
        <h2>Runtime metrics</h2>
        <span className="metrics-source">
          {enabled
            ? "Current container measurements"
            : "Service is not running"}
        </span>
      </div>
      <FeatureError error={metrics.error} />
      {!enabled ? (
        <p className="feature-empty-copy">
          Metrics are available when the service is running.
        </p>
      ) : metrics.isPending ? (
        <FeatureLoading label="Reading container metrics" />
      ) : metrics.data ? (
        <div className="service-metrics-grid">
          <div>
            <span>CPU usage</span>
            <strong>
              {metrics.data.cpuPercent.toFixed(1)}
              <small>%</small>
            </strong>
          </div>
          <div>
            <span>Memory usage</span>
            <strong>{formatBytes(metrics.data.memoryBytes)}</strong>
            <small>Limit {formatBytes(metrics.data.memoryLimitBytes)}</small>
          </div>
          <div>
            <span>Network received</span>
            <strong>{formatBytes(metrics.data.networkRxBytes)}</strong>
            <small>Cumulative container counter</small>
          </div>
          <div>
            <span>Network sent</span>
            <strong>{formatBytes(metrics.data.networkTxBytes)}</strong>
            <small>Cumulative container counter</small>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function DatabaseConnection({ service, admin }: { service: Service; admin: boolean }) {
  const [visible, setVisible] = useState(false);
  const [revealed, setRevealed] = useState<ConnectionInfo | null>(null);
  const connection = useQuery({
    queryKey: ["connection", service.id, service.deployedRevision],
    queryFn: () => api<ConnectionInfo>(`/services/${service.id}/connection`),
  });
  const reveal = useMutation({
    mutationFn: () =>
      api<ConnectionInfo>(`/services/${service.id}/connection/reveal`, {
        method: "POST",
        body: {},
      }),
    onSuccess: (value) => {
      setRevealed(value);
      setVisible(true);
    },
  });
  const exportMutation = useMutation({
    mutationFn: async () => {
      const result = await api<{ downloadUrl: string }>(`/services/${service.id}/database-export`, { method: "POST", body: {} });
      const expected = `/api/v1/services/${service.id}/database-export/download`;
      if (result.downloadUrl !== expected) throw new Error("The export could not be downloaded.");
      return expected;
    },
    onSuccess: (url) => {
      const link = document.createElement("a");
      link.href = url;
      link.download = "";
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
    },
  });
  useEffect(() => {
    setVisible(false);
    setRevealed(null);
  }, [service.deployedRevision]);
  useEffect(() => {
    if (!visible) return;
    const timeout = setTimeout(() => {
      setVisible(false);
      setRevealed(null);
    }, 60_000);
    return () => clearTimeout(timeout);
  }, [visible]);
  return (
    <section className="surface details-card">
      <div className="card-heading">
        <Database size={18} />
        <h2>Database connection</h2>
      </div>
      <FeatureError error={connection.error ?? reveal.error ?? exportMutation.error} />
      {connection.isPending ? (
        <FeatureLoading label="Loading connection details" />
      ) : connection.data ? (
        <>
          <div className="detail-row">
            <span>Internal hostname</span>
            <strong className="mono">{connection.data.host}</strong>
          </div>
          <div className="detail-row">
            <span>Port</span>
            <strong className="mono">{connection.data.port}</strong>
          </div>
          <div className="detail-row">
            <span>Database</span>
            <strong className="mono">
              {connection.data.database || "Not applicable"}
            </strong>
          </div>
          <div className="detail-row">
            <span>Username</span>
            <strong className="mono">
              {connection.data.user || "Not applicable"}
            </strong>
          </div>
          <div className="connection-password">
            <label>
              Password
              <input
                type={visible ? "text" : "password"}
                value={visible ? (revealed?.password ?? "") : "************"}
                readOnly
                autoComplete="off"
                aria-label="Database password"
              />
            </label>
            <button
              className="button button-small"
              type="button"
              disabled={reveal.isPending}
              onClick={() => {
                if (visible) {
                  setVisible(false);
                  setRevealed(null);
                } else reveal.mutate();
              }}
            >
              {reveal.isPending ? (
                <FeatureLoading label="Loading" />
              ) : visible ? (
                <>
                  <EyeOff size={15} />
                  Hide
                </>
              ) : (
                <>
                  <Eye size={15} />
                  Reveal
                </>
              )}
            </button>
          </div>
          <p className="feature-helper">
            This address is reachable by services in the project network.
            Revealed credentials are hidden after one minute.
          </p>
          <div className="detail-row">
            <span>Database export</span>
            <button className="button button-small" type="button" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate()}>
              {exportMutation.isPending ? <FeatureLoading label="Preparing export" /> : <><Download size={15} /> Download</>}
            </button>
          </div>
          <p className="feature-helper">Exports up to 2 GiB of database data. Application files are not included.</p>
          {(service.kind === "postgres" || service.kind === "mariadb") && <DatabaseRestore service={service} admin={admin} />}
        </>
      ) : null}
    </section>
  );
}

function RuntimeLogs({ service }: { service: Service }) {
  const [live, setLive] = useState(false);
  const [lines, setLines] = useState<string[] | null>(null);
  const [connection, setConnection] = useState("Snapshot");
  const [streamError, setStreamError] = useState<string | null>(null);
  const output = useRef<HTMLPreElement>(null);
  const snapshot = useQuery({
    queryKey: ["runtime-logs", service.id],
    queryFn: () => api<ServiceLogs>(`/services/${service.id}/logs`),
    enabled: !live,
  });
  useEffect(() => {
    if (!live) return;
    setConnection("Connecting");
    setStreamError(null);
    setLines([]);
    const stream = new EventSource(
      `/api/v1/services/${service.id}/logs/stream`,
    );
    stream.onopen = () => {
      setConnection("Live");
      setStreamError(null);
    };
    stream.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ServiceLogs;
        if (!Array.isArray(message.lines)) return;
        setConnection("Live");
        setStreamError(null);
        setLines((previous) =>
          [...(previous ?? []), ...message.lines].slice(-2_000),
        );
      } catch {
        setStreamError("The log stream returned an unreadable event.");
      }
    };
    stream.addEventListener("unavailable", () => {
      setConnection("Unavailable");
      setStreamError(
        "The agent cannot read runtime logs. The stream will retry automatically.",
      );
    });
    stream.onerror = () => {
      setConnection("Reconnecting");
      setStreamError(
        "Log stream interrupted. Reconnecting with the last received cursor.",
      );
    };
    return () => {
      stream.close();
      setConnection("Paused");
    };
  }, [live, service.id]);
  const displayed = lines ?? snapshot.data?.lines ?? [];
  return (
    <section className="surface live-logs-card">
      <div className="feature-panel-heading">
        <div>
          <h2>Runtime logs</h2>
          <p>
            Application output from Docker. The display retains the latest 2,000
            streamed lines.
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="button button-small"
            type="button"
            disabled={live || snapshot.isFetching}
            onClick={() => {
              setLines(null);
              void snapshot.refetch();
            }}
          >
            <RefreshCw size={15} />
            Refresh
          </button>
          <button
            className="button button-small"
            type="button"
            onClick={() => setLive((value) => !value)}
          >
            {live ? "Pause stream" : "Follow live"}
          </button>
        </div>
      </div>
      <div className="live-log-status">
        <span
          className={`status-dot ${live && connection === "Live" ? "" : "offline"}`}
        />
        {live ? connection : lines ? "Paused" : "Snapshot"}
      </div>
      <FeatureError error={snapshot.error} />
      {streamError ? (
        <p className="feature-helper stream-error" role="status">
          {streamError}
        </p>
      ) : null}
      <pre
        className="runtime-log-output"
        ref={output}
        role="log"
        aria-label="Runtime application logs"
        aria-live="off"
      >
        {snapshot.isPending && !live
          ? "Reading logs..."
          : displayed.length
            ? displayed.join("\n")
            : "No runtime output is available."}
      </pre>
      <p className="feature-helper">
        Runtime output may contain application data. Pause the stream to inspect
        a fixed snapshot.
      </p>
    </section>
  );
}

export function DestroyService({
  service,
  busy,
  onStarted,
  onFailure,
  onDestroyed,
}: {
  service: Service;
  busy: boolean;
  onStarted: () => void;
  onFailure: () => void;
  onDestroyed: () => void;
}) {
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);
  const [deletionError, setDeletionError] = useState<Error | null>(null);
  const remove = useMutation({
    mutationFn: () =>
      api<Action>(`/services/${service.id}`, {
        method: "DELETE",
        idempotent: true,
      }),
    onSuccess: (action) => {
      setActionId(action.id);
      onStarted();
    },
  });
  const status = useQuery({
    queryKey: ["destroy-action", actionId],
    queryFn: () => api<ActionDetail>(`/actions/${actionId}`),
    enabled: !!actionId,
    refetchInterval: (query) =>
      query.state.data &&
      ["succeeded", "failed", "cancelled"].includes(
        query.state.data.action.status,
      )
        ? false
        : 1_000,
  });
  useEffect(() => {
    if (status.data?.action.status === "succeeded") onDestroyed();
    else if (
      status.data &&
      ["failed", "cancelled"].includes(status.data.action.status)
    ) {
      setDeletionError(
        new Error(
          status.data.action.error ??
            "Deletion did not complete. Inspect the action history before retrying.",
        ),
      );
      setActionId(null);
      onFailure();
    }
  }, [status.data?.action.status, onDestroyed, onFailure]);
  return (
    <>
      <section className="surface danger-zone">
        <div>
          <h2>Delete service</h2>
          <p>
            Remove its running containers and HTTP routes. Existing managed data
            is retained.
          </p>
        </div>
        <button
          className="button button-danger"
          type="button"
          disabled={busy}
          onClick={() => setShow(true)}
        >
          <Trash2 size={16} />
          Delete service
        </button>
      </section>
      {show ? (
        <FeatureModal
          dismissible={!actionId}
          title={`Delete ${service.name}?`}
          description="This stops the workload and removes its service configuration from the project. Existing managed data is retained and will not be automatically attached to a new service."
          onClose={() => {
            if (!actionId) setShow(false);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (confirm === service.name && !actionId) {
                setDeletionError(null);
                remove.mutate();
              }
            }}
          >
            <label>
              Type {service.name} to confirm
              <input
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                required
                disabled={!!actionId}
              />
            </label>
            <FeatureError
              error={deletionError ?? remove.error ?? status.error}
            />
            {status.data?.action.error ? (
              <FeatureError error={new Error(status.data.action.error)} />
            ) : null}
            {actionId ? (
              <div className="info-notice">
                <Terminal size={17} />
                <span>
                  {status.data?.action.status === "failed"
                    ? "Deletion failed. Inspect the operation output before retrying."
                    : `Removing service: ${status.data?.action.phase ?? "queued"}. This page will return to the project when complete.`}
                </span>
              </div>
            ) : null}
            <div className="modal-footer">
              <button
                className="button"
                type="button"
                disabled={!!actionId}
                onClick={() => setShow(false)}
              >
                Cancel
              </button>
              <button
                className="button button-danger"
                type="submit"
                disabled={
                  confirm !== service.name || remove.isPending || !!actionId
                }
              >
                {remove.isPending ||
                (actionId &&
                  !["failed", "cancelled"].includes(
                    status.data?.action.status ?? "",
                  )) ? (
                  <FeatureLoading label="Deleting" />
                ) : (
                  "Delete service"
                )}
              </button>
            </div>
          </form>
        </FeatureModal>
      ) : null}
    </>
  );
}

export function ProjectSettings({
  project,
  onDeleted,
}: {
  project: Project;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [confirmation, setConfirmation] = useState("");
  const update = useMutation({
    mutationFn: () =>
      api<Project>(`/projects/${project.id}`, {
        method: "PATCH",
        body: { name, description },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/projects/${project.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      onDeleted();
    },
  });
  return (
    <>
      <button
        type="button"
        className="button"
        onClick={() => {
          setName(project.name);
          setDescription(project.description);
          setOpen(true);
        }}
      >
        <Settings2 size={16} />
        Project settings
      </button>
      {open ? (
        <FeatureModal
          title="Project settings"
          description="Rename the project or update its description. Runtime resource identities remain stable."
          onClose={() => setOpen(false)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate();
            }}
          >
            <label>
              Project name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                pattern="[a-z0-9][a-z0-9-]*"
                required
                maxLength={63}
              />
            </label>
            <label>
              Description
              <textarea
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={500}
              />
            </label>
            <FeatureError error={update.error} />
            <div className="modal-footer">
              <button
                className="button"
                type="button"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={update.isPending}
              >
                {update.isPending ? (
                  <FeatureLoading label="Saving" />
                ) : (
                  "Save project"
                )}
              </button>
            </div>
          </form>
          <div className="project-delete-section">
            <h3>Delete empty project</h3>
            <p>
              {project.serviceCount
                ? "Remove all services before deleting this project."
                : "This permanently removes the empty project."}
            </p>
            {!project.serviceCount ? (
              <>
                <label>
                  Type {project.name} to confirm
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button
                  className="button button-danger"
                  type="button"
                  disabled={confirmation !== project.name || remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? (
                    <FeatureLoading label="Deleting" />
                  ) : (
                    "Delete project"
                  )}
                </button>
                <FeatureError error={remove.error} />
              </>
            ) : null}
          </div>
        </FeatureModal>
      ) : null}
    </>
  );
}
