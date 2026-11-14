import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { api, errorMessage } from "./api.js";

type CentralStatus = { connected: boolean; issuer?: string };
type Pairing = { pairingId: string; approvalUrl: string; expiresAt: string };
type Invitation = { token: string; expiresAt: string };

function Notice({ error }: { error: unknown }) {
  return error ? <div className="error-notice" role="alert">{errorMessage(error)}</div> : null;
}

export function CentralSignIn() {
  const [invitation, setInvitation] = useState("");
  const status = useQuery({
    queryKey: ["central-access"],
    queryFn: () => api<CentralStatus>("/auth/central"),
    retry: false,
  });
  const start = useMutation({
    mutationFn: () => api<{ authorizationUrl: string }>("/auth/central/start", {
      method: "POST",
      body: invitation.trim() ? { invitation: invitation.trim() } : {},
    }),
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
  });
  if (!status.data?.connected) return null;
  return (
    <div className="central-sign-in">
      <label>
        Invitation code <small>Enter a code if this is your first sign-in.</small>
        <input value={invitation} onChange={(event) => setInvitation(event.target.value)} autoComplete="off" />
      </label>
      <Notice error={start.error} />
      <button className="button auth-submit" type="button" disabled={start.isPending} onClick={() => start.mutate()}>
        {start.isPending ? "Starting sign-in..." : "Sign in with Servus"}
      </button>
    </div>
  );
}

export function AccountLinkSettings() {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const status = useQuery({
    queryKey: ["central-account-link"],
    queryFn: () => api<{ linked: boolean; canLink: boolean }>("/auth/central/link/status"),
    retry: false,
  });
  const link = useMutation({
    mutationFn: () => api<{ authorizationUrl: string }>("/auth/central/link/start", {
      method: "POST",
      body: { password },
    }),
    onSuccess: ({ authorizationUrl }) => {
      setPassword("");
      window.location.assign(authorizationUrl);
    },
    onError: () => setPassword(""),
  });
  return (
    <section className="surface details-card central-settings">
      <div className="card-heading"><ShieldCheck size={19} /><h2>Link your account</h2></div>
      <Notice error={status.error} />
      {status.isPending ? <p>Checking account...</p> : status.data?.linked ? (
        <p>Your local account is linked to a Servus account.</p>
      ) : status.data?.canLink ? (
        <>
          <p>Link your local account to a Servus account to use central sign-in. Your existing project access stays with this account.</p>
          <form onSubmit={(event) => { event.preventDefault(); link.mutate(); }}>
            <label>Local account password
              <input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </label>
            <button type="button" className="button button-small" onClick={() => setShowPassword(!showPassword)} aria-pressed={showPassword}>
              {showPassword ? "Hide password" : "Show password"}
            </button>{" "}
            <button type="submit" className="button button-primary" disabled={link.isPending}>{link.isPending ? "Starting..." : "Continue to Servus"}</button>
          </form>
          <Notice error={link.error} />
        </>
      ) : status.data ? <p>Linking requires a local password and a connected identity service.</p> : null}
    </section>
  );
}

export function CentralAccessSettings() {
  const client = useQueryClient();
  const [serviceUrl, setServiceUrl] = useState("");
  const [callbackUrl, setCallbackUrl] = useState(() => `${window.location.origin}/api/v1/auth/oidc/callback`);
  const [email, setEmail] = useState("");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const status = useQuery({ queryKey: ["central-access"], queryFn: () => api<CentralStatus>("/auth/central"), retry: false });
  const revocations = useQuery({ queryKey: ["central-revocations"], queryFn: () => api<{ pendingRevocations: number }>("/auth/central/revocations"), retry: false });
  const pending = useQuery({ queryKey: ["central-pending"], queryFn: () => api<{ pairingId: string; expiresAt: string } | null>("/auth/central/pending"), retry: false });
  const refresh = () => client.invalidateQueries({ queryKey: ["central-access"] });
  const pair = useMutation({
    mutationFn: () => api<Pairing>("/auth/central/pair", { method: "POST", body: { serviceUrl, callbackUrl } }),
    onSuccess: setPairing,
  });
  const redeem = useMutation({
    mutationFn: (pairingId: string) => api<{ connected: true }>("/auth/central/redeem", { method: "POST", body: { pairingId } }),
    onSuccess: () => { setPairing(null); void refresh(); void client.invalidateQueries({ queryKey: ["central-pending"] }); void client.invalidateQueries({ queryKey: ["central-account-link"] }); },
    onError: () => { void client.invalidateQueries({ queryKey: ["central-pending"] }); void refresh(); },
  });
  const disconnect = useMutation({
    mutationFn: () => api<{ success: true; pendingRevocations: number }>("/auth/central", { method: "DELETE" }),
    onSuccess: (value) => { setInvitation(null); setPairing(null); client.setQueryData(["central-revocations"], { pendingRevocations: value.pendingRevocations }); void client.invalidateQueries({ queryKey: ["central-pending"] }); void client.invalidateQueries({ queryKey: ["central-account-link"] }); void refresh(); },
  });
  const retryRevocations = useMutation({
    mutationFn: () => api<{ pendingRevocations: number }>("/auth/central/retry-revocations", { method: "POST", body: {} }),
    onSuccess: (value) => client.setQueryData(["central-revocations"], value),
  });
  const invite = useMutation({
    mutationFn: () => api<Invitation>("/auth/central/invitations", { method: "POST", body: { email } }),
    onSuccess: (value) => { setInvitation(value); setEmail(""); },
  });
  const busy = pair.isPending || redeem.isPending || disconnect.isPending || invite.isPending;
  return (
    <section className="surface details-card central-settings">
      <div className="card-heading"><ShieldCheck size={19} /><h2>Central sign-in</h2></div>
      <Notice error={status.error} />
      <Notice error={revocations.error} />
      <Notice error={pending.error} />
      {pending.data ? <div className="central-result" role="status">
        <p>The connection still needs confirmation. Finish before {new Date(pending.data.expiresAt).toLocaleString()}.</p>
        <button className="button button-primary" type="button" disabled={busy} onClick={() => redeem.mutate(pending.data!.pairingId)}>{redeem.isPending ? "Connecting..." : "Resume connection"}</button>
        <Notice error={redeem.error} />
      </div> : null}
      {(revocations.data?.pendingRevocations ?? 0) > 0 ? <div className="central-result" role="status">
        <p>Client revocation is pending. The identity service has not yet confirmed disconnection.</p>
        <button className="button" type="button" disabled={retryRevocations.isPending} onClick={() => retryRevocations.mutate()}>{retryRevocations.isPending ? "Retrying..." : "Retry revocation"}</button>
        <Notice error={retryRevocations.error} />
      </div> : null}
      {status.isPending ? <p>Checking connection...</p> : status.data?.connected ? (
        <>
          <div className="detail-row"><span>Connection</span><strong>{pending.isPending ? "Checking" : pending.error ? "Status unavailable" : pending.data ? "Confirmation pending" : "Connected"}</strong></div>
          {status.data.issuer ? <div className="detail-row"><span>Identity service</span><strong>{status.data.issuer}</strong></div> : null}
          <p>Invite people to this instance. Each person also needs an account with the identity service.</p>
          <form onSubmit={(event) => { event.preventDefault(); setInvitation(null); invite.mutate(); }}>
            <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>
            <button className="button" disabled={busy || !!pending.data || pending.isPending || !!pending.error} type="submit">{invite.isPending ? "Creating invitation..." : "Create invitation"}</button>
          </form>
          <Notice error={invite.error} />
          {invitation ? <div className="central-result" role="status">
            <label>Invitation code<input readOnly value={invitation.token} onFocus={(event) => event.currentTarget.select()} /></label>
            <p>Share this code securely. It expires at {new Date(invitation.expiresAt).toLocaleString()}.</p>
          </div> : null}
          <div className="central-disconnect">
            <p>Disconnecting ends central sessions on this instance. Local sign-in remains available.</p>
            <button className="button button-danger" type="button" disabled={busy} onClick={() => { if (window.confirm("Disconnect central sign-in from this instance?")) disconnect.mutate(); }}>
              {disconnect.isPending ? "Disconnecting..." : "Disconnect"}
            </button>
            <Notice error={disconnect.error} />
          </div>
        </>
      ) : status.data ? (
        <>
          <p>Connect this instance to your Servus identity service. An administrator of that service must approve the connection.</p>
          <form onSubmit={(event) => { event.preventDefault(); setPairing(null); pair.mutate(); }}>
            <label>Identity service URL<input type="url" value={serviceUrl} onChange={(event) => setServiceUrl(event.target.value)} placeholder="https://auth.example.com" required /></label>
            <label>Panel callback URL<input type="url" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="https://panel.example.com/api/v1/auth/oidc/callback" required /><small>Use the HTTPS address of this instance.</small></label>
            <button className="button" disabled={busy} type="submit">{pair.isPending ? "Starting..." : "Start connection"}</button>
          </form>
          <Notice error={pair.error} />
          {pairing ? <div className="central-result">
            <p>Approve this connection in the identity service, then return here to finish. This request expires at {new Date(pairing.expiresAt).toLocaleString()}.</p>
            <a className="button" href={pairing.approvalUrl} target="_blank" rel="noopener noreferrer">Review connection <ExternalLink size={15} /></a>{" "}
            <button className="button button-primary" type="button" disabled={busy} onClick={() => redeem.mutate(pairing.pairingId)}>{redeem.isPending ? "Connecting..." : "Finish connection"}</button>
            <Notice error={redeem.error} />
          </div> : null}
        </>
      ) : null}
    </section>
  );
}
