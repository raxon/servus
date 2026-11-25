import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, KeyRound, Plus } from 'lucide-react';
import type { Project } from '../shared/types.js';
import { api, errorMessage } from './api.js';
import { FeatureModal } from './feature-ui.js';
import './ApiTokenSettings.css';

interface Token { id:string;projectId:string;name:string;scope:'read'|'deploy';expiresAt:string;revokedAt:string|null }
export function ApiTokenSettings({ canCreateProject = false }: { canCreateProject?: boolean }) {
  const client=useQueryClient(),[name,setName]=useState(''),[projectId,setProjectId]=useState(''),[scope,setScope]=useState<'read'|'deploy'>('read');
  const [open,setOpen]=useState(false),[secret,setSecret]=useState('');
  const nameInput=useRef<HTMLInputElement>(null),secretInput=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{
    if (open) (secret ? secretInput.current : nameInput.current)?.focus();
  },[open,secret]);
  const projects=useQuery({queryKey:['projects'],queryFn:()=>api<Project[]>('/projects')});
  const tokens=useQuery({queryKey:['api-tokens'],queryFn:()=>api<{tokens:Token[]}>('/auth/api-tokens')});
  const selectedProject = projects.data?.find(project => project.id === projectId) ?? projects.data?.[0];
  const selected = selectedProject?.id ?? '';
  const effectiveScope = selectedProject?.canWrite ? scope : 'read';
  const create=useMutation({mutationFn:()=>api<{token:string}>('/auth/api-tokens',{method:'POST',body:{name,projectId:selected,scope:effectiveScope,expiresInDays:30}}),onSuccess:result=>{setSecret(result.token);setName('');void client.invalidateQueries({queryKey:['api-tokens']});}});
  const revoke=useMutation({mutationFn:(id:string)=>api(`/auth/api-tokens/${id}`,{method:'DELETE'}),onSuccess:()=>{void client.invalidateQueries({queryKey:['api-tokens']});}});
  const error=projects.error||tokens.error||revoke.error;
  function closeDialog() {
    setOpen(false);
    setSecret('');
    setName('');
    setScope('read');
    create.reset();
  }
  return <section id="api-tokens" className="surface details-card central-settings api-token-settings" aria-labelledby="api-tokens-heading">
    <div className="settings-card-header">
      <div className="settings-card-intro">
        <div className="card-heading"><KeyRound size={19} aria-hidden="true"/><h3 id="api-tokens-heading">API tokens</h3></div>
        <p>Connect your CLI, automations and MCP clients to a project.</p>
      </div>
      <button className="button button-primary" type="button" disabled={!selected} onClick={()=>setOpen(true)}><Plus size={16} aria-hidden="true"/>Create token</button>
    </div>
    {error?<div className="error-notice" role="alert">{errorMessage(error)}</div>:null}
    {projects.isPending ? <p role="status">Loading projects...</p> : !projects.error && !selectedProject ? (
      canCreateProject ? <p>Create a project to enable token creation. <a href="/">Go to projects</a></p> : <p>Ask an administrator for access to a project to create a token.</p>
    ) : null}
    {tokens.isPending?<p role="status">Loading tokens...</p>:tokens.data?.tokens.length?<ul className="api-token-list" aria-label="API tokens">{tokens.data.tokens.map(token=><li className="api-token-row" key={token.id}>
      <span className="api-token-symbol"><KeyRound size={17} aria-hidden="true"/></span>
      <div className="api-token-details"><strong>{token.name}</strong><span>{projects.data?.find(project=>project.id===token.projectId)?.name ?? 'Project'}<span aria-hidden="true"> · </span>{token.scope==='deploy'?'Read & deploy':'Read only'}<span aria-hidden="true"> · </span>Expires {new Date(token.expiresAt).toLocaleDateString()}</span></div>
      {token.revokedAt?<span className="api-token-revoked">Revoked</span>:<button className="button button-small" type="button" disabled={revoke.isPending} aria-label={`Revoke ${token.name}`} onClick={()=>revoke.mutate(token.id)}>Revoke</button>}
    </li>)}</ul>:!tokens.error?<div className="settings-empty api-token-empty"><KeyRound size={24} aria-hidden="true"/><div><strong>No API tokens yet</strong><p>Create a project token when you’re ready to connect an external tool.</p></div></div>:null}
    <div className="api-token-reference">
      <details><summary>MCP client setup</summary><p>From the Servus repository, launch <code>node scripts/servus-mcp.mjs</code> over stdio. Set <code>SERVUS_URL</code> to your panel address and <code>SERVUS_TOKEN</code> to a project token in your client’s environment.</p></details>
      <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI specification<ArrowUpRight size={14} aria-hidden="true"/></a>
    </div>
    {open?<FeatureModal title={secret?'Token created':'Create API token'} description={secret?'Copy your token now. It will only be shown once.':'Tokens belong to one project, expire after 30 days and retain your current project permissions.'} dismissible={!create.isPending} onClose={closeDialog}>
      {secret?<div className="api-token-success">
        <div className="api-token-success-note" role="status"><Check size={18} aria-hidden="true"/>Your token is ready to use.</div>
        <label>New API token<textarea aria-describedby="api-token-secret-help" name="new-token" ref={secretInput} autoFocus value={secret} readOnly rows={3} spellCheck={false} onFocus={event=>event.currentTarget.select()}/></label>
        <p id="api-token-secret-help">Keep this token private. Use it as <code>SERVUS_TOKEN</code> for the CLI and MCP.</p>
        <div className="settings-modal-actions"><button type="button" className="button button-primary" onClick={closeDialog}>Done</button></div>
      </div>:<form className="settings-modal-form api-token-form" aria-label="Create API token" method="post" action="/api/v1/auth/api-tokens" onSubmit={event=>{
        event.preventDefault();
        if (selected && name.trim() && !create.isPending) create.mutate();
      }}>
        {create.error?<div className="error-notice" role="alert">{errorMessage(create.error)}</div>:null}
        <label>Name<input name="name" ref={nameInput} autoFocus placeholder="e.g. Production deploy" value={name} onChange={event=>setName(event.target.value)} maxLength={80} required disabled={!selected || create.isPending} /></label>
        <label>Project<select name="projectId" value={selected} disabled={!selected || create.isPending} onChange={event=>{setProjectId(event.target.value);setScope('read');}}>
          {!selected && <option value="">No projects available</option>}
          {projects.data?.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
        </select></label>
        <fieldset className="api-token-options" disabled={!selected || create.isPending}><legend>Access</legend>
          <label><input name="scope" type="radio" value="read" checked={effectiveScope==='read'} onChange={()=>setScope('read')}/><span><strong>Read only</strong><small>Read configuration, actions, logs and metrics</small></span></label>
          <label><input name="scope" type="radio" value="deploy" checked={effectiveScope==='deploy'} disabled={!selectedProject?.canWrite} onChange={()=>setScope('deploy')}/><span><strong>Read & deploy</strong><small>Read and deploy, start, stop or restart services</small></span></label>
        </fieldset>
        <div className="settings-modal-actions"><button className="button" type="button" disabled={create.isPending} onClick={closeDialog}>Cancel</button><button className="button button-primary" type="submit" disabled={!selected || !name.trim() || create.isPending}>{create.isPending?'Creating...':'Create token'}</button></div>
      </form>}
    </FeatureModal>:null}
  </section>;
}
