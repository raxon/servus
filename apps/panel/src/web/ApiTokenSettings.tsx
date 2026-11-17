import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import type { Project } from '../shared/types.js';
import { api, errorMessage } from './api.js';

interface Token { id:string;projectId:string;name:string;scope:'read'|'deploy';expiresAt:string;revokedAt:string|null }
export function ApiTokenSettings() {
  const client=useQueryClient(),[name,setName]=useState(''),[projectId,setProjectId]=useState(''),[scope,setScope]=useState<'read'|'deploy'>('read');
  const [secret,setSecret]=useState('');
  const projects=useQuery({queryKey:['projects'],queryFn:()=>api<Project[]>('/projects')});
  const tokens=useQuery({queryKey:['api-tokens'],queryFn:()=>api<{tokens:Token[]}>('/auth/api-tokens')});
  const selected=projectId||projects.data?.[0]?.id||'';
  const selectedProject=projects.data?.find(project=>project.id===selected);
  const create=useMutation({mutationFn:()=>api<{token:string}>('/auth/api-tokens',{method:'POST',body:{name,projectId:selected,scope,expiresInDays:30}}),onSuccess:result=>{setSecret(result.token);setName('');void client.invalidateQueries({queryKey:['api-tokens']});}});
  const revoke=useMutation({mutationFn:(id:string)=>api(`/auth/api-tokens/${id}`,{method:'DELETE'}),onSuccess:()=>{setSecret('');void client.invalidateQueries({queryKey:['api-tokens']});}});
  const error=projects.error||tokens.error||create.error||revoke.error;
  return <section className="surface details-card central-settings">
    <div className="card-heading"><KeyRound size={19} aria-hidden="true"/><h2 id="api-tokens-heading">API tokens</h2></div>
    <p>Create a token for one project. Tokens expire after 30 days and retain your current project permissions.</p>
    {error?<div className="error-notice" role="alert">{errorMessage(error)}</div>:null}
    {projects.isPending?<p role="status">Loading projects...</p>:projects.data?.length?<form className="local-password-form" aria-labelledby="api-tokens-heading" method="post" action="/api/v1/auth/api-tokens" onSubmit={event=>{event.preventDefault();create.mutate();}}>
      <label>Name<input name="name" value={name} onChange={event=>setName(event.target.value)} maxLength={80} required/></label>
      <label>Project<select name="projectId" value={selected} onChange={event=>{setProjectId(event.target.value);setScope('read');}}>{projects.data.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <fieldset className="api-token-options"><legend>Access</legend><label><input name="scope" type="radio" value="read" checked={scope==='read'} onChange={()=>setScope('read')}/>Read configuration, actions, logs and metrics</label><label><input name="scope" type="radio" value="deploy" checked={scope==='deploy'} disabled={!selectedProject?.canWrite} onChange={()=>setScope('deploy')}/>Read and deploy, start, stop or restart services</label></fieldset>
      <button className="button button-primary" type="submit" disabled={create.isPending}>{create.isPending?'Creating...':'Create token'}</button>
    </form>:<p>Create a project or request project access to use the API.</p>}
    {secret?<div role="status"><p>Copy this token now. It is shown once. Use it as the SERVUS_TOKEN environment variable for the CLI and MCP.</p><label>New API token<textarea aria-describedby="api-token-secret-help" name="new-token" value={secret} readOnly rows={3} spellCheck={false} onFocus={event=>event.currentTarget.select()}/></label><small id="api-token-secret-help">Keep this token private.</small><button type="button" className="button" onClick={()=>setSecret('')}>Hide token</button></div>:null}
    {tokens.isPending?<p role="status">Loading tokens...</p>:tokens.data?.tokens.length?tokens.data.tokens.map(token=><div className="detail-row" key={token.id}><span>{token.name} ({token.scope})<small> · Expires {new Date(token.expiresAt).toLocaleDateString()}</small></span>{token.revokedAt?<span>Revoked</span>:<button className="button button-small" type="button" disabled={revoke.isPending} onClick={()=>revoke.mutate(token.id)}>Revoke {token.name}</button>}</div>):<p>No API tokens.</p>}
    <p><a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI specification</a></p>
  </section>;
}
