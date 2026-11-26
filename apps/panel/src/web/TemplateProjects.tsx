import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Rocket } from 'lucide-react';
import type { ApplicationTemplate } from '../shared/templates.js';
import type { ComposeAction, ComposeWorkload } from '../shared/compose.js';
import { api } from './api.js';
import { FeatureError, FeatureLoading } from './feature-ui.js';

export function TemplateProjects({
  projectId,
  canWrite = true,
  onCreated,
}: {
  projectId: string;
  canWrite?: boolean;
  onCreated?: (result: { workload: ComposeWorkload; action: ComposeAction }) => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string>('wordpress');
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [apiHostname, setApiHostname] = useState('');

  const catalog = useQuery({
    queryKey: ['application-templates'],
    queryFn: async () => {
      const result = await api<{ templates: ApplicationTemplate[] }>('/templates');
      if (
        !Array.isArray(result?.templates) ||
        !result.templates.every(
          (template) =>
            template &&
            ['id', 'name', 'description', 'version', 'setup', 'publisher'].every(
              (key) => typeof template[key as keyof ApplicationTemplate] === 'string',
            ) &&
            Array.isArray(template.images) &&
            template.images.every((image) => typeof image === 'string'),
        )
      ) {
        throw new Error('The application template catalog could not be loaded. Refresh the page to try again.');
      }
      return result;
    },
  });

  const templates = catalog.data?.templates ?? [];
  const template = templates.find((item) => item.id === selected) ?? templates[0];

  const create = useMutation({
    mutationFn: () =>
      api<{ workload: ComposeWorkload; action: ComposeAction }>(
        `/projects/${encodeURIComponent(projectId)}/templates/${selected}`,
        {
          method: 'POST',
          idempotent: true,
          body: {
            name,
            ...(hostname.trim() ? { hostname: hostname.trim() } : {}),
            ...(template?.supportsApiDomain && apiHostname.trim() ? { apiHostname: apiHostname.trim() } : {}),
          },
        },
      ),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['compose-project', projectId] });
      void client.invalidateQueries({ queryKey: ['compose-workloads', projectId] });
      setName('');
      onCreated?.(result);
    },
  });

  return (
    <section className="template-workspace" aria-labelledby={`${id}-title`}>
      <div className="surface template-catalog-card">
        <div className="settings-card-header" style={{ marginBlockEnd: 0 }}>
          <div className="settings-card-intro">
            <div className="card-heading">
              <Layers size={18} aria-hidden="true" />
              <h2 id={`${id}-title`}>Application templates</h2>
            </div>
            <p>
              Deploy a maintained, version-pinned application stack with persistent storage. Pick a template to configure and launch it.
            </p>
          </div>
          {templates.length ? <span className="subtle-count">{templates.length} templates</span> : null}
        </div>

        {catalog.isPending ? <FeatureLoading label="Loading templates" /> : null}
        <FeatureError error={catalog.error} />

        {templates.length ? (
          <div className="template-catalog-grid" role="group" aria-label="Available templates">
            {templates.map((item) => {
              const isSelected = item.id === (template?.id ?? selected);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="template-choice-card"
                  aria-pressed={isSelected}
                  disabled={create.isPending}
                  onClick={() => {
                    setSelected(item.id);
                    create.reset();
                  }}
                >
                  <div className="template-choice-head">
                    <strong>{item.name}</strong>
                    <span className="template-choice-pill">{item.images.length} img</span>
                  </div>
                  <p className="template-choice-desc">{item.description}</p>
                  <span className="template-choice-meta mono" title={item.images.join(', ')}>
                    {item.images[0]}
                  </span>
                </button>
              );
            })}
          </div>
        ) : catalog.data ? (
          <p className="feature-helper">No application templates are available.</p>
        ) : null}
      </div>

      {templates.length ? (
        <div className="surface template-deploy-card">
          <div className="card-heading" style={{ marginBottom: 0 }}>
            <Rocket size={18} aria-hidden="true" />
            <h3>Deploy {template?.name ?? 'template'}</h3>
          </div>

          <form
            method="post"
            action={`/api/v1/projects/${encodeURIComponent(projectId)}/templates/${selected}`}
            aria-labelledby={`${id}-title`}
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <div className="servus-field">
              <label htmlFor={`${id}-template`}>Application</label>
              <select
                id={`${id}-template`}
                name="template"
                className="servus-select"
                value={selected}
                disabled={!canWrite || create.isPending}
                onChange={(event) => {
                  setSelected(event.target.value);
                  create.reset();
                }}
              >
                {templates.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            {template ? (
              <div className="template-selected-meta">
                <strong>{template.name}</strong>
                <span>{template.description}</span>
                <span className="mono">Images: {template.images.join(', ')}</span>
                <span>Publisher: {template.publisher}. {template.setup}</span>
              </div>
            ) : null}

            <div className="servus-field">
              <label htmlFor={`${id}-name`}>Workload name</label>
              <input
                id={`${id}-name`}
                name="name"
                className="servus-input mono"
                required
                maxLength={63}
                pattern="[a-z0-9][a-z0-9_\-]*"
                value={name}
                disabled={!canWrite || create.isPending}
                onChange={(event) => {
                  setName(event.target.value);
                  create.reset();
                }}
                placeholder={template?.id ?? 'my-app'}
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby={`${id}-name-help`}
              />
              <small id={`${id}-name-help`}>Use lowercase letters, numbers, hyphens or underscores.</small>
            </div>

            <div className="servus-field">
              <label htmlFor={`${id}-hostname`}>Application domain (optional)</label>
              <input
                id={`${id}-hostname`}
                name="hostname"
                className="servus-input mono"
                value={hostname}
                maxLength={253}
                disabled={!canWrite || create.isPending}
                onChange={(event) => {
                  setHostname(event.target.value);
                  create.reset();
                }}
                placeholder="app.example.com"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby={`${id}-domain-help`}
              />
              <small id={`${id}-domain-help`}>
                Leave empty to keep the workload private or configure HTTPS in Compose settings after deploy.
              </small>
            </div>

            {template?.supportsApiDomain ? (
              <div className="servus-field">
                <label htmlFor={`${id}-api-domain`}>S3 API domain (optional)</label>
                <input
                  id={`${id}-api-domain`}
                  name="apiHostname"
                  className="servus-input mono"
                  value={apiHostname}
                  maxLength={253}
                  disabled={!canWrite || create.isPending}
                  onChange={(event) => {
                    setApiHostname(event.target.value);
                    create.reset();
                  }}
                  placeholder="s3.example.com"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>
            ) : null}

            <FeatureError error={create.error} />

            {canWrite ? (
              <button className="button button-primary" type="submit" disabled={create.isPending || !template}>
                {create.isPending ? 'Queuing deployment...' : 'Deploy template'}
              </button>
            ) : null}

            {create.isSuccess ? (
              <div className="success-notice" role="status" style={{ margin: 0 }}>
                Deployment queued. Follow its progress in Compose workloads.
              </div>
            ) : null}
          </form>
        </div>
      ) : null}
    </section>
  );
}
