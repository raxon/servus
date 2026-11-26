import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Box, Download, FileJson, Globe2, Upload } from "lucide-react";
import type {
  BoxRuntimePreset,
  DedicatedBoxResult,
  DedicatedWordPressResult,
  ProjectExportBundle,
  ProjectImportResult,
} from "../shared/platform-settings.js";
import { api, errorMessage } from "./api.js";
import { useI18n } from "./i18n.js";

export function DedicatedModulesSection({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}) {
  const id = useId();
  const client = useQueryClient();
  const { t } = useI18n();
  const [wpName, setWpName] = useState("wordpress");
  const [boxName, setBoxName] = useState("sandbox");
  const [boxPreset, setBoxPreset] = useState<BoxRuntimePreset>("node-22");

  const wpMutation = useMutation({
    mutationFn: () =>
      api<DedicatedWordPressResult>(`/projects/${projectId}/modules/wordpress`, {
        method: "POST",
        body: { name: wpName.trim() || "wordpress" },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["services", projectId] });
    },
  });

  const boxMutation = useMutation({
    mutationFn: () =>
      api<DedicatedBoxResult>(`/projects/${projectId}/modules/box`, {
        method: "POST",
        body: { name: boxName.trim() || "sandbox", preset: boxPreset },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["services", projectId] });
    },
  });

  if (!canWrite) return null;

  return (
    <section className="surface details-card" aria-label="Dedicated modules WordPress and Box">
      <div className="settings-card-header">
        <div className="settings-card-intro">
          <div className="card-heading">
            <Box size={18} aria-hidden="true" />
            <h3>Dedicated modules</h3>
          </div>
          <p>Provision first-class managed stacks with persistent storage, generated host domains, and operational scripts.</p>
        </div>
      </div>

      <div className="servus-grid-2-stretch">
        <article className="module-card">
          <div className="module-card-header">
            <span className="servus-icon-badge" aria-hidden="true">
              <Globe2 size={18} />
            </span>
            <div>
              <h4>{t("modules.wordpress", "Managed WordPress")}</h4>
              <p>Independent MariaDB 11.4 database + WordPress service with persistent storage and health scripts.</p>
            </div>
          </div>

          <div className="module-card-fields">
            <div className="servus-field">
              <label htmlFor={`${id}-wp-name`}>Service name</label>
              <input
                id={`${id}-wp-name`}
                className="servus-input mono"
                value={wpName}
                onChange={(e) => setWpName(e.target.value)}
                placeholder="wordpress"
                pattern="[a-z0-9][a-z0-9-]*"
                autoCapitalize="none"
                spellCheck={false}
              />
              <small>Creates `{wpName.trim() || "wordpress"}` and `{wpName.trim() || "wordpress"}-db` on a private project network.</small>
            </div>
            {wpMutation.error ? <div className="error-notice" role="alert" style={{ margin: 0 }}>{errorMessage(wpMutation.error)}</div> : null}
            {wpMutation.data ? (
              <div className="success-notice" role="status" style={{ margin: 0 }}>
                Queued {wpMutation.data.appServiceName} + {wpMutation.data.databaseServiceName} ({wpMutation.data.hostname})
              </div>
            ) : null}
          </div>

          <div className="module-card-actions">
            <span className="servus-help">MariaDB 11.4 + PHP 8.3</span>
            <button type="button" className="button button-primary" disabled={wpMutation.isPending} onClick={() => wpMutation.mutate()}>
              {wpMutation.isPending ? "Deploying..." : "Deploy WordPress"}
            </button>
          </div>
        </article>

        <article className="module-card">
          <div className="module-card-header">
            <span className="servus-icon-badge" aria-hidden="true">
              <Box size={18} />
            </span>
            <div>
              <h4>{t("modules.box", "Sandbox Box")}</h4>
              <p>Persistent <code>/workspace</code> container sandbox with interactive browser console and HTTP preview.</p>
            </div>
          </div>

          <div className="module-card-fields">
            <div className="servus-grid-2">
              <div className="servus-field">
                <label htmlFor={`${id}-box-name`}>Box name</label>
                <input
                  id={`${id}-box-name`}
                  className="servus-input mono"
                  value={boxName}
                  onChange={(e) => setBoxName(e.target.value)}
                  placeholder="sandbox"
                  pattern="[a-z0-9][a-z0-9-]*"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>
              <div className="servus-field">
                <label htmlFor={`${id}-box-preset`}>Runtime preset</label>
                <select
                  id={`${id}-box-preset`}
                  className="servus-select"
                  value={boxPreset}
                  onChange={(e) => setBoxPreset(e.target.value as BoxRuntimePreset)}
                >
                  <option value="node-22">Node.js 22</option>
                  <option value="python-3.12">Python 3.12</option>
                  <option value="alpine-tools">Alpine Tools</option>
                  <option value="ubuntu-24">Ubuntu / Python</option>
                </select>
              </div>
            </div>
            {boxMutation.error ? <div className="error-notice" role="alert" style={{ margin: 0 }}>{errorMessage(boxMutation.error)}</div> : null}
            {boxMutation.data ? (
              <div className="success-notice" role="status" style={{ margin: 0 }}>
                Queued Box {boxMutation.data.serviceName} ({boxMutation.data.preset})
              </div>
            ) : null}
          </div>

          <div className="module-card-actions">
            <span className="servus-help">Persistent /workspace volume</span>
            <button type="button" className="button button-primary" disabled={boxMutation.isPending} onClick={() => boxMutation.mutate()}>
              {boxMutation.isPending ? "Creating..." : "Create Box"}
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}

export function ProjectMigrationSection({
  projectId,
  projectName,
  admin,
  canWrite,
}: {
  projectId: string;
  projectName: string;
  admin: boolean;
  canWrite: boolean;
}) {
  const id = useId();
  const client = useQueryClient();
  const { t } = useI18n();
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [importText, setImportText] = useState("");
  const [importTargetName, setImportTargetName] = useState("");

  const exportMutation = useMutation({
    mutationFn: () => api<ProjectExportBundle>(`/projects/${projectId}/export?includeSecrets=${includeSecrets ? "true" : "false"}`),
    onSuccess: (bundle) => {
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `servus-${projectName}-export.json`;
      link.click();
      URL.revokeObjectURL(url);
    },
  });

  const importMutation = useMutation({
    mutationFn: () =>
      api<ProjectImportResult>("/projects/import", {
        method: "POST",
        body: {
          bundle: JSON.parse(importText),
          ...(importTargetName.trim() ? { targetProjectName: importTargetName.trim() } : {}),
          useAutomaticDomains: true,
        },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      setImportText("");
      setImportTargetName("");
    },
  });

  if (!canWrite) return null;

  return (
    <div className="servus-grid-2-stretch" aria-label="Export and import project configuration">
      <section className="surface details-card" style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: 16 }}>
        <div className="settings-card-header" style={{ marginBlockEnd: 0 }}>
          <div className="settings-card-intro">
            <div className="card-heading">
              <Download size={18} aria-hidden="true" />
              <h3>{t("project.export", "Export project")}</h3>
            </div>
            <p>Download a portable JSON bundle containing services, Compose stacks, shared environment variables, and saved scripts.</p>
          </div>
        </div>

        <div className="module-card-fields">
          {admin ? (
            <label className="servus-toggle-row" htmlFor={`${id}-include-secrets`}>
              <span>
                <strong>Include decrypted secrets</strong>
                <small>Enable only when migrating directly to another trusted Servus server. Store the file securely.</small>
              </span>
              <input
                id={`${id}-include-secrets`}
                type="checkbox"
                checked={includeSecrets}
                onChange={(e) => setIncludeSecrets(e.target.checked)}
              />
            </label>
          ) : (
            <div className="info-notice" style={{ margin: 0 }}>
              Secret values are automatically redacted for non-administrator exports.
            </div>
          )}
          {exportMutation.error ? <div className="error-notice" role="alert" style={{ margin: 0 }}>{errorMessage(exportMutation.error)}</div> : null}
        </div>

        <div className="module-card-actions">
          <span className="servus-help mono">servus-{projectName}-export.json</span>
          <button type="button" className="button button-primary" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate()}>
            <Download size={14} aria-hidden="true" />
            {exportMutation.isPending ? "Exporting..." : "Download JSON bundle"}
          </button>
        </div>
      </section>

      {admin ? (
        <section className="surface details-card" style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: 16 }}>
          <div className="settings-card-header" style={{ marginBlockEnd: 0 }}>
            <div className="settings-card-intro">
              <div className="card-heading">
                <Upload size={18} aria-hidden="true" />
                <h3>{t("project.import", "Import project")}</h3>
              </div>
              <p>Create a new project on this server from a previously exported Servus bundle JSON.</p>
            </div>
            <label className="button button-small" style={{ cursor: "pointer" }}>
              <FileJson size={14} aria-hidden="true" />
              Load file
              <input
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file) return;
                  void file.text().then((content) => setImportText(content));
                }}
              />
            </label>
          </div>

          <div className="module-card-fields">
            <div className="servus-field">
              <label htmlFor={`${id}-target-name`}>New project name (optional)</label>
              <input
                id={`${id}-target-name`}
                className="servus-input mono"
                value={importTargetName}
                onChange={(e) => setImportTargetName(e.target.value)}
                placeholder="Leave blank to reuse exported name"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>

            <div className="servus-field">
              <label htmlFor={`${id}-bundle-json`}>Bundle JSON</label>
              <textarea
                id={`${id}-bundle-json`}
                className="servus-textarea mono"
                rows={5}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder='Paste exported servus-project-export/v1 JSON here or use "Load file"...'
                spellCheck={false}
              />
            </div>

            {importMutation.error ? <div className="error-notice" role="alert" style={{ margin: 0 }}>{errorMessage(importMutation.error)}</div> : null}
            {importMutation.data ? (
              <div className="success-notice" role="status" style={{ margin: 0 }}>
                Imported project <strong>{importMutation.data.projectName}</strong>: {importMutation.data.importedServices.length} services,{" "}
                {importMutation.data.importedCompose.length} Compose stacks, {importMutation.data.importedEnvCount} env vars,{" "}
                {importMutation.data.importedScriptCount} scripts.
              </div>
            ) : null}
          </div>

          <div className="module-card-actions">
            <span className="servus-help">Assigns fresh automatic host domains</span>
            <button
              type="button"
              className="button button-primary"
              disabled={!importText.trim() || importMutation.isPending}
              onClick={() => importMutation.mutate()}
            >
              <Upload size={14} aria-hidden="true" />
              {importMutation.isPending ? "Importing..." : "Import as new project"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function ProjectTransferAndModules(props: { projectId: string; projectName: string; admin: boolean; canWrite: boolean }) {
  return (
    <div className="project-tab-panel">
      <DedicatedModulesSection projectId={props.projectId} canWrite={props.canWrite} />
      <ProjectMigrationSection {...props} />
    </div>
  );
}
