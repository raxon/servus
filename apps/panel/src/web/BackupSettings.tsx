import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, HardDrive, Trash2 } from 'lucide-react';
import type { DatabaseBackup, DatabaseBackupSettings } from '../shared/backups.js';
import type { Service } from '../shared/types.js';
import type { BackupDestination } from '../shared/storage-target.js';
import { api } from './api.js';
import { FeatureError, FeatureLoading } from './feature-ui.js';
import './backups.css';

export function BackupSettings({service,canWrite=true}:{service:Service;canWrite?:boolean}) {
  const id=useId(),client=useQueryClient(),[name,setName]=useState(''),[deleting,setDeleting]=useState<string|null>(null);
  const prefix=`/services/${encodeURIComponent(service.id)}`;
  const history=useQuery({queryKey:['database-backups',service.id],queryFn:()=>api<{backups:DatabaseBackup[]}>(`${prefix}/backups`),refetchInterval:5000});
  const settings=useQuery({queryKey:['database-backup-settings',service.id],queryFn:()=>api<{settings:DatabaseBackupSettings}>(`${prefix}/backup-settings`)});
  const create=useMutation({mutationFn:()=>api(`${prefix}/backups`,{method:'POST',body:name.trim()?{name:name.trim()}:{},idempotent:true}),onSuccess:()=>{setName('');void client.invalidateQueries({queryKey:['database-backups',service.id]});}});
  const remove=useMutation({mutationFn:(backupId:string)=>api(`${prefix}/backups/${encodeURIComponent(backupId)}`,{method:'DELETE'}),onSuccess:()=>{setDeleting(null);void client.invalidateQueries({queryKey:['database-backups',service.id]});}});
  if(!['postgres','mariadb','redis'].includes(service.kind??''))return <p>Backups are available for managed databases.</p>;
  const active=history.data?.backups.some(backup=>['queued','running'].includes(backup.status))??false;
  return <div className="database-backups">
    <section className="backup-section">
      <div className="backup-heading"><HardDrive size={19} aria-hidden="true" /><h2>Database backups</h2></div>
      <p>Save a database export on this server or in S3-compatible storage. Backups contain database data only, up to 2 GiB. Keep a copy outside this server to protect against disk or server loss.</p>
      {service.kind==='redis'?<p className="feature-helper">Redis backups can be downloaded. Restoring Redis through the panel is not available yet.</p>:<p className="feature-helper">To restore, download a backup and upload it through Database restore in the database connection panel. Preparation and confirmation happen there before the running database is replaced.</p>}
      {canWrite?<form method="post" action={`/api/v1${prefix}/backups`} aria-labelledby={`${id}-manual`} onSubmit={event=>{event.preventDefault();create.mutate();}}>
        <h3 id={`${id}-manual`}>Manual backup</h3>
        <label htmlFor={`${id}-name`}>Backup name (optional)</label>
        <input id={`${id}-name`} name="name" value={name} maxLength={100} onChange={event=>setName(event.target.value)} placeholder="Before application update" />
        <p className="feature-helper">A name is generated if you leave this empty.</p>
        <button className="button button-primary" type="submit" disabled={create.isPending||active||service.deployedRevision===null}>{create.isPending?'Queuing backup':active?'Backup in progress':'Create backup'}</button>
        {create.isSuccess?<p role="status">Backup queued. Its result will appear below.</p>:null}
      </form>:null}
      <FeatureError error={create.error||history.error||settings.error} />
    </section>
    <BackupDestinationForm serviceId={service.id} canWrite={canWrite} />
    {settings.data?<BackupScheduleForm serviceId={service.id} settings={settings.data.settings} canWrite={canWrite} />:settings.isPending?<FeatureLoading label="Loading backup settings" />:null}
    <section className="backup-section" aria-labelledby={`${id}-history`}>
      <h3 id={`${id}-history`}>Backup history</h3>
      {history.isPending?<FeatureLoading label="Loading backups" />:history.data?.backups.length?<ul className="backup-history">{history.data.backups.map(backup=><li key={backup.id}>
        <div className="detail-row"><strong>{backup.name}</strong><span>{backup.status}</span></div>
        <p className="feature-helper"><time dateTime={backup.createdAt}>{new Date(backup.createdAt).toLocaleString()}</time> · {backup.trigger} · {backup.destination==='s3'?'S3 storage':'This server'}{backup.size!==null?` · ${(backup.size/1024/1024).toFixed(2)} MiB`:''}</p>
        {backup.error?<p>{backup.error}</p>:null}
        {canWrite&&backup.status==='succeeded'?<a className="button button-small" href={`/api/v1${prefix}/backups/${backup.id}/download`} download><Download size={15} aria-hidden="true" /> Download</a>:null}
        {canWrite&&['succeeded','failed'].includes(backup.status)?deleting===backup.id?<div>
          <p>Delete this backup file from the server? This cannot be undone.</p>
          <button className="button button-danger" type="button" disabled={remove.isPending} onClick={()=>remove.mutate(backup.id)}>Delete backup</button>
          <button className="button" type="button" disabled={remove.isPending} onClick={()=>setDeleting(null)}>Keep backup</button>
        </div>:<button className="button button-small" type="button" onClick={()=>setDeleting(backup.id)}><Trash2 size={15} aria-hidden="true" /> Delete</button>:null}
      </li>)}</ul>:<p>No backups yet. Create one manually before enabling a schedule.</p>}
      <FeatureError error={remove.error} />
    </section>
  </div>;
}

export function BackupDestinationForm({serviceId,canWrite,mountTarget}:{serviceId:string;canWrite:boolean;mountTarget?:string}) {
  const id=useId(),client=useQueryClient();
  const path=`/services/${encodeURIComponent(serviceId)}/${mountTarget===undefined?'backup-destination':'volume-backup-destination'}`;
  const queryKey=mountTarget===undefined?['database-backup-destination',serviceId]:['volume-backup-destination',serviceId,mountTarget];
  const query=useQuery({queryKey,queryFn:()=>api<{destination:BackupDestination}>(path+(mountTarget===undefined?'':`?mountTarget=${encodeURIComponent(mountTarget)}`))});
  type Draft={type:'local'|'s3'|'r2';endpoint:string;region:string;bucket:string;prefix:string;storageClass:string;accessKeyId:string;secretAccessKey:string};
  const [draft,setDraft]=useState<Draft|null>(null);
  const current=query.data?.destination;
  const value:Draft=draft??{type:current?.type==='s3'?current.provider:'local',endpoint:current?.type==='s3'?current.endpoint:'https://s3.us-east-1.amazonaws.com',region:current?.type==='s3'?current.region:'us-east-1',bucket:current?.type==='s3'?current.bucket:'',prefix:current?.type==='s3'?current.prefix:'backups',storageClass:current?.type==='s3'?current.storageClass:'STANDARD',accessKeyId:'',secretAccessKey:''};
  const update=(next:Partial<Draft>)=>{setDraft({...value,...next});save.reset();};
  const save=useMutation({mutationFn:()=>{const destination=value.type==='local'?{type:'local'}:{...value,type:'s3',provider:value.type};return api(path,{method:'PUT',body:mountTarget===undefined?destination:{mountTarget,destination}});},onSuccess:()=>{setDraft(null);void client.invalidateQueries({queryKey});}});
  return <section className="backup-section"><form method="post" action={`/api/v1${path}`} aria-labelledby={`${id}-heading`} onSubmit={event=>{event.preventDefault();save.mutate();}}>
    <h3 id={`${id}-heading`}>Backup destination</h3>
    <p className="feature-helper">New backups use this destination. Existing backups stay in their original location. Create a manual backup to verify access before enabling a schedule.</p>
    <fieldset className="backup-destination-choice"><legend>Storage provider</legend>{([{type:'local',label:'This server'},{type:'s3',label:'Amazon S3 / compatible'},{type:'r2',label:'Cloudflare R2'}] as const).map(option=><div className="backup-toggle" key={option.type}>
      <input id={`${id}-${option.type}`} name="provider" type="radio" value={option.type} checked={value.type===option.type} disabled={!canWrite} onChange={()=>update({type:option.type,region:option.type==='r2'?'auto':'us-east-1',endpoint:option.type==='r2'?'':option.type==='s3'?'https://s3.us-east-1.amazonaws.com':value.endpoint})} /><label htmlFor={`${id}-${option.type}`}>{option.label}</label>
    </div>)}</fieldset>
    {value.type!=='local'?<>
      <label htmlFor={`${id}-endpoint`}>S3 endpoint URL</label><input id={`${id}-endpoint`} name="endpoint" type="url" required value={value.endpoint} disabled={!canWrite} maxLength={512} placeholder={value.type==='r2'?'https://your-account-id.r2.cloudflarestorage.com':'https://s3.us-east-1.amazonaws.com'} onChange={event=>update({endpoint:event.target.value})} spellCheck={false} autoCapitalize="none" />
      <label htmlFor={`${id}-region`}>Region</label><input id={`${id}-region`} name="region" required value={value.region} disabled={!canWrite} maxLength={64} onChange={event=>update({region:event.target.value})} spellCheck={false} autoCapitalize="none" />
      <label htmlFor={`${id}-bucket`}>Bucket name</label><input id={`${id}-bucket`} name="bucket" required value={value.bucket} disabled={!canWrite} minLength={3} maxLength={63} onChange={event=>update({bucket:event.target.value})} spellCheck={false} autoCapitalize="none" />
      <label htmlFor={`${id}-prefix`}>Folder prefix (optional)</label><input id={`${id}-prefix`} name="prefix" value={value.prefix} disabled={!canWrite} maxLength={200} onChange={event=>update({prefix:event.target.value})} spellCheck={false} autoCapitalize="none" />
      <label htmlFor={`${id}-class`}>Storage class</label><select id={`${id}-class`} name="storageClass" value={value.storageClass} disabled={!canWrite} onChange={event=>update({storageClass:event.target.value})}>{(value.type==='r2'?['STANDARD','STANDARD_IA']:['STANDARD','STANDARD_IA','ONEZONE_IA','INTELLIGENT_TIERING','GLACIER_IR']).map(option=><option key={option} value={option}>{option}</option>)}</select>
      {current?.type==='s3'?<p className="feature-helper">Credentials are configured. Enter both keys again to save a changed destination.</p>:null}
      <label htmlFor={`${id}-access`}>Access key ID</label><input id={`${id}-access`} name="accessKeyId" type="password" autoComplete="off" required value={value.accessKeyId} disabled={!canWrite} maxLength={256} onChange={event=>update({accessKeyId:event.target.value})} />
      <label htmlFor={`${id}-secret`}>Secret access key</label><input id={`${id}-secret`} name="secretAccessKey" type="password" autoComplete="new-password" required value={value.secretAccessKey} disabled={!canWrite} maxLength={4096} onChange={event=>update({secretAccessKey:event.target.value})} />
    </>:<p className="feature-helper">Local backup files are private, but a failure of this server can also destroy its backups.</p>}
    {canWrite?<button className="button button-primary" type="submit" disabled={save.isPending||query.isPending}>{save.isPending?'Saving destination':'Save backup destination'}</button>:null}
    {save.isSuccess?<p role="status">Backup destination saved.</p>:null}<FeatureError error={query.error||save.error} />
  </form></section>;
}

export function BackupScheduleForm({serviceId,settings,canWrite,mountTarget}:{serviceId:string;settings:DatabaseBackupSettings;canWrite:boolean;mountTarget?:string}) {
  const id=useId(),client=useQueryClient(),[draft,setDraft]=useState<Pick<DatabaseBackupSettings,'enabled'|'cron'|'retention'>|null>(null);
  const value=draft??settings;
  const path=`/services/${encodeURIComponent(serviceId)}/${mountTarget===undefined?'backup-settings':'volume-backup-settings'}`;
  const save=useMutation({mutationFn:()=>api(path,{method:'PUT',body:{enabled:value.enabled,cron:value.cron,retention:value.retention,...(mountTarget===undefined?{}:{mountTarget})}}),onSuccess:()=>{setDraft(null);void client.invalidateQueries({queryKey:[mountTarget===undefined?'database-backup-settings':'volume-backup-settings',serviceId]});}});
  return <section className="backup-section"><form method="post" action={`/api/v1${path}`} aria-labelledby={`${id}-heading`} onSubmit={event=>{event.preventDefault();save.mutate();}}>
    <h3 id={`${id}-heading`}>Scheduled backups</h3>
    <p>Schedules use UTC and run at most once per minute. Missed runs are not replayed after downtime. Only one backup per {mountTarget===undefined?'database':'application'} runs at a time.</p>
    <div className="backup-toggle"><input id={`${id}-enabled`} name="enabled" type="checkbox" checked={value.enabled} disabled={!canWrite} onChange={event=>setDraft({...value,enabled:event.target.checked})} /><label htmlFor={`${id}-enabled`}>Enable scheduled backups</label></div>
    <label htmlFor={`${id}-cron`}>Cron schedule (UTC)</label>
    <p id={`${id}-cron-help`} className="feature-helper">Five fields: minute, hour, day, month, weekday. For example, 0 2 * * * runs every day at 02:00 UTC.</p>
    <input id={`${id}-cron`} name="cron" value={value.cron} required maxLength={128} spellCheck={false} autoCapitalize="none" disabled={!canWrite} aria-describedby={`${id}-cron-help`} onChange={event=>{setDraft({...value,cron:event.target.value});save.reset();}} />
    {!draft?<p className="feature-helper">{settings.description}</p>:null}
    <label htmlFor={`${id}-retention`}>Completed backups to keep</label>
    <input id={`${id}-retention`} name="retention" type="number" min={1} max={100} step={1} required disabled={!canWrite} value={Number.isFinite(value.retention)?value.retention:''} onChange={event=>setDraft({...value,retention:event.target.valueAsNumber})} aria-describedby={`${id}-retention-help`} />
    <p id={`${id}-retention-help`} className="feature-helper">Keep 1-100 completed backups. Older successful backups are removed after a new backup completes. Failed runs never remove the last good backup.</p>
    {canWrite?<button className="button button-primary" type="submit" disabled={save.isPending}>{save.isPending?'Saving schedule':'Save backup settings'}</button>:null}
    {save.isSuccess?<p role="status">Backup settings saved.</p>:null}
    <FeatureError error={save.error} />
  </form></section>;
}
