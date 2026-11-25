import { randomUuid } from "./random-uuid.js";
import {useEffect,useId,useRef,useState} from 'react';
import {useInfiniteQuery,useQuery} from '@tanstack/react-query';
import {Archive} from 'lucide-react';
import {api,apiDownload,RequestError} from './api.js';
import './InstallationBackupSettings.css';

type InstallationBackupCapability={available:true}|{available:false;reason:'not_configured'|'host_unavailable'|'host_unsupported'};
interface InstallationBackupOperation{operationId:string;actorId:string;name:string;state:'requested'|'capturing'|'verified'|'starting'|'recovering'|'completed'|'failed'|'cancelled'|'recovery_required';createdAt:number;updatedAt:number;errorCode:'capture_failed'|'resume_required'|null}

type InstallationBackupHistory={available:true;operations:InstallationBackupOperation[];nextCursor:string|null}|{available:false;reason:'not_configured'|'host_unsupported'};
const stateLabel=(state:InstallationBackupOperation['state'])=>state[0]!.toUpperCase()+state.slice(1).replaceAll('_',' ');

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const terminal=(operation:InstallationBackupOperation|null)=>operation?.state==='completed'||operation?.state==='failed'||operation?.state==='cancelled';
const description:Record<InstallationBackupOperation['state'],string>={requested:'Waiting for the host to begin.',capturing:'Capturing installation configuration and encrypted secrets.',verified:'Snapshot verified. Waiting for the panel to restart.',starting:'Restarting the panel and checking its health.',recovering:'The host is resuming the original installation. Its restart and health are not verified yet; this does not confirm a successful backup.',completed:'Installation backup completed and panel health verified.',failed:'Backup failed. The host did not confirm a completed installation backup.',cancelled:'Backup request cancelled before the host began capturing. No completed backup was created.',recovery_required:'Host recovery is required. An administrator must reconcile the installation on the server before another backup or update.'};
const validName=(value:string)=>value===value.trim()&&Array.from(value).length>0&&Array.from(value).length<=100&&!/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)&&!value.startsWith('\u0085')&&!value.endsWith('\u0085');
function remembered(key:string){try{const value=localStorage.getItem(key);return value&&uuid.test(value)?value:null;}catch{return null;}}

function BackupDetails({operation,onChanged}:{operation:InstallationBackupOperation;onChanged?:()=>void}){
  const [busy,setBusy]=useState<'verify'|'download'|'delete'|null>(null);
  const [confirmDelete,setConfirmDelete]=useState(false);
  const [showRestoreGuide,setShowRestoreGuide]=useState(false);
  const [verifiedDigest,setVerifiedDigest]=useState<string|null>(null);
  const [notice,setNotice]=useState<{kind:'ok'|'error';text:string}|null>(null);

  async function verify(){
    setBusy('verify');setNotice(null);
    try{
      const res=await api<{verification:{manifestDigest:string}}>(`/installation-backups/${operation.operationId}/verify`,{method:'POST',body:{}});
      setVerifiedDigest(res.verification.manifestDigest);
      setNotice({kind:'ok',text:`Archive verified (${res.verification.manifestDigest.slice(0,23)}...).`});
    }catch(error){
      setNotice({kind:'error',text:error instanceof RequestError?error.message:'Archive verification could not be completed.'});
    }finally{setBusy(null);}
  }

  async function download(){
    setBusy('download');setNotice(null);
    try{
      const {blob,headers}=await apiDownload(`/installation-backups/${operation.operationId}/download`,{method:'POST',body:{name:operation.name}});
      const url=URL.createObjectURL(blob);
      try{
        const link=document.createElement('a');
        link.href=url;
        link.download=`servus-installation-backup-${operation.operationId}.tar.gz`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }finally{URL.revokeObjectURL(url);}
      const sha=headers.get('x-backup-sha256');
      setNotice({kind:'ok',text:sha?`Archive downloaded (SHA-256 ${sha.slice(0,16)}...).`:'Archive downloaded.'});
    }catch(error){
      setNotice({kind:'error',text:error instanceof RequestError?error.message:'Archive download could not be completed.'});
    }finally{setBusy(null);}
  }

  async function remove(){
    setBusy('delete');setNotice(null);
    try{
      const res=await api<{result:{remainingSnapshots:number}}>(`/installation-backups/${operation.operationId}/delete`,{method:'POST',body:{name:operation.name}});
      setConfirmDelete(false);
      setNotice({kind:'ok',text:`Snapshot archive deleted. ${res.result.remainingSnapshots} verified snapshot(s) remain on disk.`});
      onChanged?.();
    }catch(error){
      setNotice({kind:'error',text:error instanceof RequestError?error.message:'Snapshot deletion was rejected. The last remaining verified snapshot cannot be deleted.'});
    }finally{setBusy(null);}
  }

  return <div className="installation-backup-details">
    <p>{description[operation.state]}</p>
    <dl><div><dt>Operation ID</dt><dd><code>{operation.operationId}</code></dd></div>
      <div><dt>Last confirmed</dt><dd><time dateTime={new Date(operation.updatedAt).toISOString()}>{new Date(operation.updatedAt).toLocaleString()}</time></dd></div>
      {operation.errorCode?<div><dt>Host result</dt><dd>{operation.errorCode==='resume_required'?'The original installation needs a verified restart. Reconcile it on the host.':'The host reported a capture failure. Check the host before retrying.'}</dd></div>:null}</dl>
    {operation.state==='completed'?<>
      <div className="heading-actions" style={{flexWrap:'wrap'}}>
        <button className="button" type="button" disabled={busy!==null} onClick={()=>void verify()}>{busy==='verify'?'Verifying...':'Verify archive'}</button>
        <button className="button" type="button" disabled={busy!==null} onClick={()=>void download()}>{busy==='download'?'Downloading...':'Download archive'}</button>
        <button className="button" type="button" disabled={busy!==null} onClick={()=>setShowRestoreGuide(value=>!value)}>{showRestoreGuide?'Hide restore checklist':'Restore checklist'}</button>
        {!confirmDelete?<button className="button button-danger" type="button" disabled={busy!==null} onClick={()=>setConfirmDelete(true)}>Delete snapshot</button>:<>
          <button className="button button-danger" type="button" disabled={busy!==null} onClick={()=>void remove()}>{busy==='delete'?'Deleting...':'Confirm snapshot deletion'}</button>
          <button className="button" type="button" disabled={busy!==null} onClick={()=>setConfirmDelete(false)}>Keep snapshot</button>
        </>}
      </div>
      {showRestoreGuide?<div className="info-notice" style={{flexDirection:'column',alignItems:'flex-start',gap:8,marginTop:10}}>
        <strong>Operator restore procedure (snapshot <code>{operation.operationId}</code>)</strong>
        <ol style={{margin:'4px 0 0 18px',padding:0,display:'grid',gap:6}}>
          <li>Run <strong>Verify archive</strong>{verifiedDigest?<> (verified: <code>{verifiedDigest.slice(0,24)}...</code>)</>:null} and <strong>Download archive</strong> to keep an off-host copy with its <code>X-Backup-SHA256</code> checksum.</li>
          <li>On the Linux host over SSH, stop the panel control plane and inspect the snapshot with the host supervisor: <code>--verify-installation-backup {operation.operationId}</code>.</li>
          <li>Back up the current data directory, restore the verified control-plane files from the archive while preserving private ownership and <code>0600/0700</code> permissions, then restart the panel service.</li>
          <li>Confirm panel health, sign in as administrator, and restore application/database data backups separately if required.</li>
        </ol>
      </div>:null}
      <p className="feature-helper">Host CLI verification: run supervisor-daemon with its existing systemd flags plus <code>--verify-installation-backup {operation.operationId}</code>. The last remaining verified snapshot on disk is protected from deletion.</p>
      {notice?<p role={notice.kind==='error'?'alert':'status'} className={notice.kind==='error'?'error-notice':'feature-helper'}>{notice.text}</p>:null}
    </>:null}
    {operation.state==='recovery_required'?<p className="feature-helper">Ask the server operator to stop the standard supervisor, then run supervisor-daemon with its existing systemd service configuration and the additional flag <code>--recover-installation-backup {operation.operationId}</code>. This flag is not a complete standalone command. Recovery must verify the original installation before normal work resumes.</p>:null}
  </div>;
}

export function InstallationBackupSettings({userId}:{userId:string}){
  // Browser storage is already origin-bound. Persist no names, receipts, states or secrets.
  const key=`servus.installation-backup.v1:${userId}`,id=useId(),nameRef=useRef<HTMLInputElement>(null),statusRef=useRef<HTMLHeadingElement>(null),submittedName=useRef<string|null>(null),submitLock=useRef(false);
  const [operationId,setOperationId]=useState<string|null>(()=>remembered(key)),[operation,setOperation]=useState<InstallationBackupOperation|null>(null),[name,setName]=useState(''),[invalid,setInvalid]=useState(false),[submitting,setSubmitting]=useState(false),[failure,setFailure]=useState(''),[missing,setMissing]=useState(false),[refresh,setRefresh]=useState(0);
  const capability=useQuery({queryKey:['installation-backups','capability',userId],queryFn:({signal})=>api<InstallationBackupCapability>('/installation-backups',{signal}),retry:false,refetchInterval:30_000});
  const [lookup,setLookup]=useState(''),[lookupId,setLookupId]=useState<string|null>(null),[lookupInvalid,setLookupInvalid]=useState(false);
  const history=useInfiniteQuery({queryKey:['installation-backups','history',userId],initialPageParam:null as string|null,
    queryFn:({pageParam,signal})=>api<InstallationBackupHistory>(`/installation-backups/history${pageParam?`?cursor=${pageParam}`:''}`,{signal}),
    getNextPageParam:page=>page.available?page.nextCursor:undefined,
    retry:false,
    refetchInterval:query=>(query.state.data?.pages.length??0)<=1?30_000:false,
    refetchOnWindowFocus:query=>(query.state.data?.pages.length??0)<=1});
  const lookupResult=useQuery({queryKey:['installation-backups','lookup',userId,lookupId],enabled:lookupId!==null,
    queryFn:({signal})=>api<{operation:InstallationBackupOperation}>(`/installation-backups/${lookupId}`,{signal}),retry:false,
    refetchInterval:query=>query.state.data&&(terminal(query.state.data.operation)||query.state.data.operation.state==='recovery_required')?false:5_000});
  const historyPage=history.data?.pages[0],historyOperations=history.data?.pages.flatMap(page=>page.available?page.operations:[])??[];
  useEffect(()=>{submittedName.current=null;setOperationId(remembered(key));setOperation(null);setName('');setMissing(false);setFailure('');setLookup('');setLookupId(null);setLookupInvalid(false);},[key]);
  useEffect(()=>{
    if(!operationId||terminal(operation)||submitting)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const check=async()=>{
      try{const result=await api<{operation:InstallationBackupOperation}>(`/installation-backups/${operationId}`,{signal:controller.signal});if(controller.signal.aborted)return;setOperation(result.operation);setMissing(false);setFailure('');if(terminal(result.operation)||result.operation.state==='recovery_required')return;}
      catch(error){if(controller.signal.aborted)return;setMissing(error instanceof RequestError&&error.status===404);setFailure(error instanceof RequestError&&[401,403].includes(error.status)?'Sign in again as an administrator to check this operation.':error instanceof RequestError&&error.status===404?'The host has no record of this operation yet. Retry the original request with the same name and operation ID.':'The panel or host is temporarily unavailable. The outcome is not confirmed; keep this operation ID and check again.');}
      if(!controller.signal.aborted)timer=setTimeout(check,5_000);
    };
    void check();return()=>{controller.abort();if(timer)clearTimeout(timer);};
  },[operationId,refresh,operation?.state,submitting]);
  const available=capability.data?.available===true,needsName=!!operationId&&!operation&&(missing||!!failure);
  async function submit(event:React.FormEvent){
    event.preventDefault();if(submitLock.current)return;const requestedName=submittedName.current??name;if(!validName(requestedName)){setInvalid(true);nameRef.current?.focus();return;}
    const current=operationId??randomUuid();
    if(!operationId){try{localStorage.setItem(key,current);}catch{setFailure('Browser storage is unavailable. Allow local storage before starting a backup so its operation ID survives a restart.');return;}setOperationId(current);}
    submitLock.current=true;submittedName.current=requestedName;setSubmitting(true);setFailure('');setInvalid(false);
    try{const result=await api<{operation:InstallationBackupOperation}>('/installation-backups',{method:'POST',body:{operationId:current,name:requestedName}});setOperation(result.operation);setMissing(false);void history.refetch();statusRef.current?.focus();}
    catch{setFailure('The request outcome is not confirmed. Check the saved operation, or retry this same request. Do not start a new backup.');setRefresh(value=>value+1);}
    finally{submitLock.current=false;setSubmitting(false);}
  }
  function clearCompleted(){try{localStorage.removeItem(key);}catch{setFailure('Could not clear saved progress in this browser.');return;}submittedName.current=null;setOperationId(null);setOperation(null);setName('');setMissing(false);setFailure('');setInvalid(false);requestAnimationFrame(()=>nameRef.current?.focus());}
  async function cancel(){
    if(!operation||operation.state!=='requested'||submitLock.current)return;
    submitLock.current=true;setSubmitting(true);setFailure('');
    try{const result=await api<{operation:InstallationBackupOperation}>(`/installation-backups/${operation.operationId}/cancel`,{method:'POST',body:{name:operation.name}});setOperation(result.operation);void history.refetch();}
    catch{setFailure('Cancellation is not confirmed. The host may already have started. Check status before trying again.');setRefresh(value=>value+1);}
    finally{submitLock.current=false;setSubmitting(false);}
  }
  return <section id="installation-backups" className="surface details-card installation-backups" aria-labelledby={`${id}-heading`}>
    <div className="card-heading"><Archive size={19} aria-hidden="true"/><h3 id={`${id}-heading`}>Installation backup</h3></div>
    <p>Save the panel configuration and encrypted secrets on this server. Application files, volumes and database contents require their own backups.</p>
    <p className="feature-helper">The panel briefly disconnects while the host captures the installation and verifies its restart.</p>
    {!available?<p role="status">{capability.isPending?'Checking backup availability...':capability.data?.available===false&&capability.data.reason==='not_configured'?'Installation backups are not configured on this host.':capability.data?.available===false&&capability.data.reason==='host_unsupported'?'The host updater needs an upgrade before installation backups can be used.':'The host backup service is temporarily unavailable. Check again shortly.'}</p>:null}
    {operationId?<div className="installation-backup-progress">
      <h3 ref={statusRef} tabIndex={-1}>Current backup operation</h3>
      <dl><div><dt>Operation ID</dt><dd><code>{operationId}</code></dd></div>{operation?<><div><dt>Name</dt><dd>{operation.name}</dd></div><div><dt>Host state</dt><dd>{stateLabel(operation.state)}</dd></div><div><dt>Last confirmed</dt><dd><time dateTime={new Date(operation.updatedAt).toISOString()}>{new Date(operation.updatedAt).toLocaleString()}</time></dd></div></>:null}</dl>
      <p role="status">{operation?description[operation.state]:'Checking the operation saved in this browser. Completion has not been confirmed.'}</p>
      {operation?.errorCode?<p className="feature-helper">{operation.errorCode==='resume_required'?'The original installation needs a verified restart. Reconcile it on the host.':'The host reported a capture failure. Check the host before retrying.'}</p>:null}
      {operation?.state==='recovery_required'&&uuid.test(operationId)?<p className="feature-helper">Ask the server operator to stop the standard supervisor, then run supervisor-daemon with its existing systemd service configuration and the additional flag <code>--recover-installation-backup {operationId}</code>. This flag is not a complete standalone command. Recovery must verify the original installation before normal work resumes.</p>:null}
      <button className="button" type="button" disabled={submitting} onClick={()=>{setRefresh(value=>value+1);void capability.refetch();}}>Check status</button>
      {operation?.state==='requested'?<button className="button" type="button" disabled={submitting||!available} onClick={()=>void cancel()}>Cancel pending request</button>:null}
      {terminal(operation)?<button className="button" type="button" onClick={clearCompleted}>Start another backup</button>:null}
    </div>:null}
    {!operationId||needsName?<form aria-label={operationId?'Retry installation backup':'Create installation backup'} onSubmit={submit}>
      <label htmlFor={`${id}-name`}>{operationId?'Original backup name':'Backup name'}</label><p id={`${id}-hint`} className="feature-helper">Use 1 to 100 characters without leading or trailing spaces.{operationId?' Re-enter the exact original name; the same operation ID will be reused.':''}</p>
      <input ref={nameRef} id={`${id}-name`} name="backupName" value={name} maxLength={200} required disabled={submitting} readOnly={submittedName.current!==null} aria-invalid={invalid} aria-describedby={`${id}-hint${invalid?` ${id}-error`:''}`} onInvalid={()=>setInvalid(true)} onBlur={()=>{if(name)setInvalid(!validName(name));}} onChange={event=>{setName(event.target.value);if(invalid)setInvalid(false);}}/>
      {invalid?<p id={`${id}-error`} className="form-error">Enter a name of 1 to 100 characters without extra spaces or control characters.</p>:null}
      <button className="button button-primary" disabled={!available||submitting} type="submit">{submitting?'Sending request...':operationId?'Retry same request':'Create installation backup'}</button>
    </form>:null}
    <div className="installation-backup-history">
      <div className="installation-backup-history-heading"><h3 id={`${id}-history`}>Backup history</h3>
        <button className="button" type="button" disabled={history.isFetching} onClick={()=>void history.refetch()}>Refresh history</button></div>
      <p className="feature-helper">Read from this server, newest first. History records attempts; only Completed confirms a verified backup and healthy panel restart.</p>
      {history.isPending?<p role="status">Loading backup history...</p>:null}
      {history.isError?<p className="error-notice" role="alert">Backup history could not be read from the host. Refresh history to try again.</p>:null}
      {historyPage?.available===false?<p role="status">{historyPage.reason==='not_configured'?'Installation backup history is not configured on this host.':'This host does not provide backup history. Upgrade the host updater to enable it. Existing operation IDs can still be checked below.'}</p>:null}
      {historyPage?.available===true&&!historyOperations.length?<p>No installation backup attempts recorded on this host.</p>:null}
      {historyOperations.length?<div className="installation-backup-history-table" tabIndex={0} role="region" aria-labelledby={`${id}-history`}>
        <table><thead><tr><th scope="col">Created</th><th scope="col">Backup</th><th scope="col">Outcome</th><th scope="col">Operation details</th></tr></thead>
          <tbody>{historyOperations.map(item=><tr key={item.operationId}>
            <td><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time></td>
            <th scope="row">{item.name}</th><td>{stateLabel(item.state)}</td>
            <td><details><summary>Details for {item.name}</summary><BackupDetails operation={item} onChanged={()=>void history.refetch()}/></details></td>
          </tr>)}</tbody></table>
      </div>:null}
      {history.hasNextPage?<button className="button" type="button" disabled={history.isFetching} onClick={()=>void history.fetchNextPage()}>{history.isFetchingNextPage?'Loading older backups...':'Load older backups'}</button>:null}
      <form aria-label="Find installation backup" onSubmit={event=>{event.preventDefault();if(!uuid.test(lookup)){setLookupInvalid(true);return;}setLookupInvalid(false);if(lookupId===lookup)void lookupResult.refetch();else setLookupId(lookup);}}>
        <label htmlFor={`${id}-lookup`}>Find by operation ID</label>
        <input id={`${id}-lookup`} value={lookup} required maxLength={36} spellCheck={false} autoCapitalize="none" aria-invalid={lookupInvalid} aria-describedby={lookupInvalid?`${id}-lookup-error`:undefined} onChange={event=>{setLookup(event.target.value);setLookupInvalid(false);}}/>
        {lookupInvalid?<p id={`${id}-lookup-error`} className="form-error">Enter a complete operation ID.</p>:null}
        <button className="button" type="submit" disabled={lookupResult.isFetching}>Find operation</button>
      </form>
      {lookupId&&lookupResult.isPending?<p role="status">Checking operation...</p>:null}
      {lookupResult.isError?<p className="error-notice" role="alert">{lookupResult.error instanceof RequestError&&lookupResult.error.status===404?'No operation with this ID was found on the host.':'The operation could not be read. Check your administrator session and host availability, then try again.'}</p>:null}
      {lookupResult.data?<div className="installation-backup-lookup"><h4>{lookupResult.data.operation.name}: {stateLabel(lookupResult.data.operation.state)}</h4><BackupDetails operation={lookupResult.data.operation} onChanged={()=>void history.refetch()}/></div>:null}
    </div>
    {failure?<p className="error-notice" role="alert">{failure}</p>:null}
    {!operationId&&!available?<button className="button" type="button" disabled={capability.isFetching} onClick={()=>void capability.refetch()}>Check availability</button>:null}
  </section>;
}
