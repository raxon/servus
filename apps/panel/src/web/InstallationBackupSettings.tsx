import { randomUuid } from "./random-uuid.js";
import {useEffect,useId,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Archive} from 'lucide-react';
import {api,RequestError} from './api.js';
import './InstallationBackupSettings.css';

type InstallationBackupCapability={available:true}|{available:false;reason:'not_configured'|'host_unavailable'|'host_unsupported'};
interface InstallationBackupOperation{operationId:string;actorId:string;name:string;state:'requested'|'capturing'|'verified'|'starting'|'recovering'|'completed'|'failed'|'cancelled'|'recovery_required';createdAt:number;updatedAt:number;errorCode:'capture_failed'|'resume_required'|null}

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const terminal=(operation:InstallationBackupOperation|null)=>operation?.state==='completed'||operation?.state==='failed'||operation?.state==='cancelled';
const description:Record<InstallationBackupOperation['state'],string>={requested:'Waiting for the host to begin.',capturing:'Capturing installation configuration and encrypted secrets.',verified:'Snapshot verified. Waiting for the panel to restart.',starting:'Restarting the panel and checking its health.',recovering:'The host is resuming the original installation. Its restart and health are not verified yet; this does not confirm a successful backup.',completed:'Installation backup completed and panel health verified.',failed:'Backup failed. The host did not confirm a completed installation backup.',cancelled:'Backup request cancelled before the host began capturing. No completed backup was created.',recovery_required:'Host recovery is required. An administrator must reconcile the installation on the server before another backup or update.'};
const validName=(value:string)=>value===value.trim()&&Array.from(value).length>0&&Array.from(value).length<=100&&!/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)&&!value.startsWith('\u0085')&&!value.endsWith('\u0085');
function remembered(key:string){try{const value=localStorage.getItem(key);return value&&uuid.test(value)?value:null;}catch{return null;}}

export function InstallationBackupSettings({userId}:{userId:string}){
  // Browser storage is already origin-bound. Persist no names, receipts, states or secrets.
  const key=`servus.installation-backup.v1:${userId}`,id=useId(),nameRef=useRef<HTMLInputElement>(null),statusRef=useRef<HTMLHeadingElement>(null),submittedName=useRef<string|null>(null),submitLock=useRef(false);
  const [operationId,setOperationId]=useState<string|null>(()=>remembered(key)),[operation,setOperation]=useState<InstallationBackupOperation|null>(null),[name,setName]=useState(''),[invalid,setInvalid]=useState(false),[submitting,setSubmitting]=useState(false),[failure,setFailure]=useState(''),[missing,setMissing]=useState(false),[refresh,setRefresh]=useState(0);
  const capability=useQuery({queryKey:['installation-backups','capability',userId],queryFn:({signal})=>api<InstallationBackupCapability>('/installation-backups',{signal}),retry:false,refetchInterval:30_000});
  useEffect(()=>{submittedName.current=null;setOperationId(remembered(key));setOperation(null);setName('');setMissing(false);setFailure('');},[key]);
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
    try{const result=await api<{operation:InstallationBackupOperation}>('/installation-backups',{method:'POST',body:{operationId:current,name:requestedName}});setOperation(result.operation);setMissing(false);statusRef.current?.focus();}
    catch{setFailure('The request outcome is not confirmed. Check the saved operation, or retry this same request. Do not start a new backup.');setRefresh(value=>value+1);}
    finally{submitLock.current=false;setSubmitting(false);}
  }
  function clearCompleted(){try{localStorage.removeItem(key);}catch{setFailure('Could not clear saved progress in this browser.');return;}submittedName.current=null;setOperationId(null);setOperation(null);setName('');setMissing(false);setFailure('');setInvalid(false);requestAnimationFrame(()=>nameRef.current?.focus());}
  async function cancel(){
    if(!operation||operation.state!=='requested'||submitLock.current)return;
    submitLock.current=true;setSubmitting(true);setFailure('');
    try{const result=await api<{operation:InstallationBackupOperation}>(`/installation-backups/${operation.operationId}/cancel`,{method:'POST',body:{name:operation.name}});setOperation(result.operation);}
    catch{setFailure('Cancellation is not confirmed. The host may already have started. Check status before trying again.');setRefresh(value=>value+1);}
    finally{submitLock.current=false;setSubmitting(false);}
  }
  return <section id="installation-backups" className="surface details-card installation-backups" aria-labelledby={`${id}-heading`}>
    <div className="card-heading"><Archive size={19} aria-hidden="true"/><h2 id={`${id}-heading`}>Installation backup</h2></div>
    <p>Save the panel configuration and encrypted secrets on this server. Application files, volumes and database contents require their own backups.</p>
    <p className="feature-helper">The panel briefly disconnects while the host captures the installation and verifies its restart.</p>
    {!available?<p role="status">{capability.isPending?'Checking backup availability...':capability.data?.available===false&&capability.data.reason==='not_configured'?'Installation backups are not configured on this host.':capability.data?.available===false&&capability.data.reason==='host_unsupported'?'The host updater needs an upgrade before installation backups can be used.':'The host backup service is temporarily unavailable. Check again shortly.'}</p>:null}
    {operationId?<div className="installation-backup-progress">
      <h3 ref={statusRef} tabIndex={-1}>Current backup operation</h3>
      <dl><div><dt>Operation ID</dt><dd><code>{operationId}</code></dd></div>{operation?<><div><dt>Name</dt><dd>{operation.name}</dd></div><div><dt>Host state</dt><dd>{operation.state}</dd></div><div><dt>Last confirmed</dt><dd><time dateTime={new Date(operation.updatedAt).toISOString()}>{new Date(operation.updatedAt).toLocaleString()}</time></dd></div></>:null}</dl>
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
    {failure?<p className="error-notice" role="alert">{failure}</p>:null}
    {!operationId&&!available?<button className="button" type="button" disabled={capability.isFetching} onClick={()=>void capability.refetch()}>Check availability</button>:null}
  </section>;
}
