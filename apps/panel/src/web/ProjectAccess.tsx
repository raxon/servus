import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, ShieldCheck, UserRound } from "lucide-react";
import type { Project, User } from "../shared/types.js";
import { api } from "./api.js";
import { FeatureError, FeatureLoading, FeatureModal } from "./feature-ui.js";

type Member = { userId: string; email: string; role: "editor" | "viewer" };
type AccessUpdate = { projectId: string; id: string; role?: Member["role"] };

export function ProjectAccess() {
  const client = useQueryClient();
  const firstField = useRef<HTMLSelectElement>(null);
  const [projectChoice, setProjectChoice] = useState("");
  const [draft, setDraft] = useState<{ member?: Member; userId: string; role: Member["role"] } | null>(null);
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<Project[]>("/projects") });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<{ users: User[] }>("/users") });
  const project = projects.data?.find((item) => item.id === projectChoice) ?? projects.data?.[0];
  const projectId = project?.id ?? "";
  const members = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => api<{ members: Member[] }>(`/projects/${encodeURIComponent(projectId)}/members`),
    enabled: !!projectId,
  });
  const eligible = users.data?.users.filter((user) =>
    user.role === "member" && !members.data?.members.some((member) => member.userId === user.id),
  ) ?? [];
  const update = useMutation({
    mutationFn: ({ projectId: target, id, role }: AccessUpdate) =>
      api(`/projects/${encodeURIComponent(target)}/members/${encodeURIComponent(id)}`,
        role ? { method: "PUT", body: { role } } : { method: "DELETE" }),
    onSuccess: (_result, variables) => {
      setDraft(null);
      void client.invalidateQueries({ queryKey: ["project-members", variables.projectId] });
    },
  });

  function close() {
    update.reset();
    setDraft(null);
  }

  const title = draft?.member ? "Edit project access" : "Grant project access";
  const loading = projects.isPending || users.isPending || (!!projectId && members.isPending);
  return (
    <section id="project-access" className="surface details-card" aria-labelledby="project-access-heading">
      <div className="settings-card-header">
        <div className="settings-card-intro">
          <div className="card-heading"><ShieldCheck size={19} aria-hidden="true" /><h3 id="project-access-heading">Project access</h3></div>
          <p>Manage which workspace members can use each project.</p>
        </div>
        <button type="button" className="button button-primary" disabled={loading || !project || !eligible.length || !!members.error || update.isPending} onClick={() => {
          update.reset();
          setDraft({ userId: eligible[0]?.id ?? "", role: "viewer" });
        }}><Plus size={16} aria-hidden="true" />Grant access</button>
      </div>
      <FeatureError error={projects.error || users.error || members.error || (draft ? null : update.error)} />
      {project ? (
        <label className="settings-project-picker">Project
          <select value={projectId} disabled={update.isPending} onChange={(event) => { setProjectChoice(event.target.value); update.reset(); }}>
            {projects.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      ) : null}
      {loading ? <FeatureLoading label="Loading access settings" /> : projects.error || members.error ? null : !project ? (
        <div className="settings-empty"><UserRound size={23} aria-hidden="true" /><div><strong>No projects yet</strong><p>Create a project to manage its access.</p></div></div>
      ) : members.data?.members.length ? (
        <ul className="settings-list" aria-label="Current members">
          {members.data.members.map((member) => (
            <li className="settings-list-item" key={member.userId}>
              <span className="settings-list-icon"><UserRound size={18} aria-hidden="true" /></span>
              <div className="settings-list-copy"><strong>{member.email}</strong><span className="capitalize">{member.role}</span></div>
              <div className="settings-list-actions">
                <button type="button" className="button button-small" disabled={update.isPending} aria-label={`Edit access for ${member.email}`} onClick={() => {
                  update.reset();
                  setDraft({ member, userId: member.userId, role: member.role });
                }}><Pencil size={15} aria-hidden="true" />Edit</button>
                <button type="button" className="button button-small" disabled={update.isPending} aria-label={`Remove ${member.email} from this project`} onClick={() => update.mutate({ projectId, id: member.userId })}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="settings-empty"><UserRound size={23} aria-hidden="true" /><div>
          <strong>No members assigned</strong>
          <p>{eligible.length ? "Grant access to a workspace member for this project." : "There are no workspace members available to add. Instance administrators already have access."}</p>
        </div></div>
      )}
      {draft && project ? (
        <FeatureModal title={title} description={`Manage member permissions for ${project.name}.`} dismissible={!update.isPending} initialFocus={firstField} onClose={close}>
          <form className="settings-modal-form" aria-label={title} onSubmit={(event) => {
            event.preventDefault();
            if (draft.userId && !update.isPending) update.mutate({ projectId, id: draft.userId, role: draft.role });
          }}>
            <fieldset className="settings-form-fields" disabled={update.isPending}>
              {draft.member ? <p className="settings-form-note">{draft.member.email}</p> : (
                <label>Member
                  <select ref={firstField} required value={draft.userId} onChange={(event) => setDraft({ ...draft, userId: event.target.value })}>
                    {eligible.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
                  </select>
                </label>
              )}
              <label>Role
                <select ref={draft.member ? firstField : undefined} value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value === "editor" ? "editor" : "viewer" })}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
              </label>
            </fieldset>
            <FeatureError error={update.error} />
            <div className="settings-modal-actions">
              <button className="button" type="button" disabled={update.isPending} onClick={close}>Cancel</button>
              <button className="button button-primary" type="submit" disabled={!draft.userId || update.isPending}>{update.isPending ? "Saving access…" : "Save access"}</button>
            </div>
          </form>
        </FeatureModal>
      ) : null}
    </section>
  );
}
