import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { z } from "zod";
import { FeatureModal } from "./feature-ui.js";
import { api, RequestError } from "./api.js";
type UpdateDiscovery =
  | { status: "checking" | "unavailable" }
  | { status: "no_newer_version" | "ahead"; current: string; latest: string }
  | { status: "release_pending"; tag: string }
  | { status: "candidate"; tag: string; commit: string; digest: string };
type UpdateOperation = { status: "accepted" | "verifying" | "verified" | "verification_failed" | "recovery_required" };
type UpdatePreparation = { status: "preparing" | "prepared" | "completed" | "recovery_required" };
type UpdateApplication = { status: "requested" | "dispatching" | "awaiting_completion" | "completed" | "recovery_required" };

const storageKey = "servus.update.operation.v1";
const savedUpdate = z.strictObject({
  operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  tag: z.string().regex(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/).max(64),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  stage: z.enum(["submit", "verifying", "preparing", "applying", "verification_failed", "retry_verification", "attention"]),
});
type SavedUpdate = z.infer<typeof savedUpdate>;
class StorageError extends Error {}

function readUpdate(): SavedUpdate | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = savedUpdate.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function useUpdateDiscovery(enabled: boolean) {
  const capability = useQuery({
    queryKey: ["updates"],
    queryFn: () => api<{ applyAvailable: boolean }>("/updates"),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
  const discovery = useQuery({
    queryKey: ["updates", "discovery"],
    queryFn: () => api<{ discovery: UpdateDiscovery }>("/updates/discovery"),
    enabled: enabled && Boolean(capability.data?.applyAvailable),
    retry: false,
    staleTime: 60_000,
    refetchInterval: query => query.state.data?.discovery.status === "checking" ? 5_000 : 6 * 60 * 60 * 1000,
  });
  return { capability, discovery };
}

type Preferences = {
  automatic: boolean;
  installTime: string;
  timeZone: string;
  channel: "production" | "beta";
  lastAutomaticUpdate: {operationId: string; tag: string; stage: string} | null;
};
function UpdatePolicySettings() {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Pick<Preferences, "automatic" | "channel" | "installTime" | "timeZone"> | null>(null);
  const [saved, setSaved] = useState(false);
  const query = useQuery({queryKey: ["updates", "preferences"], queryFn: () => api<{preferences: Preferences}>("/updates/preferences"), retry: false, refetchInterval: 15000});
  const mutation = useMutation({
    mutationFn: (body: Pick<Preferences, "automatic" | "channel" | "installTime" | "timeZone">) => api<{preferences: Preferences}>("/updates/preferences", {method: "PUT", body}),
    onSuccess: data => {
      client.setQueryData(["updates", "preferences"], data);
      setDraft(null); setSaved(true);
      void client.invalidateQueries({queryKey: ["updates", "discovery"]});
    },
  });
  useEffect(() => {
    if (!("switch" in HTMLInputElement.prototype)) void import("input-switch-polyfill");
  }, []);
  const value = draft ?? query.data?.preferences;
  if (!value) return <p role="status">{query.error ? "Update preferences are unavailable. The host update service may need to be upgraded." : "Loading update preferences..."}</p>;
  const change = (next: Pick<Preferences, "automatic" | "channel" | "installTime" | "timeZone">) => {setDraft(next); setSaved(false); mutation.reset();};
  const automatic = query.data?.preferences.lastAutomaticUpdate;
  return <form className="update-policy" onSubmit={event => {event.preventDefault(); mutation.mutate({automatic: value.automatic, channel: value.channel, installTime: value.installTime, timeZone: value.timeZone});}}>
    <fieldset disabled={mutation.isPending}>
      <legend className="sr-only">Update preferences</legend>
      <label className="update-policy-toggle">
        <span><strong>Automatic updates</strong><small>Check and install new versions from the selected channel at the scheduled time. Turning this off does not interrupt an update already started.</small></span>
        <input type="checkbox" {...({switch: ""} as Record<string, string>)} checked={value.automatic} onChange={event => change({...value, automatic: event.target.checked})} />
      </label>
      <fieldset className="update-channels">
        <legend>Release channel</legend>
        <label><input type="radio" name="update-channel" value="production" checked={value.channel === "production"} onChange={() => change({...value, channel: "production"})} /><span><strong>Production</strong><small>Published GitHub releases only. Drafts and prereleases are excluded.</small></span></label>
        <label><input type="radio" name="update-channel" value="beta" checked={value.channel === "beta"} onChange={() => change({...value, channel: "beta"})} /><span><strong>Beta</strong><small>Every new version tag, including builds without a production release. Signatures are verified before installation.</small></span></label>
      </fieldset>
      <label className="update-install-time">Installation time ({value.timeZone})<input type="time" required value={value.installTime} onChange={event => change({...value, installTime: event.target.value})} /><small>Default: 02:00. Automatic installation starts within five minutes of this time. Manual installation is always available.</small></label>
      <button type="submit" className="button" disabled={!draft || mutation.isPending}>{mutation.isPending ? "Saving..." : "Save preferences"}</button>
    </fieldset>
    {saved ? <p role="status">Update preferences saved.</p> : null}
    {mutation.error ? <p role="alert" className="error-notice">Could not save update preferences. Try again.</p> : null}
    {automatic ? <p role="status">Automatic update {automatic.tag}: {automatic.stage === "attention" ? "needs attention. Check the update service logs; this version will not be retried automatically." : automatic.stage}.</p> : null}
  </form>;
}

export function UpdateSettings() {
  const [confirmation, setConfirmation] = useState<{tag: string; commit: string; digest: string; channel: string} | null>(null);
  const [run, setRun] = useState<SavedUpdate | null>(readUpdate);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const [missingOperation, setMissingOperation] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [resume, setResume] = useState(0);
  const { capability, discovery } = useUpdateDiscovery(true);
  const policy = useQuery({queryKey: ["updates", "preferences"], queryFn: () => api<{preferences: Preferences}>("/updates/preferences"), enabled: Boolean(capability.data?.applyAvailable), retry: false});

  useEffect(() => {
    if (!run || (run.stage === "attention" || run.stage === "verification_failed") || !capability.data?.applyAvailable) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = (next: SavedUpdate) => {
      try { localStorage.setItem(storageKey, JSON.stringify(next)); }
      catch { throw new StorageError(); }
      setRun(next);
    };
    const tick = async () => {
      try {
        const options = { signal: controller.signal };
        const path = `/updates/${run.operationId}`;
        if (run.stage === "submit") {
          setMessage("Starting update...");
          const { operationId, tag, commit, digest } = run;
          await api<{ operation: UpdateOperation }>("/updates", { ...options, method: "POST", body: { operationId, tag, commit, digest } });
          save({ ...run, stage: "verifying" });
          return;
        }
        if (run.stage === "retry_verification") {
          setMessage("Retrying release verification...");
          await api<{ operation: UpdateOperation }>(`${path}/retry`, { ...options, method: "POST", body: {} });
          save({ ...run, stage: "verifying" });
          return;
        }
        if (run.stage === "verifying") {
          setMessage("Checking the release signature...");
          const { operation } = await api<{ operation: UpdateOperation }>(path, options);
          if (operation.status === "verified") { save({ ...run, stage: "preparing" }); return; }
          if (operation.status === "verification_failed" || operation.status === "recovery_required") {
            save({ ...run, stage: operation.status === "verification_failed" ? "verification_failed" : "attention" });
            setFailure(operation.status === "verification_failed" ? "The release could not be verified. Check the update service logs." : "The update needs attention. Check the server before trying again.");
            return;
          }
        } else if (run.stage === "preparing") {
          setMessage("Preparing the update...");
          const { operation } = await api<{ operation: UpdatePreparation }>(`${path}/prepare`, { ...options, method: "POST", body: {} });
          if (operation.status === "prepared" || operation.status === "completed") { save({ ...run, stage: "applying" }); return; }
          if (operation.status === "recovery_required") { save({ ...run, stage: "attention" }); setFailure("The update needs attention. Check the server before trying again."); return; }
        } else {
          setMessage("Installing the update. The panel may briefly disconnect...");
          let operation: UpdateApplication;
          try { ({ operation } = await api<{ operation: UpdateApplication }>(`${path}/apply`, options)); }
          catch (error) {
            if (!(error instanceof RequestError && error.status === 404)) throw error;
            ({ operation } = await api<{ operation: UpdateApplication }>(`${path}/apply`, { ...options, method: "POST", body: {} }));
          }
          if (operation.status === "completed") {
            try { localStorage.removeItem(storageKey); } catch { throw new StorageError(); }
            setRun(null); setCompleted(true); setMessage(""); void capability.refetch(); void discovery.refetch(); return;
          }
          if (operation.status === "recovery_required") { save({ ...run, stage: "attention" }); setFailure("The update needs attention. Check the server before trying again."); return; }
        }
        setFailure("");
        timer = setTimeout(tick, run.stage === "preparing" ? 15000 : 5000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof StorageError) { setFailure("Could not save update progress in this browser. Enable browser storage and try again."); return; }
        if (!(error instanceof RequestError) || error.status === 0 || error.status === 429 || error.status >= 500) {
          setMessage("Waiting for the update service...");
          timer = setTimeout(tick, error instanceof RequestError && error.status === 429 ? 60000 : 15000);
          return;
        }
        if (error instanceof RequestError && error.status === 404) {
          setMissingOperation(true);
          setFailure("This update operation is no longer available. Clear the saved browser progress, then check the update status before starting again.");
          return;
        }
        setFailure(error.message);
      }
    };
    void tick();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [run, capability.data?.applyAvailable, resume]);

  const candidate = completed || discovery.isFetching ? undefined : discovery.data?.discovery;
  const start = () => {
    if (!confirmation) return;
    try {
      const next: SavedUpdate = { operationId: crypto.randomUUID(), tag: confirmation.tag, commit: confirmation.commit, digest: confirmation.digest, stage: "submit" };
      localStorage.setItem(storageKey, JSON.stringify(next));
      setFailure(""); setCompleted(false); setConfirmation(null); setRun(next);
    } catch { setFailure("Could not save update progress in this browser. Enable browser storage and try again."); }
  };
  return (
    <section id="updates" className="surface details-card central-settings">
      <div className="card-heading"><RefreshCw size={19} aria-hidden="true" /><h2>Updates</h2></div>
      {capability.data?.applyAvailable ? <UpdatePolicySettings /> : null}
      {capability.isPending ? <p>Checking update settings...</p> : capability.error ? <p role="alert">Could not load update settings.</p> : !capability.data?.applyAvailable ? <p>Updates are not configured on this installation.</p> : run ? (
        <>
          <p>Update {run.tag}</p>
          <p role="status" aria-live="polite">{missingOperation ? "Update status unavailable." : run.stage === "attention" ? "Update needs attention." : run.stage === "verification_failed" ? "Release verification failed." : message || "Checking update progress..."}</p>
          {failure ? <div className="error-notice" role="alert">{failure}</div> : null}
          {run.stage === "verification_failed" ? <button type="button" className="button" onClick={() => {
            try { const next = { ...run, stage: "retry_verification" as const }; localStorage.setItem(storageKey, JSON.stringify(next)); setFailure(""); setRun(next); }
            catch { setFailure("Could not save update progress in this browser. Enable browser storage and try again."); }
          }}>Retry verification</button> : null}
          {missingOperation ? <button type="button" className="button" onClick={() => {
            try { localStorage.removeItem(storageKey); setRun(null); setMissingOperation(false); setFailure(""); setMessage(""); void discovery.refetch(); }
            catch { setFailure("Could not clear update progress in this browser."); }
          }}>Clear saved progress</button> : null}
          {failure && !missingOperation && run.stage !== "attention" && run.stage !== "verification_failed" ? <button type="button" className="button" onClick={() => { setFailure(""); setResume(value => value + 1); }}>Check again</button> : null}
        </>
      ) : (
        <>
          <p>Check for a new version of Servus.</p>
          {completed ? <p role="status">Update installed.</p> : null}
          {discovery.error ? <div className="error-notice" role="alert">Could not check for updates. Try again.</div> : null}
          {failure ? <div className="error-notice" role="alert">{failure}</div> : null}
          {discovery.isFetching || candidate?.status === "checking" ? <p role="status">Checking for updates...</p> : null}
          {candidate?.status === "unavailable" ? <p role="status">Update information is unavailable. Try again later.</p> : null}
          {candidate?.status === "no_newer_version" ? <p role="status">Servus is up to date.</p> : null}
          {candidate?.status === "ahead" ? <p role="status">This installation is newer than the latest release.</p> : null}
          {candidate?.status === "release_pending" ? <p role="status">Release {candidate.tag} is not ready yet.</p> : null}
          {candidate?.status === "candidate" ? <p role="status">Version {candidate.tag} is available. Its signature will be checked before installation.</p> : null}
          <button type="button" className="button" disabled={discovery.isFetching || candidate?.status === "checking"} onClick={() => { setCompleted(false); void discovery.refetch(); }}>Check for updates</button>{" "}
          {candidate?.status === "candidate" ? <button type="button" className="button button-primary" onClick={() => { if (candidate?.status === "candidate") setConfirmation({...candidate, channel: policy.data?.preferences.channel ?? "production"}); }}>Install update</button> : null}
        </>
      )}
      {confirmation ? <FeatureModal title={`Install ${confirmation.tag}?`} description="The panel may briefly disconnect during installation. Keep this tab open to follow its progress." onClose={() => setConfirmation(null)}>
        <div className="update-confirm-body"><p>Version: <strong>{confirmation.tag}</strong> · Channel: <strong>{confirmation.channel === "beta" ? "Beta" : "Production"}</strong></p>
        <p>The release signature will be verified before installation. Install now, independently of the automatic update schedule?</p>
        <div className="update-confirm-actions"><button type="button" className="button" autoFocus onClick={() => setConfirmation(null)}>Cancel</button><button type="button" className="button button-primary" onClick={start}>Confirm installation</button></div></div>
      </FeatureModal> : null}
    </section>
  );
}
