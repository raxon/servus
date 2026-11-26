import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Box, Check, CircleAlert, FileCode2, GitBranch, Info, LockKeyhole, RotateCcw, ShieldCheck } from "lucide-react";
import type { Service, SourceBuilder, SourceConfig } from "../shared/types.js";
import type { SourceUploadRecord } from "../shared/host-admin.js";
import { api, RequestError } from "./api.js";
import { FeatureError, FeatureLoading, useServiceSave } from "./feature-ui.js";
import { useGithubConnection } from "./GithubSettings.js";
import { SOURCE_BUILDERS, SourceChoiceFields, githubRepositoryName, githubRepositoryUrl, initialSourceChoice, type SourceChoice } from "./source-choice.js";
import { validEnvFilePath } from "../shared/build-options.js";
import { GithubSourcePicker } from "./GithubSourcePicker.js";
import {RegistryFields,SshFields} from './SourceCredentialFields.js';
import {imageRegistry,parseSshRepository} from '../shared/source-credentials.js';

function sourceDraft(service: Service, type = initialSourceChoice(service.source ?? { type: "image" })) {
  const source = service.source;
  return {
    type,
    image: service.image,
    repository: source?.type === "git" ? source.repository : "",
    githubRepository: source?.type === "git" ? githubRepositoryName(source.repository) : "",
    privateGit: source?.type === "git" && Boolean(source.credential),
    gitUsername: source?.type === "git" ? source.credential?.username ?? "" : "",
    gitToken: "",
    branch: source?.type === "git" ? source.branch : "main",
    context: source?.type === "git" ? source.context : source?.type === "upload" ? source.context ?? "." : ".",
    dockerfile: source?.type === "git" ? source.dockerfile : source?.type === "upload" ? source.dockerfile ?? "Dockerfile" : "Dockerfile",
    builder: (source?.type === "git" ? source.builder ?? "dockerfile" : source?.type === "upload" ? source.builder ?? "auto" : "dockerfile") as SourceBuilder,
    dockerfileContent: source?.type === "dockerfile" ? source.dockerfileContent : "FROM nginx:alpine\nEXPOSE 80\n",
    uploadId: source?.type === "upload" ? source.uploadId : "",
    uploadFilename: source?.type === "upload" ? source.filename ?? "" : "",
    uploadSha256: source?.type === "upload" ? source.sha256 ?? "" : "",
    generateEnv: (source?.type === "git" || source?.type === "dockerfile" || source?.type === "upload") && source.envFile !== undefined,
    envFile: (source?.type === "git" || source?.type === "dockerfile" || source?.type === "upload") ? source.envFile ?? ".env" : ".env",
    knownHosts:source?.type==='git'?source.ssh?.knownHosts??'':'',rotateSsh:false,
    registryEnabled:Boolean(service.registry),registryServer:service.registry?.server??(()=>{try{return imageRegistry(service.image);}catch{return'docker.io';}})(),registryUsername:service.registry?.username??'',registryPassword:'',
  };
}

type SourceDraft = ReturnType<typeof sourceDraft>;

function draftKey(draft: SourceDraft) {
  if (draft.type === "image") return JSON.stringify([draft.type, draft.image, draft.registryEnabled, ...(draft.registryEnabled ? [draft.registryServer, draft.registryUsername, draft.registryPassword] : [])]);
  if (draft.type === "dockerfile") return JSON.stringify([draft.type, draft.dockerfileContent, draft.generateEnv, ...(draft.generateEnv ? [draft.envFile] : [])]);
  if (draft.type === "upload") return JSON.stringify([draft.type, draft.uploadId, draft.uploadSha256, draft.context, draft.dockerfile, draft.builder, draft.generateEnv, ...(draft.generateEnv ? [draft.envFile] : [])]);
  return JSON.stringify([
    draft.type, draft.type === "github" ? draft.githubRepository : draft.repository,
    draft.branch, draft.context, draft.dockerfile, draft.builder, draft.generateEnv, ...(draft.generateEnv ? [draft.envFile] : []),
    ...(draft.type === "git" ? [draft.privateGit, ...(draft.privateGit ? [draft.gitUsername, draft.gitToken] : [])] : []),
    draft.knownHosts,draft.rotateSsh,
  ]);
}

function repositoryError(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if(url.protocol==='ssh:'){parseSshRepository(value);return'';}
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return "Use HTTPS, or an ssh:// URL with a Git username and no password.";
    }
  } catch { return "Enter a complete HTTPS or ssh:// repository URL."; }
  return "";
}

function buildPathError(value: string) {
  return value.startsWith("/") || value.startsWith("\\") || value.split(/[\\/]/).includes("..") || value.includes("\0")
    ? "Use a relative path without .. to stay inside the repository." : "";
}

function SourceField({ label, help, error, validate, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  help?: ReactNode;
  error?: string;
  validate?: (value: string) => string;
}) {
  const id = useId();
  const [nativeError, setNativeError] = useState("");
  const message = error || nativeError;
  return <div className="source-field">
    <label htmlFor={id}>{label}{props.required ? <span className="source-required" aria-hidden="true">*</span> : null}</label>
    {help ? <small id={`${id}-help`}>{help}</small> : null}
    <input {...props} id={id} autoCapitalize="none" autoCorrect="off" spellCheck={false}
      aria-invalid={Boolean(message)} aria-describedby={[help ? `${id}-help` : "", message ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined}
      onChange={event => {
        event.currentTarget.setCustomValidity(validate?.(event.currentTarget.value) ?? "");
        setNativeError("");
        props.onChange?.(event);
      }}
      onInvalid={event => {
        const details = event.currentTarget.closest("details");
        if (details) details.open = true;
        setNativeError(event.currentTarget.validationMessage);
      }} />
    {message ? <small className="source-field-error" id={`${id}-error`}><CircleAlert size={14} aria-hidden="true" />{message}</small> : null}
  </div>;
}

export function SourcePanel({ service, admin }: { service: Service; admin: boolean }) {
  const id = useId();
  const [savedService, setSavedService] = useState(service);
  const [savedDraft, setSavedDraft] = useState(() => sourceDraft(service));
  const [draft, setDraft] = useState(savedDraft);
  const [formVersion, setFormVersion] = useState(0);
  const [buildSettingsOpen, setBuildSettingsOpen] = useState(() => savedDraft.context !== "." || savedDraft.dockerfile !== "Dockerfile" || savedDraft.generateEnv);
  const current = savedService.source ?? { type: "image" };
  const { type, image, repository, githubRepository, privateGit, gitUsername, gitToken, branch, context, dockerfile, builder, dockerfileContent, uploadId, uploadFilename, uploadSha256, generateEnv, envFile } = draft;
  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      api<SourceUploadRecord>(`/projects/${service.projectId}/source-uploads`, {
        method: "POST",
        binary: file,
        headers: { "X-Upload-Filename": file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "source.tar.gz" },
      }),
    onSuccess: (record) => {
      update({ uploadId: record.id, uploadFilename: record.filename, uploadSha256: record.sha256 });
    },
  });
  const selectedRepository = type === "github" ? githubRepositoryUrl(githubRepository) : repository;
  const sshSource=type==='git'&&repository.startsWith('ssh:');
  const existingCredential = current.type === "git" ? current.credential : undefined;
  const github = useGithubConnection(admin);
  const sharedManagedByAdmin = !admin && current.type === "git" && Boolean(current.sharedGithub||current.ssh);
  const isDatabase = Boolean(service.kind && service.kind !== "app");
  const dirty = draftKey(draft) !== draftKey(savedDraft);
  const save = useServiceSave(service);
  const checkSource = useMutation({
    mutationFn: (source: { repository: string; branch: string; context: string; dockerfile: string; builder?: SourceBuilder }) =>
      api<{ commit: string }>(`/services/${service.id}/check-source`, { method: "POST", body: source }),
  });
  const busy = save.isPending || checkSource.isPending || uploadMutation.isPending;
  const sourceFieldError = checkSource.error instanceof RequestError && ["SOURCE_REPOSITORY_OR_BRANCH", "SOURCE_CONTEXT", "SOURCE_DOCKERFILE"].includes(checkSource.error.code) ? checkSource.error : undefined;
  const checkSupported = current.type === "git" && type !== "image" && !gitToken && (!sshSource||Boolean(current.ssh?.secretRef)&&selectedRepository===current.repository&&draft.knownHosts===current.ssh?.knownHosts&&!draft.rotateSsh)
    && (type === "github" || (privateGit === Boolean(existingCredential) && (!privateGit || gitUsername === existingCredential?.username)))
    && (!existingCredential || current.sharedGithub || selectedRepository === current.repository)
    && (type !== "github" || Boolean(current.sharedGithub) === Boolean(github.data?.connected || current.sharedGithub));
  const needsToken = !existingCredential?.secretRef || (current.type === "git" && (current.sharedGithub || selectedRepository !== current.repository || gitUsername !== existingCredential.username));
  const githubReady = type !== "github" || !admin || github.isSuccess;
  const update = (patch: Partial<SourceDraft>) => {
    setDraft(value => ({ ...value, ...patch }));
    save.reset();
    checkSource.reset();
  };
  const discard = () => {
    setDraft(savedDraft);
    setFormVersion(value => value + 1);
    save.reset();
    checkSource.reset();
  };
  const fieldError = (code: string) => sourceFieldError?.code === code ? sourceFieldError.message : undefined;

  return <form className="surface configuration-card source-panel" aria-labelledby={`${id}-title`} aria-busy={busy}
    onSubmit={event => {
      event.preventDefault();
      if (!dirty || busy || sharedManagedByAdmin || !githubReady || sshSource&&!admin) return;
      const source: SourceConfig = type === "image" ? { type }
        : type === "dockerfile" ? { type: "dockerfile", dockerfileContent, ...(generateEnv ? { envFile } : {}) }
        : type === "upload" ? { type: "upload", uploadId, ...(uploadFilename ? { filename: uploadFilename } : {}), ...(uploadSha256 ? { sha256: uploadSha256 } : {}), context, dockerfile, builder, ...(generateEnv ? { envFile } : {}) }
        : {
        type: "git", repository: selectedRepository, branch, context, dockerfile, ...(builder !== "dockerfile" ? { builder } : {}), ...(generateEnv ? { envFile } : {}),
        ...(sshSource?{ssh:{knownHosts:draft.knownHosts,...(current.type==='git'&&current.repository===selectedRepository&&current.ssh?.secretRef&&!draft.rotateSsh?{secretRef:current.ssh.secretRef,publicKey:current.ssh.publicKey}:{})}}:type === "github" && (github.data?.connected || (current.type === "git" && current.sharedGithub)) ? { sharedGithub: true }
          : type === "github" && current.type === "git" && selectedRepository === current.repository && existingCredential ? { credential: existingCredential }
          : type === "git" && privateGit ? { credential: gitToken ? { username: gitUsername, token: gitToken } : { username: gitUsername, secretRef: existingCredential?.secretRef } } : {}),
      };
      const registry=type==='image'&&draft.registryEnabled?{server:draft.registryServer,username:draft.registryUsername,...(draft.registryPassword?{password:draft.registryPassword}:{secretRef:savedService.registry?.secretRef})}:null;
      save.mutate({ ...(type === "image" ? { image } : {}), source,...(!isDatabase?{registry}:{}) }, { onSuccess: value => {
        const next = sourceDraft(value, type);
        setSavedService(value);
        setSavedDraft(next);
        setDraft(next);
        setFormVersion(version => version + 1);
        checkSource.reset();
      } });
    }}>
    <header className="configuration-intro source-intro">
      <div className="source-intro-icon"><GitBranch size={21} aria-hidden="true" /></div>
      <div><h2 id={`${id}-title`}>{isDatabase ? "Database source" : "Application source"}</h2><p>Choose where your {isDatabase ? "database image" : "application"} comes from.</p></div>
      <span className={`source-status${dirty ? " source-status-dirty" : ""}`}><span aria-hidden="true" />{dirty ? "Unsaved changes" : "Saved configuration"}</span>
    </header>

    {sharedManagedByAdmin ? <div className="source-access-note"><LockKeyhole size={17} aria-hidden="true" /><p>{current.type==='git'&&current.ssh?'This source uses a service SSH deploy key. Ask an administrator to make changes.':'This source uses the shared GitHub connection. Ask an administrator to make changes.'}</p></div> : null}

    <fieldset key={formVersion} className="source-fields" disabled={busy || sharedManagedByAdmin}>
      <legend className="sr-only">Source configuration</legend>
      <section className="source-section">
        <SourceChoiceFields value={type} onChange={value => update({ type: value })} disabled={isDatabase} detailed />
        {isDatabase ? <p className="source-section-hint">Database services use Docker images. Git builds are available for applications.</p> : null}
      </section>

      {type === "image" ? <section className="source-section source-image-section">
        <div className="source-section-heading"><Box size={17} aria-hidden="true" /><h3>Container image</h3></div>
        <SourceField key="image" label="Docker image" name="image" className="mono" value={image} required maxLength={300}
          pattern={"[a-zA-Z0-9][a-zA-Z0-9._\\/:@\\-]*"} title="Use an image name with an optional registry, version tag or digest."
          placeholder="nginx:alpine" onChange={event => update({ image: event.target.value })}
          help="An image from Docker Hub or another registry, including its tag or digest." />
        {!isDatabase?<RegistryFields value={draft} needsPassword={!savedService.registry?.secretRef||draft.registryServer!==savedService.registry.server||draft.registryUsername!==savedService.registry.username} onChange={update}/>:null}
        <div className="source-tip"><ShieldCheck size={17} aria-hidden="true" /><p>Use a specific version tag or an immutable digest to keep deployments reproducible.</p></div>
      </section> : type === "dockerfile" ? <section className="source-section">
        <div className="source-section-heading"><FileCode2 size={17} aria-hidden="true" /><h3>Inline Dockerfile</h3></div>
        <label>
          Dockerfile content
          <textarea className="mono" rows={10} required value={dockerfileContent} onChange={event => update({ dockerfileContent: event.target.value })} placeholder={"FROM node:22-alpine\nWORKDIR /app\n..."} />
          <small>Built directly by Docker BuildKit on each deploy. Supports build args and BuildKit secrets from service environment variables.</small>
        </label>
      </section> : type === "upload" ? <section className="source-section">
        <div className="source-section-heading"><FileCode2 size={17} aria-hidden="true" /><h3>Uploaded code archive</h3></div>
        <label>
          Upload .tar.gz archive (max 50 MiB)
          <input type="file" accept=".tar.gz,.tgz,application/gzip" disabled={busy} onChange={event => {
            const file = event.currentTarget.files?.[0];
            if (file) uploadMutation.mutate(file);
          }} />
          <small>{uploadId ? `Active archive: ${uploadFilename || uploadId} (${uploadSha256.slice(0, 12)})` : "Upload a gzipped tarball containing your application source."}</small>
        </label>
        {uploadMutation.error ? <FeatureError error={uploadMutation.error} /> : null}
        <label>
          Builder
          <select value={builder} onChange={event => update({ builder: event.target.value as SourceBuilder })}>
            {SOURCE_BUILDERS.map(item => <option key={item.value} value={item.value}>{item.label} - {item.description}</option>)}
          </select>
        </label>
        <div className="source-build-grid">
          <SourceField label="Build context" name="context" className="mono" value={context} required maxLength={255} placeholder="." validate={buildPathError} onChange={event => update({ context: event.target.value })} />
          <SourceField label="Dockerfile" name="dockerfile" className="mono" value={dockerfile} required maxLength={255} placeholder="Dockerfile" validate={buildPathError} onChange={event => update({ dockerfile: event.target.value })} />
        </div>
      </section> : <>
        <section className="source-section">
          <div className="source-section-heading"><GitBranch size={17} aria-hidden="true" /><h3>Repository</h3></div>
          {type === "github" && admin && github.data?.connected ? <GithubSourcePicker repository={githubRepository} branch={branch} disabled={busy} onChange={selection => update({ githubRepository: selection.repository, branch: selection.branch })} /> : null}
          <SourceField key={type} label={type === "github" ? "GitHub repository" : "Repository URL"} name={type === "github" ? "github-repository" : "repository"}
            type={type === "github" ? "text" : "url"} className="mono" value={type === "github" ? githubRepository : repository}
            required maxLength={type === "github" ? 300 : 1000} pattern={type === "github" ? "[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+" : undefined}
            validate={type === "git" ? repositoryError : undefined} error={fieldError("SOURCE_REPOSITORY_OR_BRANCH")}
            title={type === "github" ? "Enter the owner and repository, for example organization/app." : undefined}
            placeholder={type === "github" ? "organization/repository" : "https://git.example.com/team/application.git"}
            help={type === "github" ? "Enter the owner and repository name, for example organization/app." : "Use HTTPS with a token, or ssh://git@hostname/owner/repository.git with a deploy key."}
            onChange={event => update(type === "github" ? { githubRepository: event.target.value } : { repository: event.target.value })} />

          {sshSource?<><SshFields key={repository} repository={repository} knownHosts={draft.knownHosts} publicKey={!draft.rotateSsh&&current.type==='git'&&current.repository===repository?current.ssh?.publicKey:undefined} rotate={draft.rotateSsh} onKnownHosts={value=>update({knownHosts:value})} onRotate={admin?value=>update({rotateSsh:value}):undefined}/>{!admin?<p>Only an administrator can configure SSH deploy keys and trusted host keys.</p>:null}</>:type === "github" ? <div className="source-connection">
            <LockKeyhole size={17} aria-hidden="true" />
            <div>{admin && github.isPending ? <FeatureLoading label="Loading GitHub connection" /> : <>
              <strong>{github.data?.connected || (current.type === "git" && current.sharedGithub) ? "GitHub connection configured" : existingCredential ? "Saved repository credentials" : "Public repository access"}</strong>
              <p>{github.data?.connected || (current.type === "git" && current.sharedGithub) ? "The shared token will be used for this repository." : existingCredential ? "The saved token is kept when the repository stays the same." : "Private repositories need a GitHub connection."}</p>
              {admin ? <a href="/settings#github-connection">Manage GitHub connection <ArrowRight size={13} aria-hidden="true" /></a> : <p>Ask an administrator to configure access to private repositories.</p>}
            </>}
            {admin && github.isError ? <><FeatureError error={github.error} /><button type="button" className="button button-small" onClick={() => void github.refetch()}>Retry connection</button></> : null}</div>
          </div> : <div className="source-auth">
            <label className="source-private-toggle"><input type="checkbox" name="private-repository" checked={privateGit} onChange={event => update({ privateGit: event.target.checked })} aria-controls={`${id}-credentials`} aria-expanded={privateGit} /><span><strong>Private repository</strong><small>Authenticate with a username and access token.</small></span><LockKeyhole size={16} aria-hidden="true" /></label>
            {privateGit ? <div id={`${id}-credentials`} className="source-credentials">
              <SourceField label="Git username" name="git-username" value={gitUsername} autoComplete="username" required maxLength={256} onChange={event => update({ gitUsername: event.target.value })} />
              <SourceField label="Access token" name="git-token" type="password" value={gitToken} autoComplete="new-password" required={Boolean(needsToken)} maxLength={4096}
                placeholder={needsToken ? "Enter an access token" : "Saved token unchanged"}
                help={needsToken ? "Use a token with read access. It is encrypted when saved." : "Leave empty to keep the saved token."}
                onChange={event => update({ gitToken: event.target.value })} />
            </div> : <div id={`${id}-credentials`} hidden />}
          </div>}

          <SourceField label="Branch or ref" name="branch" className="mono" value={branch} required maxLength={200} placeholder="main"
            help="A branch, tag or commit to build." error={fieldError("SOURCE_REPOSITORY_OR_BRANCH")}
            onChange={event => update({ branch: event.target.value })} />
        </section>

        <section className="source-section">
          <div className="source-section-heading"><FileCode2 size={17} aria-hidden="true" /><h3>Build settings</h3></div>
          <label>
            Builder
            <select name="builder" value={builder} onChange={event => update({ builder: event.target.value as SourceBuilder })}>
              {SOURCE_BUILDERS.map(item => <option key={item.value} value={item.value}>{item.label} - {item.description}</option>)}
            </select>
            <small>Choose Dockerfile or zero-config Railpack / Nixpacks / Buildpacks / Auto-detect.</small>
          </label>
          <details className="source-build-advanced" open={buildSettingsOpen || Boolean(fieldError("SOURCE_CONTEXT") || fieldError("SOURCE_DOCKERFILE"))} onToggle={event => setBuildSettingsOpen(event.currentTarget.open)}>
            <summary>Advanced build settings</summary>
            <div className="source-build-grid">
            <SourceField label="Build context" name="context" className="mono" value={context} required maxLength={255} placeholder="."
              help="Relative to the repository root. Use . for the root." validate={buildPathError} error={fieldError("SOURCE_CONTEXT")}
              onChange={event => update({ context: event.target.value })} />
            <SourceField label="Dockerfile" name="dockerfile" className="mono" value={dockerfile} required maxLength={255} placeholder="Dockerfile"
              help="Relative to the build context." validate={buildPathError} error={fieldError("SOURCE_DOCKERFILE")}
              onChange={event => update({ dockerfile: event.target.value })} />
            </div>
            <label className="checkbox-label"><input type="checkbox" name="generate-env-file" checked={generateEnv}
              aria-controls={`${id}-env-file`} aria-expanded={generateEnv} onChange={event => update({ generateEnv: event.target.checked })} /> Generate an environment file before building</label>
            {generateEnv ? <div id={`${id}-env-file`}>
              <SourceField label="Environment file path" name="env-file" className="mono" value={envFile} required maxLength={255}
                placeholder=".env" help="Relative to the build context. Includes environment values and secrets; your Dockerfile can include this file in the image."
                validate={value => validEnvFilePath(value) && value !== dockerfile ? "" : "Use a relative file path outside Git and Docker build configuration files."}
                onChange={event => update({ envFile: event.target.value })} />
            </div> : <div id={`${id}-env-file`} hidden />}
          </details>
          <div className="source-check-row">
            <button type="button" className="button" aria-label={checkSource.isPending ? "Checking source" : undefined} disabled={!checkSupported || busy} onClick={event => {
              if (event.currentTarget.form?.reportValidity()) checkSource.mutate({ repository: selectedRepository, branch, context, dockerfile, ...(builder !== "dockerfile" ? { builder } : {}) });
            }}>{checkSource.isPending ? <FeatureLoading label="Checking source" /> : <><ShieldCheck size={16} aria-hidden="true" />Check source</>}</button>
            <p>{checkSupported ? "Verify repository access, ref and Dockerfile before deploying." : "Save this source and its credentials to enable the access check."}</p>
          </div>
          <span className="sr-only" aria-live="polite" aria-atomic="true">{sourceFieldError?.message}</span>
          {checkSource.isSuccess ? <div className="source-check-success" role="status"><Check size={17} aria-hidden="true" /><p>Source is accessible. Repository, ref and build paths checked.<br /><span>Commit <code>{checkSource.data.commit.slice(0, 12)}</code></span></p></div> : null}
          <FeatureError error={sourceFieldError ? undefined : checkSource.error} />
          <div className="source-tip"><Info size={17} aria-hidden="true" /><p>Each deployment checks out the selected ref and builds a new image. Follow the build output in Deployments.</p></div>
        </section>
      </>}
    </fieldset>

    <div className="source-save-error"><FeatureError error={save.error} /></div>
    <footer className="configuration-footer source-footer">
      <div className="source-footer-note"><Info size={17} aria-hidden="true" /><div aria-live="polite" aria-atomic="true"><strong>{save.isSuccess ? "Configuration saved" : dirty ? "You have unsaved changes" : "Configuration is up to date"}</strong><p>{save.isSuccess ? "Deploy this service to apply the saved configuration." : "Saving does not change the running deployment."}</p></div></div>
      <div className="source-footer-actions">
        {dirty ? <button type="button" className="button" disabled={busy || sharedManagedByAdmin} onClick={discard}><RotateCcw size={15} aria-hidden="true" />Discard changes</button> : null}
        <button type="submit" className="button button-primary" aria-label={save.isPending ? "Saving configuration" : undefined} disabled={!dirty || busy || sharedManagedByAdmin || !githubReady || sshSource&&!admin}>
          {save.isPending ? <FeatureLoading label="Saving" /> : <><Check size={16} aria-hidden="true" />Save configuration</>}
        </button>
      </div>
    </footer>
  </form>;
}
