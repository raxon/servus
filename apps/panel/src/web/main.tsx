import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock3,
  ExternalLink,
  Folder,
  FolderPlus,
  GitBranch,
  Globe2,
  Layers3,
  LayoutGrid,
  LoaderCircle,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type {
  Action,
  ActionDetail,
  Project,
  RuntimeStatus,
  Service,
  SessionResponse,
} from "../shared/types.js";
import { api, errorMessage, RequestError, setCsrfToken } from "./api.js";
import { CreateService } from "./ServiceCreate.js";
import {
  DatabaseConnection,
  DestroyService,
  ProjectSettings,
  ServiceConfigurationPanel,
  ServiceMetricsPanel,
  serviceTabs,
} from "./ServiceFeatures.js";
import type { ServiceTab } from "./ServiceFeatures.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 2_000, refetchOnWindowFocus: true },
  },
});
const AuthContext = createContext<SessionResponse | null>(null);
const useAuth = () => useContext(AuthContext)!;
const pendingAction = (action: Action) =>
  action.status === "queued" || action.status === "running";
const formatDate = (date: string) =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
const relative = (date: string) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 60_000),
  );
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
};
const shortId = (id: string) => id.slice(0, 8);

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-symbol" aria-hidden="true">
        <img src="/brand/servus.svg" width="32" height="32" alt="" />
      </span>
      <span>
        Servus
      </span>
    </div>
  );
}

function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="loading-inline" role="status">
      <LoaderCircle size={17} className="spin" />
      {label}
    </span>
  );
}
function ErrorNotice({ error }: { error: unknown }) {
  return error ? (
    <div className="error-notice" role="alert">
      <CircleAlert size={17} />
      <span>{errorMessage(error)}</span>
    </div>
  ) : null;
}
function Badge({ status }: { status: string }) {
  const label = status.replaceAll("_", " ");
  return (
    <span className={`badge status-${status}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

function AuthGate() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      try {
        const data = await api<SessionResponse>("/auth/session");
        setCsrfToken(data.csrfToken);
        return data;
      } catch (error) {
        if (error instanceof RequestError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () => api<{ required: boolean }>("/setup"),
    enabled: session.data === null,
  });
  if (session.isPending || (session.data === null && setup.isPending))
    return (
      <div className="screen-loading">
        <Brand />
        <Spinner label="Opening your workspace" />
      </div>
    );
  if (session.error || setup.error)
    return (
      <div className="screen-loading">
        <Brand />
        <ErrorNotice error={session.error ?? setup.error} />
        <button
          className="button"
          onClick={() => {
            void session.refetch();
            void setup.refetch();
          }}
        >
          Try again
        </button>
      </div>
    );
  if (!session.data) return <AuthForm setup={setup.data?.required ?? false} />;
  return (
    <AuthContext.Provider value={session.data}>
      <RouterProvider router={router} />
    </AuthContext.Provider>
  );
}

function AuthForm({ setup }: { setup: boolean }) {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api<SessionResponse>(setup ? "/setup" : "/auth/login", {
        method: "POST",
        body: { email, password, ...(setup ? { token } : {}) },
      }),
    onSuccess: (data) => {
      setCsrfToken(data.csrfToken);
      client.setQueryData(["session"], data);
    },
  });
  return (
    <div className="auth-layout">
      <aside className="auth-story">
        <Brand />
        <div className="auth-story-body">
          <span className="eyebrow light">
            SELF-HOSTED APPLICATION MANAGEMENT
          </span>
          <h1>
            Manage your
            <br />
            applications.
          </h1>
          <p>
            Deploy Docker images and inspect service status, configuration
            revisions, and operation output.
          </p>
          <div className="auth-feature">
            <ShieldCheck size={20} />
            <span>Project-scoped service management</span>
          </div>
          <div className="auth-feature">
            <Terminal size={20} />
            <span>Deployment history and runtime status</span>
          </div>
        </div>
        <div className="auth-bottom">
          <span className="status-dot" /> Local installation
        </div>
      </aside>
      <main className="auth-form-area">
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="auth-icon">
            <Server size={24} />
          </div>
          <span className="eyebrow">
            {setup ? "FIRST-TIME SETUP" : "WELCOME BACK"}
          </span>
          <h2>
            {setup ? "Create your workspace" : "Sign in to your workspace"}
          </h2>
          <p className="muted">
            {setup
              ? "Set up the administrator for this installation."
              : "Access projects, services, and deployment history."}
          </p>
          {setup ? (
            <label>
              Bootstrap token
              <input
                name="token"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required
                autoComplete="off"
                placeholder="Token from your local installation"
              />
              <small>
                Find the one-time token in your installation data directory.
              </small>
            </label>
          ) : null}
          <label>
            Email address
            <input
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="username"
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              value={password}
              minLength={setup ? 12 : undefined}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete={setup ? "new-password" : "current-password"}
              placeholder={
                setup ? "At least 12 characters" : "Enter your password"
              }
            />
          </label>
          <ErrorNotice error={mutation.error} />
          <button
            className="button button-primary auth-submit"
            type="submit"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <Spinner label={setup ? "Creating workspace" : "Signing in"} />
            ) : (
              <>
                {setup ? "Create workspace" : "Sign in"}
                <ArrowRight size={17} />
              </>
            )}
          </button>
          <div className="auth-note">
            <ShieldCheck size={15} />
            <span>Credentials stay on your own installation.</span>
          </div>
        </form>
        <div className="auth-footer">
          Servus <span>/</span> servus.run
        </div>
      </main>
    </div>
  );
}

function useRuntime() {
  return useQuery({
    queryKey: ["runtime"],
    queryFn: () => api<RuntimeStatus>("/runtime"),
    refetchInterval: 15_000,
  });
}
function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/projects"),
    refetchInterval: 5_000,
  });
}
function useActions(projectId?: string) {
  return useQuery({
    queryKey: ["actions", projectId ?? "all"],
    queryFn: () =>
      api<Action[]>(
        `/actions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      ),
    refetchInterval: 2_000,
  });
}

function Shell() {
  const { user } = useAuth();
  const client = useQueryClient();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const projects = useProjects();
  const runtime = useRuntime();
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST", body: {} }),
    onSuccess: () => {
      setCsrfToken("");
      client.clear();
      client.setQueryData(["session"], null);
    },
  });
  const locationName = path.startsWith("/services/")
    ? "Service"
    : path.startsWith("/projects/")
      ? "Project"
      : path === "/activity"
        ? "Activity"
        : path === "/settings"
          ? "Instance"
          : "Overview";
  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link to="/" className="brand-link" aria-label="Servus overview">
          <Brand />
        </Link>
        <div className="workspace-switch">
          <span className="workspace-avatar">L</span>
          <span>
            <strong>Local workspace</strong>
            <small>Self-hosted</small>
          </span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <Link to="/" className={`nav-item ${path === "/" ? "active" : ""}`}>
            <LayoutGrid size={18} />
            Overview
          </Link>
          <Link
            to="/activity"
            className={`nav-item ${path === "/activity" ? "active" : ""}`}
          >
            <Activity size={18} />
            Activity
          </Link>
          <Link
            to="/settings"
            className={`nav-item ${path === "/settings" ? "active" : ""}`}
          >
            <Settings2 size={18} />
            Instance
          </Link>
        </nav>
        <div className="nav-label project-nav-label">
          PROJECTS<span>{projects.data?.length ?? ""}</span>
        </div>
        <div className="sidebar-projects">
          {projects.data?.length ? (
            projects.data.map((project) => (
              <Link
                key={project.id}
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                className={`project-nav ${path === `/projects/${project.id}` ? "active" : ""}`}
              >
                <Folder size={16} />
                <span>{project.name}</span>
              </Link>
            ))
          ) : (
            <p className="sidebar-hint">Your projects will appear here.</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-engine">
            <span
              className={`status-dot ${runtime.data?.online ? "online" : "offline"}`}
            />
            <span>Docker engine</span>
            <span>
              {runtime.data?.online
                ? "Connected"
                : runtime.isPending
                  ? "Checking"
                  : "Offline"}
            </span>
          </div>
          <div className="sidebar-user">
            <span className="user-avatar">{user.email[0]?.toUpperCase()}</span>
            <span>
              <strong>{user.email.split("@")[0]}</strong>
              <small>
                {user.role === "admin" ? "Administrator" : "Member"}
              </small>
            </span>
            <button
              className="icon-button logout-button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{locationName}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-pill">
              <span className="status-dot" />
              LOCAL INSTANCE
            </span>
            <span className="top-avatar">{user.email[0]?.toUpperCase()}</span>
          </div>
        </header>
        <main id="main-content" className="content">
          <Outlet />
        </main>
        <footer className="workspace-footer">
          <span>
            Servus <span className="footer-dot">·</span> servus.run
          </span>
          <span>
            <span className="status-dot" />
            Local control plane
          </span>
        </footer>
      </div>
    </div>
  );
}

function Modal({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="modal-title"
      aria-describedby="modal-description"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <div>
          <h2 id="modal-title">{title}</h2>
          <p id="modal-description">{description}</p>
        </div>
        <button
          onClick={onClose}
          className="icon-button"
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function CreateProject({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api<Project>("/projects", {
        method: "POST",
        body: { name, description },
      }),
    onSuccess: (project) => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      void navigate({
        to: "/projects/$projectId",
        params: { projectId: project.id },
      });
    },
  });
  return (
    <Modal
      title="Create a project"
      description="Give related applications a place to work together."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Project name
          <input
            autoFocus
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. production"
            pattern="[a-z0-9][a-z0-9-]*"
            required
            maxLength={63}
          />
          <small>Use lowercase letters, numbers, and hyphens.</small>
        </label>
        <label>
          Description <span className="optional">Optional</span>
          <textarea
            name="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What will you deploy here?"
            rows={3}
            maxLength={500}
          />
        </label>
        <ErrorNotice error={mutation.error} />
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
              <Spinner label="Creating" />
            ) : (
              <>
                <Plus size={16} />
                Create project
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Dashboard() {
  const projects = useProjects();
  const actions = useActions();
  const runtime = useRuntime();
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");
  const visible =
    projects.data?.filter((project) =>
      `${project.name} ${project.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  const services =
    projects.data?.reduce((sum, project) => sum + project.serviceCount, 0) ?? 0;
  const running = actions.data?.filter(pendingAction).length ?? 0;
  const completed =
    actions.data?.filter((action) => action.status === "succeeded").length ?? 0;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR INFRASTRUCTURE</div>
          <h1>Your workspace</h1>
          <p>Projects, services, and deployment operations.</p>
        </div>
        <button
          className="button button-primary"
          onClick={() => setShowCreate(true)}
        >
          <Plus size={17} />
          New project
        </button>
      </div>
      <div className="summary-grid">
        <Summary
          icon={<Folder size={20} />}
          label="Projects"
          value={
            projects.isPending
              ? "..."
              : projects.error
                ? "--"
                : String(projects.data?.length ?? 0)
          }
          detail="Organized workspaces"
        />
        <Summary
          icon={<Box size={20} />}
          label="Services"
          value={
            projects.isPending
              ? "..."
              : projects.error
                ? "--"
                : String(services)
          }
          detail="Across all projects"
        />
        <Summary
          icon={<Activity size={20} />}
          label="Active operations"
          value={
            actions.isPending ? "..." : actions.error ? "--" : String(running)
          }
          detail={running ? "Work in progress" : "No operations in progress"}
        />
        <Summary
          icon={<CheckCircle2 size={20} />}
          label="Completed operations"
          value={
            actions.isPending ? "..." : actions.error ? "--" : String(completed)
          }
          detail="Successful recorded actions"
        />
        <Summary
          icon={<Server size={20} />}
          label="Docker engine"
          value={
            runtime.isPending
              ? "Checking"
              : runtime.data?.online
                ? "Connected"
                : "Offline"
          }
          detail={
            runtime.data?.online
              ? `Engine ${runtime.data.engineVersion ?? ""}`
              : "Check your local agent"
          }
          good={runtime.data?.online}
        />
      </div>
      <div className="dashboard-workload-grid">
        <div className="dashboard-project-region">
          <div className="section-heading">
            <div>
              <h2>
                Projects{" "}
                <span className="count-pill">{projects.data?.length ?? 0}</span>
              </h2>
              <p>Manage related services within a project.</p>
            </div>
            <div className="search-field">
              <Search size={16} />
              <input
                aria-label="Search projects"
                placeholder="Search projects..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <kbd>/</kbd>
            </div>
          </div>
          <ErrorNotice error={projects.error} />
          {projects.isPending ? (
            <div className="surface loading-surface">
              <Spinner label="Loading projects" />
            </div>
          ) : projects.data?.length ? (
            <div className="project-grid">
              {visible.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
              {!visible.length ? (
                <div className="surface no-results">
                  No projects match "{search}".
                </div>
              ) : null}
            </div>
          ) : (
            <div className="empty-projects surface">
              <div className="empty-illustration">
                <span className="empty-tile tile-back">
                  <Box size={24} />
                </span>
                <span className="empty-tile tile-front">
                  <FolderPlus size={31} strokeWidth={1.5} />
                </span>
                <span className="illustration-cross">+</span>
              </div>
              <span className="eyebrow">PROJECTS</span>
              <h2>No projects yet</h2>
              <p>
                Create a project to group your applications.
                <br />
                Then deploy an image and follow its progress.
              </p>
              <button
                className="button button-primary"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={16} />
                Create your first project
              </button>
              <div className="empty-footnote">
                <ShieldCheck size={14} />
                Everything stays on your own server.
              </div>
            </div>
          )}
          <div className="section-heading activity-heading">
            <div>
              <h2>Recent activity</h2>
              <p>Recent deployments and service changes.</p>
            </div>
            <Link to="/activity" className="text-link">
              View all activity
              <ArrowRight size={15} />
            </Link>
          </div>
          <ErrorNotice error={actions.error} />
          <ActionsTable
            actions={actions.data?.slice(0, 5) ?? []}
            loading={actions.isPending}
          />
          {showCreate ? (
            <CreateProject onClose={() => setShowCreate(false)} />
          ) : null}
        </div>
        <RuntimeAside
          runtime={runtime.data}
          loading={runtime.isPending}
          actions={actions.data ?? []}
        />
      </div>
    </>
  );
}

function RuntimeAside({
  runtime,
  loading,
  actions,
}: {
  runtime?: RuntimeStatus;
  loading: boolean;
  actions: Action[];
}) {
  const failures = actions.filter(
    (action) => action.status === "failed",
  ).length;
  const active = actions.filter(pendingAction).length;
  return (
    <aside className="runtime-aside">
      <section className="surface runtime-card">
        <div className="card-heading">
          <h2>Runtime capacity</h2>
          <Server size={18} />
        </div>
        <p className="runtime-card-description">
          Resources available to your local Docker engine.
        </p>
        <div className="runtime-capacity">
          <div>
            <span>CPUs</span>
            <strong>{loading ? "..." : (runtime?.cpus ?? "--")}</strong>
            <small>Available processors</small>
          </div>
          <div>
            <span>Memory</span>
            <strong>
              {loading
                ? "..."
                : runtime?.memoryBytes
                  ? `${(runtime.memoryBytes / 1024 ** 3).toFixed(1)}`
                  : "--"}
              <em>GiB</em>
            </strong>
            <small>Engine capacity</small>
          </div>
        </div>
        <div className="runtime-status-row">
          <span>
            <span
              className={`status-dot ${runtime?.online ? "" : "offline"}`}
            />
            {runtime?.online
              ? "Engine connected"
              : loading
                ? "Checking connection"
                : "Engine unavailable"}
          </span>
          <span>
            {runtime?.engineVersion ? `v${runtime.engineVersion}` : "--"}
          </span>
        </div>
        {runtime?.error ? (
          <p className="runtime-error">{runtime.error}</p>
        ) : null}
      </section>
      <section className="surface runtime-card">
        <div className="card-heading">
          <h2>Operation status</h2>
          <Activity size={18} />
        </div>
        <div className="operation-health">
          <div>
            <span className="health-dot active-dot" />
            <span>In progress</span>
            <strong>{active}</strong>
          </div>
          <div>
            <span className="health-dot success-dot" />
            <span>Succeeded</span>
            <strong>
              {actions.filter((action) => action.status === "succeeded").length}
            </strong>
          </div>
          <div>
            <span className="health-dot failed-dot" />
            <span>Failed</span>
            <strong>{failures}</strong>
          </div>
        </div>
        <p className="runtime-hint">
          {failures
            ? "Open activity to inspect the failed operation output."
            : "Every operation is recorded with its progress and result."}
        </p>
        <Link to="/activity" className="runtime-link">
          View operation history
          <ArrowUpRight size={15} />
        </Link>
      </section>
      <section className="surface runtime-card workspace-guide">
        <span className="guide-icon">
          <Layers3 size={22} />
        </span>
        <h2>Deploy a Docker image</h2>
        <p>
          A project groups your services. Start with a Docker image, then follow
          every step from pull to deployment.
        </p>
        <span className="guide-footer">
          <ShieldCheck size={14} />
          Hosted on your infrastructure
        </span>
      </section>
    </aside>
  );
}

function Summary({
  icon,
  label,
  value,
  detail,
  good,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  good?: boolean;
}) {
  return (
    <div className="summary-card">
      <div className="summary-label">
        <span>{label}</span>
        <span className="summary-icon">{icon}</span>
      </div>
      <div className={`summary-value ${good ? "summary-value-connected" : ""}`}>
        {good ? <span className="status-dot" /> : null}
        {value}
      </div>
      <div className="summary-detail">{detail}</div>
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="project-card surface"
    >
      <div className="project-card-top">
        <div className="project-glyph">
          <Folder size={23} strokeWidth={1.6} />
        </div>
        <ArrowUpRight size={18} className="project-arrow" />
      </div>
      <h3>{project.name}</h3>
      <p>{project.description || "A workspace for your applications."}</p>
      <div className="project-card-bottom">
        <span>
          <Box size={14} />
          {project.serviceCount}{" "}
          {project.serviceCount === 1 ? "service" : "services"}
        </span>
        <span>Created {relative(project.createdAt)}</span>
      </div>
    </Link>
  );
}

function ProjectPage() {
  const { projectId } = useParams({ strict: false });
  const navigate = useNavigate();
  const projects = useProjects();
  const project = projects.data?.find((item) => item.id === projectId);
  const actions = useActions(projectId);
  const [create, setCreate] = useState(false);
  const services = useQuery({
    queryKey: ["services", projectId],
    queryFn: () => api<Service[]>(`/projects/${projectId}/services`),
    enabled: !!projectId,
    refetchInterval: 2_000,
  });
  return (
    <>
      <Link to="/" className="back-link">
        <ArrowDownLeft size={15} />
        All projects
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PROJECT</div>
          <h1 className="project-title">
            <Folder size={29} />
            {project?.name ?? "Project"}
          </h1>
          <p>
            {project?.description ||
              "One place for your applications and deployment history."}
          </p>
        </div>
        <div className="heading-actions">
          {project ? (
            <ProjectSettings
              project={project}
              onDeleted={() => void navigate({ to: "/" })}
            />
          ) : null}
          <button
            className="button button-primary"
            onClick={() => setCreate(true)}
          >
            <Plus size={17} />
            New service
          </button>
        </div>
      </div>
      <div className="project-meta">
        <span>
          <Box size={15} />
          {services.data?.length ?? 0} services
        </span>
        <span>
          <ShieldCheck size={15} />
          Private project network
        </span>
        {project ? (
          <span>
            <Clock3 size={15} />
            Created {formatDate(project.createdAt)}
          </span>
        ) : null}
      </div>
      <div className="section-heading">
        <div>
          <h2>Services</h2>
          <p>Your application workloads and their current state.</p>
        </div>
      </div>
      <ErrorNotice error={services.error} />
      {services.isPending ? (
        <div className="surface loading-surface">
          <Spinner label="Loading services" />
        </div>
      ) : services.data?.length ? (
        <div className="services-table surface">
          <div className="service-table-head">
            <span>Service</span>
            <span>Source</span>
            <span>Status</span>
            <span>Configuration</span>
            <span />
          </div>
          {services.data.map((service) => (
            <Link
              to="/services/$serviceId"
              params={{ serviceId: service.id }}
              key={service.id}
              className="service-row"
            >
              <div className="service-name">
                <span className="service-glyph">
                  <Box size={19} />
                </span>
                <span>
                  <strong>{service.name}</strong>
                  <small>{service.hostname}</small>
                </span>
              </div>
              <span
                className="mono truncate"
                title={
                  service.source?.type === "git"
                    ? `${service.source.repository} · ${service.source.branch}`
                    : service.image
                }
              >
                {service.source?.type === "git"
                  ? `Git · ${service.source.branch}`
                  : service.image}
              </span>
              <Badge status={service.state} />
              <span
                className={`revision-indicator ${service.revision !== service.deployedRevision ? "has-changes" : ""}`}
              >
                {service.revision === service.deployedRevision ? (
                  <>
                    <Check size={14} />
                    Up to date
                  </>
                ) : (
                  <>
                    <Circle size={9} />
                    Pending deployment
                  </>
                )}
              </span>
              <ChevronRight size={16} />
            </Link>
          ))}
        </div>
      ) : (
        <div className="surface empty-services">
          <div className="empty-service-icon">
            <Box size={34} strokeWidth={1.4} />
          </div>
          <h2>No services yet</h2>
          <p>
            Start with a Docker image. Configure a hostname,
            <br />
            deploy it, and watch the operation here.
          </p>
          <button
            className="button button-primary"
            onClick={() => setCreate(true)}
          >
            <Plus size={16} />
            Create service
          </button>
        </div>
      )}
      <div className="section-heading activity-heading">
        <div>
          <h2>Project activity</h2>
          <p>Deployment progress and recent operations.</p>
        </div>
      </div>
      <ActionsTable actions={actions.data ?? []} loading={actions.isPending} />
      {create && projectId ? (
        <CreateService projectId={projectId} onClose={() => setCreate(false)} />
      ) : null}
    </>
  );
}

function ActionsTable({
  actions,
  loading,
  onSelect,
}: {
  actions: Action[];
  loading?: boolean;
  onSelect?: (action: Action) => void;
}) {
  if (loading)
    return (
      <div className="surface loading-surface">
        <Spinner label="Loading activity" />
      </div>
    );
  if (!actions.length)
    return (
      <div className="surface empty-activity">
        <span className="activity-empty-icon">
          <Activity size={22} />
        </span>
        <div>
          <strong>No operations yet</strong>
          <p>Deployments and service actions will appear here.</p>
        </div>
      </div>
    );
  return (
    <div className="surface action-table">
      <div className="action-table-head">
        <span>Operation</span>
        <span>Status</span>
        <span>Phase</span>
        <span>Started</span>
      </div>
      {actions.map((action) => (
        <button
          key={action.id}
          className="action-row"
          onClick={() =>
            onSelect
              ? onSelect(action)
              : void router.navigate({
                  to: "/services/$serviceId",
                  params: { serviceId: action.serviceId },
                })
          }
        >
          <div className="action-name">
            <span
              className={`action-glyph ${pendingAction(action) ? "in-progress" : ""}`}
            >
              {pendingAction(action) ? (
                <LoaderCircle size={17} className="spin" />
              ) : action.status === "succeeded" ? (
                <Check size={17} />
              ) : action.status === "failed" ? (
                <CircleAlert size={17} />
              ) : (
                <Terminal size={17} />
              )}
            </span>
            <span>
              <strong>
                {action.type[0]?.toUpperCase()}
                {action.type.slice(1)} service
              </strong>
              <small className="mono">{shortId(action.id)}</small>
            </span>
          </div>
          <Badge status={action.status} />
          <span className="action-phase">
            {action.phase.replaceAll("_", " ")}
          </span>
          <span className="action-time">
            {relative(action.createdAt)}
            <ChevronRight size={15} />
          </span>
        </button>
      ))}
    </div>
  );
}

function ServicePage() {
  const { serviceId } = useParams({ strict: false });
  const client = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const runtime = useRuntime();
  const [tab, setTab] = useState<ServiceTab>("overview");
  const [selectedAction, setSelectedAction] = useState<string | null>(null);
  const [destroying, setDestroying] = useState(false);
  const serviceQuery = useQuery({
    queryKey: ["service", serviceId],
    queryFn: () => api<Service>(`/services/${serviceId}`),
    enabled: !!serviceId,
    refetchInterval: destroying ? false : 2_000,
  });
  const actionsQuery = useQuery({
    queryKey: ["service-actions", serviceId],
    queryFn: () => api<Action[]>(`/services/${serviceId}/actions`),
    enabled: !!serviceId,
    refetchInterval: 1_500,
  });
  const execute = useMutation({
    mutationFn: (operation: "deploy" | "start" | "stop" | "restart") =>
      api<Action>(`/services/${serviceId}/${operation}`, {
        method: "POST",
        body: {},
        idempotent: true,
      }),
    onSuccess: (action) => {
      setSelectedAction(action.id);
      setTab("deployments");
      void client.invalidateQueries({
        queryKey: ["service-actions", serviceId],
      });
      void client.invalidateQueries({ queryKey: ["service", serviceId] });
      void client.invalidateQueries({ queryKey: ["actions"] });
    },
  });
  if (serviceQuery.isPending)
    return (
      <div className="surface loading-surface">
        <Spinner label="Loading service" />
      </div>
    );
  if (!serviceQuery.data)
    return (
      <ErrorNotice
        error={serviceQuery.error ?? new Error("Service not found.")}
      />
    );
  const service = serviceQuery.data;
  const database = !!service.kind && service.kind !== "app";
  const busy = !!(
    destroying ||
    execute.isPending ||
    actionsQuery.data?.some(pendingAction)
  );
  const changed = service.revision !== service.deployedRevision;
  const latest = actionsQuery.data?.[0];
  const actionId = selectedAction ?? latest?.id;
  const domains = service.domains ?? [
    { hostname: service.hostname, port: service.port, primary: true },
  ];
  const primaryDomain = domains.find((domain) => domain.primary) ?? domains[0];
  const appUrl = primaryDomain
    ? `http://${primaryDomain.hostname}:${runtime.data?.ingressPort ?? 18080}`
    : null;
  const sourceLabel =
    service.source?.type === "git"
      ? `${service.source.repository} · ${service.source.branch}`
      : service.image;
  return (
    <>
      <Link
        to="/projects/$projectId"
        params={{ projectId: service.projectId }}
        className="back-link"
      >
        <ArrowDownLeft size={15} />
        Back to project
      </Link>
      <div className="page-heading service-heading">
        <div>
          <div className="eyebrow">
            {database
              ? `${service.kind?.toUpperCase()} SERVICE`
              : "APPLICATION SERVICE"}
          </div>
          <h1>
            <span className="service-title-icon">
              <Box size={27} />
            </span>
            {service.name}
            <Badge status={service.state} />
          </h1>
          <p className="mono service-image">{sourceLabel}</p>
        </div>
        <div className="heading-actions">
          {!database && appUrl ? (
            <a
              href={appUrl}
              target="_blank"
              rel="noreferrer"
              className="button"
            >
              <ExternalLink size={15} />
              Open app
            </a>
          ) : null}
          <button
            className="button button-primary"
            onClick={() => execute.mutate("deploy")}
            disabled={busy}
          >
            {busy ? (
              <Spinner label="In progress" />
            ) : (
              <>
                <Play size={15} />
                Deploy
              </>
            )}
          </button>
        </div>
      </div>
      <div
        className="service-tabs feature-tabs"
        role="tablist"
        aria-label="Service sections"
      >
        {serviceTabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "selected" : ""}
            onClick={() => setTab(item.id)}
          >
            <span>{item.label}</span>
            {item.id === "deployments" && actionsQuery.data?.length ? (
              <span className="tab-count">{actionsQuery.data.length}</span>
            ) : null}
          </button>
        ))}
      </div>
      <ErrorNotice error={execute.error} />
      {service.lastError ? (
        <div className="error-notice">
          <CircleAlert size={17} />
          <span>{service.lastError}</span>
        </div>
      ) : null}
      {changed ? (
        <div className="change-notice">
          <GitBranch size={17} />
          <div>
            <strong>
              {service.deployedRevision === null
                ? "Waiting for the first deployment"
                : "Configuration changes are ready"}
            </strong>
            <span>
              Saved revision {service.revision}
              {service.deployedRevision !== null
                ? ` · Running revision ${service.deployedRevision}`
                : ""}
              . Deploy to apply the saved settings.
            </span>
          </div>
        </div>
      ) : null}
      {tab === "deployments" ? (
        <div className="operations-grid">
          <div>
            <div className="section-heading">
              <h2>Deployments and operations</h2>
            </div>
            <ActionsTable
              actions={actionsQuery.data ?? []}
              loading={actionsQuery.isPending}
              onSelect={(action) => setSelectedAction(action.id)}
            />
          </div>
          <ActionLog actionId={actionId} />
        </div>
      ) : tab !== "overview" ? (
        <ServiceConfigurationPanel
          key={`${service.id}-${tab}`}
          service={service}
          tab={tab}
          admin={user.role === "admin"}
        />
      ) : (
        <>
          <ServiceMetricsPanel service={service} />
          <div className="service-overview-grid">
            {database ? (
              <DatabaseConnection service={service} />
            ) : (
              <section className="surface details-card">
                <div className="card-heading">
                  <Globe2 size={18} />
                  <h2>Networking</h2>
                </div>
                <div className="detail-row">
                  <span>Primary hostname</span>
                  {appUrl && primaryDomain ? (
                    <a
                      className="mono"
                      href={appUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {primaryDomain.hostname}
                      <ArrowUpRight size={13} />
                    </a>
                  ) : (
                    <strong>Private service</strong>
                  )}
                </div>
                <div className="detail-row">
                  <span>Configured domains</span>
                  <strong>{domains.length}</strong>
                </div>
                <div className="detail-row">
                  <span>Container port</span>
                  <strong className="mono">{service.port}</strong>
                </div>
                <div className="detail-row">
                  <span>Ingress</span>
                  <strong>
                    HTTP{" "}
                    <span className="muted mono">
                      :{runtime.data?.ingressPort ?? 18080}
                    </span>
                  </strong>
                </div>
              </section>
            )}
            <section className="surface details-card">
              <div className="card-heading">
                <Layers3 size={18} />
                <h2>Deployment</h2>
              </div>
              <div className="detail-row">
                <span>Type</span>
                <strong>{service.kind ?? "app"}</strong>
              </div>
              <div className="detail-row">
                <span>Replicas</span>
                <strong>{service.replicas}</strong>
              </div>
              <div className="detail-row">
                <span>Saved revision</span>
                <strong className="mono">{service.revision}</strong>
              </div>
              <div className="detail-row">
                <span>Deployed revision</span>
                <strong className="mono">
                  {service.deployedRevision ?? "Not deployed"}
                </strong>
              </div>
              {service.sourceCommit ? (
                <div className="detail-row">
                  <span>Built commit</span>
                  <strong className="mono" title={service.sourceCommit}>
                    {service.sourceCommit.slice(0, 12)}
                  </strong>
                </div>
              ) : null}
              {service.imageDigest ? (
                <div className="detail-row">
                  <span>Image digest</span>
                  <strong
                    className="mono digest-value"
                    title={service.imageDigest}
                  >
                    {service.imageDigest}
                  </strong>
                </div>
              ) : null}
            </section>
          </div>
          <div className="section-heading activity-heading">
            <div>
              <h2>Latest operation</h2>
              <p>Worker progress and deployment output.</p>
            </div>
            <div className="lifecycle-actions">
              <button
                className="button button-small"
                onClick={() => execute.mutate("restart")}
                disabled={busy || service.deployedRevision === null}
              >
                <RefreshCw size={14} />
                Restart
              </button>
              <button
                className="button button-small"
                onClick={() =>
                  execute.mutate(service.state === "stopped" ? "start" : "stop")
                }
                disabled={busy}
              >
                {service.state === "stopped" ? (
                  <Play size={14} />
                ) : (
                  <Square size={13} />
                )}
                {service.state === "stopped" ? "Start" : "Stop"}
              </button>
            </div>
          </div>
          <ActionLog actionId={latest?.id} />
          <DestroyService
            service={service}
            busy={busy}
            onStarted={() => setDestroying(true)}
            onFailure={() => setDestroying(false)}
            onDestroyed={() => {
              void client.invalidateQueries({ queryKey: ["projects"] });
              void client.invalidateQueries({
                queryKey: ["services", service.projectId],
              });
              void navigate({
                to: "/projects/$projectId",
                params: { projectId: service.projectId },
              });
            }}
          />
        </>
      )}
    </>
  );
}

function ActionLog({ actionId }: { actionId?: string }) {
  const detail = useQuery({
    queryKey: ["action", actionId],
    queryFn: () => api<ActionDetail>(`/actions/${actionId}`),
    enabled: !!actionId,
    refetchInterval: (query) =>
      query.state.data && !pendingAction(query.state.data.action)
        ? false
        : 1_000,
  });
  return (
    <section className="log-card">
      <div className="log-heading">
        <span>
          <Terminal size={16} />
          {detail.data
            ? `${detail.data.action.type[0]?.toUpperCase()}${detail.data.action.type.slice(1)} output`
            : "Operation output"}
        </span>
        <span>
          {detail.data ? (
            <Badge status={detail.data.action.status} />
          ) : (
            <span className="log-id">Waiting for an operation</span>
          )}
        </span>
      </div>
      <div
        className="log-body"
        role="log"
        aria-label="Operation output"
        aria-live="polite"
      >
        {!actionId ? (
          <p className="log-placeholder">Deployment output will appear here.</p>
        ) : detail.isPending ? (
          <Spinner label="Connecting to operation" />
        ) : detail.error ? (
          <ErrorNotice error={detail.error} />
        ) : (
          <>
            {detail.data?.events.map((event) => (
              <div key={event.id} className={`log-line log-${event.level}`}>
                <time>
                  {new Date(event.createdAt).toLocaleTimeString("en", {
                    hour12: false,
                  })}
                </time>
                <span>{event.message}</span>
              </div>
            ))}
            {detail.data && !detail.data.events.length ? (
              <p className="log-placeholder">
                Waiting for the worker to pick up this operation...
              </p>
            ) : null}
            {detail.data?.action.error ? (
              <div className="log-line log-error">
                <span>{detail.data.action.error}</span>
              </div>
            ) : null}
            {detail.data && pendingAction(detail.data.action) ? (
              <span className="log-cursor" />
            ) : null}
          </>
        )}
      </div>
      <div className="log-footer">
        <span>Persisted operation history</span>
        {actionId ? <span className="mono">{shortId(actionId)}</span> : null}
      </div>
    </section>
  );
}

function ActivityPage() {
  const actions = useActions();
  const [selected, setSelected] = useState<string | undefined>();
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">OPERATION HISTORY</div>
          <h1>Activity</h1>
          <p>
            Deployment progress, service changes, and the details behind them.
          </p>
        </div>
        <span className="subtle-count">
          {actions.data?.length ?? 0} operations
        </span>
      </div>
      <ErrorNotice error={actions.error} />
      <ActionsTable
        actions={actions.data ?? []}
        loading={actions.isPending}
        onSelect={(action) => setSelected(action.id)}
      />
      {selected ? (
        <div className="activity-log">
          <ActionLog actionId={selected} />
        </div>
      ) : null}
    </>
  );
}

function SettingsPage() {
  const runtime = useRuntime();
  const { user } = useAuth();
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">SELF-HOSTED INSTALLATION</div>
          <h1>Your instance</h1>
          <p>The connection between your workspace and its Docker engine.</p>
        </div>
        <Badge status={runtime.data?.online ? "running" : "unknown"} />
      </div>
      <ErrorNotice error={runtime.error} />
      <div className="instance-grid">
        <section className="surface details-card">
          <div className="card-heading">
            <Server size={19} />
            <h2>Docker runtime</h2>
          </div>
          <div className="detail-row">
            <span>Connection</span>
            <strong>
              {runtime.isPending
                ? "Checking"
                : runtime.data?.online
                  ? "Connected"
                  : "Offline"}
            </strong>
          </div>
          <div className="detail-row">
            <span>Engine version</span>
            <strong className="mono">
              {runtime.data?.engineVersion ?? "Unavailable"}
            </strong>
          </div>
          <div className="detail-row">
            <span>CPUs</span>
            <strong>{runtime.data?.cpus ?? "Unavailable"}</strong>
          </div>
          <div className="detail-row">
            <span>Memory capacity</span>
            <strong>
              {runtime.data?.memoryBytes
                ? `${(runtime.data.memoryBytes / 1024 ** 3).toFixed(1)} GiB`
                : "Unavailable"}
            </strong>
          </div>
          <div className="detail-row">
            <span>Swarm state</span>
            <strong>{runtime.data?.swarmState ?? "Unavailable"}</strong>
          </div>
          <div className="detail-row">
            <span>HTTP ingress port</span>
            <strong className="mono">
              {runtime.data?.ingressPort ?? 18080}
            </strong>
          </div>
          {runtime.data?.error ? (
            <div className="error-notice">
              <CircleAlert size={16} />
              {runtime.data.error}
            </div>
          ) : null}
        </section>
        <section className="surface details-card">
          <div className="card-heading">
            <ShieldCheck size={19} />
            <h2>Workspace access</h2>
          </div>
          <div className="detail-row">
            <span>Signed in as</span>
            <strong>{user.email}</strong>
          </div>
          <div className="detail-row">
            <span>Role</span>
            <strong className="capitalize">{user.role}</strong>
          </div>
          <div className="instance-note">
            <ShieldCheck size={25} />
            <h3>Local installation</h3>
            <p>
              This workspace runs on your own infrastructure. The browser talks
              to your local panel API.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <div className="surface empty-services">
      <h1>Page not found</h1>
      <p>This workspace page does not exist.</p>
      <Link to="/" className="button">
        Back to overview
      </Link>
    </div>
  ),
});
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectPage,
});
const serviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/services/$serviceId",
  component: ServicePage,
});
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  component: ActivityPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    dashboardRoute,
    projectRoute,
    serviceRoute,
    activityRoute,
    settingsRoute,
  ]),
  defaultPreload: "intent",
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  </React.StrictMode>,
);
