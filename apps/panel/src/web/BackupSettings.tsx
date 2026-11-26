import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, HardDrive, Trash2, ShieldCheck, Clock3, ArrowUpRight, Database } from 'lucide-react';
import type { DatabaseBackup, DatabaseBackupSettings, BackupRetentionPolicy } from '../shared/backups.js';
import type { Service } from '../shared/types.js';
import type { BackupStorageProfile, BackupStorageSelection } from '../shared/storage-target.js';
import { api } from './api.js';
import { FeatureError, FeatureLoading } from './feature-ui.js';
import './backups.css';

export function BackupSettings({service,canWrite=true,admin=false}:{service:Service;canWrite?:boolean;admin?:boolean}) {
  const id=useId(),client=useQueryClient(),[name,setName]=useState(''),[deleting,setDeleting]=useState<string|null>(null);
  const prefix=`/services/${encodeURIComponent(service.id)}`;
  const history=useQuery({queryKey:['database-backups',service.id],queryFn:()=>api<{backups:DatabaseBackup[]}>(`${prefix}/backups`),refetchInterval:5000});
  const settings=useQuery({queryKey:['database-backup-settings',service.id],queryFn:()=>api<{settings:DatabaseBackupSettings}>(`${prefix}/backup-settings`)});
  const create=useMutation({mutationFn:()=>api(`${prefix}/backups`,{method:'POST',body:name.trim()?{name:name.trim()}:{},idempotent:true}),onSuccess:()=>{setName('');void client.invalidateQueries({queryKey:['database-backups',service.id]});}});
  const remove=useMutation({mutationFn:(backupId:string)=>api(`${prefix}/backups/${encodeURIComponent(backupId)}`,{method:'DELETE'}),onSuccess:()=>{setDeleting(null);void client.invalidateQueries({queryKey:['database-backups',service.id]});}});
  if(!['postgres','mariadb','redis','mysql','mongodb'].includes(service.kind??''))return <p>Backups are available for managed databases.</p>;
  const active=history.data?.backups.some(backup=>['queued','running'].includes(backup.status))??false;
  return <div className="database-backups">
    <section className="backup-section">
      <div className="backup-overview"><div><h2>Database backups</h2></div><span className="backup-status"><span className={settings.data?.settings.enabled?"backup-status-dot active":"backup-status-dot"}/>{settings.data?.settings.enabled?"Schedule enabled":"Manual backups"}</span></div>
      <p className="feature-helper">Save database exports to this server, Amazon S3 or Cloudflare R2. Keep a copy outside this server to protect against disk loss.</p>
      <div className="backup-summary"><div><HardDrive size={17} aria-hidden="true"/><span>Database data only<small>Up to 2 GiB per backup</small></span></div><div><ShieldCheck size={17} aria-hidden="true"/><span>{settings.data?.settings.encrypted?'Encryption enabled':'Encryption optional'}<small>AES-256-GCM at rest</small></span></div><div><Clock3 size={17} aria-hidden="true"/><span>UTC schedules<small>One backup at a time</small></span></div></div>
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
    <DatabaseBackupDestination serviceId={service.id} canWrite={canWrite} admin={admin} />
    {settings.data?<BackupScheduleForm serviceId={service.id} settings={settings.data.settings} canWrite={canWrite} />:settings.isPending?<FeatureLoading label="Loading backup settings" />:null}
    <section className="backup-section" aria-labelledby={`${id}-history`}>
      <h3 id={`${id}-history`}>Backup history</h3>
      {history.isPending?<FeatureLoading label="Loading backups" />:history.data?.backups.length?<ul className="backup-history">{history.data.backups.map(backup=><li key={backup.id}>
        <div className="detail-row"><strong>{backup.name}</strong><span>{backup.status}</span></div>
        <p className="feature-helper"><time dateTime={backup.createdAt}>{new Date(backup.createdAt).toLocaleString()}</time> · {backup.trigger} · {backup.destination==='s3'?'Remote storage':'This server'}{backup.encrypted?' · Encrypted':''}{backup.size!==null?` · ${(backup.size/1024/1024).toFixed(2)} MiB`:''}</p>
        {backup.error?<p>{backup.error}</p>:null}
        {canWrite&&backup.status==='succeeded'?<a className="button button-small" href={`/api/v1${prefix}/backups/${backup.id}/download`} download><Download size={15} aria-hidden="true" /> Download</a>:null}
        {canWrite&&['succeeded','failed'].includes(backup.status)?deleting===backup.id?<div>
          <p>Delete this backup file from its storage destination? This cannot be undone.</p>
          <button className="button button-danger" type="button" disabled={remove.isPending} onClick={()=>remove.mutate(backup.id)}>Delete backup</button>
          <button className="button" type="button" disabled={remove.isPending} onClick={()=>setDeleting(null)}>Keep backup</button>
        </div>:<button className="button button-small" type="button" onClick={()=>setDeleting(backup.id)}><Trash2 size={15} aria-hidden="true" /> Delete</button>:null}
      </li>)}</ul>:<div className="backup-empty"><Database size={24} aria-hidden="true"/><h3>Your first recovery point starts here</h3><p>Create a manual backup to verify storage, then enable a schedule.</p></div>}
      <FeatureError error={remove.error} />
    </section>
  </div>;
}

export function BackupDestinationForm({serviceId,canWrite,mountTarget,admin=false}:{serviceId:string;canWrite:boolean;mountTarget?:string;admin?:boolean}) {
  return <DatabaseBackupDestination serviceId={serviceId} canWrite={canWrite} admin={admin} mountTarget={mountTarget}/>;
}

function DatabaseBackupDestination({serviceId,canWrite,admin,mountTarget}:{serviceId:string;canWrite:boolean;admin:boolean;mountTarget?:string}) {
  const id=useId(),client=useQueryClient(),[selected,setSelected]=useState<string|null>(null);
  const path=`/services/${encodeURIComponent(serviceId)}/${mountTarget===undefined?'backup-destination':'volume-backup-destination'}`;
  const queryKey=mountTarget===undefined?['database-backup-destination',serviceId]:['volume-backup-destination',serviceId,mountTarget];
  const current=useQuery({queryKey,queryFn:()=>api<BackupStorageSelection>(path+(mountTarget===undefined?'':`?mountTarget=${encodeURIComponent(mountTarget)}`))});
  const profiles=useQuery({queryKey:['backup-storage'],queryFn:()=>api<{profiles:BackupStorageProfile[]}>('/backup-storage')});
  const value=selected??current.data?.profileId??(current.data?.legacy?'legacy':'local');
  const save=useMutation({mutationFn:()=>api(path,{method:'PUT',body:{profileId:value==='local'?null:value,...(mountTarget===undefined?{}:{mountTarget})}}),onSuccess:()=>{setSelected(null);void client.invalidateQueries({queryKey});}});
  const unavailable=!!current.data?.profileId&&!profiles.data?.profiles.some(profile=>profile.id===current.data?.profileId);
  return <section className="backup-section"><form action={`/api/v1${path}`} method="post" aria-labelledby={`${id}-heading`} onSubmit={event=>{event.preventDefault();save.mutate();}}>
    <div className="backup-overview"><div><h3 id={`${id}-heading`}>Where backups are stored</h3></div>{admin?<a className="backup-settings-link" href="/settings#backup-storage">Manage storage<ArrowUpRight size={15} aria-hidden="true"/></a>:null}</div>
    <label htmlFor={`${id}-profile`}>Storage profile</label><select id={`${id}-profile`} name="profileId" value={value} disabled={!canWrite||current.isPending||profiles.isPending} onChange={event=>{setSelected(event.target.value);save.reset();}}>
      <option value="local">This server (default)</option>
      {current.data?.legacy?<option value="legacy">Existing service destination (saved credentials)</option>:null}
      {unavailable?<option value={current.data?.profileId??''}>{current.data?.profileName??'Removed profile'} (saved destination)</option>:null}
      {profiles.data?.profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name} · {profile.destination.type==='local'?'Local':profile.destination.type==='s3'?(profile.destination.provider==='r2'?'R2':'S3'):profile.destination.type.toUpperCase()}</option>)}
    </select>
    <p className="feature-helper">Profiles are managed in instance Settings. Saving takes a copy of the selected profile for future backups. Select and save again to apply profile updates; existing backups retain their original location and credentials.</p>
    {current.data?.legacy?<p className="backup-notice">Your existing destination remains active until you choose another profile.</p>:null}
    {canWrite?<button className="button button-primary" type="submit" disabled={save.isPending||current.isPending||profiles.isPending||value==='legacy'}>{save.isPending?'Saving destination':'Save destination'}</button>:null}
    {save.isSuccess?<p role="status">Backup destination saved.</p>:null}<FeatureError error={current.error||profiles.error||save.error}/>
  </form></section>;
}

type ScheduleDraft={enabled:boolean;cron:string;retention:number;encrypted?:boolean;retentionPolicy?:BackupRetentionPolicy};
function schedulePreset(cron:string):'hourly'|'daily'|'weekly'|'custom' {
  if(/^0 \* \* \* \*$/.test(cron))return 'hourly';
  if(/^\d+ \d+ \* \* \*$/.test(cron))return 'daily';
  if(/^\d+ \d+ \* \* 0$/.test(cron))return 'weekly';
  return 'custom';
}
export function BackupScheduleForm({serviceId,settings,canWrite,mountTarget}:{serviceId:string;settings:DatabaseBackupSettings;canWrite:boolean;mountTarget?:string}) {
  const id=useId(),client=useQueryClient(),[draft,setDraft]=useState<ScheduleDraft|null>(null),[presetOverride,setPresetOverride]=useState<string|null>(null);
  const value=draft??settings,policy=value.retentionPolicy??{mode:'count'},preset=presetOverride??schedulePreset(value.cron);
  const path=`/services/${encodeURIComponent(serviceId)}/${mountTarget===undefined?'backup-settings':'volume-backup-settings'}`;
  const save=useMutation({mutationFn:()=>api(path,{method:'PUT',body:{enabled:value.enabled,cron:value.cron,retention:value.retention,...(mountTarget===undefined?{encrypted:value.encrypted??false,retentionPolicy:policy}:{mountTarget})}}),onSuccess:()=>{setDraft(null);void client.invalidateQueries({queryKey:[mountTarget===undefined?'database-backup-settings':'volume-backup-settings',serviceId]});}});
  const update=(next:Partial<ScheduleDraft>)=>{setDraft({...value,...next});save.reset();};
  const clock=/^(\d+) (\d+) /.exec(value.cron),time=clock?`${clock[2]!.padStart(2,'0')}:${clock[1]!.padStart(2,'0')}`:'02:00';
  const setPreset=(next:string,nextTime=time)=>{setPresetOverride(next);const [hour,minute]=nextTime.split(':').map(Number);update({cron:next==='hourly'?'0 * * * *':next==='daily'?`${minute} ${hour} * * *`:next==='weekly'?`${minute} ${hour} * * 0`:value.cron});};
  return <section className="backup-section"><form method="post" action={`/api/v1${path}`} aria-labelledby={`${id}-heading`} onSubmit={event=>{event.preventDefault();save.mutate();}}>
    <div><h3 id={`${id}-heading`}>Schedule & retention</h3></div>
    <div className="backup-toggle backup-enable"><input id={`${id}-enabled`} name="enabled" type="checkbox" role="switch" checked={value.enabled} disabled={!canWrite} onChange={event=>update({enabled:event.target.checked})}/><label htmlFor={`${id}-enabled`}>Automatic backups<small>Run a backup on a recurring schedule</small></label><span className="backup-status">{value.enabled?'Enabled':'Disabled'}</span></div>
    <fieldset className="backup-presets"><legend>Frequency</legend>{[{id:'hourly',label:'Hourly'},{id:'daily',label:'Daily'},{id:'weekly',label:'Weekly'},{id:'custom',label:'Custom cron'}].map(option=><label key={option.id} className={preset===option.id?'selected':''}><input type="radio" name="frequency" value={option.id} checked={preset===option.id} disabled={!canWrite} onChange={()=>setPreset(option.id)}/>{option.label}</label>)}</fieldset>
    {preset==='daily'||preset==='weekly'?<><label htmlFor={`${id}-time`}>{preset==='weekly'?'Every Sunday at':'Backup time'} (UTC)</label><input id={`${id}-time`} name="time" type="time" required disabled={!canWrite} value={time} onChange={event=>{if(event.target.value)setPreset(preset,event.target.value);}}/></>:null}
    {preset==='custom'?<><label htmlFor={`${id}-cron`}>Cron schedule (UTC)</label><input id={`${id}-cron`} name="cron" value={value.cron} required maxLength={128} spellCheck={false} autoCapitalize="none" disabled={!canWrite} aria-describedby={`${id}-cron-help`} onChange={event=>update({cron:event.target.value})}/><p id={`${id}-cron-help`} className="feature-helper">Five fields: minute, hour, day, month, weekday. For example, 0 2 * * * runs daily at 02:00 UTC.</p></>:null}
    <p className="feature-helper">Schedules use UTC. Missed runs are not replayed after downtime. Only one backup per {mountTarget===undefined?'database':'application'} runs at a time.</p>
    {mountTarget===undefined?<><label htmlFor={`${id}-policy`}>Retention policy</label><select id={`${id}-policy`} name="retentionPolicy" disabled={!canWrite} value={policy.mode} onChange={event=>update({retentionPolicy:event.target.value==='age'?{mode:'age',days:30}:event.target.value==='gfs'?{mode:'gfs',hourly:0,daily:7,weekly:4,monthly:12,yearly:0}:{mode:'count'}})}><option value="count">Keep a fixed number</option><option value="age">Keep by age</option><option value="gfs">Tiered retention (GFS)</option></select></>:null}
    {policy.mode==='age'?<><label htmlFor={`${id}-days`}>Days to keep</label><input id={`${id}-days`} name="days" type="number" min={1} max={3650} required disabled={!canWrite} value={Number.isFinite(policy.days) ? policy.days : ''} onChange={event=>update({retentionPolicy:{...policy,days:event.target.valueAsNumber}})}/></>:policy.mode==='gfs'?<div className="backup-field-pair backup-gfs">{(['hourly','daily','weekly','monthly','yearly'] as const).map(period=><div key={period}><label htmlFor={`${id}-${period}`}>{period[0]!.toUpperCase()+period.slice(1)} copies</label><input id={`${id}-${period}`} name={period} type="number" required min={period==='daily'?1:0} max={period==='hourly'?168:period==='daily'?365:period==='weekly'?52:period==='yearly'?10:120} disabled={!canWrite} value={Number.isNaN(policy[period]) ? '' : policy[period] ?? 0} onChange={event=>update({retentionPolicy:{...policy,[period]:event.target.valueAsNumber}})}/></div>)}</div>:<><label htmlFor={`${id}-retention`}>Completed backups to keep</label><input id={`${id}-retention`} name="retention" type="number" min={1} max={100} step={1} required disabled={!canWrite} value={Number.isFinite(value.retention)?value.retention:''} onChange={event=>update({retention:event.target.valueAsNumber})}/></>}
    <p className="feature-helper">{policy.mode==='gfs'?'Keeps the newest successful backup in each retained UTC hour, day, week, month and year. ':''}Cleanup runs only after a successful backup and always preserves the newest recovery point.</p>
    {mountTarget===undefined?<div className="backup-encryption"><div className="backup-toggle"><input id={`${id}-encrypted`} name="encrypted" type="checkbox" checked={value.encrypted??false} disabled={!canWrite} onChange={event=>update({encrypted:event.target.checked})}/><label htmlFor={`${id}-encrypted`}><ShieldCheck size={16} aria-hidden="true"/>Encrypt new backup files</label></div><p className="feature-helper">AES-256-GCM protects files at rest. The panel verifies and decrypts downloads into their original export format for Database restore. Existing files keep their current format. Recovery requires this installation's secret key.</p></div>:null}
    {canWrite?<button className="button button-primary" type="submit" disabled={save.isPending}>{save.isPending?'Saving settings':'Save backup settings'}</button>:null}
    {save.isSuccess?<p role="status">Backup settings saved.</p>:null}<FeatureError error={save.error}/>
  </form></section>;
}
