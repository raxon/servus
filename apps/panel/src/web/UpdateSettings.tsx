import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { z } from "zod";
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
  stage: z.enum(["submit", "verifying", "preparing", "applying", "attention"]),
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

export function UpdateSettings() {
  const [run, setRun] = useState<SavedUpdate | null>(readUpdate);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const [completed, setCompleted] = useState(false);
  const [resume, setResume] = useState(0);
  const [checking, setChecking] = useState(false);
  const capability = useQuery({ queryKey: ["updates"], queryFn: () => api<{ applyAvailable: boolean }>("/updates"), retry: false });
  const discovery = useQuery({
    queryKey: ["updates", "discovery"],
    queryFn: () => api<{ discovery: UpdateDiscovery }>("/updates/discovery"),
    enabled: checking && Boolean(capability.data?.applyAvailable),
    retry: false,
    refetchInterval: query => query.state.data?.discovery.status === "checking" ? 5000 : false,
  });

  useEffect(() => {
    if (!run || run.stage === "attention" || !capability.data?.applyAvailable) return;
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
        if (run.stage === "verifying") {
          setMessage("Checking the release signature...");
          const { operation } = await api<{ operation: UpdateOperation }>(path, options);
          if (operation.status === "verified") { save({ ...run, stage: "preparing" }); return; }
          if (operation.status === "verification_failed" || operation.status === "recovery_required") {
            save({ ...run, stage: "attention" });
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
            setRun(null); setCompleted(true); setMessage(""); void capability.refetch(); return;
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
        setFailure(error.message);
      }
    };
    void tick();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [run, capability.data?.applyAvailable, resume]);

  const candidate = discovery.data?.discovery;
  const start = () => {
    if (!candidate || candidate.status !== "candidate") return;
    try {
      const next: SavedUpdate = { operationId: crypto.randomUUID(), tag: candidate.tag, commit: candidate.commit, digest: candidate.digest, stage: "submit" };
      localStorage.setItem(storageKey, JSON.stringify(next));
      setFailure(""); setCompleted(false); setRun(next);
    } catch { setFailure("Could not save update progress in this browser. Enable browser storage and try again."); }
  };
  return (
    <section className="surface details-card central-settings">
      <div className="card-heading"><RefreshCw size={19} aria-hidden="true" /><h2>Updates</h2></div>
      {capability.isPending ? <p>Checking update settings...</p> : capability.error ? <p role="alert">Could not load update settings.</p> : !capability.data?.applyAvailable ? <p>Updates are not configured on this installation.</p> : run ? (
        <>
          <p>Update {run.tag}</p>
          <p role="status" aria-live="polite">{run.stage === "attention" ? "Update needs attention." : message || "Checking update progress..."}</p>
          {failure ? <div className="error-notice" role="alert">{failure}</div> : null}
          {failure && run.stage !== "attention" ? <button type="button" className="button" onClick={() => { setFailure(""); setResume(value => value + 1); }}>Check again</button> : null}
        </>
      ) : (
        <>
          <p>Check for a new version of Servus.</p>
          {completed ? <p role="status">Update installed.</p> : null}
          {discovery.error ? <div className="error-notice" role="alert">Could not check for updates. Try again.</div> : null}
          {failure ? <div className="error-notice" role="alert">{failure}</div> : null}
          {candidate?.status === "checking" ? <p role="status">Checking for updates...</p> : null}
          {candidate?.status === "unavailable" ? <p role="status">Update information is unavailable. Try again later.</p> : null}
          {candidate?.status === "no_newer_version" ? <p role="status">Servus is up to date.</p> : null}
          {candidate?.status === "ahead" ? <p role="status">This installation is newer than the latest release.</p> : null}
          {candidate?.status === "release_pending" ? <p role="status">Release {candidate.tag} is not ready yet.</p> : null}
          {candidate?.status === "candidate" ? <p role="status">Version {candidate.tag} is available. Its signature will be checked before installation.</p> : null}
          <button type="button" className="button" disabled={discovery.isFetching || candidate?.status === "checking"} onClick={() => { setCompleted(false); if (checking) void discovery.refetch(); else setChecking(true); }}>Check for updates</button>{" "}
          {candidate?.status === "candidate" ? <button type="button" className="button button-primary" onClick={start}>Install update</button> : null}
        </>
      )}
    </section>
  );
}
