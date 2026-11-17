import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, HardDrive, Trash2 } from 'lucide-react';
import type { Service } from '../shared/types.js';
import type { VolumeBackup, VolumeBackupSettings as Settings, VolumeRestore } from '../shared/volume-backups.js';
import { api } from './api.js';
import { BackupDestinationForm, BackupScheduleForm } from './BackupSettings.js';
import { FeatureError, FeatureLoading } from './feature-ui.js';

export function VolumeBackupSettings({service,canWrite}:{service:Service;canWrite:boolean}) {
  const id=useId(),mounts=(service.mounts??[]).filter(mount=>mount.type==='volume'&&!mount.readOnly);
  const [selection,setSelection]=useState('');
  const target=mounts.some(mount=>mount.target===selection)?selection:mounts[0]?.target;
  return <div className="database-backups">
    <section className="backup-section">
      <div className="backup-heading"><HardDrive size={19} aria-hidden="true"/><h2>Volume backups</h2></div>
      <p>Back up a writable application volume, up to 2 GiB. The application stops during capture and resumes with its previous replica count. Only the selected volume is included.</p>
      <p className="feature-helper">Database data and panel configuration have separate backup procedures. Keep a copy outside this server to protect against server or disk loss. Hard links, special files and symbolic links that leave their directory are unsupported.</p>
      {target?<><label htmlFor={`${id}-mount`}>Application volume</label><select id={`${id}-mount`} name="mountTarget" value={target} onChange={event=>setSelection(event.target.value)}>{mounts.map(mount=><option key={mount.target} value={mount.target}>{mount.name} - {mount.target}</option>)}</select></>:<p>Add a writable named volume in Storage before creating a volume backup. Bind mounts and configuration files are excluded.</p>}
    </section>
    {target?<SelectedVolumeBackups key={`${service.id}:${target}`} service={service} mountTarget={target} canWrite={canWrite}/>:null}
  </div>;
}

function SelectedVolumeBackups({service,mountTarget,canWrite}:{service:Service;mountTarget:string;canWrite:boolean}) {
  const id=useId(),client=useQueryClient(),[name,setName]=useState('');
  const [confirmation,setConfirmation]=useState<{restore:VolumeRestore;action:'commit'|'rollback'}|null>(null);
  const [deleting,setDeleting]=useState<string|null>(null);
  const prefix=`/services/${encodeURIComponent(service.id)}`;
  const history=useQuery({queryKey:['volume-backups',service.id],queryFn:()=>api<{backups:VolumeBackup[]}>(`${prefix}/volume-backups`),refetchInterval:5000});
  const settings=useQuery({queryKey:['volume-backup-settings',service.id],queryFn:()=>api<{settings:Settings[]}>(`${prefix}/volume-backup-settings`)});
  const restores=useQuery({queryKey:['volume-restores',service.id],queryFn:()=>api<{restores:VolumeRestore[]}>(`${prefix}/volume-restores`),refetchInterval:3000});
  const refresh=()=>{for(const key of ['volume-backups','volume-restores','service'])void client.invalidateQueries({queryKey:[key,service.id]});};
  const create=useMutation({mutationFn:()=>api(`${prefix}/volume-backups`,{method:'POST',body:{mountTarget,...(name.trim()?{name:name.trim()}:{})},idempotent:true}),onSuccess:()=>{setName('');refresh();}});
  const prepare=useMutation({mutationFn:(backupId:string)=>api(`${prefix}/volume-backups/${encodeURIComponent(backupId)}/restore`,{method:'POST',body:{},idempotent:true}),onSuccess:refresh});
  const reconcile=useMutation({mutationFn:(backupId:string)=>api<{phase:string}>(`${prefix}/volume-backups/${encodeURIComponent(backupId)}/recover`,{method:'POST',body:{}}),onSuccess:refresh});
  const remove=useMutation({mutationFn:(backupId:string)=>api(`${prefix}/volume-backups/${encodeURIComponent(backupId)}`,{method:'DELETE'}),onSuccess:()=>{setDeleting(null);refresh();}});
  const change=useMutation({mutationFn:(value:{restoreId:string;action:'commit'|'rollback'|'cancel'})=>api(`${prefix}/volume-restores/${encodeURIComponent(value.restoreId)}/${value.action}`,{method:'POST',body:value.action==='cancel'?{}:{confirm:true}}),onSuccess:()=>{setConfirmation(null);refresh();}});
  const activeBackup=history.data?.backups.some(backup=>['queued','running'].includes(backup.status))??false;
  const activeRestore=restores.data?.restores.some(restore=>['preparing','prepared','switching','rolling_back','needs_review'].includes(restore.phase))??false;
  const busy=create.isPending||prepare.isPending||change.isPending||reconcile.isPending||remove.isPending;
  const selectedSettings=settings.data?.settings.find(value=>value.mountTarget===mountTarget);
  const selectedBackups=history.data?.backups.filter(backup=>backup.mountTarget===mountTarget)??[];
  const selectedRestores=restores.data?.restores.filter(restore=>restore.mountTarget===mountTarget)??[];
  return <>
    {canWrite?<section className="backup-section"><form method="post" action={`/api/v1${prefix}/volume-backups`} aria-labelledby={`${id}-manual`} onSubmit={event=>{event.preventDefault();create.mutate();}}>
      <h3 id={`${id}-manual`}>Manual volume backup</h3>
      <label htmlFor={`${id}-name`}>Backup name (optional)</label><input id={`${id}-name`} name="name" maxLength={100} value={name} onChange={event=>setName(event.target.value)}/>
      <p className="feature-helper">The deployed mount at {mountTarget} is used. Save and deploy any pending storage changes first.</p>
      <button className="button button-primary" type="submit" disabled={busy||activeBackup||activeRestore||service.deployedRevision===null}>{create.isPending?'Queuing backup':'Create volume backup'}</button>
      {create.isSuccess?<p role="status">Volume backup queued. Its result will appear below.</p>:null}<FeatureError error={create.error}/>
    </form></section>:null}
    <BackupDestinationForm serviceId={service.id} mountTarget={mountTarget} canWrite={canWrite}/>
    {selectedSettings?<BackupScheduleForm serviceId={service.id} mountTarget={mountTarget} settings={selectedSettings} canWrite={canWrite}/>:settings.isPending?<FeatureLoading label="Loading volume backup settings"/>:null}
    <section className="backup-section" aria-labelledby={`${id}-history`}><h3 id={`${id}-history`}>Volume backup history</h3>
      {history.isPending?<FeatureLoading label="Loading volume backups"/>:selectedBackups.length?<ul className="backup-history">{selectedBackups.map(backup=><li key={backup.id}>
        <div className="detail-row"><strong>{backup.name}</strong><span>{backup.deletionPending?'deletion pending':backup.status}</span></div>
        <p className="feature-helper"><time dateTime={backup.createdAt}>{new Date(backup.createdAt).toLocaleString()}</time> · {backup.trigger} · {backup.destination==='s3'?'S3 storage':'This server'}{backup.size!==null?` · ${(backup.size/1024/1024).toFixed(2)} MiB`:''}</p>
        {backup.error?<p>{backup.error}</p>:null}
        {canWrite&&backup.status==='succeeded'&&!backup.deletionPending?<button className="button button-small" type="button" disabled={busy||activeBackup||activeRestore} onClick={()=>prepare.mutate(backup.id)}>Prepare restore</button>:null}
        {canWrite&&backup.status==='succeeded'&&!backup.deletionPending?<a className="button button-small" href={`/api/v1${prefix}/volume-backups/${encodeURIComponent(backup.id)}/download`} download><Download size={15} aria-hidden="true"/>Download volume backup</a>:null}
        {canWrite&&['running','failed'].includes(backup.status)&&!backup.deletionPending?<button className="button button-small" type="button" disabled={busy} onClick={()=>reconcile.mutate(backup.id)}>Check backup recovery</button>:null}
        {canWrite&&['succeeded','failed'].includes(backup.status)?deleting===backup.id?<div><p>Delete this backup archive from its storage destination? This cannot be undone.</p><button className="button button-danger" type="button" disabled={busy||activeRestore} onClick={()=>remove.mutate(backup.id)}>Delete volume backup</button><button className="button" type="button" disabled={busy} onClick={()=>setDeleting(null)}>Keep backup</button></div>:<button className="button button-small" type="button" disabled={busy||activeRestore} onClick={()=>setDeleting(backup.id)}><Trash2 size={15} aria-hidden="true"/>{backup.deletionPending?'Retry deletion':'Delete'}</button>:null}
      </li>)}</ul>:<p>No backups for this volume yet.</p>}
      {reconcile.isSuccess?<p role="status">Backup recovery checked. Review its result and the application status before starting another operation.</p>:null}
      <FeatureError error={history.error||settings.error||prepare.error||reconcile.error||remove.error}/>
    </section>
    <section className="backup-section" aria-labelledby={`${id}-restores`}><h3 id={`${id}-restores`}>Volume restore history</h3>
      <p>Preparation validates the archive in a new volume. Switching stops the application briefly. The original volume is retained for rollback.</p>
      {restores.isPending?<FeatureLoading label="Loading volume restores"/>:selectedRestores.length?<ul className="backup-history">{selectedRestores.map(restore=><li key={restore.id}>
        <div className="detail-row"><strong>{restore.mountTarget}</strong><span>{restore.phase}</span></div>
        <p className="feature-helper"><time dateTime={restore.updatedAt}>{new Date(restore.updatedAt).toLocaleString()}</time></p>{restore.error?<p>{restore.error}</p>:null}
        {canWrite&&['prepared','switching'].includes(restore.phase)?<button className="button button-primary" type="button" disabled={busy} onClick={()=>setConfirmation({restore,action:'commit'})}>{restore.phase==='switching'?'Resume volume switch':'Switch to restored volume'}</button>:null}
        {canWrite&&['prepared','failed'].includes(restore.phase)?<button className="button" type="button" disabled={busy} onClick={()=>change.mutate({restoreId:restore.id,action:'cancel'})}>Cancel prepared restore</button>:null}
        {canWrite&&['completed','rolling_back','needs_review'].includes(restore.phase)?<button className="button" type="button" disabled={busy||activeBackup} onClick={()=>setConfirmation({restore,action:'rollback'})}>Roll back volume</button>:null}
      </li>)}</ul>:<p>No volume restore operations yet.</p>}
      {confirmation?<form key={`${confirmation.restore.id}:${confirmation.action}`} method="post" action={`/api/v1${prefix}/volume-restores/${encodeURIComponent(confirmation.restore.id)}/${confirmation.action}`} aria-labelledby={`${id}-confirm`} onSubmit={event=>{event.preventDefault();change.mutate({restoreId:confirmation.restore.id,action:confirmation.action});}}>
        <h3 id={`${id}-confirm`}>{confirmation.action==='commit'?'Confirm volume switch':'Confirm volume rollback'}</h3>
        <p>{confirmation.action==='commit'?'The application will use the restored data. The current volume will be retained.':'The application will use the original volume. Changes written to the restored volume will remain there.'}</p>
        <div className="backup-toggle"><input id={`${id}-confirmed`} name="confirm" type="checkbox" required/><label htmlFor={`${id}-confirmed`}>I understand that the application will stop briefly and its active data will change.</label></div>
        <button className="button button-primary" type="submit" disabled={busy}>{change.isPending?'Applying volume change':confirmation.action==='commit'?'Confirm switch':'Confirm rollback'}</button>
        <button className="button" type="button" disabled={busy} onClick={()=>setConfirmation(null)}>Keep current volume</button>
      </form>:null}
      <FeatureError error={restores.error||change.error}/>
    </section>
  </>;
}
