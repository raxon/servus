import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Box,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Database,
  Folder,
  GitBranch,
  Plus,
  Settings,
  Sparkles,
  Zap,
} from "lucide-react";
import type { Project, RuntimeStatus, Service } from "../shared/types.js";
import { api, errorMessage } from "./api.js";
import { DashboardActions } from "./DashboardActions.js";
import { HostSparklines } from "./HostSparklines.js";
import { Skeleton } from "./Skeleton.js";
import { FeatureModal } from "./feature-ui.js";
import "./DashboardAttention.css";

const hasChanges = (service: Service) =>
  service.deployedRevision !== null &&
  service.revision !== service.deployedRevision;
const attention = (service: Service) =>
  service.state === "failed"
    ? 4
    : service.state === "unknown"
      ? 3
      : service.state === "pending"
        ? 2
        : service.state === "deploying" || hasChanges(service)
          ? 1
          : 0;

/** Clean 1:1 EasyPanel Dashboard: 4 live server sparklines + Projects workspace. */
export function DashboardOverview({
  projects,
  loading,
  error,
  userId,
  canCreate,
  search,
  onCreate,
}: {
  projects: Project[] | undefined;
  loading: boolean;
  error: unknown;
  userId: string;
  canCreate: boolean;
  search: string;
  onCreate: () => void;
}) {
  const [errorService, setErrorService] = useState<Service | null>(null);
  const collapseKey = `servus-dashboard-collapsed:${userId}`;
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(collapseKey) ?? "[]",
      );
      return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  const queries = useQueries({
    queries: (projects ?? []).map((project) => ({
      queryKey: ["services", project.id],
      queryFn: () => api<Service[]>(`/projects/${project.id}/services`),
      refetchInterval: 5_000,
    })),
  });
  const runtime = useQuery({
    queryKey: ["runtime"],
    queryFn: () => api<RuntimeStatus>("/runtime"),
    refetchInterval: 15_000,
  });
  const query = search.trim().toLowerCase();
  const entries = (projects ?? []).map((project, index) => {
    const result = queries[index]!;
    const projectMatches = `${project.name} ${project.description}`
      .toLowerCase()
      .includes(query);
    const services = (result.data ?? []).filter(
      (service) => projectMatches || service.name.toLowerCase().includes(query),
    );
    services.sort(
      (a, b) => attention(b) - attention(a) || a.name.localeCompare(b.name),
    );
    const score = result.isError
      ? 5
      : services.reduce((max, service) => Math.max(max, attention(service)), 0);
    return { project, result, services, projectMatches, score };
  });
  const visible = entries.filter(
    (entry) =>
      !entry.result.isSuccess || entry.services.length || entry.projectMatches,
  );
  visible.sort(
    (a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name),
  );
  const complete =
    !loading && !error && queries.every((result) => result.isSuccess);
  const filtered = query !== "";
  const updateCollapsed = (next: string[]) => {
    setCollapsed(next);
    localStorage.setItem(collapseKey, JSON.stringify(next));
  };

  return (
    <div className="dashboard-overview">
      <div className="dashboard-heading">
        <div>
          <h1>Overview</h1>
          <span className="dashboard-scope">
            {query ? "Search results" : "All projects"}
          </span>
        </div>
        <div className="dashboard-operator-actions">
          <span className={`badge dashboard-runtime-badge ${!runtime.isError && runtime.data?.online ? "status-running" : ""}`}>
            <span className="status-dot" />
            {runtime.isPending ? "Checking Docker"
              : runtime.isError ? "Docker status unavailable"
              : runtime.data?.online ? "Docker connected" : "Docker offline"}
          </span>
          {canCreate ? (
            <button className="button button-primary" type="button" onClick={onCreate}>
              <Plus size={16} aria-hidden="true" /> New project
            </button>
          ) : null}
        </div>
      </div>

      <HostSparklines />

      <section
        className="dashboard-project-region"
        aria-labelledby="dashboard-projects-title"
      >
        <div className="section-heading dashboard-collection-heading">
          <h2 id="dashboard-projects-title">
            Projects{" "}
            <span className="count-pill">
              {loading
                ? "…"
                : error || (filtered && !complete)
                  ? "—"
                  : filtered
                    ? `${visible.length}/${projects?.length ?? 0}`
                    : (projects?.length ?? 0)}
            </span>
          </h2>
        </div>
        {error ? (
          <div className="error-notice" role="alert">
            <CircleAlert size={17} />
            <span>{errorMessage(error)}</span>
          </div>
        ) : loading ? (
          <Skeleton kind="projects" label="Loading projects" />
        ) : projects?.length ? (
          <div className="dashboard-project-list">
            {visible.map(({ project, result, services }) => {
              const isCollapsed = collapsed.includes(project.id);
              const failures = result.isSuccess ? services.filter(service => service.state === "failed").length : 0;
              return (
                <section className="dashboard-project-group" key={project.id}>
                  <div className="dashboard-project-heading">
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: project.id }}
                    >
                      <Folder size={16} aria-hidden="true" />
                      <h3>{project.name}</h3>
                      <ChevronRight size={14} aria-hidden="true" />
                    </Link>
                    <div className="dashboard-project-meta">
                      {failures > 0 ? <span className="badge status-failed">{failures} failed</span> : null}
                      <span>
                        {result.isSuccess && result.data
                          ? `${filtered ? `${services.length}/` : ""}${result.data.length}`
                          : "—"}{" "}
                        {result.data?.length === 1 ? "service" : "services"}
                      </span>
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: project.id }}
                        search={{ tab: "templates" }}
                        className="icon-button"
                        title={`Templates for ${project.name}`}
                        aria-label={`Templates for ${project.name}`}
                      >
                        <Sparkles size={14} aria-hidden="true" />
                      </Link>
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: project.id }}
                        search={{ tab: "settings" }}
                        className="icon-button"
                        title={`Settings for ${project.name}`}
                        aria-label={`Settings for ${project.name}`}
                      >
                        <Settings size={14} aria-hidden="true" />
                      </Link>
                      <button
                        type="button"
                        className="dashboard-collapse"
                        aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${project.name}`}
                        aria-expanded={!isCollapsed}
                        aria-controls={`project-services-${project.id}`}
                        onClick={() =>
                          updateCollapsed(
                            isCollapsed
                              ? collapsed.filter((id) => id !== project.id)
                              : [...collapsed, project.id],
                          )
                        }
                      >
                        <ChevronDown size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div
                    id={`project-services-${project.id}`}
                    hidden={isCollapsed}
                  >
                    {result.isPending ? (
                      <Skeleton kind="services" label="Loading services" />
                    ) : result.error ? (
                      <div
                        className="dashboard-services-message dashboard-project-error"
                        role="alert"
                      >
                        <CircleAlert size={16} aria-hidden="true" />
                        <span>{errorMessage(result.error)}</span>
                        <button
                          className="button button-small"
                          onClick={() => void result.refetch()}
                        >
                          Try again
                        </button>
                      </div>
                    ) : services.length ? (
                      <div className="dashboard-services-grid">
                        {services.map((service) => (
                          <article
                            key={service.id}
                            className={`dashboard-service-entry ${service.state === "failed" ? "has-failure" : ""}`}
                          >
                            <Link
                              to="/services/$serviceId"
                              params={{ serviceId: service.id }}
                              className="dashboard-service-card"
                            >
                              <span className="dashboard-service-identity">
                                <span
                                  className="dashboard-service-icon"
                                  aria-hidden="true"
                                >
                                  {service.kind === "redis" ? (
                                    <Zap size={15} />
                                  ) : service.kind === "postgres" ||
                                    service.kind === "mariadb" ? (
                                    <Database size={15} />
                                  ) : (
                                    <Box size={15} />
                                  )}
                                </span>
                                <strong title={service.name}>
                                  {service.name}
                                </strong>
                              </span>
                              <span className="dashboard-service-meta">
                                <small>
                                  {service.kind === "app" || !service.kind
                                    ? "Application"
                                    : service.kind === "postgres"
                                      ? "PostgreSQL"
                                      : service.kind === "mariadb"
                                        ? "MariaDB"
                                        : "Redis"}
                                </small>
                                <span
                                  className={`badge status-${service.state}`}
                                >
                                  {service.state === "failed" ? (
                                    <CircleAlert size={12} aria-hidden="true" />
                                  ) : (
                                    <span className="status-dot" />
                                  )}
                                  {service.state.replaceAll("_", " ")}
                                </span>
                              </span>
                            </Link>
                            <DashboardActions
                              service={service}
                              canWrite={!!project.canWrite}
                              ingressPort={runtime.data?.ingressPort ?? 18080}
                            />
                            <footer className="dashboard-service-footer">
                              {hasChanges(service) ? (
                                <span className="dashboard-service-change">
                                  <GitBranch size={13} aria-hidden="true" />
                                  Pending deployment
                                </span>
                              ) : null}
                              {service.lastError ? (
                                <button
                                  type="button"
                                  className="dashboard-error-button"
                                  aria-label={`Error details for ${service.name}`}
                                  onClick={() => setErrorService(service)}
                                >
                                  <CircleAlert size={14} aria-hidden="true" />
                                  <span>Error details</span>
                                </button>
                              ) : null}
                              {service.state === "failed" ? (
                                <Link
                                  className="dashboard-logs-link"
                                  to="/services/$serviceId"
                                  params={{ serviceId: service.id }}
                                  search={{ tab: "logs" }}
                                  aria-label={`Logs for ${service.name}`}
                                >
                                  Logs
                                  <ChevronRight size={13} aria-hidden="true" />
                                </Link>
                              ) : null}
                            </footer>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="dashboard-services-message">
                        {result.data?.length
                          ? "No services match the current filters."
                          : "No services yet. Open the project to add one."}
                      </p>
                    )}
                  </div>
                </section>
              );
            })}
            {!visible.length ? (
              <div className="surface no-results">
                No projects or services match the current filters.
              </div>
            ) : null}
            {canCreate && !filtered ? (
              <button type="button" className="ep-dashed-create-btn" onClick={onCreate}>
                <Plus size={16} aria-hidden="true" />
                Create Project
              </button>
            ) : null}
          </div>
        ) : (
          <div className="empty-projects surface">
            <Folder size={32} aria-hidden="true" />
            <h2>No projects yet</h2>
            <p>
              {canCreate
                ? "Create a project to group your applications, then add a service to deploy."
                : "Ask an administrator to give you access to a project."}
            </p>
            {canCreate ? (
              <button className="button button-primary" onClick={onCreate}>
                <Plus size={16} />
                Create your first project
              </button>
            ) : null}
          </div>
        )}
      </section>
      {errorService ? (
        <FeatureModal
          title="Error details"
          description={errorService.name}
          onClose={() => setErrorService(null)}
        >
          <p className="dashboard-error-detail">{errorService.lastError}</p>
        </FeatureModal>
      ) : null}
    </div>
  );
}
