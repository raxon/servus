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
  ChevronRight,
  ChevronDown,
  Circle,
  CircleAlert,
  Clock3,
  Database,
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
  Zap,
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
import { AccountLinkSettings, CentralAccessSettings, CentralSignIn } from "./CentralAccess.js";
import { LocalPasswordSettings } from "./LocalPassword.js";
import { GithubSettings } from "./GithubSettings.js";
import { UpdateSettings, useUpdateDiscovery } from "./UpdateSettings.js";
import { ProjectAccess } from "./ProjectAccess.js";
import { PanelNotifications, notifyProjectCreated } from "./notifications.js";
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

const createQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 2_000, refetchOnWindowFocus: true },
  },
});
const queryClient = createQueryClient();
const AuthContext = createContext<SessionResponse | null>(null);
const SessionClientContext = createContext<QueryClient | null>(null);
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
  const sessionClient = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async ({ signal }) => {
      try {
        const data = await api<SessionResponse>("/auth/session", { signal });
        signal.throwIfAborted();
        setCsrfToken(data.csrfToken);
        return data;
      } catch (error) {
        if (error instanceof RequestError && error.status === 401) {
          signal.throwIfAborted();
          setCsrfToken("");
          return null;
        }
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
  return <AuthenticatedApp key={session.data.csrfToken} auth={session.data} sessionClient={sessionClient} />;
}

function AuthenticatedApp({ auth, sessionClient }: { auth: SessionResponse; sessionClient: QueryClient }) {
  const [client] = useState(createQueryClient);
  return <SessionClientContext.Provider value={sessionClient}>
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>
    </AuthContext.Provider>
  </SessionClientContext.Provider>;
}

function AuthForm({ setup }: { setup: boolean }) {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api<SessionResponse>(setup ? "/setup" : "/auth/login", {
        method: "POST",
        body: { email, password },
      }),
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: ["session"], exact: true });
      setCsrfToken(data.csrfToken);
      client.setQueryData(["session"], data);
    },
  });
  return (
    <main className="setup-screen">
      <header className="setup-topbar"><Brand /></header>
      <div className="setup-shell">
        <div className="setup-intro">
          <div className="setup-intro-copy">
            <p className="setup-kicker">YOUR SERVER, YOUR SPACE</p>
            <h1>{setup ? "Welcome to" : "Welcome back to"}<br /><em>your server.</em></h1>
            <p className="setup-intro-description">{setup ? "A home for the applications you run. Set up your administrator account to get started." : "Sign in to manage your applications and check their status."}</p>
          </div>
          <div className="setup-diagram" aria-hidden="true">
            <div className="setup-diagram-grid" />
            <div className="setup-diagram-line" />
            <div className="setup-diagram-orbit">
              <div className="setup-diagram-node"><Server size={27} strokeWidth={1.4} /></div>
            </div>
            <div className="setup-diagram-caption"><span />YOUR LOCAL SERVER</div>
          </div>
        </div>
        <section className="setup-form-side" aria-labelledby="setup-form-heading">
          <div className="setup-form-inner">
            <h2 id="setup-form-heading">{setup ? <>Create your<br />administrator account</> : "Sign in to your account"}</h2>
            <form className="setup-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
              <label htmlFor="setup-email">Email address</label>
              <input id="setup-email" name="email" type="email" autoComplete="username" placeholder="you@example.com" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} required />
              <label htmlFor="setup-password">Password</label>
              <input id="setup-password" name="password" type="password" autoComplete={setup ? "new-password" : "current-password"} placeholder={setup ? "At least 8 characters" : "Enter your password"} minLength={setup ? 8 : undefined} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required aria-describedby={setup ? "setup-password-hint" : undefined} />
              {setup ? <p id="setup-password-hint" className="setup-password-hint">Use at least 8 characters.</p> : null}
              <ErrorNotice error={mutation.error} />
              <button className="setup-submit" type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? <Spinner label={setup ? "Creating administrator" : "Signing in"} /> : <>{setup ? "Create administrator" : "Sign in"} <ArrowRight size={18} aria-hidden="true" /></>}
              </button>
            </form>
            {!setup ? <CentralSignIn /> : null}
            <p className="setup-security-note"><ShieldCheck size={16} aria-hidden="true" /> {setup ? "This account is local to your installation." : "Local sign-in uses an account on this installation."}</p>
          </div>
        </section>
      </div>
    </main>
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

const ProjectSearchContext = createContext("");

function Shell() {
  const { user } = useAuth();
  const client = useQueryClient();
  const sessionClient = useContext(SessionClientContext)!;
  const path = useRouterState({ select: (state) => state.location.pathname });
  const projects = useProjects();
  const { discovery: updateDiscovery } = useUpdateDiscovery(user.role === "admin");
  const availableUpdate = !updateDiscovery.isError && updateDiscovery.data?.discovery.status === "candidate" ? updateDiscovery.data.discovery : undefined;
  const serviceId = path.startsWith("/services/") ? path.split("/")[2] : undefined;
  const routeProjectId = path.startsWith("/projects/") ? path.split("/")[2] : undefined;
  const currentService = useQuery({
    queryKey: ["service", serviceId],
    queryFn: () => api<Service>(`/services/${serviceId}`),
    enabled: !!serviceId,
  });
  const projectId = currentService.data?.projectId ?? routeProjectId;
  const currentProject = projects.data?.find((project) => project.id === projectId);
  const [projectSearch, setProjectSearch] = useState("");
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Tab") setKeyboardNavigation(true); };
    const onPointerDown = () => setKeyboardNavigation(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("pointerdown", onPointerDown); };
  }, []);
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST", body: {} }),
    onSuccess: async () => {
      await sessionClient.cancelQueries({ queryKey: ["session"], exact: true });
      setCsrfToken("");
      client.clear();
      sessionClient.setQueryData(["session"], null);
    },
  });
  const locationName = path.startsWith("/services/")
    ? "Service"
    : path.startsWith("/projects/")
      ? "Project"
      : path === "/activity"
        ? "Activity"
        : path === "/settings"
          ? "Settings"
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
            Settings
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
          {availableUpdate ? <Link to="/settings" hash="updates" className="sidebar-update" aria-label={`Update available: ${availableUpdate.tag}`}>
            <RefreshCw size={16} aria-hidden="true" />
            <span><strong>Update available</strong><small>{availableUpdate.tag}</small></span>
            <ChevronRight size={15} aria-hidden="true" />
          </Link> : null}
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
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <Link to="/">Workspace</Link>
            <ChevronRight size={14} aria-hidden="true" />
            {serviceId ? <>
              {projectId ? <><Link to="/projects/$projectId" params={{ projectId }}>{currentProject?.name ?? "Project"}</Link><ChevronRight size={14} aria-hidden="true" /></> : null}
              <strong aria-current="page">{currentService.data?.name ?? "Service"}</strong>
            </> : <strong aria-current="page">{routeProjectId ? currentProject?.name ?? "Project" : locationName}</strong>}
          </nav>
          <div className="topbar-right">
            {path === "/" ? <div className={`search-field topbar-search ${keyboardNavigation ? "keyboard-navigation" : ""}`}>
              <Search size={16} />
              <input aria-label="Search projects" placeholder="Search projects..." value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} />
            </div> : null}
          </div>
        </header>
        <main id="main-content" className="content">
          <ProjectSearchContext.Provider value={projectSearch}><Outlet /></ProjectSearchContext.Provider>
        </main>
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
      notifyProjectCreated();
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
  const { user } = useAuth();
  const projects = useProjects();
  const [showCreate, setShowCreate] = useState(false);
  const search = useContext(ProjectSearchContext);
  const [sort, setSort] = useState<"name" | "time">("name");
  const visible = (projects.data ?? [])
    .filter((project) =>
      `${project.name} ${project.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) => sort === "name"
      ? a.name.localeCompare(b.name)
      : b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <div className="dashboard-project-region">
          <div className="section-heading">
            <div>
              <h2>
                Projects{" "}
                <span className="count-pill">{projects.isPending ? "..." : projects.error ? "--" : projects.data?.length ?? 0}</span>
              </h2>
              <p>Manage related services within a project.</p>
            </div>
            <div className="dashboard-project-controls">
              <details className="dashboard-sort" onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
              }} onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                }
              }}>
                <summary aria-label={`Sort projects: ${sort === "name" ? "Name" : "Newest"}`}>
                  <span>{sort === "name" ? "Name" : "Newest"}</span><ChevronDown size={16} aria-hidden="true" />
                </summary>
                <div className="dashboard-sort-menu" role="group" aria-label="Sort projects">
                  {([ ["name", "Name"], ["time", "Newest"] ] as const).map(([value, label]) =>
                    <button key={value} type="button" aria-pressed={sort === value} onClick={(event) => {
                      setSort(value);
                      const details = event.currentTarget.closest("details");
                      if (details) { details.open = false; details.querySelector("summary")?.focus(); }
                    }}>{label}{sort === value ? <Check size={15} aria-hidden="true" /> : null}</button>
                  )}
                </div>
              </details>
              {user.role === "admin" ? <button className="button button-primary" onClick={() => setShowCreate(true)}>
                <Plus size={17} /> New project
              </button> : null}
            </div>
          </div>
          <ErrorNotice error={projects.error} />
          {projects.isPending ? (
            <div className="surface loading-surface">
              <Spinner label="Loading projects" />
            </div>
          ) : projects.error ? null : projects.data?.length ? (
            <div className="dashboard-project-list">
              {visible.map((project) => (
                <DashboardProject key={project.id} project={project} />
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
              <p>{user.role === "admin" ? "Create a project to group your applications, then add a service to deploy." : "Ask an administrator to give you access to a project."}</p>
              {user.role === "admin" ? <button
                className="button button-primary"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={16} />
                Create your first project
              </button> : null}
            </div>
          )}
      </div>
      {showCreate ? <CreateProject onClose={() => setShowCreate(false)} /> : null}
    </>
  );
}

function DashboardProject({ project }: { project: Project }) {
  const services = useQuery({
    queryKey: ["services", project.id],
    queryFn: () => api<Service[]>(`/projects/${project.id}/services`),
    refetchInterval: 5_000,
  });
  return (
    <section className="dashboard-project-group">
      <div className="dashboard-project-heading">
        <Link to="/projects/$projectId" params={{ projectId: project.id }}>
          <Folder size={18} />
          <h3>{project.name}</h3>
          <ChevronRight size={16} />
        </Link>
        <span>{project.serviceCount} {project.serviceCount === 1 ? "service" : "services"}</span>
      </div>
      {services.isPending ? <div className="dashboard-services-message"><Spinner label="Loading services" /></div>
        : services.error ? <div className="dashboard-services-message"><ErrorNotice error={services.error} /><button className="text-link" onClick={() => void services.refetch()}>Try again</button></div>
        : services.data?.length ? <div className="dashboard-services-grid">
          {services.data.map((service) => <Link key={service.id} to="/services/$serviceId" params={{ serviceId: service.id }} className="dashboard-service-card">
            <span className="dashboard-service-identity">
              <span className={`dashboard-service-icon dashboard-service-icon-${service.kind ?? "app"}`} aria-hidden="true">
                {service.kind === "redis" ? <Zap size={19} /> : service.kind === "postgres" || service.kind === "mariadb" ? <Database size={19} /> : <Box size={19} />}
              </span>
              <span className="dashboard-service-name"><strong>{service.name}</strong><small>{service.kind ?? "app"}</small></span>
            </span>
            <Badge status={service.state} />
          </Link>)}
        </div> : <p className="dashboard-services-message">No services yet. Open the project to add one.</p>}
    </section>
  );
}

function ProjectPage() {
  const { user } = useAuth();
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
          {services.isPending ? "Loading services" : services.error ? "Services unavailable" : `${services.data?.length ?? 0} services`}
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
      ) : services.error ? null : services.data?.length ? (
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
      <ErrorNotice error={actions.error} />
      {!actions.error ? <ActionsTable actions={actions.data ?? []} loading={actions.isPending} /> : null}
      {create && projectId ? (
        <CreateService projectId={projectId} admin={user.role === "admin"} onClose={() => setCreate(false)} />
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
              <DatabaseConnection service={service} admin={user.role === "admin"} />
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
      {user.role === "admin" ? <UpdateSettings /> : null}
      {user.role === "admin" ? <GithubSettings /> : null}
      <LocalPasswordSettings />
      {user.role === "admin" ? <CentralAccessSettings /> : null}
      <AccountLinkSettings />
      {user.role === "admin" ? <ProjectAccess /> : null}
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
      <PanelNotifications />
    </QueryClientProvider>
  </React.StrictMode>,
);
