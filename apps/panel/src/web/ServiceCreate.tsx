import "./service-setup.css";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Box, Database, GitBranch, Globe2, Play } from "lucide-react";
import type {
  Action,
  Service,
  ServiceInput,
  ServiceKind,
  SourceBuilder,
  SourceConfig,
} from "../shared/types.js";
import type { SourceUploadRecord } from "../shared/host-admin.js";
import { api } from "./api.js";
import { useGithubConnection } from "./GithubSettings.js";
import { useHostDomain } from "./HostDomainSettings.js";
import { SOURCE_BUILDERS, SourceChoiceFields, githubRepositoryUrl, type SourceChoice } from "./source-choice.js";
import { validEnvFilePath } from "../shared/build-options.js";
import { GithubSourcePicker } from "./GithubSourcePicker.js";
import {RegistryFields,SshFields,type RegistryDraft} from './SourceCredentialFields.js';
import { notifyServiceQueued } from "./notifications.js";
import { FeatureError, FeatureLoading, FeatureModal } from "./feature-ui.js";

const kinds: {
  kind: ServiceKind;
  label: string;
  description: string;
  image: string;
  port: number;
}[] = [
  {
    kind: "app",
    label: "Application",
    description: "Docker image or Git source",
    image: "",
    port: 80,
  },
  {
    kind: "postgres",
    label: "PostgreSQL",
    description: "Persistent SQL database",
    image: "postgres:17-alpine",
    port: 5432,
  },
  {
    kind: "redis",
    label: "Redis",
    description: "Persistent key-value store",
    image: "redis:7-alpine",
    port: 6379,
  },
  {
    kind: "mariadb",
    label: "MariaDB",
    description: "Persistent SQL database",
    image: "mariadb:11.4",
    port: 3306,
  },
  {
    kind: "mysql",
    label: "MySQL",
    description: "Persistent SQL database",
    image: "mysql:8.4",
    port: 3306,
  },
  {
    kind: "mongodb",
    label: "MongoDB",
    description: "Persistent document store",
    image: "mongo:7",
    port: 27017,
  },
];

export function CreateService({
  projectId,
  admin,
  serviceNames,
  onClose,
}: {
  projectId: string;
  admin: boolean;
  serviceNames: readonly string[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [kind, setKind] = useState<ServiceKind>("app");
  const [sourceType, setSourceType] = useState<SourceChoice>("image");
  const [name, setName] = useState("");
  const nameBase = kind === "app" ? "web" : kind;
  let defaultName: string = nameBase;
  const existingNames = new Set(serviceNames);
  for (let suffix = 2; existingNames.has(defaultName); suffix++) defaultName = `${nameBase}-${suffix}`;
  const serviceName = name || defaultName;
  const [image, setImage] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState(80);
  const [repository, setRepository] = useState("");
  const [githubRepository, setGithubRepository] = useState("");
  const [privateGit, setPrivateGit] = useState(false);
  const github = useGithubConnection(admin);
  const hostDomain=useHostDomain();
  const automaticDomain=hostDomain.data?.ready===true;
  const [gitUsername, setGitUsername] = useState("");
  const [gitToken, setGitToken] = useState("");
  const [branch, setBranch] = useState("main");
  const [context, setContext] = useState(".");
  const [dockerfile, setDockerfile] = useState("Dockerfile");
  const [builder, setBuilder] = useState<SourceBuilder>("dockerfile");
  const [dockerfileContent, setDockerfileContent] = useState("FROM nginx:alpine\nEXPOSE 80\n");
  const [uploadRecord, setUploadRecord] = useState<SourceUploadRecord | null>(null);
  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      api<SourceUploadRecord>(`/projects/${projectId}/source-uploads`, {
        method: "POST",
        binary: file,
        headers: { "X-Upload-Filename": file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "source.tar.gz" },
      }),
    onSuccess: (record) => setUploadRecord(record),
  });
  const [generateEnv, setGenerateEnv] = useState(false);
  const [envFile, setEnvFile] = useState(".env");
  const [knownHosts,setKnownHosts]=useState('');
  const [registry,setRegistry]=useState<RegistryDraft>({registryEnabled:false,registryServer:'docker.io',registryUsername:'',registryPassword:''});
  const sshSource=sourceType==='git'&&repository.startsWith('ssh:');
  const [database, setDatabase] = useState("app");
  const [user, setUser] = useState("app");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => {
      const source: SourceConfig =
        kind !== "app" || sourceType === "image"
          ? { type: "image" }
          : sourceType === "dockerfile"
            ? { type: "dockerfile", dockerfileContent, ...(generateEnv ? { envFile } : {}) }
            : sourceType === "upload"
              ? { type: "upload", uploadId: uploadRecord?.id ?? "", filename: uploadRecord?.filename, sha256: uploadRecord?.sha256, context, dockerfile, builder: builder === "dockerfile" ? "auto" : builder, ...(generateEnv ? { envFile } : {}) }
              : { type: "git", repository: sourceType === "github" ? githubRepositoryUrl(githubRepository) : repository, branch, context, dockerfile, ...(builder !== "dockerfile" ? { builder } : {}), ...(generateEnv ? { envFile } : {}), ...(sshSource?{ssh:{knownHosts}}:sourceType === "github" && github.data?.connected ? {sharedGithub: true} : sourceType === "git" && privateGit ? { credential: { username: gitUsername, token: gitToken } } : {}) };
      const body: Omit<ServiceInput,'hostname'> & {hostname?:string} = {
        name: serviceName,
        kind,
        source,
        image:
          image ||
          (source.type !== "image"
            ? "panel-build:pending"
            : kinds.find((item) => item.kind === kind)!.image),
        ...(kind==='app' && automaticDomain && !hostname?{}:{hostname:hostname || `${serviceName}.localhost`}),
        port,
        replicas: 1,
        ...(kind==='app'&&sourceType==='image'&&registry.registryEnabled?{registry:{server:registry.registryServer,username:registry.registryUsername,password:registry.registryPassword}}:{}),
        ...(kind !== "app"
          ? {
              domains: [],
              database: { database, user, ...(password ? { password } : {}) },
            }
          : {}),
      };
      return api<{ service: Service; action: Action }>(
        `/projects/${projectId}/services`,
        { method: "POST", idempotent: true, body },
      );
    },
    onSuccess: ({ service }) => {
      notifyServiceQueued();
      void client.invalidateQueries({ queryKey: ["projects"] });
      void client.invalidateQueries({ queryKey: ["services", projectId] });
      void client.invalidateQueries({ queryKey: ["actions"] });
      onClose();
      void navigate({
        to: "/services/$serviceId",
        params: { serviceId: service.id },
        ...(service.source?.type==='git'&&service.source.ssh?{search:{tab:'source'}}:{}),
      });
    },
  });
  return (
    <FeatureModal
      title="Create a service"
      description="Deploy an application or a private database in this project."
      onClose={onClose}
    >
      <form
        className="service-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          if(sshSource&&!admin)return;
          if (sourceType === "github" && admin && !github.isSuccess) return;
          mutation.mutate();
        }}
      >
        <div className="service-create-body">
        <fieldset
          className="service-create-fields"
          disabled={mutation.isPending}
        >
          <legend className="sr-only">Service configuration</legend>
          {sourceType === "github" && admin && github.isError ? <FeatureError error={github.error} /> : null}
          <div className="service-kind-grid">
            {kinds.map((item) => (
              <button
                className={`service-kind-choice ${kind === item.kind ? "selected" : ""}`}
                type="button"
                key={item.kind}
                aria-pressed={kind === item.kind}
                onClick={() => {
                  setKind(item.kind);
                  setImage(item.image);
                  setPort(item.port);
                  if (item.kind !== "app") setSourceType("image");
                }}
              >
                {item.kind === "app" ? (
                  <Box size={19} />
                ) : (
                  <Database size={19} />
                )}
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </button>
            ))}
          </div>
          <label>
            Service name
            <input
              autoFocus
              name="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              pattern={"[a-z0-9][a-z0-9\\-]*"}
              maxLength={63}
              placeholder={defaultName}
            />
            <small>Leave blank to use {defaultName}. Custom names use lowercase letters, numbers, and hyphens.</small>
          </label>
          {kind === "app" ? <SourceChoiceFields value={sourceType} onChange={setSourceType} /> : null}
          {sourceType === "image" ? (<>
            {kind === "postgres" ? (
              <label>
                PostgreSQL major version
                <select
                  value={image || "postgres:17-alpine"}
                  onChange={(event) => setImage(event.target.value)}
                >
                  <option value="postgres:17-alpine">PostgreSQL 17 (default - postgres:17-alpine)</option>
                  <option value="postgres:18-alpine">PostgreSQL 18 (postgres:18-alpine)</option>
                </select>
                <small>Major-version upgrades after deployment use backup and restore into a fresh service.</small>
              </label>
            ) : null}
            <label>
              Docker image
              <input
                className="mono"
                value={image}
                onChange={(event) => setImage(event.target.value)}
                required
                placeholder="nginx:alpine"
              />
              <small>
                {kind === "app"
                  ? "Use an image with an explicit tag or digest. Configure registry access below for a private image."
                  : "The selected engine requires a compatible database image."}
              </small>
            </label>
            {kind==='app'?<details className="service-registry-settings"><summary>Private registry access{registry.registryEnabled ? ' (enabled)' : ''}</summary><RegistryFields value={registry} needsPassword onChange={patch=>setRegistry(value=>({...value,...patch}))}/></details>:null}
            </>
          ) : sourceType === "dockerfile" ? (
            <label>
              Inline Dockerfile
              <textarea
                className="mono"
                rows={8}
                required
                value={dockerfileContent}
                onChange={(event) => setDockerfileContent(event.target.value)}
                placeholder={"FROM nginx:alpine\nEXPOSE 80\n"}
              />
              <small>Built directly by Docker BuildKit when deployed.</small>
            </label>
          ) : sourceType === "upload" ? (
            <>
              <label>
                Upload source archive (.tar.gz)
                <input
                  type="file"
                  accept=".tar.gz,.tgz,application/gzip"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) uploadMutation.mutate(file);
                  }}
                />
                <small>{uploadRecord ? `Uploaded ${uploadRecord.filename} (${uploadRecord.sizeBytes} B)` : "Upload a gzipped tarball containing your app source."}</small>
              </label>
              {uploadMutation.error ? <FeatureError error={uploadMutation.error} /> : null}
              <label>
                Builder
                <select value={builder === "dockerfile" ? "auto" : builder} onChange={(event) => setBuilder(event.target.value as SourceBuilder)}>
                  {SOURCE_BUILDERS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label} - {item.description}</option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              {sourceType === "github" && admin && github.data?.connected ? <GithubSourcePicker repository={githubRepository} branch={branch} disabled={mutation.isPending} onChange={selection => { setGithubRepository(selection.repository); setBranch(selection.branch); }} /> : null}
              {sourceType === "github" ? <label>
                GitHub repository
                <input name="github-repository" aria-describedby="github-repository-help" value={githubRepository} onChange={(event) => setGithubRepository(event.target.value)} pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" placeholder="organization/repository" autoCapitalize="none" spellCheck={false} required />
                <small>Enter the owner and repository name, for example organization/app.</small>
              </label> : <label>
                Repository URL
                <input name="repository" type="url" value={repository} onChange={(event) => setRepository(event.target.value)} required placeholder="https://github.com/organization/application.git" />
              </label>}
              {sshSource?(admin?<SshFields key={repository} repository={repository} knownHosts={knownHosts} onKnownHosts={setKnownHosts}/>:<p>Ask an administrator to configure SSH deploy keys and trusted host keys.</p>):sourceType === "github" ? <small id="github-repository-help">Private GitHub repositories require a token in {admin ? <a href="/settings#github-connection">Settings under GitHub connection</a> : "Settings under GitHub connection; ask an administrator to configure it"}. {github.data?.connected ? "The saved connection will be used automatically." : null}</small> : <>
                <label className="checkbox-label">
                  <input type="checkbox" checked={privateGit} onChange={(event) => setPrivateGit(event.target.checked)} />
                  Private repository
                </label>
                {privateGit ? <>
                  <label>Git username<input value={gitUsername} onChange={(event) => setGitUsername(event.target.value)} autoComplete="off" required /></label>
                  <label>Access token<input type="password" value={gitToken} onChange={(event) => setGitToken(event.target.value)} autoComplete="new-password" required /><small>The token is encrypted on this installation.</small></label>
                </> : null}
              </>}
              <label>
                Branch or ref
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  required
                />
              </label>
              <label>
                Builder
                <select value={builder} onChange={(event) => setBuilder(event.target.value as SourceBuilder)}>
                  {SOURCE_BUILDERS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label} - {item.description}</option>
                  ))}
                </select>
                <small>Use Dockerfile or zero-config Railpack / Nixpacks / Buildpacks / Auto-detect.</small>
              </label>
              <div className="form-grid">
                <label>
                  Build context
                  <input
                    className="mono"
                    value={context}
                    onChange={(event) => setContext(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Dockerfile
                  <input
                    className="mono"
                    value={dockerfile}
                    onChange={(event) => setDockerfile(event.target.value)}
                    required
                  />
                </label>
              </div>
              <label className="checkbox-label"><input type="checkbox" name="generate-env-file" checked={generateEnv}
                aria-controls="create-env-file" aria-expanded={generateEnv} onChange={event => setGenerateEnv(event.target.checked)} /> Generate an environment file before building</label>
              {generateEnv ? <label id="create-env-file">
                Environment file path
                <input name="env-file" className="mono" value={envFile} required maxLength={255} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  aria-describedby="create-env-file-help" onChange={event => {
                    event.currentTarget.setCustomValidity(validEnvFilePath(event.target.value) && event.target.value !== dockerfile ? "" : "Use a relative file path outside Git and Docker build configuration files.");
                    setEnvFile(event.target.value);
                  }} />
                <small id="create-env-file-help">Relative to the build context. Includes environment values and secrets; your Dockerfile can include this file in the image.</small>
              </label> : <div id="create-env-file" hidden />}
            </>
          )}
          {kind === "app" ? (
            <div className="form-grid">
              <label>
                Hostname
                <input
                  name="hostname"
                  value={hostname || (automaticDomain ? "" : `${serviceName}.localhost`)}
                  onChange={(event) => setHostname(event.target.value)}
                  required={!automaticDomain}
                  placeholder={automaticDomain ? "Leave blank for an automatic HTTPS address" : `${serviceName}.localhost`}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby="service-hostname-help"
                />
                <small id="service-hostname-help">{automaticDomain?`Leave blank to use an automatic address under ${hostDomain.data?.hostname}. Enter a custom domain to use your own DNS.`:'Point this domain to your server. A .localhost address is for local use.'}</small>
              </label>
              <label>
                Container port
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(event) => setPort(Number(event.target.value))}
                  required
                />
                <small>The port your application listens on inside the container.</small>
              </label>
            </div>
          ) : (
            <>
              {kind === "redis" ? (
                <p className="feature-helper">
                  Redis uses logical database 0 and the default user.
                </p>
              ) : (
                <div className="form-grid">
                  <label>
                    Database name
                    <input
                      value={database}
                      onChange={(event) => setDatabase(event.target.value)}
                      required
                      pattern="[a-zA-Z][a-zA-Z0-9_]*"
                    />
                  </label>
                  <label>
                    Database user
                    <input
                      value={user}
                      onChange={(event) => setUser(event.target.value)}
                      required
                      pattern="[a-zA-Z][a-zA-Z0-9_]*"
                    />
                  </label>
                </div>
              )}
              <label>
                Database password
                <input
                  type="password"
                  minLength={12}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Leave blank to generate a password"
                />
                <small>
                  Stored encrypted. Reveal it later through the database
                  connection section.
                </small>
              </label>
            </>
          )}
          <div className="info-notice">
            {kind === "app" ? (
              <>
                <Globe2 size={16} />
                <span>
                  {automaticDomain?'An automatic Servus address includes HTTPS. Your process must listen on the selected container port.':'Deployments use the local HTTP ingress. Your process must listen on the selected container port.'}
                </span>
              </>
            ) : (
              <>
                <Database size={16} />
                <span>
                  The database is private to the project network. A persistent
                  volume is prepared for its data.
                </span>
              </>
            )}
          </div>
          <FeatureError error={mutation.error} />
        </fieldset>
        <aside className="service-create-preview" aria-label="Service preview">
          <h3>Service preview</h3>
          <dl>
            <div><dt>Name</dt><dd>{serviceName}</dd></div>
            <div><dt>Source</dt><dd>{sourceType === "image" ? image || "Choose a Docker image" : sourceType === "dockerfile" ? "Inline Dockerfile" : sourceType === "upload" ? (uploadRecord ? `Upload · ${uploadRecord.filename}` : "Upload a .tar.gz archive") : `${sourceType === "github" ? githubRepository || "Choose a GitHub repository" : repository || "Enter a repository URL"} · ${branch || "Choose a ref"}`}</dd></div>
            <div><dt>{kind === "app" ? "Address" : "Network"}</dt><dd>{kind !== "app" ? "Private project network" : hostname || (automaticDomain ? `Automatic HTTPS address under ${hostDomain.data?.hostname}, assigned on creation` : `${serviceName}.localhost (local use)`)}</dd></div>
            <div><dt>Container port</dt><dd>{port || "Enter a port"}</dd></div>
          </dl>
          <p>{sshSource ? "Creation queues a deployment. Add the generated deploy public key to your repository before a Git build can succeed." : "Creation queues a deployment. The service becomes available after deployment succeeds."}</p>
        </aside>
        </div>
        <div className="modal-footer service-create-footer">
          <small>Creates the service and queues deployment.</small>
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button button-primary"
            type="submit"
            disabled={mutation.isPending || uploadMutation.isPending || (sourceType === "upload" && !uploadRecord) || (sshSource && !admin)}
          >
            {mutation.isPending ? (
              <FeatureLoading label="Creating service" />
            ) : (
              <>
                <Play size={15} />
                Create & deploy
              </>
            )}
          </button>
        </div>
      </form>
    </FeatureModal>
  );
}
