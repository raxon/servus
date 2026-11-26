import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Layers, Plus } from 'lucide-react';
import type { ComposeAction, ComposeCertificateStatus, ComposeConfiguration, ComposeWorkload } from '../shared/compose.js';
import type { ServiceMetrics } from '../shared/types.js';
import { api } from './api.js';
import { FeatureError, FeatureLoading, FeatureModal } from './feature-ui.js';

const initial = 'services:\n  web:\n    image: nginx:alpine\n    restart: unless-stopped\n';

export function ComposeProjects({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const buildHelpId = useId();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [source, setSource] = useState<'inline' | 'git'>('inline');
  const [yaml, setYaml] = useState(initial);
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('main');
  const [path, setPath] = useState('compose.yaml');
  const [sharedGithub, setSharedGithub] = useState(false);
  const [gitUsername, setGitUsername] = useState('');
  const [gitToken, setGitToken] = useState('');

  const query = useQuery({
    queryKey: ['compose-project', projectId],
    queryFn: ({ signal }) => api<ComposeWorkload[]>(`/projects/${projectId}/compose`, { signal }),
    refetchInterval: 3000,
  });

  const create = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/compose`, {
        method: 'POST',
        idempotent: true,
        body: {
          name,
          source:
            source === 'inline'
              ? { type: 'inline', yaml }
              : {
                  type: 'git',
                  repository,
                  branch,
                  path,
                  ...(sharedGithub
                    ? { sharedGithub: true }
                    : gitToken.trim()
                      ? { credential: { username: gitUsername.trim() || 'git', token: gitToken.trim() } }
                      : {}),
                },
          domains: [],
        },
      }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      setSharedGithub(false);
      setGitUsername('');
      setGitToken('');
      void client.invalidateQueries({ queryKey: ['compose-project', projectId] });
    },
  });

  return (
    <section className="surface details-card">
      <div className="settings-card-header">
        <div className="settings-card-intro">
          <div className="card-heading">
            <Layers size={18} aria-hidden="true" />
            <h2>Compose workloads</h2>
          </div>
          <p>
            Deploy multi-container stacks from inline YAML or a public/private Git repository. Supports named volumes, BuildKit build secrets, additional build contexts, and unprivileged published ports (1024-65535).
          </p>
        </div>
        {canWrite ? (
          <button className="button button-primary button-small" type="button" onClick={() => setOpen(true)}>
            <Plus size={15} aria-hidden="true" />
            New Compose workload
          </button>
        ) : null}
      </div>

      <FeatureError error={query.error} />
      {query.isPending ? (
        <FeatureLoading label="Loading Compose workloads" />
      ) : query.data?.length ? (
        <div className="compose-card-list">
          {query.data.map((item) => (
            <ComposeItem key={item.id} workload={item} canWrite={canWrite} />
          ))}
        </div>
      ) : (
        <div className="settings-empty">
          <Layers size={18} aria-hidden="true" />
          <div>
            <strong>No Compose workloads yet</strong>
            <p>Create a multi-service Docker Compose stack or launch a pinned application template.</p>
          </div>
        </div>
      )}

      {open ? (
        <FeatureModal
          title="New Compose workload"
          description="Configuration is stored encrypted. Creating a workload queues its build and deployment."
          onClose={() => setOpen(false)}
        >
          <form
            className="settings-modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <fieldset className="settings-form-fields" disabled={create.isPending}>
              <legend className="sr-only">Compose configuration</legend>
              <label>
                Name
                <input name="compose-name" className="mono" value={name} required pattern="[a-z0-9][a-z0-9_\-]*" maxLength={63} placeholder="my-stack" onChange={(event) => setName(event.target.value)} />
              </label>

              <div className="servus-field">
                <span className="servus-field-label">Source</span>
                <div className="compose-radio-row">
                  <label>
                    <input type="radio" name="compose-source" checked={source === 'inline'} onChange={() => setSource('inline')} />
                    Inline YAML
                  </label>
                  <label>
                    <input type="radio" name="compose-source" checked={source === 'git'} onChange={() => setSource('git')} />
                    Git repository
                  </label>
                </div>
              </div>

              {source === 'inline' ? (
                <label>
                  Compose YAML
                  <textarea
                    name="compose-yaml"
                    aria-describedby={buildHelpId}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="mono"
                    rows={10}
                    value={yaml}
                    required
                    maxLength={262144}
                    onChange={(event) => setYaml(event.target.value)}
                  />
                </label>
              ) : (
                <>
                  <label>
                    Repository URL
                    <input name="compose-repository" type="url" required value={repository} placeholder="https://github.com/org/repo.git" onChange={(event) => setRepository(event.target.value)} />
                  </label>
                  <div className="settings-form-pair">
                    <label>
                      Branch
                      <input name="compose-branch" className="mono" required value={branch} onChange={(event) => setBranch(event.target.value)} />
                    </label>
                    <label>
                      Compose file path
                      <input name="compose-path" className="mono" required value={path} onChange={(event) => setPath(event.target.value)} />
                    </label>
                  </div>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={sharedGithub} onChange={(event) => setSharedGithub(event.target.checked)} />
                    Use shared GitHub credential (github.com)
                  </label>
                  {!sharedGithub ? (
                    <div className="settings-form-pair">
                      <label>
                        Git username (optional)
                        <input name="compose-git-user" value={gitUsername} placeholder="x-access-token" onChange={(event) => setGitUsername(event.target.value)} />
                      </label>
                      <label>
                        Git access token (optional)
                        <input name="compose-git-token" type="password" value={gitToken} onChange={(event) => setGitToken(event.target.value)} />
                      </label>
                    </div>
                  ) : null}
                </>
              )}
              <ComposeBuildHelp sourceType={source} id={buildHelpId} />
              <FeatureError error={create.error} />
            </fieldset>

            <div className="settings-modal-actions">
              <button type="button" className="button" onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={create.isPending}>
                {create.isPending ? 'Queuing...' : 'Create and deploy'}
              </button>
            </div>
          </form>
        </FeatureModal>
      ) : null}
    </section>
  );
}

function ComposeItem({ workload, canWrite }: { workload: ComposeWorkload; canWrite: boolean }) {
  const buildHelpId = useId();
  const client = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ComposeConfiguration | null>(null);
  const [expectedRevision, setExpectedRevision] = useState(workload.revision);
  const actions = useQuery({
    queryKey: ['compose-actions', workload.id],
    queryFn: ({ signal }) => api<ComposeAction[]>(`/compose/${workload.id}/actions`, { signal }),
    enabled: expanded,
    refetchInterval: expanded ? 2000 : false,
  });
  const logs = useQuery({
    queryKey: ['compose-logs', workload.id],
    queryFn: ({ signal }) => api<{ logs: string }>(`/compose/${workload.id}/logs`, { signal }),
    enabled: expanded && workload.deployedRevision !== null,
    refetchInterval: expanded ? 5000 : false,
  });
  const metrics = useQuery({
    queryKey: ['compose-metrics', workload.id],
    queryFn: ({ signal }) => api<ServiceMetrics>(`/compose/${workload.id}/metrics`, { signal }),
    enabled: expanded && workload.deployedRevision !== null,
    refetchInterval: expanded ? 5000 : false,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['compose-project', workload.projectId] });
    void client.invalidateQueries({ queryKey: ['compose-actions', workload.id] });
  };
  const operation = useMutation({
    mutationFn: (type: string) =>
      api(`/compose/${workload.id}/${type}`, {
        method: 'POST',
        idempotent: true,
        ...(type === 'destroy' ? { body: { confirm: true } } : {}),
      }),
    onSuccess: refresh,
  });
  const load = useMutation({
    mutationFn: () => api<ComposeConfiguration>(`/compose/${workload.id}/configuration`),
    onSuccess: (value) => {
      setDraft(value);
      setExpectedRevision(workload.revision);
      setEditing(true);
    },
  });
  const save = useMutation({
    mutationFn: () => api(`/compose/${workload.id}`, { method: 'PATCH', body: { ...draft, expectedRevision } }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const busy = operation.isPending || actions.data?.some((item) => item.status === 'queued' || item.status === 'running');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [verified, setVerified] = useState<Record<string, boolean>>({});

  return (
    <article className="compose-workload-card">
      <div className="compose-workload-head">
        <h3>
          <span>{workload.name}</span>
          <span className={`badge status-${workload.state}`}>{workload.state}</span>
        </h3>
        <span className="servus-help mono">
          Rev {workload.revision} · Deployed {workload.deployedRevision ?? 'none'}
        </span>
      </div>

      {workload.domains.length ? (
        <div className="servus-inline-row">
          {workload.domains.map((domain) => (
            <a
              key={domain.hostname}
              className="button button-small mono"
              href={`${domain.https ? 'https' : 'http'}://${domain.hostname}`}
              target="_blank"
              rel="noreferrer"
            >
              {domain.hostname} → {domain.service}:{domain.port}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          ))}
        </div>
      ) : null}

      {canWrite
        ? workload.domains
            .filter((domain) => domain.https)
            .map((domain) => (
              <ComposeCertificate
                key={`${domain.hostname}:${workload.deployedRevision}`}
                workloadId={workload.id}
                hostname={domain.hostname}
                busy={Boolean(busy)}
                onVerified={(value) => setVerified((previous) => ({ ...previous, [domain.hostname]: value }))}
                onQueued={refresh}
              />
            ))
        : null}

      <div className="heading-actions" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="button button-small" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Hide details' : 'Details and logs'}
        </button>
        {canWrite ? (
          <>
            <button type="button" className="button button-small" disabled={load.isPending} onClick={() => load.mutate()}>
              Edit configuration
            </button>
            {(['deploy', 'start', 'stop', 'restart'] as const).map((type) => (
              <button
                className="button button-small"
                key={type}
                type="button"
                disabled={busy || (type !== 'deploy' && workload.deployedRevision === null)}
                onClick={() => operation.mutate(type)}
              >
                {type[0]!.toUpperCase() + type.slice(1)}
              </button>
            ))}
            <button type="button" className="button button-small button-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Remove
            </button>
          </>
        ) : null}
      </div>

      <FeatureError error={operation.error || load.error} />
      {workload.lastError ? <div className="error-notice" role="alert" style={{ margin: 0 }}>{workload.lastError}</div> : null}

      {expanded ? (
        <div className="servus-subpanel">
          <FeatureError error={actions.error} />
          {actions.data?.map((item) => (
            <details key={item.id}>
              <summary className="mono">{item.type}: {item.status}</summary>
              {item.error ? <p role="alert">{item.error}</p> : null}
              <pre className="servus-terminal-pre" style={{ background: '#171c19', borderRadius: 8, marginTop: 6 }}>{item.logs}</pre>
            </details>
          ))}
          <h4 style={{ margin: 0, fontSize: 13 }}>Runtime metrics</h4>
          {metrics.data && typeof metrics.data.cpuPercent === 'number' ? (
            <dl className="host-storage-kpis" aria-label={`Metrics for ${workload.name}`} style={{ margin: 0 }}>
              <div className="host-storage-kpi"><dt><span>CPU</span></dt><dd style={{ margin: 0 }}><strong className="mono">{metrics.data.cpuPercent.toFixed(1)}%</strong></dd></div>
              <div className="host-storage-kpi"><dt><span>Memory</span></dt><dd style={{ margin: 0 }}><strong className="mono">{(metrics.data.memoryBytes / 1048576).toFixed(1)} MiB</strong></dd></div>
              <div className="host-storage-kpi"><dt><span>Containers</span></dt><dd style={{ margin: 0 }}><strong className="mono">{metrics.data.containers}</strong></dd></div>
              <div className="host-storage-kpi"><dt><span>Network RX / TX</span></dt><dd style={{ margin: 0 }}><strong className="mono">{(metrics.data.networkRxBytes / 1048576).toFixed(2)} / {(metrics.data.networkTxBytes / 1048576).toFixed(2)} MiB</strong></dd></div>
            </dl>
          ) : (
            <p className="servus-help">{metrics.isPending ? 'Loading runtime metrics...' : 'Runtime metrics unavailable.'}</p>
          )}
          <h4 style={{ margin: 0, fontSize: 13 }}>Runtime logs</h4>
          <FeatureError error={logs.error} />
          <div className="servus-terminal-box">
            <pre className="servus-terminal-pre">{logs.data?.logs ?? 'No runtime logs available.'}</pre>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <FeatureModal
          title="Remove Compose workload?"
          description="Containers and private networks will be removed. Named volumes are retained; this operation does not delete application data."
          onClose={() => setConfirmDelete(false)}
        >
          <div style={{ padding: '16px 24px 0' }}><FeatureError error={operation.error} /></div>
          <div className="settings-modal-actions" style={{ padding: '16px 24px' }}>
            <button type="button" className="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button
              type="button"
              className="button button-danger"
              disabled={operation.isPending}
              onClick={() => operation.mutate('destroy', { onSuccess: () => setConfirmDelete(false) })}
            >
              Remove workload and retain volumes
            </button>
          </div>
        </FeatureModal>
      ) : null}

      {editing && draft ? (
        <FeatureModal
          title="Edit Compose configuration"
          description="Save records the next configuration. Deploy applies it to running containers."
          onClose={() => setEditing(false)}
        >
          <form
            className="settings-modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <fieldset className="settings-form-fields" disabled={save.isPending}>
              <legend className="sr-only">Compose settings</legend>
              {draft.source.type === 'inline' ? (
                <label>
                  Compose YAML
                  <textarea
                    name="compose-yaml"
                    aria-describedby={buildHelpId}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="mono"
                    rows={10}
                    required
                    maxLength={262144}
                    value={draft.source.yaml}
                    onChange={(event) => setDraft({ ...draft, source: { type: 'inline', yaml: event.target.value } })}
                  />
                </label>
              ) : (
                <>
                  <label>
                    Repository URL
                    <input
                      type="url"
                      required
                      value={draft.source.repository}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          source: { ...(draft.source as Extract<ComposeConfiguration['source'], { type: 'git' }>), repository: event.target.value },
                        })
                      }
                    />
                  </label>
                  <div className="settings-form-pair">
                    <label>
                      Branch
                      <input
                        className="mono"
                        required
                        value={draft.source.branch}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            source: { ...(draft.source as Extract<ComposeConfiguration['source'], { type: 'git' }>), branch: event.target.value },
                          })
                        }
                      />
                    </label>
                    <label>
                      Compose file path
                      <input
                        className="mono"
                        required
                        value={draft.source.path}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            source: { ...(draft.source as Extract<ComposeConfiguration['source'], { type: 'git' }>), path: event.target.value },
                          })
                        }
                      />
                    </label>
                  </div>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.source.sharedGithub)}
                      onChange={(event) => {
                        const git = draft.source as Extract<ComposeConfiguration['source'], { type: 'git' }>;
                        setDraft({
                          ...draft,
                          source: { ...git, sharedGithub: event.target.checked, credential: event.target.checked ? undefined : git.credential },
                        });
                      }}
                    />
                    Use shared GitHub credential (github.com)
                  </label>
                  {!draft.source.sharedGithub ? (
                    <div className="settings-form-pair">
                      <label>
                        Git username (optional)
                        <input
                          value={draft.source.credential?.username ?? ''}
                          placeholder="x-access-token"
                          onChange={(event) => {
                            const git = draft.source as Extract<ComposeConfiguration['source'], { type: 'git' }>;
                            setDraft({
                              ...draft,
                              source: { ...git, credential: event.target.value || git.credential?.token ? { username: event.target.value, token: git.credential?.token } : undefined },
                            });
                          }}
                        />
                      </label>
                      <label>
                        Git access token
                        <input
                          type="password"
                          value={draft.source.credential?.token ?? ''}
                          placeholder={(draft.source.credential as { hasToken?: boolean } | undefined)?.hasToken ? 'Saved token present' : ''}
                          onChange={(event) => {
                            const git = draft.source as Extract<ComposeConfiguration['source'], { type: 'git' }>;
                            setDraft({
                              ...draft,
                              source: {
                                ...git,
                                credential:
                                  event.target.value || git.credential?.username
                                    ? { username: git.credential?.username || 'git', token: event.target.value || undefined }
                                    : undefined,
                              },
                            });
                          }}
                        />
                      </label>
                    </div>
                  ) : null}
                </>
              )}

              <ComposeBuildHelp sourceType={draft.source.type} id={buildHelpId} />

              <h3 style={{ fontSize: 14, margin: '6px 0 0' }}>Domains</h3>
              {draft.domains.map((domain, index) => (
                <fieldset key={index} className="storage-credentials">
                  <legend>Domain {index + 1}</legend>
                  <div className="settings-form-fields">
                    <label>
                      Hostname
                      <input
                        className="mono"
                        required
                        value={domain.hostname}
                        onChange={(event) =>
                          setDraft({ ...draft, domains: draft.domains.map((entry, i) => (i === index ? { ...entry, hostname: event.target.value } : entry)) })
                        }
                      />
                    </label>
                    <div className="settings-form-pair">
                      <label>
                        Compose service
                        <input
                          className="mono"
                          required
                          value={domain.service}
                          onChange={(event) =>
                            setDraft({ ...draft, domains: draft.domains.map((entry, i) => (i === index ? { ...entry, service: event.target.value } : entry)) })
                          }
                        />
                      </label>
                      <label>
                        Container port
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          required
                          value={domain.port}
                          onChange={(event) =>
                            setDraft({ ...draft, domains: draft.domains.map((entry, i) => (i === index ? { ...entry, port: Number(event.target.value) } : entry)) })
                          }
                        />
                      </label>
                    </div>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        name={`compose-https-${index}`}
                        checked={domain.https}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            domains: draft.domains.map((entry, i) => (i === index ? { ...entry, https: event.target.checked, redirectHttps: false } : entry)),
                          })
                        }
                      />
                      Automatic HTTPS (ACME HTTP-01)
                    </label>
                    {domain.https ? (
                      <>
                        <p className="settings-form-note">
                          Point this public domain at the server and deploy with HTTP available. Verify the certificate before enabling HTTPS redirect.
                        </p>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            name={`compose-redirect-${index}`}
                            disabled={!domain.redirectHttps && !verified[domain.hostname]}
                            checked={Boolean(domain.redirectHttps)}
                            onChange={(event) =>
                              setDraft({ ...draft, domains: draft.domains.map((entry, i) => (i === index ? { ...entry, redirectHttps: event.target.checked } : entry)) })
                            }
                          />
                          Redirect HTTP to HTTPS after verification
                        </label>
                      </>
                    ) : null}
                    <div>
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => setDraft({ ...draft, domains: draft.domains.filter((_, i) => i !== index) })}
                      >
                        Remove domain
                      </button>
                    </div>
                  </div>
                </fieldset>
              ))}

              <div>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => setDraft({ ...draft, domains: [...draft.domains, { hostname: '', service: 'web', port: 80, https: false }] })}
                >
                  <Plus size={14} aria-hidden="true" />
                  Add domain
                </button>
              </div>
              <FeatureError error={save.error} />
            </fieldset>

            <div className="settings-modal-actions">
              <button type="button" className="button" onClick={() => setEditing(false)}>Cancel</button>
              <button type="submit" className="button button-primary">Save configuration</button>
            </div>
          </form>
        </FeatureModal>
      ) : null}
    </article>
  );
}

function ComposeCertificate({
  workloadId,
  hostname,
  busy,
  onVerified,
  onQueued,
}: {
  workloadId: string;
  hostname: string;
  busy: boolean;
  onVerified: (value: boolean) => void;
  onQueued: () => void;
}) {
  const check = useMutation({
    mutationFn: () => api<ComposeCertificateStatus>(`/compose/${workloadId}/check-managed-certificate`, { method: 'POST', body: { hostname } }),
    onSuccess: (value) => onVerified(value.status === 'active' && value.publicVerified),
    onError: () => onVerified(false),
  });
  const retry = useMutation({
    mutationFn: () => api(`/compose/${workloadId}/retry-certificate`, { method: 'POST', idempotent: true, body: { hostname } }),
    onSuccess: () => {
      check.reset();
      onVerified(false);
      onQueued();
    },
  });
  const status = check.data;
  return (
    <section className="servus-subpanel" aria-label={`HTTPS certificate for ${hostname}`}>
      <strong className="mono">HTTPS: {hostname}</strong>
      <div role="status" className="servus-help">
        {check.isPending
          ? 'Checking certificate and public route…'
          : status
            ? status.status === 'not_found'
              ? 'Certificate not issued yet.'
              : status.status === 'active'
                ? status.publicVerified
                  ? 'Certificate active; public HTTPS verified.'
                  : 'Certificate active; public HTTPS could not be verified.'
                : status.status === 'expired'
                  ? 'Certificate expired.'
                  : 'Certificate is not valid yet.'
            : 'Check validates the deployed route, certificate and public HTTPS response.'}
      </div>
      <FeatureError error={check.error || retry.error} />
      {retry.isSuccess ? <p role="status" className="servus-help">Certificate retry queued. Check status after the action finishes.</p> : null}
      <div className="heading-actions" style={{ flexWrap: 'wrap' }}>
        <button
          type="button"
          className="button button-small"
          disabled={busy || check.isPending || retry.isPending}
          onClick={() => {
            retry.reset();
            check.mutate();
          }}
        >
          Check HTTPS certificate
        </button>
        {status?.status === 'not_found' ? (
          <button
            type="button"
            className="button button-small"
            disabled={busy || check.isPending || retry.isPending}
            onClick={() => retry.mutate()}
          >
            Retry certificate issuance
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ComposeBuildHelp({ sourceType, id }: { sourceType: 'inline' | 'git'; id: string }) {
  return (
    <p id={id} className="settings-form-note">
      {sourceType === 'inline'
        ? 'Use an image or build.dockerfile_inline. Supports BuildKit build secrets and unprivileged published ports (1024-65535).'
        : 'Build paths are relative to the Compose file inside the repository checkout. Supports args, target, additional_contexts, build secrets, and opt-in SSH forwarding.'}
    </p>
  );
}
