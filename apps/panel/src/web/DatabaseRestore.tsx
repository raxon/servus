import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import type { Service } from "../shared/types.js";
import { api, RequestError } from "./api.js";
import { FeatureError, FeatureLoading, FeatureModal } from "./feature-ui.js";

type RestoreOperation = {
  operationId: string;
  phase: "uploading" | "reserved" | "discarding" | "discarding_candidate" | "importing" | "prepared" | "switching" | "needs_review" | "completed" | "cancelled";
  kind: "postgres" | "mariadb" | "redis";
  reviewPhase?: "uploading" | "reserved" | "discarding" | "importing" | "prepared" | "switching";
  recoveryReason?: "legacy_upload_unverified" | "preparation_unverified";
  rolledBack?: true;
  canRollback?:true;restoreDirection?:"rollback";redisRecoveryRequired?:true;
};

type RecoveryOperation = {status:"requested" | "dispatching" | "awaiting_completion" | "completed" | "recovery_required"};

export function DatabaseRestore({ service, admin }: { service: Service; admin: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="detail-row">
      <span>Restore database</span>
      <button className="button button-small" type="button" onClick={() => setOpen(true)}><Upload size={15} /> Restore</button>
    </div>
    {open && <RestoreDialog service={service} admin={admin} onClose={() => setOpen(false)} />}
  </>;
}

function RestoreDialog({ service, admin, onClose }: { service: Service; admin: boolean; onClose: () => void }) {
  const dialogId=useId(),isRedis=service.kind==="redis";
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [rollbackConfirmed,setRollbackConfirmed]=useState(false);
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
    mutationFn: async (input: {type: "upload"; file: File} | {type: "prepare" | "commit" | "cancel" | "rollback" | "recover"; operationId: string}) => {
      if (input.type === "upload") {
        const id = crypto.randomUUID().replaceAll("-", "");
        return api(`${base}/${id}/upload`, {method:"POST", binary:input.file});
      }
      return api(`${base}/${input.operationId}/${input.type}`, {method:"POST", body:input.type === "commit" || input.type === "rollback" ? {confirm:true} : {}});
    },
    onMutate:input=>{if(input.type==='upload'){cancelUpload.reset();setUploadInProgress(true);}},
    onSettled: () => { setUploadInProgress(false); setConfirmed(false);setRollbackConfirmed(false); void client.invalidateQueries({queryKey:key}); },
  });
  const cancelUpload = useMutation({
    mutationFn:(operationId:string)=>api(`${base}/${operationId}/cancel`,{method:"POST",body:{}}),
    onSettled:()=>{void client.invalidateQueries({queryKey:key});},
  });
  const operation = status.data?.operation;
  const phase = operation?.phase;
  const recoveryKey=["legacy-recovery",service.id,operation?.operationId];
  const recovery=useQuery({
    queryKey:recoveryKey,
    enabled:admin && !!operation && !isRedis,
    queryFn:async()=>{
      try{
        const result=await api<{operation:RecoveryOperation}>(`${base}/${operation!.operationId}/legacy-recovery`,{csrf:true});
        if(result.operation.status==="completed")void client.invalidateQueries({queryKey:key});
        return result;
      }
      catch(error){if(error instanceof RequestError && error.status===404)return {operation:null};throw error;}
    },
    retry:false,
    refetchInterval:query=>query.state.data?.operation && query.state.data.operation.status!=="completed" ? 3000 : false,
  });
  const recover=useMutation({
    mutationFn:(operationId:string)=>api<{operation:RecoveryOperation}>(`${base}/${operationId}/legacy-recovery`,{method:"POST",body:{}}),
    onSettled:()=>{void client.invalidateQueries({queryKey:recoveryKey});void client.invalidateQueries({queryKey:key});},
  });
  const recoveryPhase=recovery.data?.operation?.status;
  const recoveryPending=!!recoveryPhase && recoveryPhase!=="completed";
  const readyForFile = (!operation || phase === "completed" || phase === "cancelled") && !recoveryPending && !operation?.redisRecoveryRequired;
  const busy = action.isPending || status.isFetching || !!status.error;
  const extension = service.kind === "postgres" ? ".dump" : isRedis ? ".rdb" : ".sql";
  const fileValid = !!file && file.size > 0 && file.size <= 2 * 1024 ** 3;
  return <FeatureModal title="Restore database" description={`Restore a ${extension} export to this ${service.kind === "postgres" ? "PostgreSQL" : isRedis ? "Redis 7" : "MariaDB"} database.`} onClose={onClose}>
    <div className="restore-dialog">
      <FeatureError error={status.error ?? cancelUpload.error ?? recover.error ?? (cancelUpload.isSuccess && phase === "cancelled" ? null : action.error)} />
      {status.isPending ? <FeatureLoading label="Checking restore status" /> : status.data && !status.error ? <>
        {phase === "completed" && !operation?.redisRecoveryRequired && <p role="status">The database was restored.</p>}
        {phase === "cancelled" && <p role="status">{operation?.rolledBack ? "The restore was rolled back. The previous database is running." : "The restore was cancelled."}</p>}
        {readyForFile && <>
          <label className="restore-file-label" htmlFor={`${dialogId}-file`}>Export file
            <input id={`${dialogId}-file`} type="file" accept={extension} required aria-describedby={`${dialogId}-file-hint`} disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <p className="feature-helper" id={`${dialogId}-file-hint`}>Use an export from the same database type. Maximum file size: 2 GiB.{isRedis && " Redis restores validate the RDB in an isolated copy and preserve absolute key expiration times."}</p>
          {file && !fileValid && <p className="error-notice" role="alert">Choose a non-empty file no larger than 2 GiB.</p>}
          <button className="button button-primary" type="button" disabled={busy || !fileValid} onClick={() => file && action.mutate({type:"upload",file})}>
            {busy ? <FeatureLoading label="Uploading" /> : "Upload export"}
          </button>
        </>}
        {phase === "reserved" && <>
          <p role="status">The export is uploaded. Prepare it before replacing the database.</p>
          <button className="button button-primary" type="button" disabled={busy} onClick={() => action.mutate({type:"prepare",operationId:operation!.operationId})}>{busy ? <FeatureLoading label="Preparing" /> : "Prepare restore"}</button>
        </>}
        {(phase === "prepared" || phase === "switching") && operation?.restoreDirection!=="rollback" && <>
          <p role="status">{phase === "prepared" ? "The export is ready. Restoring it replaces the current database data and briefly stops the service." : "The restore is being applied. You can resume it if the operation was interrupted."}</p>
          <label className="restore-confirm" htmlFor={`${dialogId}-confirm`}><input id={`${dialogId}-confirm`} type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /> I understand that current database data will be replaced.</label>
          <button className="button button-danger" type="button" disabled={busy || !confirmed} onClick={() => action.mutate({type:"commit",operationId:operation!.operationId})}>{busy ? <FeatureLoading label="Restoring" /> : phase === "prepared" ? "Restore database" : "Resume restore"}</button>
        </>}
        {isRedis && phase==="completed" && operation?.canRollback && !operation.redisRecoveryRequired && <fieldset>
          <legend>Restore previous Redis data</legend>
          <p id={`${dialogId}-rollback-hint`}>Switch back to the retained original volume. Writes made after this restore remain on the restored volume. Rollback briefly stops Redis and is available while its deployed configuration still matches this restore.</p>
          <label className="restore-confirm" htmlFor={`${dialogId}-rollback`}><input id={`${dialogId}-rollback`} type="checkbox" checked={rollbackConfirmed} aria-describedby={`${dialogId}-rollback-hint`} disabled={busy} onChange={event=>setRollbackConfirmed(event.target.checked)} /> I understand that Redis will use the previous data.</label>
          <button className="button button-danger" type="button" disabled={busy||!rollbackConfirmed} onClick={()=>action.mutate({type:"rollback",operationId:operation.operationId})}>Roll back Redis restore</button>
        </fieldset>}
        {isRedis && (operation?.redisRecoveryRequired || phase==="needs_review" || (phase==="importing"&&operation?.recoveryReason==="preparation_unverified")) && <div>
          <p role="status">{operation?.restoreDirection==="rollback"?"The Redis rollback needs recovery. Both volumes are retained.":phase==="importing"||phase==="needs_review"?"Interrupted preparation can be discarded after its writer has stopped. The original database remains protected.":"The Redis restore needs recovery before further changes."}</p>
          <button className="button" type="button" disabled={busy} onClick={()=>action.mutate({type:"recover",operationId:operation!.operationId})}>{busy?"Recovering":"Recover Redis restore"}</button>
        </div>}
        {(phase === "reserved" || phase === "prepared") && <button className="button" type="button" disabled={busy} onClick={() => action.mutate({type:"cancel",operationId:operation!.operationId})}>Cancel restore</button>}
        {phase === "uploading" && operation?.recoveryReason === "legacy_upload_unverified" && <div role="alert">
          <p>This older upload has no recorded process lock, so its writer cannot be verified as stopped.</p>
          <p>The service remains locked for changes. {admin ? "Recovery briefly restarts the panel." : "Ask an administrator to review this restore."}</p>
          <p>Restore ID: <code>{operation.operationId}</code></p>
          {admin && recovery.isPending && <FeatureLoading label="Checking recovery" />}
          {admin && recovery.error && <><p>Recovery status is unavailable. Check the status before trying again.</p><button className="button" type="button" onClick={()=>void recovery.refetch()}>Check recovery status</button></>}
          {admin && recovery.data?.operation===null && <button className="button" type="button" disabled={recover.isPending || recovery.isFetching} onClick={()=>recover.mutate(operation.operationId)}>{recover.isPending ? <FeatureLoading label="Starting recovery" /> : "Recover interrupted upload"}</button>}
        </div>}
        {recoveryPending && <div role="status"><p>{recoveryPhase === "recovery_required" ? "Recovery needs administrator review. The panel may be temporarily unavailable." : "Recovery is in progress. The panel may be temporarily unavailable."}</p><button className="button" type="button" onClick={()=>{void recovery.refetch();void status.refetch();}}>Check recovery status</button></div>}
        {phase === "uploading" && operation?.recoveryReason !== "legacy_upload_unverified" && <>
          <FeatureLoading label="Uploading export" />
          <button className="button" type="button" disabled={cancelUpload.isPending} onClick={() => cancelUpload.mutate(operation!.operationId)}>{cancelUpload.isPending ? <FeatureLoading label="Cancelling" /> : "Cancel upload"}</button>
        </>}
        {phase === "importing" && operation?.recoveryReason === "preparation_unverified" && <div role="alert">
          <p>Preparation may have been interrupted. The temporary database and its import cannot yet be verified as stopped.</p>
          <p>The service remains locked for changes. {isRedis?"Use recovery to discard the interrupted preparation.":"Ask an administrator to review this restore."}</p>
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
          <p>The service is locked for changes. {isRedis?"Try Redis recovery before retrying.":"Ask an administrator to review this restore before retrying."}</p>
          <p>Restore ID: <code>{operation?.operationId}</code></p>
        </div>}
      </> : <button className="button" type="button" onClick={() => void status.refetch()}>Check status again</button>}
    </div>
  </FeatureModal>;
}
