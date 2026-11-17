import {useId,useState} from 'react';
import {canonicalRegistry,normalizeKnownHosts} from '../shared/source-credentials.js';

export interface RegistryDraft {registryEnabled:boolean;registryServer:string;registryUsername:string;registryPassword:string}
export function RegistryFields({value,needsPassword,onChange}:{value:RegistryDraft;needsPassword:boolean;onChange:(patch:Partial<RegistryDraft>)=>void}) {
  const id=useId();
  return <fieldset className="source-auth"><legend>Registry access</legend>
    <label className="checkbox-label"><input name="registry-enabled" type="checkbox" checked={value.registryEnabled} aria-expanded={value.registryEnabled} aria-controls={`${id}-fields`} onChange={event=>onChange({registryEnabled:event.target.checked})}/> Authenticate to a private registry</label>
    {value.registryEnabled?<div id={`${id}-fields`} className="source-build-grid">
      <div className="source-field"><label htmlFor={`${id}-server`}>Registry hostname</label><small id={`${id}-server-help`}>Must match the image registry. Use docker.io for Docker Hub.</small><input id={`${id}-server`} name="registry-server" className="mono" required maxLength={253} value={value.registryServer} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="ghcr.io" aria-describedby={`${id}-server-help`} onChange={event=>{try{canonicalRegistry(event.target.value);event.currentTarget.setCustomValidity('');}catch{event.currentTarget.setCustomValidity('Use a registry hostname with an optional port, without https:// or a path.');}onChange({registryServer:event.target.value});}}/></div>
      <label>Registry username<input name="registry-username" required maxLength={256} value={value.registryUsername} autoComplete="username" autoCapitalize="none" onChange={event=>onChange({registryUsername:event.target.value})}/></label>
      <div className="source-field"><label htmlFor={`${id}-password`}>Registry password or token</label><small id={`${id}-password-help`}>Encrypted when saved. {needsPassword?'Use read access to this image.':'Leave empty to keep the saved credential.'}</small><input id={`${id}-password`} name="registry-password" type="password" autoComplete="new-password" maxLength={4096} required={needsPassword} value={value.registryPassword} placeholder={needsPassword?'Enter a password or token':'Saved credential unchanged'} aria-describedby={`${id}-password-help`} onChange={event=>onChange({registryPassword:event.target.value})}/></div>
    </div>:<div id={`${id}-fields`} hidden/>}
  </fieldset>;
}

export function SshFields({repository,knownHosts,publicKey,rotate=false,onKnownHosts,onRotate}:{repository:string;knownHosts:string;publicKey?:string;rotate?:boolean;onKnownHosts:(value:string)=>void;onRotate?:(value:boolean)=>void}) {
  const id=useId(),[copy,setCopy]=useState('');
  return <fieldset className="source-auth"><legend>SSH deploy key and host verification</legend>
    <p>Saving generates an Ed25519 deploy key for this service. Add its public key to the repository with read access, then deploy.</p>
    <label htmlFor={`${id}-hosts`}>Verified known_hosts entry</label>
    <small id={`${id}-hosts-help`}>Paste an Ed25519 host key verified with your Git provider or server administrator. For a custom port use [hostname]:port. A key collected from the network alone does not verify the server.</small>
    <textarea id={`${id}-hosts`} name="git-known-hosts" className="mono" rows={3} required maxLength={4096} value={knownHosts} aria-describedby={`${id}-hosts-help`} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event=>{try{normalizeKnownHosts(event.target.value,repository);event.currentTarget.setCustomValidity('');}catch{event.currentTarget.setCustomValidity('Enter a verified Ed25519 known_hosts entry for this exact repository hostname and port.');}onKnownHosts(event.target.value);}}/>
    {publicKey?<><label htmlFor={`${id}-public`}>Deploy public key</label><textarea id={`${id}-public`} name="git-public-key" className="mono" rows={3} value={publicKey} readOnly/><button type="button" className="button" onClick={()=>{if(!navigator.clipboard){setCopy('Select the public key and copy it manually.');return;}void navigator.clipboard.writeText(publicKey).then(()=>setCopy('Public key copied.'),()=>setCopy('Select the public key and copy it manually.'));}}>Copy deploy public key</button><span role="status">{copy}</span></>:null}
    {onRotate?<label className="checkbox-label"><input name="rotate-ssh-key" type="checkbox" checked={rotate} onChange={event=>onRotate(event.target.checked)}/> Generate a replacement deploy key when saving</label>:null}
    {rotate?<p>After saving, add the replacement public key to the repository before deploying. Remove the old key at your Git provider when it is no longer needed.</p>:null}
  </fieldset>;
}
