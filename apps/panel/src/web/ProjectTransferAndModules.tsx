import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Box, Download, Globe2, Upload } from "lucide-react";
import type {
  BoxRuntimePreset,
  DedicatedBoxResult,
  DedicatedWordPressResult,
  ProjectExportBundle,
  ProjectImportResult,
} from "../shared/platform-settings.js";
import { api, errorMessage } from "./api.js";
import { useI18n } from "./i18n.js";

export function ProjectTransferAndModules({ projectId, projectName, admin, canWrite }: { projectId: string; projectName: string; admin: boolean; canWrite: boolean }) {
  const client = useQueryClient();
  const { t } = useI18n();
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [wpName, setWpName] = useState("wordpress");
  const [boxName, setBoxName] = useState("sandbox");
  const [boxPreset, setBoxPreset] = useState<BoxRuntimePreset>("node-22");
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
    <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
      <section className="surface details-card" aria-label="Dedicated modules WordPress and Box">
        <div className="card-heading">
          <Box size={19} aria-hidden="true" />
          <h3>Dedicated modules ({t("modules.wordpress", "Managed WordPress")} &amp; {t("modules.box", "Sandbox Box")})</h3>
        </div>
        <div className="form-grid">
          <div style={{ display: "grid", gap: 8 }}>
            <strong style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Globe2 size={15} aria-hidden="true" /> {t("modules.wordpress", "Managed WordPress")}</strong>
            <small>Deploys an independent managed MariaDB 11.4 database + WordPress service with persistent storage and health scripts.</small>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="mono" value={wpName} onChange={(e) => setWpName(e.target.value)} placeholder="wordpress" pattern="[a-z0-9][a-z0-9-]*" />
              <button type="button" className="button button-primary" disabled={wpMutation.isPending} onClick={() => wpMutation.mutate()}>
                {wpMutation.isPending ? "Deploying..." : "Deploy WordPress"}
              </button>
            </div>
            {wpMutation.error ? <div className="error-notice" role="alert">{errorMessage(wpMutation.error)}</div> : null}
            {wpMutation.data ? <small role="status" className="mono">Queued {wpMutation.data.appServiceName} + {wpMutation.data.databaseServiceName} ({wpMutation.data.hostname})</small> : null}
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            <strong style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Box size={15} aria-hidden="true" /> {t("modules.box", "Sandbox Box")}</strong>
            <small>Launches a persistent /workspace container sandbox with browser console and HTTP preview.</small>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input className="mono" value={boxName} onChange={(e) => setBoxName(e.target.value)} placeholder="sandbox" pattern="[a-z0-9][a-z0-9-]*" />
              <select value={boxPreset} onChange={(e) => setBoxPreset(e.target.value as BoxRuntimePreset)}>
                <option value="node-22">Node.js 22</option>
                <option value="python-3.12">Python 3.12</option>
                <option value="alpine-tools">Alpine Tools</option>
                <option value="ubuntu-24">Ubuntu / Python</option>
              </select>
              <button type="button" className="button button-primary" disabled={boxMutation.isPending} onClick={() => boxMutation.mutate()}>
                {boxMutation.isPending ? "Creating..." : "Create Box"}
              </button>
            </div>
            {boxMutation.error ? <div className="error-notice" role="alert">{errorMessage(boxMutation.error)}</div> : null}
            {boxMutation.data ? <small role="status" className="mono">Queued Box {boxMutation.data.serviceName} ({boxMutation.data.preset})</small> : null}
          </div>
        </div>
      </section>

      <section className="surface details-card" aria-label="Export and import project configuration">
        <div className="card-heading">
          <Download size={19} aria-hidden="true" />
          <h3>{t("project.export", "Export project")} / {t("project.import", "Import project")} (Migration)</h3>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {admin ? (
            <label className="checkbox-label">
              <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
              Include decrypted secrets for server-to-server migration
            </label>
          ) : null}
          <button type="button" className="button" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate()}>
            <Download size={14} aria-hidden="true" /> {exportMutation.isPending ? "Exporting..." : "Download JSON bundle"}
          </button>
        </div>
        {exportMutation.error ? <div className="error-notice" role="alert">{errorMessage(exportMutation.error)}</div> : null}

        {admin ? (
          <details style={{ marginTop: 12 }}>
            <summary><Upload size={14} aria-hidden="true" style={{ verticalAlign: "middle", marginRight: 6 }} />Import project bundle JSON (migrate from another Servus server)</summary>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <input
                className="mono"
                value={importTargetName}
                onChange={(e) => setImportTargetName(e.target.value)}
                placeholder="Optional new project name (leave blank to reuse exported name)"
              />
              <textarea
                className="mono"
                rows={5}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder='Paste exported servus-project-export/v1 JSON here...'
              />
              <div>
                <button type="button" className="button button-primary" disabled={!importText.trim() || importMutation.isPending} onClick={() => importMutation.mutate()}>
                  {importMutation.isPending ? "Importing..." : "Import as new project"}
                </button>
              </div>
              {importMutation.error ? <div className="error-notice" role="alert">{errorMessage(importMutation.error)}</div> : null}
              {importMutation.data ? (
                <div className="info-notice" role="status">
                  Imported project <strong>{importMutation.data.projectName}</strong>: {importMutation.data.importedServices.length} services, {importMutation.data.importedCompose.length} Compose stacks, {importMutation.data.importedEnvCount} env vars, {importMutation.data.importedScriptCount} scripts.
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}
