import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Box, Database, GitBranch, Globe2, Play } from "lucide-react";
import type {
  Action,
  Service,
  ServiceInput,
  ServiceKind,
  SourceConfig,
} from "../shared/types.js";
import { api } from "./api.js";
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
];

export function CreateService({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [kind, setKind] = useState<ServiceKind>("app");
  const [sourceType, setSourceType] = useState<SourceConfig["type"]>("image");
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState(80);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [context, setContext] = useState(".");
  const [dockerfile, setDockerfile] = useState("Dockerfile");
  const [database, setDatabase] = useState("app");
  const [user, setUser] = useState("app");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => {
      const source: SourceConfig =
        kind === "app" && sourceType === "git"
          ? { type: "git", repository, branch, context, dockerfile }
          : { type: "image" };
      const body: ServiceInput = {
        name,
        kind,
        source,
        image:
          image ||
          (source.type === "git"
            ? "panel-build:pending"
            : kinds.find((item) => item.kind === kind)!.image),
        hostname: hostname || `${name}.localhost`,
        port,
        replicas: 1,
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
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <fieldset
          className="service-create-fields"
          disabled={mutation.isPending}
        >
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
                if (!hostname || hostname === `${name}.localhost`)
                  setHostname(`${event.target.value}.localhost`);
              }}
              pattern="[a-z0-9][a-z0-9-]*"
              maxLength={63}
              placeholder={kind === "app" ? "web" : kind}
              required
            />
            <small>Use lowercase letters, numbers, and hyphens.</small>
          </label>
          {kind === "app" ? (
            <label>
              Source
              <select
                value={sourceType}
                onChange={(event) =>
                  setSourceType(event.target.value as SourceConfig["type"])
                }
              >
                <option value="image">Docker image</option>
                <option value="git">Public Git repository</option>
              </select>
            </label>
          ) : null}
          {sourceType === "image" ? (
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
                  ? "Use a public image with an explicit tag or digest."
                  : "The selected engine requires a compatible database image."}
              </small>
            </label>
          ) : (
            <>
              <label>
                Repository URL
                <input
                  type="url"
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                  required
                  placeholder="https://github.com/organization/application.git"
                />
              </label>
              <label>
                Branch or ref
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  required
                />
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
            </>
          )}
          {kind === "app" ? (
            <div className="form-grid">
              <label>
                Hostname
                <input
                  name="hostname"
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                  required
                  placeholder="web.localhost"
                  autoCapitalize="none"
                />
                <small>Point this domain to your server. A .localhost address is for local use.</small>
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
                  Deployments use the local HTTP ingress. Your process must
                  listen on the selected container port.
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
        <div className="modal-footer">
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button button-primary"
            type="submit"
            disabled={mutation.isPending}
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
