import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import type { Project, User } from "../shared/types.js";
import { api, errorMessage } from "./api.js";

type Member = { userId: string; email: string; role: "editor" | "viewer" };

export function ProjectAccess() {
  const client = useQueryClient();
  const [projectChoice, setProjectChoice] = useState("");
  const [userChoice, setUserChoice] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<Project[]>("/projects") });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<{ users: User[] }>("/users") });
  const projectId = projectChoice || projects.data?.[0]?.id || "";
  const availableUsers = users.data?.users.filter((user) => user.role === "member") ?? [];
  const userId = userChoice || availableUsers[0]?.id || "";
  const members = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => api<{ members: Member[] }>(`/projects/${encodeURIComponent(projectId)}/members`),
    enabled: !!projectId,
  });
  const update = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "save" | "remove" }) => api(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(id)}`, action === "save" ? { method: "PUT", body: { role } } : { method: "DELETE" }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["project-members", projectId] }); },
  });
  const error = projects.error || users.error || members.error || update.error;
  return (
    <section className="surface details-card central-settings">
      <div className="card-heading"><ShieldCheck size={19} /><h2>Project access</h2></div>
      <p>Choose a project and grant access to an existing member. Instance administrators already have access to every project.</p>
      {error ? <div className="error-notice" role="alert">{errorMessage(error)}</div> : null}
      {projects.isPending || users.isPending ? <p>Loading access settings...</p> : !projects.data?.length ? <p>Create a project to manage access.</p> : <>
        <label>Project<select value={projectId} onChange={(event) => setProjectChoice(event.target.value)}>{projects.data.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <form onSubmit={(event) => { event.preventDefault(); if (userId) update.mutate({ id: userId, action: "save" }); }}>
          <label>Member<select value={userId} onChange={(event) => setUserChoice(event.target.value)} disabled={!availableUsers.length}>{availableUsers.length ? availableUsers.map((user) => <option key={user.id} value={user.id}>{user.email}</option>) : <option value="">No members available</option>}</select></label>
          <label>Role<select value={role} onChange={(event) => setRole(event.target.value === "editor" ? "editor" : "viewer")}><option value="viewer">Viewer</option><option value="editor">Editor</option></select></label>
          <button type="submit" className="button" disabled={!userId || update.isPending}>{update.isPending ? "Saving..." : "Save access"}</button>
        </form>
        <div className="central-result">
          <h3>Current members</h3>
          {members.isPending ? <p>Loading members...</p> : members.data?.members.length ? members.data.members.map((member) => <div className="detail-row" key={member.userId}>
            <span>{member.email} - {member.role}</span>
            <button type="button" className="button button-small" disabled={update.isPending} onClick={() => update.mutate({ id: member.userId, action: "remove" })} aria-label={`Remove ${member.email} from this project`}>Remove</button>
          </div>) : <p>No members have been added to this project.</p>}
        </div>
      </>}
    </section>
  );
}
