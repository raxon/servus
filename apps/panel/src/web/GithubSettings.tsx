import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { api } from "./api.js";
import { FeatureError, FeatureModal } from "./feature-ui.js";

type GithubConnection = { connected: boolean; username?: string };
export function useGithubConnection(enabled: boolean) {
  return useQuery({ queryKey: ["github-connection"], queryFn: () => api<GithubConnection>("/integrations/github"), enabled, retry: false });
}

export function GithubSettings() {
  const client = useQueryClient();
  const connection = useGithubConnection(true);
  const [token, setToken] = useState("");
  const [disconnect, setDisconnect] = useState(false);
  const save = useMutation({
    mutationFn: () => api<GithubConnection>("/integrations/github", {method:"PUT",body:{token}}),
    onSuccess: (result) => { client.setQueryData(["github-connection"], result); setToken(""); },
  });
  const remove = useMutation({
    mutationFn: () => api<GithubConnection>("/integrations/github", {method:"DELETE"}),
    onSuccess: (result) => { client.setQueryData(["github-connection"], result); setDisconnect(false); },
  });
  return <section id="github-connection" className="surface details-card central-settings">
    <div className="card-heading"><GitBranch size={19} aria-hidden="true" /><h2>GitHub connection</h2></div>
    <p>Save one token for GitHub repositories used across projects. Only administrators can manage or assign it.</p>
    {connection.isPending ? <p>Loading connection...</p> : connection.error ? <FeatureError error={connection.error} /> : <>
      <p role="status">{connection.data?.connected ? "GitHub token saved. Access is checked during deployment." : "No GitHub token saved."}</p>
      <form aria-label="GitHub connection" onSubmit={event => {event.preventDefault(); save.mutate();}}>
        <label>Access token<input name="github-token" type="password" autoComplete="new-password" aria-describedby="github-token-help" maxLength={4096} required value={token} onChange={event => setToken(event.target.value)} /><small id="github-token-help">Use a token with read access to the repositories you need. The token is encrypted and cannot be viewed again.</small></label>
        <FeatureError error={save.error} />
        {save.isSuccess ? <p role="status">Connection saved. New deployments will use this token.</p> : null}
        <button className="button button-primary" type="submit" disabled={save.isPending}>{save.isPending ? "Saving..." : connection.data?.connected ? "Replace token" : "Save connection"}</button>
      </form>
      {connection.data?.connected ? <button type="button" className="button" onClick={() => setDisconnect(true)}>Disconnect GitHub</button> : null}
    </>}
    {disconnect ? <FeatureModal title="Disconnect GitHub?" description="Running services and queued deployments are unchanged. New deployments using this connection will need another token." onClose={() => setDisconnect(false)}>
      <FeatureError error={remove.error} />
      <div className="heading-actions"><button type="button" className="button" onClick={() => setDisconnect(false)}>Cancel</button><button type="button" className="button button-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Disconnect</button></div>
    </FeatureModal> : null}
  </section>;
}
