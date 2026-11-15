import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import type { Service } from "../shared/types.js";
import { api } from "./api.js";
import { FeatureError, FeatureLoading, FeatureModal } from "./feature-ui.js";

type RestoreOperation = {
  operationId: string;
  phase: "uploading" | "reserved" | "discarding" | "discarding_candidate" | "importing" | "prepared" | "switching" | "needs_review" | "completed" | "cancelled";
  kind: "postgres" | "mariadb" | "redis";
  reviewPhase?: "uploading" | "reserved" | "discarding" | "importing" | "prepared" | "switching";
  recoveryReason?: "legacy_upload_unverified" | "preparation_unverified";
  rolledBack?: true;
};

export function DatabaseRestore({ service }: { service: Service }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="detail-row">
      <span>Restore database</span>
      <button className="button button-small" type="button" onClick={() => setOpen(true)}><Upload size={15} /> Restore</button>
    </div>
    {open && <RestoreDialog service={service} onClose={() => setOpen(false)} />}
  </>;
}

function RestoreDialog({ service, onClose }: { service: Service; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [uploadInProgress, setUploadInProgress] = useState(false);
  const client = useQueryClient();
  const key = ["database-restore", service.id];
  const base = `/services/${service.id}/database-restore`;
  const status = useQuery({
    queryKey: key,
    queryFn: () => api<{operation: RestoreOperation | null}>(base, {csrf:true}),
    retry: false,
    refetchInterval: query => {
      const operation = query.state.data?.operation;
      const phase = operation?.phase;
      if(uploadInProgress)return 1000;
      if(operation?.recoveryReason === "legacy_upload_unverified")return false;
      return phase && ["uploading", "importing", "switching", "discarding", "discarding_candidate"].includes(phase) ? 3000 : false;
    },
  });
  const action = useMutation({
    mutationFn: async (input: {type: "upload"; file: File} | {type: "prepare" | "commit" | "cancel"; operationId: string}) => {
      if (input.type === "upload") {
        const id = crypto.randomUUID().replaceAll("-", "");
        return api(`${base}/${id}/upload`, {method:"POST", binary:input.file});
      }
      return api(`${base}/${input.operationId}/${input.type}`, {method:"POST", body:input.type === "commit" ? {confirm:true} : {}});
    },
    onMutate:input=>{if(input.type==='upload'){cancelUpload.reset();setUploadInProgress(true);}},
    onSettled: () => { setUploadInProgress(false); setConfirmed(false); void client.invalidateQueries({queryKey:key}); },
  });
  const cancelUpload = useMutation({
    mutationFn:(operationId:string)=>api(`${base}/${operationId}/cancel`,{method:"POST",body:{}}),
    onSettled:()=>{void client.invalidateQueries({queryKey:key});},
  });
  const operation = status.data?.operation;
  const phase = operation?.phase;
  const readyForFile = !operation || phase === "completed" || phase === "cancelled";
  const busy = action.isPending || status.isFetching || !!status.error;
  const extension = service.kind === "postgres" ? ".dump" : ".sql";
  const fileValid = !!file && file.size > 0 && file.size <= 2 * 1024 ** 3;
  return <FeatureModal title="Restore database" description={`Restore a ${extension} export to this ${service.kind === "postgres" ? "PostgreSQL" : "MariaDB"} database.`} onClose={onClose}>
    <div className="restore-dialog">
      <FeatureError error={status.error ?? cancelUpload.error ?? (cancelUpload.isSuccess && phase === "cancelled" ? null : action.error)} />
      {status.isPending ? <FeatureLoading label="Checking restore status" /> : status.data && !status.error ? <>
        {phase === "completed" && <p role="status">The database was restored.</p>}
        {phase === "cancelled" && <p role="status">{operation?.rolledBack ? "The restore was rolled back. The previous database is running." : "The restore was cancelled."}</p>}
        {readyForFile && <>
          <label className="restore-file-label">Export file
            <input type="file" accept={extension} disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <p className="feature-helper">Use an export from the same database type. Maximum file size: 2 GiB.</p>
          {file && !fileValid && <p className="error-notice" role="alert">Choose a non-empty file no larger than 2 GiB.</p>}
          <button className="button button-primary" type="button" disabled={busy || !fileValid} onClick={() => file && action.mutate({type:"upload",file})}>
            {busy ? <FeatureLoading label="Uploading" /> : "Upload export"}
          </button>
        </>}
        {phase === "reserved" && <>
          <p role="status">The export is uploaded. Prepare it before replacing the database.</p>
          <button className="button button-primary" type="button" disabled={busy} onClick={() => action.mutate({type:"prepare",operationId:operation!.operationId})}>{busy ? <FeatureLoading label="Preparing" /> : "Prepare restore"}</button>
        </>}
        {(phase === "prepared" || phase === "switching") && <>
          <p role="status">{phase === "prepared" ? "The export is ready. Restoring it replaces the current database data and briefly stops the service." : "The restore is being applied. You can resume it if the operation was interrupted."}</p>
          <label className="restore-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /> I understand that current database data will be replaced.</label>
          <button className="button button-danger" type="button" disabled={busy || !confirmed} onClick={() => action.mutate({type:"commit",operationId:operation!.operationId})}>{busy ? <FeatureLoading label="Restoring" /> : phase === "prepared" ? "Restore database" : "Resume restore"}</button>
        </>}
        {(phase === "reserved" || phase === "prepared") && <button className="button" type="button" disabled={busy} onClick={() => action.mutate({type:"cancel",operationId:operation!.operationId})}>Cancel restore</button>}
        {phase === "uploading" && operation?.recoveryReason === "legacy_upload_unverified" && <div role="alert">
          <p>This older upload has no recorded process lock, so its writer cannot be verified as stopped.</p>
          <p>The service remains locked for changes. Ask an administrator to review this restore.</p>
          <p>Restore ID: <code>{operation.operationId}</code></p>
        </div>}
        {phase === "uploading" && operation?.recoveryReason !== "legacy_upload_unverified" && <>
          <FeatureLoading label="Uploading export" />
          <button className="button" type="button" disabled={cancelUpload.isPending} onClick={() => cancelUpload.mutate(operation!.operationId)}>{cancelUpload.isPending ? <FeatureLoading label="Cancelling" /> : "Cancel upload"}</button>
        </>}
        {phase === "importing" && operation?.recoveryReason === "preparation_unverified" && <div role="alert">
          <p>Preparation may have been interrupted. The temporary database and its import cannot yet be verified as stopped.</p>
          <p>The service remains locked for changes. Ask an administrator to review this restore.</p>
          <p>Restore ID: <code>{operation.operationId}</code></p>
        </div>}
        {(phase === "discarding" || (phase === "importing" && operation?.recoveryReason !== "preparation_unverified")) && <FeatureLoading label="Restore in progress" />}
        {phase === "discarding_candidate" && <>
          <p role="status">The temporary database is being removed. If cleanup was interrupted, try again.</p>
          <button className="button" type="button" disabled={busy} onClick={() => action.mutate({type:"cancel",operationId:operation!.operationId})}>Finish cleanup</button>
        </>}
        {phase === "needs_review" && <div role="alert">
          <p>{operation?.reviewPhase === "uploading" ? "The uploaded archive could not be verified or cleaned up."
            : operation?.reviewPhase === "importing" ? "The temporary database or its import could not be verified."
            : operation?.reviewPhase === "discarding" ? "The uploaded archive could not be removed safely."
            : "The restore state could not be verified."}</p>
          <p>The service is locked for changes. Ask an administrator to review this restore before retrying.</p>
          <p>Restore ID: <code>{operation?.operationId}</code></p>
        </div>}
      </> : <button className="button" type="button" onClick={() => void status.refetch()}>Check status again</button>}
    </div>
  </FeatureModal>;
}
