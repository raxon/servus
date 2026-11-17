import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApplicationTemplate } from '../shared/templates.js';
import type { ComposeAction, ComposeWorkload } from '../shared/compose.js';
import { api } from './api.js';
import { FeatureError, FeatureLoading } from './feature-ui.js';
import './backups.css';

export function TemplateProjects({projectId,canWrite=true,onCreated}:{projectId:string;canWrite?:boolean;onCreated?:(result:{workload:ComposeWorkload;action:ComposeAction})=>void}) {
  const id=useId(),client=useQueryClient(),[selected,setSelected]=useState<string>('wordpress'),[name,setName]=useState(''),[hostname,setHostname]=useState(''),[apiHostname,setApiHostname]=useState('');
  const catalog=useQuery({queryKey:['application-templates'],queryFn:async()=>{
    const result=await api<{templates:ApplicationTemplate[]}>('/templates');
    if(!Array.isArray(result?.templates)||!result.templates.every(template=>template&&['id','name','description','version','setup','publisher'].every(key=>typeof template[key as keyof ApplicationTemplate]==='string')&&Array.isArray(template.images)&&template.images.every(image=>typeof image==='string')))throw new Error('The application template catalog could not be loaded. Refresh the page to try again.');
    return result;
  }});
  const template=catalog.data?.templates.find(template=>template.id===selected);
  const create=useMutation({mutationFn:()=>api<{workload:ComposeWorkload;action:ComposeAction}>(`/projects/${encodeURIComponent(projectId)}/templates/${selected}`,{method:'POST',idempotent:true,body:{name,...(hostname.trim()?{hostname:hostname.trim()}:{}),...(template?.supportsApiDomain&&apiHostname.trim()?{apiHostname:apiHostname.trim()}:{} )}}),onSuccess:result=>{void client.invalidateQueries({queryKey:['compose-workloads',projectId]});setName('');onCreated?.(result);}});
  return <section className="database-backups" aria-labelledby={`${id}-title`}><div className="backup-section">
    <h2 id={`${id}-title`}>Application templates</h2>
    <p>Deploy a maintained application configuration with persistent storage. Review the image publisher and finish the application's own setup after deployment.</p>
    {catalog.isPending?<FeatureLoading label="Loading templates" />:null}
    {catalog.data?.templates.length?<form method="post" action={`/api/v1/projects/${encodeURIComponent(projectId)}/templates/${selected}`} aria-labelledby={`${id}-title`} onSubmit={event=>{event.preventDefault();create.mutate();}}>
      <label htmlFor={`${id}-template`}>Application</label><select id={`${id}-template`} name="template" value={selected} disabled={!canWrite||create.isPending} onChange={event=>{setSelected(event.target.value);create.reset();}}>{catalog.data.templates.map(template=><option value={template.id} key={template.id}>{template.name}</option>)}</select>
      {template?<><p>{template.description}</p><p className="feature-helper">Images: {template.images.join(', ')}. Publisher: {template.publisher}.</p><p className="feature-helper">{template.setup}</p></>:null}
      <label htmlFor={`${id}-name`}>Workload name</label><input id={`${id}-name`} name="name" required maxLength={63} pattern="[a-z0-9][a-z0-9_\-]*" value={name} disabled={!canWrite||create.isPending} onChange={event=>{setName(event.target.value);create.reset();}} autoCapitalize="none" spellCheck={false} aria-describedby={`${id}-name-help`} /><p id={`${id}-name-help`} className="feature-helper">Use lowercase letters, numbers, hyphens or underscores.</p>
      <label htmlFor={`${id}-hostname`}>Application domain (optional)</label><input id={`${id}-hostname`} name="hostname" value={hostname} maxLength={253} disabled={!canWrite||create.isPending} onChange={event=>{setHostname(event.target.value);create.reset();}} placeholder="app.example.com" autoCapitalize="none" spellCheck={false} aria-describedby={`${id}-domain-help`} />
      <p id={`${id}-domain-help`} className="feature-helper">Leave domains empty to keep the workload private. Template domains currently use HTTP. Put access behind a trusted HTTPS proxy before using credentials on a public domain.</p>
      {template?.supportsApiDomain?<><label htmlFor={`${id}-api-domain`}>S3 API domain (optional)</label><input id={`${id}-api-domain`} name="apiHostname" value={apiHostname} maxLength={253} disabled={!canWrite||create.isPending} onChange={event=>{setApiHostname(event.target.value);create.reset();}} placeholder="s3.example.com" autoCapitalize="none" spellCheck={false} /></>:null}
      {canWrite?<button className="button button-primary" type="submit" disabled={create.isPending||!template}>{create.isPending?'Queuing deployment':'Deploy template'}</button>:null}
      {create.isSuccess?<p role="status">Deployment queued. Follow its progress in Compose workloads.</p>:null}
    </form>:catalog.data?<p>No application templates are available.</p>:null}<FeatureError error={catalog.error||create.error} />
  </div></section>;
}
