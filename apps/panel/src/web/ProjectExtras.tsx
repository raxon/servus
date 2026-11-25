import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Play, Plus, Terminal, Trash2 } from "lucide-react";
import type { Service } from "../shared/types.js";
import type { ProjectEnvVariable, ProjectScript, ScriptExecutionResult } from "../shared/workspace-extras.js";
import { api } from "./api.js";
import { FeatureError, FeatureLoading, FeatureModal } from "./feature-ui.js";

export function ProjectExtras({ projectId, services, canWrite }: { projectId: string; services: Service[]; canWrite: boolean }) {
  const client = useQueryClient();
  const envQuery = useQuery({
    queryKey: ["project-env", projectId],
    queryFn: () => api<{ variables: ProjectEnvVariable[] }>(`/projects/${encodeURIComponent(projectId)}/env`),
  });
  const scriptsQuery = useQuery({
    queryKey: ["project-scripts", projectId],
    queryFn: () => api<{ scripts: ProjectScript[] }>(`/projects/${encodeURIComponent(projectId)}/scripts`),
  });

  // Shared Project Environment state
  const [envDraft, setEnvDraft] = useState<{ name: string; value: string; secret: boolean } | null>(null);
  const saveEnv = useMutation({
    mutationFn: (variables: Array<{ name: string; value?: string; secret: boolean }>) =>
      api<{ variables: ProjectEnvVariable[] }>(`/projects/${encodeURIComponent(projectId)}/env`, { method: "PUT", body: { variables } }),
    onSuccess: () => {
      setEnvDraft(null);
      void client.invalidateQueries({ queryKey: ["project-env", projectId] });
    },
  });
  const deleteEnv = useMutation({
    mutationFn: (name: string) =>
      api(`/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["project-env", projectId] }),
  });

  // Saved Scripts state
  const [scriptDraft, setScriptDraft] = useState<{ id?: string; name: string; description: string; command: string; serviceId: string } | null>(null);
  const [runResult, setRunResult] = useState<{ script: ProjectScript; result: ScriptExecutionResult } | null>(null);
  const saveScript = useMutation({
    mutationFn: (draft: { id?: string; name: string; description: string; command: string; serviceId: string }) => {
      const payload = {
        name: draft.name,
        description: draft.description,
        command: draft.command,
        serviceId: draft.serviceId || null,
      };
      return draft.id
        ? api<{ script: ProjectScript }>(`/projects/${encodeURIComponent(projectId)}/scripts/${encodeURIComponent(draft.id)}`, { method: "PUT", body: payload })
        : api<{ script: ProjectScript }>(`/projects/${encodeURIComponent(projectId)}/scripts`, { method: "POST", body: payload });
    },
    onSuccess: () => {
      setScriptDraft(null);
      void client.invalidateQueries({ queryKey: ["project-scripts", projectId] });
    },
  });
  const deleteScript = useMutation({
    mutationFn: (scriptId: string) =>
      api(`/projects/${encodeURIComponent(projectId)}/scripts/${encodeURIComponent(scriptId)}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["project-scripts", projectId] }),
  });
  const runScript = useMutation({
    mutationFn: ({ script, serviceId }: { script: ProjectScript; serviceId?: string }) =>
      api<ScriptExecutionResult>(`/projects/${encodeURIComponent(projectId)}/scripts/${encodeURIComponent(script.id)}/run`, {
        method: "POST",
        body: { ...(serviceId ? { serviceId } : {}), timeoutSeconds: 30 },
      }).then((result) => ({ script, result })),
    onSuccess: (data) => setRunResult(data),
  });

  const variables = envQuery.data?.variables ?? [];
  const scripts = scriptsQuery.data?.scripts ?? [];
  const appServices = services.filter((s) => !s.kind || s.kind === "app");

  return (
    <div className="project-extras-grid">
      <section className="surface details-card" aria-labelledby="project-env-heading">
        <div className="settings-card-header">
          <div className="settings-card-intro">
            <div className="card-heading"><KeyRound size={18} aria-hidden="true" /><h3 id="project-env-heading">Shared project environment</h3></div>
            <p>Inherited by all application services in this project on deploy. Service-level variables override matching names.</p>
          </div>
          {canWrite ? (
            <button type="button" className="button button-primary button-small" onClick={() => { saveEnv.reset(); setEnvDraft({ name: "", value: "", secret: false }); }}>
              <Plus size={15} aria-hidden="true" />Add variable
            </button>
          ) : null}
        </div>
        <FeatureError error={envQuery.error || deleteEnv.error || (envDraft ? null : saveEnv.error)} />
        {envQuery.isPending ? <FeatureLoading label="Loading shared variables" /> : variables.length ? (
          <ul className="settings-list" aria-label="Shared project environment variables">
            {variables.map((item) => (
              <li className="settings-list-item" key={item.name}>
                <div className="settings-list-copy">
                  <strong className="mono">{item.name}</strong>
                  <span className="mono">{item.secret ? "Encrypted secret" : (item.value || "(empty)")}</span>
                </div>
                {canWrite ? (
                  <div className="settings-list-actions">
                    <button type="button" className="button button-small" disabled={deleteEnv.isPending} onClick={() => deleteEnv.mutate(item.name)} aria-label={`Delete ${item.name}`}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="feature-helper">No shared variables configured for this project.</p>
        )}
      </section>

      <section className="surface details-card" aria-labelledby="project-scripts-heading">
        <div className="settings-card-header">
          <div className="settings-card-intro">
            <div className="card-heading"><Terminal size={18} aria-hidden="true" /><h3 id="project-scripts-heading">Saved operational scripts</h3></div>
            <p>Run repeatable maintenance commands (migrations, cache flushes, health checks) inside a running container.</p>
          </div>
          {canWrite ? (
            <button type="button" className="button button-primary button-small" onClick={() => { saveScript.reset(); setScriptDraft({ name: "", description: "", command: "", serviceId: appServices[0]?.id ?? services[0]?.id ?? "" }); }}>
              <Plus size={15} aria-hidden="true" />Add script
            </button>
          ) : null}
        </div>
        <FeatureError error={scriptsQuery.error || deleteScript.error || runScript.error || (scriptDraft ? null : saveScript.error)} />
        {scriptsQuery.isPending ? <FeatureLoading label="Loading saved scripts" /> : scripts.length ? (
          <ul className="settings-list" aria-label="Saved operational scripts">
            {scripts.map((script) => {
              const target = services.find((s) => s.id === script.serviceId);
              return (
                <li className="settings-list-item" key={script.id}>
                  <div className="settings-list-copy">
                    <strong>{script.name}</strong>
                    <span className="mono">{script.command}</span>
                    {script.description || target ? <small>{[target ? `Target: ${target.name}` : "No default target", script.description].filter(Boolean).join(" - ")}</small> : null}
                  </div>
                  {canWrite ? (
                    <div className="settings-list-actions">
                      <button
                        type="button"
                        className="button button-primary button-small"
                        disabled={runScript.isPending || !(script.serviceId || services[0]?.id)}
                        onClick={() => runScript.mutate({ script, serviceId: script.serviceId ?? services[0]?.id })}
                      >
                        <Play size={14} aria-hidden="true" />Run
                      </button>
                      <button type="button" className="button button-small" disabled={deleteScript.isPending} onClick={() => deleteScript.mutate(script.id)} aria-label={`Delete script ${script.name}`}>
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="feature-helper">No saved scripts yet.</p>
        )}
      </section>

      {envDraft ? (
        <FeatureModal title="Add shared project variable" description="Inherited by application services in this project on next deploy." dismissible={!saveEnv.isPending} onClose={() => setEnvDraft(null)}>
          <form className="settings-modal-form" onSubmit={(event) => {
            event.preventDefault();
            const merged = [
              ...variables.filter((v) => v.name !== envDraft.name).map((v) => ({ name: v.name, secret: v.secret, ...(v.secret ? {} : { value: v.value ?? "" }) })),
              { name: envDraft.name.trim(), value: envDraft.value, secret: envDraft.secret },
            ];
            saveEnv.mutate(merged);
          }}>
            <fieldset className="settings-form-fields" disabled={saveEnv.isPending}>
              <label>Variable name<input className="mono" required value={envDraft.name} placeholder="APP_REGION" onChange={(e) => setEnvDraft({ ...envDraft, name: e.target.value })} /></label>
              <label>Value<input className="mono" type={envDraft.secret ? "password" : "text"} value={envDraft.value} onChange={(e) => setEnvDraft({ ...envDraft, value: e.target.value })} /></label>
              <label className="checkbox-label"><input type="checkbox" checked={envDraft.secret} onChange={(e) => setEnvDraft({ ...envDraft, secret: e.target.checked })} />Encrypt at rest (secret)</label>
            </fieldset>
            <FeatureError error={saveEnv.error} />
            <div className="settings-modal-actions">
              <button type="button" className="button" onClick={() => setEnvDraft(null)}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={saveEnv.isPending}>{saveEnv.isPending ? "Saving..." : "Save variable"}</button>
            </div>
          </form>
        </FeatureModal>
      ) : null}

      {scriptDraft ? (
        <FeatureModal title={scriptDraft.id ? "Edit saved script" : "Add saved script"} description="Command runs with /bin/sh -c inside the target container (30s timeout)." dismissible={!saveScript.isPending} onClose={() => setScriptDraft(null)}>
          <form className="settings-modal-form" onSubmit={(event) => { event.preventDefault(); saveScript.mutate(scriptDraft); }}>
            <fieldset className="settings-form-fields" disabled={saveScript.isPending}>
              <label>Name<input required value={scriptDraft.name} placeholder="Run DB migrations" onChange={(e) => setScriptDraft({ ...scriptDraft, name: e.target.value })} /></label>
              <label>Target service
                <select value={scriptDraft.serviceId} onChange={(e) => setScriptDraft({ ...scriptDraft, serviceId: e.target.value })}>
                  <option value="">Choose at runtime</option>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label>Command<textarea className="mono" rows={3} required value={scriptDraft.command} placeholder="npm run migrate" onChange={(e) => setScriptDraft({ ...scriptDraft, command: e.target.value })} /></label>
              <label>Description (optional)<input value={scriptDraft.description} onChange={(e) => setScriptDraft({ ...scriptDraft, description: e.target.value })} /></label>
            </fieldset>
            <FeatureError error={saveScript.error} />
            <div className="settings-modal-actions">
              <button type="button" className="button" onClick={() => setScriptDraft(null)}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={saveScript.isPending}>{saveScript.isPending ? "Saving..." : "Save script"}</button>
            </div>
          </form>
        </FeatureModal>
      ) : null}

      {runResult ? (
        <FeatureModal title={`Script output: ${runResult.script.name}`} description={`Exit code ${runResult.result.exitCode} in ${runResult.result.durationMs}ms${runResult.result.truncated ? " (output truncated at 64 KiB)" : ""}.`} dismissible onClose={() => setRunResult(null)}>
          <pre className="mono" style={{ maxHeight: "320px", overflow: "auto", padding: "12px", background: "var(--bg-subtle)", borderRadius: "6px" }}>
            {runResult.result.output || "(no output)"}
          </pre>
          <div className="settings-modal-actions">
            <button type="button" className="button button-primary" onClick={() => setRunResult(null)}>Close</button>
          </div>
        </FeatureModal>
      ) : null}
    </div>
  );
}
