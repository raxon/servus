import { Skeleton } from "./Skeleton.js";
import { deploymentFailure, deploymentProgress } from "./deployment-progress.js";
import { applicationUrl } from "./application-url.js";
import { DashboardOverview } from "./DashboardOverview.js";
import React, {
  createContext,
  useContext,
  useEffect,
  useId,
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
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  Code2,
  Cpu,
  Database,
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  Globe2,
  HardDrive,
  Home,
  KeyRound,
  Layers3,
  LayoutGrid,
  LoaderCircle,
  Menu,
  LogOut,
  Palette,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings,
  Settings2,
  ShieldCheck,
  Sparkles,
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
  ServiceMetrics,
  DomainConfig,
  SessionResponse,
} from "../shared/types.js";
import { api, errorMessage, RequestError, setCsrfToken } from "./api.js";
import { CreateService } from "./ServiceCreate.js";
import { FeatureModal } from "./feature-ui.js";
import { LocalPasswordSettings } from "./LocalPassword.js";
import { ApiTokenSettings } from "./ApiTokenSettings.js";
import { TwoFactorSettings } from "./TwoFactorSettings.js";
import { ComposeProjects } from "./ComposeProjects.js";
import { DeployWebhookSettings } from "./DeployWebhookSettings.js";
import { TemplateProjects } from "./TemplateProjects.js";
import { GithubSettings } from "./GithubSettings.js";
import { HttpsSettings } from "./HttpsSettings.js";
import { HostDomainSettings } from "./HostDomainSettings.js";
import { UpdateSettings, useUpdateDiscovery } from "./UpdateSettings.js";
import { InstallationBackupSettings } from "./InstallationBackupSettings.js";
import { BackupStorageSettings } from "./BackupStorageSettings.js";
import { HostMetricsCard } from "./HostMetricsCard.js";
import { HostAdminPanel } from "./HostAdminPanel.js";
import { DatabaseAdminTools } from "./DatabaseAdminTools.js";
import { I18nProvider, LocaleSwitcher, useI18n } from "./i18n.js";
import { ThemeProvider, SidebarThemeToggle } from "./theme.js";
import { CommandPalette } from "./CommandPalette.js";
import { MonitorPage } from "./MonitorPage.js";
import { DomainsPage } from "./DomainsPage.js";
import { PlatformSettings } from "./PlatformSettings.js";
import { DedicatedModulesSection, ProjectMigrationSection } from "./ProjectTransferAndModules.js";
import { AlertsSettings } from "./AlertsSettings.js";
import { BuildConcurrencySettings } from "./BuildConcurrencySettings.js";
import { ProjectAccess } from "./ProjectAccess.js";
import { ProjectExtras } from "./ProjectExtras.js";
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
import "./Settings.css";
import "./ServiceOperations.css";
import "./workspace-polish.css";
import "./easypanel-theme.css";

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

function SetupIllustration() {
  return (
    <svg className="setup-stack" width="248" height="104" viewBox="0 0 248 104" fill="none" aria-hidden="true">
      <path d="M4 52h23l14-14h32m94 14h30l14 14h33" stroke="currentColor" strokeOpacity=".5" strokeDasharray="3 4" />
      <path d="M67 80 120 53 173 80 120 101Z" fill="#e9eae9" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="m73 66 47 23 47-23" strokeOpacity=".55" />
        <path d="m73 52 47 23 47-23" strokeOpacity=".75" />
        <path d="m73 38 47-23 47 23-47 23z" fill="#fafafa" />
        <path d="m102 38 18-9 18 9-18 9z" fill="#e9eae9" />
      </g>
      <circle cx="4" cy="52" r="2.5" fill="currentColor" />
      <circle cx="244" cy="66" r="2.5" fill="currentColor" />
      <circle className="setup-stack-signal setup-stack-signal-in" cx="4" cy="52" r="3.5" fill="currentColor" />
      <circle className="setup-stack-signal setup-stack-signal-out" cx="167" cy="52" r="3.5" fill="currentColor" />
    </svg>
  );
}

function AuthForm({ setup }: { setup: boolean }) {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const confirmation = useRef<HTMLInputElement>(null);
  const [totpCode, setTotpCode] = useState("");
  const passwordInputType = setup && showPasswords ? "text" : "password";
  const mutation = useMutation({
    mutationFn: () =>
      api<SessionResponse>(setup ? "/setup" : "/auth/login", {
        method: "POST",
        body: { email, password, ...(!setup&&totpCode?{totpCode}:{}) },
      }),
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: ["session"], exact: true });
      setCsrfToken(data.csrfToken);
      client.setQueryData(["session"], data);
    },
  });
  return (
    <main className={`setup-screen${setup ? " setup-first-run" : ""}`}>
      <header className="setup-topbar"><Brand /></header>
      <div className={setup ? "setup-layout" : "setup-shell"}>
        {setup ? (
          <div className="setup-heading">
            <SetupIllustration />
            <h1 id="setup-form-heading" className="setup-title">
              Create your <span>administrator account</span>
            </h1>
          </div>
        ) : (
          <div className="setup-intro">
            <div className="setup-intro-copy">
              <p className="setup-kicker">YOUR SERVER, YOUR SPACE</p>
              <h1>Welcome back to<br /><em>your server.</em></h1>
              <p className="setup-intro-description">Sign in to manage your applications and check their status.</p>
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
        )}
        <section className={setup ? "setup-form-side setup-form-card" : "setup-form-side"} aria-labelledby="setup-form-heading">
          <div className="setup-form-inner">
            {!setup && <h2 id="setup-form-heading">Sign in to your account</h2>}
            <form className="setup-form" onSubmit={(event) => {
              event.preventDefault();
              if (setup && confirmation.current?.value !== password) {
                setPasswordMismatch(true);
                confirmation.current?.focus();
                return;
              }
              mutation.mutate();
            }}>
              <label htmlFor="setup-email">Email address</label>
              <input id="setup-email" name="email" type="email" autoComplete="username" placeholder="you@example.com" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} required />
              {setup ? (
                <div className="setup-password-row">
                  <label htmlFor="setup-password">Password</label>
                  <button type="button" className="setup-password-toggle" aria-controls="setup-password setup-password-confirmation" onClick={() => setShowPasswords((visible) => !visible)}>
                    {showPasswords ? "Hide passwords" : "Show passwords"}
                  </button>
                </div>
              ) : <label htmlFor="setup-password">Password</label>}
              <input id="setup-password" name="password" type={passwordInputType} autoComplete={setup ? "new-password" : "current-password"} placeholder={setup ? undefined : "Enter your password"} minLength={setup ? 8 : undefined} maxLength={128} spellCheck={false} autoCapitalize="none" value={password} onChange={(event) => { setPassword(event.target.value); setPasswordMismatch(false); }} required aria-describedby={setup ? "setup-password-hint" : undefined} />
              {setup && <>
                <p id="setup-password-hint" className="setup-password-hint">Use at least 8 characters.</p>
                <label htmlFor="setup-password-confirmation">Confirm password</label>
                <input id="setup-password-confirmation" name="passwordConfirmation" ref={confirmation} type={passwordInputType} autoComplete="new-password" maxLength={128} spellCheck={false} autoCapitalize="none" required onChange={() => setPasswordMismatch(false)} aria-invalid={passwordMismatch} aria-describedby={passwordMismatch ? "setup-password-error" : undefined} />
                <p id="setup-password-error" className="setup-password-error" aria-live="polite">{passwordMismatch && "Passwords do not match."}</p>
              </>}
              {!setup&&(totpCode||mutation.error instanceof RequestError&&['TWO_FACTOR_REQUIRED','TWO_FACTOR_CODE_INVALID'].includes(mutation.error.code))?<><label htmlFor="signin-totp">Authenticator or recovery code</label><input id="signin-totp" name="totpCode" type="text" autoComplete="one-time-code" spellCheck={false} autoCapitalize="none" value={totpCode} maxLength={64} onChange={event=>setTotpCode(event.target.value)} required/></>:null}
              <ErrorNotice error={mutation.error} />
              <button className="setup-submit" type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? <Spinner label={setup ? "Creating administrator" : "Signing in"} /> : <>{setup ? "Create administrator" : "Sign in"} <ArrowRight size={18} aria-hidden="true" /></>}
              </button>
            </form>
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

function formatCompactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function serviceTabIcon(id: ServiceTab) {
  switch (id) {
    case "overview": return <LayoutGrid size={15} aria-hidden="true" />;
    case "source": return <Code2 size={15} aria-hidden="true" />;
    case "deployments": return <Rocket size={15} aria-hidden="true" />;
    case "environment": return <KeyRound size={15} aria-hidden="true" />;
    case "domains": return <Globe2 size={15} aria-hidden="true" />;
    case "storage": return <HardDrive size={15} aria-hidden="true" />;
    case "backups": return <Database size={15} aria-hidden="true" />;
    case "resources": return <Cpu size={15} aria-hidden="true" />;
    case "logs": return <FileText size={15} aria-hidden="true" />;
    case "console": return <Terminal size={15} aria-hidden="true" />;
  }
}

function Shell() {
  const { user } = useAuth();
  const { t } = useI18n();
  const client = useQueryClient();
  const sessionClient = useContext(SessionClientContext)!;
  const path = useRouterState({ select: (state) => state.location.pathname });
  const previousPath = useRef(path);
  const mainRef = useRef<HTMLElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const [mobileNavigation, setMobileNavigation] = useState(() => window.matchMedia("(max-width: 800px)").matches);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickCreateProject, setQuickCreateProject] = useState(false);
  const nativePopover = "popover" in HTMLElement.prototype;
  const isDualPane = path.startsWith("/projects/") || path.startsWith("/services/") || path === "/settings";

  useEffect(() => {
    const media = window.matchMedia("(max-width: 800px)");
    const update = () => setMobileNavigation(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);
  useEffect(() => {
    const navigation = navigationRef.current;
    if (nativePopover && navigation?.matches(":popover-open")) navigation.hidePopover();
    setNavigationOpen(false);
  }, [path, mobileNavigation, nativePopover]);
  useEffect(() => {
    if (nativePopover || !navigationOpen) return;
    navigationRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const outside = (event: PointerEvent) => {
      if (!navigationRef.current?.contains(event.target as Node) && !navigationTrigger.current?.contains(event.target as Node)) setNavigationOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setNavigationOpen(false); navigationTrigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [nativePopover, navigationOpen]);
  useEffect(() => {
    if (previousPath.current !== path) {
      previousPath.current = path;
      mainRef.current?.focus({ preventScroll: true });
    }
  }, [path]);
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
        : path === "/monitor"
          ? "Monitor"
          : path === "/domains"
            ? "Domains"
            : path === "/settings"
              ? "Settings"
              : "Overview";
  const compactRail = isDualPane && !mobileNavigation;
  return (
    <div className={`app-layout ${isDualPane ? "is-rail-mode" : ""}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside id="workspace-navigation" ref={navigationRef} className="sidebar" popover={mobileNavigation && nativePopover ? "auto" : undefined} data-navigation-open={navigationOpen} onToggle={event => setNavigationOpen(event.newState === "open")} onClick={event => {
        if (!(event.target as Element).closest("a")) return;
        if (nativePopover && navigationRef.current?.matches(":popover-open")) navigationRef.current.hidePopover();
        setNavigationOpen(false);
      }}>
        <div className="ep-brand-header">
          <Link to="/" className="brand-link" aria-label="Servus overview">
            {compactRail ? (
              <span className="brand-symbol" aria-hidden="true">
                <img src="/brand/servus.svg" width="22" height="22" alt="" />
              </span>
            ) : (
              <Brand />
            )}
          </Link>
          {!compactRail ? <span className="ep-version-chip">v0.7.1</span> : null}
        </div>
        <nav aria-label="Main navigation">
          <Link
            to="/"
            aria-current={path === "/" ? "page" : undefined}
            className={`nav-item ${path === "/" ? "active" : ""}`}
            title={t("nav.overview", "Overview")}
          >
            <Home size={17} aria-hidden="true" />
            <span className="ep-nav-text">Overview</span>
          </Link>
          <Link
            to="/activity"
            aria-current={path === "/activity" ? "page" : undefined}
            className={`nav-item ${path === "/activity" ? "active" : ""}`}
            title={t("nav.activity", "Activity")}
          >
            <Activity size={17} aria-hidden="true" />
            <span className="ep-nav-text">Activity</span>
          </Link>
          <Link
            to="/monitor"
            aria-current={path === "/monitor" ? "page" : undefined}
            className={`nav-item ${path === "/monitor" ? "active" : ""}`}
            title={t("nav.monitor", "Monitor")}
          >
            <BarChart3 size={17} aria-hidden="true" />
            <span className="ep-nav-text">Monitor</span>
          </Link>
          <Link
            to="/domains"
            aria-current={path === "/domains" ? "page" : undefined}
            className={`nav-item ${path === "/domains" ? "active" : ""}`}
            title={t("nav.domains", "Domains")}
          >
            <Globe2 size={17} aria-hidden="true" />
            <span className="ep-nav-text">Domains</span>
          </Link>
          <Link
            to="/settings"
            aria-current={path === "/settings" ? "page" : undefined}
            className={`nav-item ${path === "/settings" ? "active" : ""}`}
            title={t("nav.settings", "Settings")}
          >
            <Settings size={17} aria-hidden="true" />
            <span className="ep-nav-text">Settings</span>
          </Link>
        </nav>

        <div className="sidebar-bottom">
          {availableUpdate ? (
            <Link
              to="/settings"
              hash="updates"
              className="sidebar-update"
              aria-label={`Update available: ${availableUpdate.tag}`}
              title={`Update available: ${availableUpdate.tag}`}
            >
              <RefreshCw size={15} aria-hidden="true" />
              <span><strong>Update available</strong><small>{availableUpdate.tag}</small></span>
              <ChevronRight size={14} aria-hidden="true" />
            </Link>
          ) : null}

          {compactRail ? (
            <>
              <button
                type="button"
                className="ep-rail-btn"
                onClick={() => setPaletteOpen(true)}
                aria-label="Quick search"
                title="Quick search (⌘K)"
              >
                <Search size={17} aria-hidden="true" />
              </button>
              <SidebarThemeToggle compact />
              <button
                type="button"
                className="ep-rail-btn logout-button"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut size={17} aria-hidden="true" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ep-sidebar-utility-btn"
                onClick={() => setPaletteOpen(true)}
              >
                <span className="ep-sidebar-utility-label">
                  <Search size={15} aria-hidden="true" />
                  <span>Quick Search</span>
                </span>
                <kbd className="ep-kbd">⌘K</kbd>
              </button>
              <SidebarThemeToggle />
              <div className="ep-sidebar-lang-row">
                <span>Language</span>
                <LocaleSwitcher />
              </div>
              <div className="ep-sidebar-host-row" title={window.location.host}>
                <Server size={13} aria-hidden="true" />
                <strong className="mono">{window.location.hostname}</strong>
              </div>
              <div className="sidebar-user">
                <span className="user-avatar">{user.email[0]?.toUpperCase()}</span>
                <span>
                  <strong>{user.email.split("@")[0]}</strong>
                  <small>{user.role === "admin" ? "Administrator" : "Member"}</small>
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
            </>
          )}
        </div>
      </aside>
      <div className="app-main">
        <div className="ep-sheet-container">
          <header className={`topbar ${path === "/" ? "topbar-dashboard" : ""}`}>
            <nav className="breadcrumbs" aria-label="Breadcrumb">
              <Link to="/">Workspace</Link>
              <ChevronRight size={14} aria-hidden="true" />
              {serviceId ? <>
                {projectId ? <><Link to="/projects/$projectId" params={{ projectId }}>{currentProject?.name ?? "Project"}</Link><ChevronRight size={14} aria-hidden="true" /></> : null}
                <strong aria-current="page">{currentService.data?.name ?? "Service"}</strong>
              </> : <strong aria-current="page">{routeProjectId ? currentProject?.name ?? "Project" : locationName}</strong>}
            </nav>
            <button ref={navigationTrigger} type="button" className="button mobile-menu-button" aria-controls="workspace-navigation" aria-expanded={navigationOpen} popoverTarget={nativePopover ? "workspace-navigation" : undefined} onClick={nativePopover ? undefined : () => setNavigationOpen(!navigationOpen)}><Menu size={17} aria-hidden="true" />Menu</button>
            <div className="topbar-right">
              {path === "/" ? <div className={`search-field topbar-search ${keyboardNavigation ? "keyboard-navigation" : ""}`}>
                <Search size={16} aria-hidden="true" />
                <input aria-label="Search projects and services" placeholder="Search projects and services..." value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} />
                <button type="button" className="ep-search-pill-action" onClick={() => setPaletteOpen(true)} aria-label="Open quick search" title="Quick search (⌘K)">⌘K</button>
              </div> : null}
            </div>
          </header>
          <main id="main-content" className={`content ${path === "/" ? "content-dashboard" : ""} ${isDualPane ? "is-dual-pane" : ""}`} ref={mainRef} tabIndex={-1}>
            <ProjectSearchContext.Provider value={projectSearch}><Outlet /></ProjectSearchContext.Provider>
          </main>
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        projects={projects.data ?? []}
        canCreateProject={user.role === "admin"}
        onCreateProject={() => setQuickCreateProject(true)}
      />
      {quickCreateProject ? <CreateProject onClose={() => setQuickCreateProject(false)} /> : null}
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
  const mutation = useMutation({
    mutationFn: () =>
      api<Project>("/projects", {
        method: "POST",
        body: { name },
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
  const search = useContext(ProjectSearchContext);
  const [showCreate, setShowCreate] = useState(false);
  return <>
    <DashboardOverview projects={projects.data} loading={projects.isPending} error={projects.error}
      userId={user.id} canCreate={user.role === "admin"} search={search} onCreate={() => setShowCreate(true)} />
    {showCreate ? <CreateProject onClose={() => setShowCreate(false)} /> : null}
  </>;
}

type ProjectTab = "services" | "compose" | "templates" | "settings" | "environment" | "activity" | "migration";
const PROJECT_TABS: readonly ProjectTab[] = ["services", "compose", "templates", "settings", "environment", "activity", "migration"];

function ProjectContextSidebar({
  projects,
  currentProject,
  services,
  activeServiceId,
  canWrite,
  onAddService,
  children,
}: {
  projects: Project[];
  currentProject: Project | undefined;
  services: Service[];
  activeServiceId?: string;
  canWrite: boolean;
  onAddService?: () => void;
  children?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const safeProjects = Array.isArray(projects) ? projects : [];
  const safeServices = Array.isArray(services) ? services : [];
  return (
    <aside className="ep-context-sidebar" aria-label="Project navigation">
      <div className="ep-project-switcher">
        <Folder size={15} aria-hidden="true" />
        <select
          aria-label="Switch project"
          value={currentProject?.id ?? ""}
          onChange={(event) => {
            if (event.target.value) {
              void navigate({ to: "/projects/$projectId", params: { projectId: event.target.value } });
            }
          }}
        >
          {safeProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <ChevronsUpDown size={14} className="ep-project-switcher-chevron" aria-hidden="true" />
      </div>

      <div className="ep-context-section-head">
        <span>Services</span>
        {canWrite && onAddService ? (
          <button
            type="button"
            className="ep-context-add-btn"
            onClick={onAddService}
            aria-label="Create service in project"
            title="Create service"
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="ep-context-service-list">
        {safeServices.length ? (
          safeServices.map((svc) => (
            <Link
              key={svc.id}
              to="/services/$serviceId"
              params={{ serviceId: svc.id }}
              className={`ep-context-service-item ${activeServiceId === svc.id ? "is-active" : ""}`}
            >
              <span className={`ep-dot status-dot-${svc.state}`} aria-hidden="true" />
              <span className="truncate">{svc.name}</span>
            </Link>
          ))
        ) : (
          <p className="sidebar-hint" style={{ paddingInline: 8, margin: "4px 0" }}>No services yet</p>
        )}
      </div>

      {children ? (
        <>
          <hr className="ep-context-divider" />
          {children}
        </>
      ) : null}
    </aside>
  );
}

function ProjectPage() {
  const { user } = useAuth();
  const { projectId } = useParams({ strict: false });
  const { tab: requestedTab } = projectRoute.useSearch();
  const navigate = useNavigate();
  const projects = useProjects();
  const project = projects.data?.find((item) => item.id === projectId);
  const actions = useActions(projectId);
  const [create, setCreate] = useState(false);

  // Normalize legacy deep links into the clean EasyPanel 1:1 views:
  // - templates / compose -> Templates & Create Hub (with sub-tabs Templates | Modules | Compose)
  // - settings / environment / migration -> Project Settings (Shared Env, Saved Scripts, Export/Import, Danger Zone)
  const resolvedView: "services" | "templates" | "settings" | "activity" =
    requestedTab === "templates" || requestedTab === "compose"
      ? "templates"
      : requestedTab === "settings" || requestedTab === "environment" || requestedTab === "migration"
        ? "settings"
        : requestedTab === "activity"
          ? "activity"
          : "services";

  const [catalogSubTab, setCatalogSubTab] = useState<"templates" | "modules" | "compose">(
    requestedTab === "compose" ? "compose" : "templates",
  );

  useEffect(() => {
    if (requestedTab === "compose") setCatalogSubTab("compose");
    else if (requestedTab === "templates") setCatalogSubTab("templates");
  }, [requestedTab]);

  const services = useQuery({
    queryKey: ["services", projectId],
    queryFn: () => api<Service[]>(`/projects/${projectId}/services`),
    enabled: !!projectId,
    refetchInterval: 2_000,
  });

  const openView = (next: "services" | "templates" | "settings" | "activity") => {
    if (!projectId) return;
    void navigate({
      to: "/projects/$projectId",
      params: { projectId },
      search: next === "services" ? {} : { tab: next },
      viewTransition: false,
      resetScroll: false,
    });
  };

  return (
    <div className="ep-dual-layout">
      <ProjectContextSidebar
        projects={projects.data ?? (project ? [project] : [])}
        currentProject={project}
        services={services.data ?? []}
        canWrite={project?.canWrite === true}
        onAddService={() => setCreate(true)}
      />

      <div className="ep-context-sheet">
        <div className="ep-context-sheet-inner">
          <div className="ep-service-header">
            <h1 className="ep-service-crumb-title">
              <Link to="/projects/$projectId" params={{ projectId: projectId! }}>
                {project?.name ?? "Project"}
              </Link>
              {resolvedView === "templates" ? (
                <>
                  <span className="ep-service-crumb-sep">/</span>
                  <span>Templates</span>
                </>
              ) : resolvedView === "settings" ? (
                <>
                  <span className="ep-service-crumb-sep">/</span>
                  <span>Settings</span>
                </>
              ) : null}
            </h1>

            <div className="ep-service-top-actions">
              {project?.canWrite ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setCreate(true)}
                >
                  <Plus size={15} aria-hidden="true" />
                  New service
                </button>
              ) : null}
              <button
                type="button"
                className={`button ${resolvedView === "templates" ? "button-primary" : ""}`}
                onClick={() => openView(resolvedView === "templates" ? "services" : "templates")}
              >
                <Sparkles size={15} aria-hidden="true" />
                Templates
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Project settings"
                title="Project settings"
                aria-pressed={resolvedView === "settings"}
                onClick={() => openView(resolvedView === "settings" ? "services" : "settings")}
              >
                <Settings size={17} aria-hidden="true" />
              </button>
            </div>
          </div>

          {resolvedView === "services" ? (
            <>
              <ErrorNotice error={services.error} />
              {services.isPending ? (
                <Skeleton kind="table" label="Loading services" />
              ) : services.error ? null : services.data?.length ? (
                <div className="ep-framed-card">
                  <div className="ep-framed-head">
                    <span>Services ({services.data.length})</span>
                  </div>
                  <div className="ep-framed-body" style={{ padding: 0, overflow: "hidden" }}>
                    <div className="services-table" style={{ border: 0, borderRadius: 0 }}>
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
                              {service.kind && service.kind !== "app" ? <Database size={17} /> : <Box size={17} />}
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
                                : service.source?.type === "dockerfile"
                                  ? "Inline Dockerfile"
                                  : service.source?.type === "upload"
                                    ? `Upload · ${service.source.filename ?? service.source.uploadId}`
                                    : service.image
                            }
                          >
                            {service.source?.type === "git"
                              ? `Git · ${service.source.branch}`
                              : service.source?.type === "dockerfile"
                                ? "Inline Dockerfile"
                                : service.source?.type === "upload"
                                  ? `Upload · ${service.source.filename ?? "archive"}`
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
                  </div>
                </div>
              ) : (
                <div className="surface empty-services">
                  <div className="empty-service-icon">
                    <Box size={34} strokeWidth={1.4} />
                  </div>
                  <h2>Your project is empty</h2>
                  <p>
                    Create a service from a Docker image, Git repository, inline Dockerfile, or archive,
                    <br />
                    or launch a ready-to-use template, WordPress, Box, or Compose stack.
                  </p>
                  {project?.canWrite ? (
                    <div className="project-empty-actions">
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={() => setCreate(true)}
                      >
                        <Plus size={16} aria-hidden="true" />
                        Create service
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={() => openView("templates")}
                      >
                        <Sparkles size={15} aria-hidden="true" />
                        Browse Templates
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </>
          ) : resolvedView === "templates" && projectId ? (
            <div className="ep-page">
              <div className="ep-segmented" role="tablist" aria-label="Create options">
                <button
                  type="button"
                  role="tab"
                  aria-selected={catalogSubTab === "templates"}
                  className={catalogSubTab === "templates" ? "is-active" : ""}
                  onClick={() => setCatalogSubTab("templates")}
                >
                  Templates
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={catalogSubTab === "modules"}
                  className={catalogSubTab === "modules" ? "is-active" : ""}
                  onClick={() => setCatalogSubTab("modules")}
                >
                  WordPress &amp; Box
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={catalogSubTab === "compose"}
                  className={catalogSubTab === "compose" ? "is-active" : ""}
                  onClick={() => setCatalogSubTab("compose")}
                >
                  Compose
                </button>
              </div>
              {catalogSubTab === "templates" ? (
                <TemplateProjects projectId={projectId} canWrite={project?.canWrite === true} />
              ) : catalogSubTab === "modules" ? (
                <DedicatedModulesSection projectId={projectId} canWrite={project?.canWrite === true} />
              ) : (
                <ComposeProjects projectId={projectId} canWrite={project?.canWrite === true} />
              )}
            </div>
          ) : resolvedView === "settings" && projectId && project ? (
            <div className="ep-page">
              <ProjectExtras projectId={projectId} services={services.data ?? []} canWrite={project.canWrite === true} />
              <ProjectMigrationSection projectId={projectId} projectName={project.name} admin={user.role === "admin"} canWrite={project.canWrite === true} />
              {project.canWrite ? (
                <div className="ep-framed-card">
                  <div className="ep-framed-head">
                    <span>Project Danger Zone</span>
                  </div>
                  <div className="ep-framed-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                    <div>
                      <strong>Manage or delete project</strong>
                      <p className="servus-help">Rename this project or permanently delete it and all of its services.</p>
                    </div>
                    <ProjectSettings project={project} onDeleted={() => void navigate({ to: "/" })} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : resolvedView === "activity" ? (
            <>
              <ErrorNotice error={actions.error} />
              {!actions.error ? <ActionsTable actions={actions.data ?? []} loading={actions.isPending} /> : null}
            </>
          ) : null}
        </div>
      </div>

      {create && projectId ? (
        <CreateService
          projectId={projectId}
          admin={user.role === "admin"}
          serviceNames={services.data?.map((service) => service.name) ?? []}
          onClose={() => setCreate(false)}
        />
      ) : null}
    </div>
  );
}

function ActionsTable({
  actions,
  loading,
  onSelect,
  selectedId,
  emptyMessage,
}: {
  actions: Action[];
  loading?: boolean;
  onSelect?: (action: Action) => void;
  selectedId?: string;
  emptyMessage?: string;
}) {
  if (loading)
    return (
      <Skeleton kind="table" label="Loading activity" />
    );
  if (!actions.length)
    return (
      <div className="surface empty-activity">
        <span className="activity-empty-icon">
          <Activity size={22} />
        </span>
        <div>
          <strong>{emptyMessage ? "No matching operations" : "No operations yet"}</strong>
          <p>{emptyMessage ?? "Deployments and service actions will appear here."}</p>
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
          type="button"
          className="action-row"
          aria-pressed={selectedId !== undefined ? selectedId === action.id : undefined}
          onClick={() =>
            onSelect
              ? onSelect(action)
              : void router.navigate({
                  to: "/services/$serviceId",
                  params: { serviceId: action.serviceId },
                  search: { tab: "deployments", action: action.id },
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
              <small>
                <span className="mono" title={action.id}>{shortId(action.id)}</span>
                <span className="deployment-run-time"> · <time dateTime={action.createdAt} title={formatDate(action.createdAt)}>{relative(action.createdAt)}</time></span>
              </small>
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

const compactServiceLayout = "(max-width: 980px)";
const serviceTabGroups: { title: string; sections: ServiceTab[] }[] = [
  { title: "Observe", sections: ["overview", "deployments", "logs", "console"] },
  { title: "Configure", sections: ["source", "environment", "domains", "resources"] },
  { title: "Data", sections: ["storage", "backups"] },
];

function ServiceSections({
  serviceId, tab, selectedAction, actionCount, compact,
}: {
  serviceId: string;
  tab: ServiceTab;
  selectedAction?: string;
  actionCount: number;
  compact: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId();
  function sectionLink(item: (typeof serviceTabs)[number]) {
    return (
      <Link
        key={item.id}
        to="/services/$serviceId"
        params={{ serviceId }}
        search={{ tab: item.id, action: item.id === "deployments" ? selectedAction : undefined }}
        viewTransition={false}
        resetScroll={false}
        aria-current={tab === item.id ? "page" : undefined}
        className={tab === item.id ? "selected" : ""}
        onClick={() => dialog.current?.close()}
      >
        <span className="ep-context-nav-label">
          {serviceTabIcon(item.id)}
          <span>{item.label}</span>
        </span>
        {item.id === "deployments" && actionCount > 0 ? <span className="tab-count">{actionCount}</span> : null}
      </Link>
    );
  }
  if (!compact) {
    return <nav className="ep-context-nav" aria-label="Service sections">{serviceTabs.map(sectionLink)}</nav>;
  }
  const current = serviceTabs.find(item => item.id === tab)!;
  return (
    <>
      <button
        className="button service-section-trigger"
        type="button"
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        Section: {current.label} <ChevronDown size={16} aria-hidden="true" />
      </button>
      <dialog ref={dialog} className="service-section-sheet" aria-labelledby={label}>
        <div className="service-section-sheet-header">
          <h2 id={label}>Service sections</h2>
          <form method="dialog">
            <button className="icon-button" type="submit" aria-label="Close service sections">
              <X size={19} aria-hidden="true" />
            </button>
          </form>
        </div>
        <nav aria-label="Service sections">
          {serviceTabGroups.map(({ title, sections }) => (
            <div key={title} className="service-section-group">
              <h3>{title}</h3>
              <div>{sections.map(id => sectionLink(serviceTabs.find(item => item.id === id)!))}</div>
            </div>
          ))}
        </nav>
      </dialog>
    </>
  );
}

function ServicePage() {
  const { serviceId } = useParams({ strict: false });
  const client = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const runtime = useRuntime();
  const projects = useProjects();
  const { tab = "overview", action: selectedAction } = serviceRoute.useSearch();
  const [compact, setCompact] = useState(() => window.matchMedia(compactServiceLayout).matches);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [createInProject, setCreateInProject] = useState(false);
  const secondaryDisclosure = useRef<HTMLDetailsElement>(null);
  const [deploymentStatus, setDeploymentStatus] = useState("");
  useEffect(() => {
    const media = window.matchMedia(compactServiceLayout);
    const update = () => {
      if (media.matches && secondaryDisclosure.current?.querySelector("dialog[open]")) setActionsOpen(true);
      setCompact(media.matches);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const selectAction = (action: string) => void navigate({
    to: "/services/$serviceId", params: { serviceId: serviceId! },
    search: { tab: "deployments", action },
    viewTransition: false,
    resetScroll: false,
  });
  const [destroying, setDestroying] = useState(false);
  const serviceQuery = useQuery({
    queryKey: ["service", serviceId],
    queryFn: () => api<Service>(`/services/${serviceId}`),
    enabled: !!serviceId,
    refetchInterval: destroying ? false : 2_000,
  });
  const projectServicesQuery = useQuery({
    queryKey: ["services", serviceQuery.data?.projectId],
    queryFn: () => api<Service[]>(`/projects/${serviceQuery.data!.projectId}/services`),
    enabled: !!serviceQuery.data?.projectId,
    refetchInterval: 5_000,
  });
  const liveMetricsQuery = useQuery({
    queryKey: ["service-metrics", serviceId],
    queryFn: () => api<ServiceMetrics>(`/services/${serviceId}/metrics`),
    enabled: !!serviceId && serviceQuery.data?.state === "running",
    refetchInterval: 5_000,
    retry: false,
  });
  const changesQuery = useQuery({
    queryKey: ["configuration-changes", serviceId, serviceQuery.data?.revision, serviceQuery.data?.deployedRevision],
    queryFn: () => api<{status:"not_deployed"|"unavailable"|"available"; sections:string[];deployedPrimaryDomain?:DomainConfig|null}>(`/services/${serviceId}/configuration-changes`),
    enabled: !!serviceId && !!serviceQuery.data && serviceQuery.data.deployedRevision !== null && serviceQuery.data.revision !== serviceQuery.data.deployedRevision,
  });
  const actionsQuery = useQuery({
    queryKey: ["service-actions", serviceId],
    queryFn: () => api<Action[]>(`/services/${serviceId}/actions`),
    enabled: !!serviceId,
    refetchInterval: 1_500,
  });
  const execute = useMutation({
    mutationFn: (operation: "deploy" | "force-rebuild" | "start" | "stop" | "restart") =>
      api<Action>(`/services/${serviceId}/${operation === "force-rebuild" ? "deploy" : operation}`, {
        method: "POST",
        body: operation === "force-rebuild" ? {forceRebuild:true} : {},
        idempotent: true,
      }),
    onSuccess: (action) => {
      selectAction(action.id);
      void client.invalidateQueries({
        queryKey: ["service-actions", serviceId],
      });
      void client.invalidateQueries({ queryKey: ["service", serviceId] });
      void client.invalidateQueries({ queryKey: ["actions"] });
    },
  });
  if (serviceQuery.isPending)
    return (
      <div className="ep-context-sheet" style={{ margin: 0, border: 0 }}>
        <Skeleton kind="service" label="Loading service" />
      </div>
    );
  if (!serviceQuery.data)
    return (
      <div className="ep-context-sheet" style={{ margin: 0, border: 0 }}>
        <ErrorNotice error={serviceQuery.error ?? new Error("Service not found.")} />
      </div>
    );
  const service = serviceQuery.data;
  const currentProject = projects.data?.find((project) => project.id === service.projectId);
  const database = !!service.kind && service.kind !== "app";
  const canWrite = currentProject?.canWrite === true;
  const busy = !!(
    destroying ||
    execute.isPending ||
    actionsQuery.data?.some(pendingAction)
  );
  const changed = service.revision !== service.deployedRevision;
  const actions = actionsQuery.data ?? [];
  const filteredActions = deploymentStatus ? actions.filter(action => action.status === deploymentStatus) : actions;
  const actionId = selectedAction ?? filteredActions[0]?.id;
  const domains = service.domains ?? [
    { hostname: service.hostname, port: service.port, primary: true },
  ];
  const savedPrimaryDomain = domains.find((domain) => domain.primary) ?? domains[0];
  const primaryDomain = service.deployedRevision === null ? null : changed
    ? changesQuery.data?.status === "available" ? changesQuery.data.deployedPrimaryDomain : null
    : savedPrimaryDomain;
  const appUrl = applicationUrl(primaryDomain, runtime.data?.ingressPort ?? 18080);
  const sourceLabel =
    service.source?.type === "git"
      ? `${service.source.repository} · ${service.source.branch}${service.source.builder && service.source.builder !== "dockerfile" ? ` (${service.source.builder})` : ""}`
      : service.source?.type === "dockerfile"
        ? "Inline Dockerfile"
        : service.source?.type === "upload"
          ? `Uploaded archive · ${service.source.filename ?? service.source.uploadId}`
          : service.image;
  const secondaryActions = canWrite ? (
    <>
      {service.deployedRevision !== null && <>
        <button type="button" className="button" onClick={() => execute.mutate("restart")} disabled={busy}>
          <RefreshCw size={14} aria-hidden="true" /> Restart
        </button>
        <button type="button" className="button" onClick={() => execute.mutate(service.state === "stopped" ? "start" : "stop")} disabled={busy}>
          {service.state === "stopped" ? <Play size={14} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
          {service.state === "stopped" ? "Start" : "Stop"}
        </button>
      </>}
      {service.source && service.source.type !== "image" ? <button className="button" type="button" disabled={busy} onClick={() => execute.mutate("force-rebuild")}>Force rebuild</button> : null}
      <DestroyService
        service={service}
        busy={busy}
        showLabel={compact}
        onStarted={() => setDestroying(true)}
        onFailure={() => setDestroying(false)}
        onDestroyed={() => {
          void client.invalidateQueries({ queryKey: ["projects"] });
          void client.invalidateQueries({ queryKey: ["services", service.projectId] });
          void navigate({ to: "/projects/$projectId", params: { projectId: service.projectId } });
        }}
      />
    </>
  ) : null;
  const projectServices = Array.isArray(projectServicesQuery.data) ? projectServicesQuery.data : [service];
  const liveMetrics = liveMetricsQuery.data;
  return (
    <div className="ep-dual-layout">
      <ProjectContextSidebar
        projects={projects.data ?? (currentProject ? [currentProject] : [])}
        currentProject={currentProject}
        services={projectServices}
        activeServiceId={service.id}
        canWrite={canWrite}
        onAddService={() => setCreateInProject(true)}
      >
        {!compact ? (
          <ServiceSections serviceId={service.id} tab={tab} selectedAction={selectedAction} actionCount={actions.length} compact={false} />
        ) : null}
      </ProjectContextSidebar>

      <div className="ep-context-sheet">
        <div className="ep-context-sheet-inner">
          <div className="service-heading" style={{ display: "grid", gap: 14, marginBottom: 0 }}>
            <div className="ep-service-header">
              <div>
                <h1 className="ep-service-crumb-title">
                  <Link to="/projects/$projectId" params={{ projectId: service.projectId }}>
                    {currentProject?.name ?? "Project"}
                  </Link>
                  <span className="ep-service-crumb-sep">/</span>
                  <span>{service.name}</span>
                  <span className={`ep-type-pill ${database ? "is-db" : ""}`}>
                    {database ? service.kind : "APP"}
                  </span>
                  <Badge status={service.state} />
                </h1>
                <p className="mono service-image" style={{ margin: "4px 0 0", fontSize: 12.5 }}>{sourceLabel}</p>
              </div>
              <div className="ep-service-top-actions">
                {canWrite ? (
                  <button type="button" className="button button-small" onClick={() => setCreateInProject(true)}>
                    <Plus size={14} aria-hidden="true" /> Service
                  </button>
                ) : null}
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: service.projectId }}
                  search={{ tab: "templates" }}
                  className="button button-small"
                >
                  <Sparkles size={14} aria-hidden="true" /> Templates
                </Link>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: service.projectId }}
                  search={{ tab: "settings" }}
                  className="icon-button"
                  aria-label="Project settings"
                  title="Project settings"
                >
                  <Settings size={16} aria-hidden="true" />
                </Link>
              </div>
            </div>

            <div className="ep-action-toolbar-frame">
              <div className="ep-action-toolbar-top service-heading-actions">
                {canWrite && (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => execute.mutate("deploy")}
                    disabled={busy}
                  >
                    {busy ? <Spinner label="In progress" /> : <><Play size={15} aria-hidden="true" /> Deploy</>}
                  </button>
                )}
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
                {canWrite ? (
                  <details
                    ref={secondaryDisclosure}
                    className="service-actions-disclosure"
                    open={!compact || actionsOpen}
                    onToggle={event => { if (compact) setActionsOpen(event.currentTarget.open); }}
                    onKeyDown={event => {
                      if (compact && event.key === "Escape" && event.currentTarget.open && !(event.target as Element).closest("dialog")) {
                        event.preventDefault();
                        event.currentTarget.open = false;
                        event.currentTarget.querySelector("summary")?.focus();
                      }
                    }}
                  >
                    <summary className="button">Actions <ChevronDown size={15} aria-hidden="true" /></summary>
                    <div className="service-action-options">{secondaryActions}</div>
                  </details>
                ) : null}
              </div>
              <div className="ep-action-toolbar-metrics" aria-label="Live service resource summary">
                <span>CPU <strong>{liveMetrics ? `${liveMetrics.cpuPercent.toFixed(1)}%` : "0.0%"}</strong></span>
                <span>Memory <strong>{liveMetrics ? formatCompactBytes(liveMetrics.memoryBytes) : "0 B"}</strong></span>
                <span>
                  Network I/O{" "}
                  <strong>
                    {liveMetrics
                      ? `${formatCompactBytes(liveMetrics.networkRxBytes)} / ${formatCompactBytes(liveMetrics.networkTxBytes)}`
                      : "0 B / 0 B"}
                  </strong>
                </span>
              </div>
            </div>
          </div>

          {compact ? (
            <ServiceSections serviceId={service.id} tab={tab} selectedAction={selectedAction} actionCount={actions.length} compact={true} />
          ) : null}

          <ErrorNotice error={execute.error} />
          {service.lastError && !(tab === "deployments" && actions[0]?.status === "failed" && actionId === actions[0].id) ? (
            <div className="error-notice">
              <CircleAlert size={17} />
              <span>{service.lastError}</span>
            </div>
          ) : null}
          {changed ? (
            <div id="configuration-changes" className="change-notice">
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
                    ? ` · Last deployed revision ${service.deployedRevision}`
                    : ""}
                  . Deploy to apply the saved settings.
                </span>
                {changesQuery.data?.status === "available" ? <span>{changesQuery.data.sections.length ? `Changed: ${changesQuery.data.sections.join(", ")}.` : "No configuration differences found."}</span> : changesQuery.data?.status === "unavailable" ? <span>Details for the running revision are unavailable.</span> : null}
              </div>
            </div>
          ) : null}

          {tab === "deployments" ? (
            <div className="operations-grid deployment-workspace">
              <div className="deployment-history">
                <div className="section-heading deployment-history-heading">
                  <h2>Deployments and operations</h2>
                  <label>
                    <span className="sr-only">Filter deployment history by status</span>
                    <select value={deploymentStatus} onChange={event => setDeploymentStatus(event.target.value)}>
                      <option value="">All statuses</option>
                      <option value="failed">Failed</option>
                      <option value="succeeded">Succeeded</option>
                      <option value="queued">Queued</option>
                      <option value="running">Running</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </label>
                </div>
                <ErrorNotice error={actionsQuery.error} />
                {!actionsQuery.isError ? <ActionsTable
                  actions={filteredActions}
                  loading={actionsQuery.isPending}
                  onSelect={(action) => selectAction(action.id)}
                  selectedId={actionId}
                  emptyMessage={deploymentStatus ? "No operations match this status." : undefined}
                /> : null}
              </div>
              <ActionLog key={`${service.id}:${actionId ?? ""}`} actionId={actionId} service={service} busy={busy} onRedeployed={canWrite ? action => {selectAction(action.id);void client.invalidateQueries({queryKey:["service-actions",serviceId]});void client.invalidateQueries({queryKey:["service",serviceId]});} : undefined} />
              {canWrite && service.source?.type === "git" ? <div className="deployment-webhook">
                <DeployWebhookSettings service={service} canWrite={canWrite}/>
              </div> : null}
            </div>
          ) : tab !== "overview" ? (
            <ServiceConfigurationPanel
              key={`${service.id}-${tab}`}
              service={service}
              tab={tab}
              admin={user.role === "admin"}
              canWrite={canWrite}
            />
          ) : (
            <>
              <ServiceMetricsPanel service={service} />
              <div className="service-overview-grid">
                {database ? (
                  <>
                    <DatabaseConnection service={service} admin={user.role === "admin"} canWrite={canWrite} />
                    <DatabaseAdminTools service={service} canWrite={canWrite} />
                  </>
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
            </>
          )}
        </div>
      </div>

      {createInProject ? (
        <CreateService
          projectId={service.projectId}
          admin={user.role === "admin"}
          serviceNames={projectServicesQuery.data?.map((s) => s.name) ?? [service.name]}
          onClose={() => setCreateInProject(false)}
        />
      ) : null}
    </div>
  );
}

function ActionLog({ actionId, service, busy = false, onRedeployed }: {
  actionId?: string;
  service?: Service;
  busy?: boolean;
  onRedeployed?: (action: Action) => void;
}) {
  const [confirmRedeploy, setConfirmRedeploy] = useState(false);
  const [logSearch, setLogSearch] = useState("");
  const [copyState, setCopyState] = useState("");
  const [followOutput, setFollowOutput] = useState(true);
  const operationOutputRef = useRef<HTMLDivElement>(null);
  const buildOutputRef = useRef<HTMLPreElement>(null);
  const detail = useQuery({
    queryKey: ["action", actionId],
    queryFn: () => api<ActionDetail>(`/actions/${actionId}`),
    enabled: !!actionId,
    refetchInterval: (query) =>
      query.state.data && !pendingAction(query.state.data.action)
        ? false
        : 1_000,
  });
  const wrongService = !!(service && detail.data && service.id !== detail.data.action.serviceId);
  const buildLog = useQuery({
    queryKey:["build-log",actionId],
    queryFn:()=>api<{available:boolean;text:string;truncated:boolean}>(`/actions/${actionId}/build-log`),
    enabled:!wrongService && !!actionId && detail.data?.action.type === "deploy",
    refetchInterval: detail.data && pendingAction(detail.data.action) ? 2_000 : false,
    retry:false,
  });
  const project = useQuery({queryKey:["project-access",detail.data?.action.projectId],queryFn:()=>api<Project>(`/projects/${detail.data!.action.projectId}`),enabled:!wrongService && !!onRedeployed && !!detail.data?.action.projectId});
  const redeploy = useMutation({
    mutationFn:()=>api<Action>(`/services/${detail.data!.action.serviceId}/deployments/${detail.data!.action.id}/redeploy`,{method:"POST",body:{confirm:true},idempotent:true}),
    onSuccess:action=>{setConfirmRedeploy(false);onRedeployed?.(action);},
  });
  const sourceCommit = detail.data?.events.find(event => /^Source commit: [a-f0-9]{40,64}$/.test(event.message))?.message.slice('Source commit: '.length);
  const deployedImage = detail.data?.events.find(event => event.message.startsWith('Deployed image: '))?.message.slice('Deployed image: '.length);
  const started = detail.data?.events.find(event => event.message === 'Worker claimed the durable deployment job.')?.createdAt;
  const startTime = started ? Date.parse(started) : NaN;
  const endTime = detail.data?.action.finishedAt ? Date.parse(detail.data.action.finishedAt) : Date.now();
  const duration = Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime ? Math.floor((endTime-startTime)/1000) : undefined;
  const buildLines = buildLog.data?.text.split('\n').filter(line => line.toLowerCase().includes(logSearch.toLowerCase())).join('\n') ?? '';
  const failure = detail.data ? deploymentFailure(detail.data.action, buildLog.data) : undefined;
  useEffect(()=>{
    if(!followOutput)return;
    for(const node of [operationOutputRef.current,buildOutputRef.current])if(node)node.scrollTop=node.scrollHeight;
  },[followOutput,detail.data?.events,buildLog.data?.text,logSearch]);
  const pauseIfScrolledUp = (node:HTMLElement) => {if(node.scrollHeight-node.scrollTop-node.clientHeight>32)setFollowOutput(false);};
  const canRedeploy = !!onRedeployed && !!project.data?.canWrite && detail.data?.action.type === "deploy" && detail.data.action.status === "succeeded" && !!deployedImage && /^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9._/:@-]*@sha256:[a-f0-9]{64})$/.test(deployedImage);
  if (wrongService) {
    return <section className="log-card"><ErrorNotice error={new Error("This operation belongs to another service.")} /></section>;
  }
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
      {failure || (service && detail.data?.action.type === "deploy") ? (
        <div className="deploy-diagnosis">
          {failure ? (
            <>
              <div className="deploy-failure">
                <h3>{failure.title}</h3>
                <p>{failure.cause}</p>
                {failure.nextStep ? <p>{failure.nextStep}</p> : null}
              </div>
              {failure.stage ? (
                <ol className="deploy-phases" aria-label="Deployment stages">
                  <li>Queued</li>
                  <li className="failed">{failure.stage === "source" ? "Source preparation failed" : "Build failed"}</li>
                  <li>Apply {failure.laterStagesUnreached ? "skipped" : "unconfirmed"}</li>
                  <li>Health check {failure.laterStagesUnreached ? "skipped" : "unconfirmed"}</li>
                </ol>
              ) : null}
            </>
          ) : null}
          {service ? (
            <div className="deploy-revision">
              <div>
                <strong>Last deployed revision {service.deployedRevision ?? "—"}</strong>
                <small>{service.deployedRevision === null ? "No revision deployed yet" : "Live service health is unverified in this view"}</small>
              </div>
              <Link className="button button-small" to="/services/$serviceId" params={{ serviceId: service.id }} search={{ tab: "logs" }} viewTransition={false}>
                Open service logs <ChevronRight size={14} aria-hidden="true" />
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
      {detail.data ? <div className="operation-tools">
        <div className="operation-meta"><span>Progress: {deploymentProgress(detail.data.action,buildLog.data)}</span><span>Queued: {new Date(detail.data.action.createdAt).toLocaleString()}</span>{started ? <span>Started: {new Date(started).toLocaleString()}</span> : null}{duration!==undefined ? <span>Duration: {Math.floor(duration/60)}m {duration%60}s</span> : null}{detail.data.action.finishedAt ? <span>Finished: {new Date(detail.data.action.finishedAt).toLocaleString()}</span> : null}{sourceCommit ? <span>Commit: <code>{sourceCommit}</code></span> : null}{deployedImage ? <span>Image: <code>{deployedImage}</code></span> : null}</div>
        <label>Search output <input type="search" value={logSearch} onChange={event => setLogSearch(event.target.value)} /></label>
        <button type="button" className="button button-small" aria-pressed={followOutput} onClick={()=>setFollowOutput(value=>!value)}>{followOutput ? 'Pause auto-scroll' : 'Resume auto-scroll'}</button>
        <button type="button" className="button button-small" onClick={() => {
          const events = detail.data!.events.map(event => `${event.createdAt} ${event.level.toUpperCase()} ${event.message}`).join("\n");
          const text = buildLog.data?.available && buildLog.data.text ? `${events}\n\nBuild output${buildLog.data.truncated?' (recent output)':''}:\n${buildLog.data.text}` : events;
          if(!navigator.clipboard){setCopyState("Unable to copy output");return;}
          void navigator.clipboard.writeText(text).then(() => setCopyState("Copied"), () => setCopyState("Unable to copy output"));
        }}>Copy all output</button><span role="status">{copyState}</span>
      </div> : null}
      <div
        className="log-body"
        ref={operationOutputRef}
        onScroll={event=>pauseIfScrolledUp(event.currentTarget)}
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
            {detail.data?.events.filter(event => event.message.toLowerCase().includes(logSearch.toLowerCase())).map((event) => (
              <div key={event.id} className={`log-line log-${event.level}`}>
                <time>
                  {new Date(event.createdAt).toLocaleTimeString("en", {
                    hour12: false,
                  })}
                </time>
                <span>{event.message}</span>
              </div>
            ))}
            {detail.data && detail.data.events.length > 0 && logSearch && !detail.data.events.some(event => event.message.toLowerCase().includes(logSearch.toLowerCase())) ? <p className="log-placeholder">No output matches your search.</p> : null}
            {detail.data && !detail.data.events.length ? (
              <p className="log-placeholder">
                {pendingAction(detail.data.action) ? "Waiting for operation events…" : "No operation events were recorded."}
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
      {detail.data?.action.type === "deploy" ? <details className="build-log-details" onToggle={()=>{if(followOutput && buildOutputRef.current)buildOutputRef.current.scrollTop=buildOutputRef.current.scrollHeight;}}>
        <summary>Build output {buildLog.data?.truncated ? "(recent output)" : ""}</summary>
        {buildLog.isPending ? <Spinner label="Loading build output" /> : buildLog.error ? <ErrorNotice error={buildLog.error} /> : buildLog.data?.available ? <pre ref={buildOutputRef} onScroll={event=>pauseIfScrolledUp(event.currentTarget)}>{buildLog.data.text ? buildLines || "No build output matches your search." : "Waiting for build output..."}</pre> : <p>Build output is not available for this operation.</p>}
      </details> : null}
      {canRedeploy ? <div className="historical-deploy-action"><button type="button" className="button button-small" disabled={busy || redeploy.isPending} onClick={()=>{redeploy.reset();setConfirmRedeploy(true);}}>Redeploy this version</button></div> : null}
      {confirmRedeploy ? <FeatureModal title="Redeploy this version?" description="The selected image and its saved application configuration will be deployed." onClose={()=>setConfirmRedeploy(false)} dismissible={!redeploy.isPending}>
        <p>This does not restore database contents, reverse migrations, or undo external changes. The image must still be available.</p>
        <ErrorNotice error={redeploy.error} />
        <div className="historical-deploy-actions"><button type="button" className="button" disabled={redeploy.isPending} onClick={()=>setConfirmRedeploy(false)}>Cancel</button><button type="button" className="button button-primary" disabled={redeploy.isPending} onClick={()=>redeploy.mutate()}>{redeploy.isPending ? "Queuing..." : "Redeploy version"}</button></div>
      </FeatureModal> : null}
      <div className="log-footer">
        <span>Persisted operation history</span>
        {actionId ? <span className="mono">{shortId(actionId)}</span> : null}
      </div>
    </section>
  );
}

function ActivityPage() {
  const actions = useActions();
  const { action: selected } = activityRoute.useSearch();
  const navigate = useNavigate();
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
        onSelect={(action) => void navigate({ to: "/activity", search: { action: action.id } })}
      />
      {selected ? (
        <div className="activity-log">
          <ActionLog key={selected} actionId={selected} />
        </div>
      ) : null}
    </>
  );
}

function MonitorRoutePage() {
  const { user } = useAuth();
  const projects = useProjects();
  return <MonitorPage projects={projects.data ?? []} admin={user.role === "admin"} />;
}

function DomainsRoutePage() {
  const projects = useProjects();
  const runtime = useRuntime();
  return <DomainsPage projects={projects.data ?? []} runtime={runtime.data} />;
}

function SettingsPage() {
  const runtime = useRuntime();
  const { user } = useAuth();
  const admin = user.role === "admin";
  return (
    <div className="ep-dual-layout">
      <aside className="ep-context-sidebar" aria-label="Settings menu">
        <div className="ep-context-section-head"><span>User</span></div>
        <nav className="ep-context-nav" aria-label="Settings sections">
          <a href="#account-access">
            <span className="ep-context-nav-label">
              <ShieldCheck size={15} aria-hidden="true" />
              <span>Account &amp; access</span>
            </span>
          </a>
          <div className="ep-context-section-head" style={{ marginTop: 10 }}><span>Server</span></div>
          <a href="#instance">
            <span className="ep-context-nav-label">
              <Server size={15} aria-hidden="true" />
              <span>Instance</span>
            </span>
          </a>
          {admin ? (
            <>
              <a href="#connectivity">
                <span className="ep-context-nav-label">
                  <Globe2 size={15} aria-hidden="true" />
                  <span>Connectivity</span>
                </span>
              </a>
              <a href="#settings-backups">
                <span className="ep-context-nav-label">
                  <Database size={15} aria-hidden="true" />
                  <span>Backups</span>
                </span>
              </a>
              <a href="#host-administration">
                <span className="ep-context-nav-label">
                  <HardDrive size={15} aria-hidden="true" />
                  <span>Host</span>
                </span>
              </a>
              <a href="#platform-branding">
                <span className="ep-context-nav-label">
                  <Palette size={15} aria-hidden="true" />
                  <span>Branding</span>
                </span>
              </a>
            </>
          ) : null}
        </nav>
      </aside>

      <div className="ep-context-sheet">
        <div className="ep-context-sheet-inner settings-page">
          <header className="ep-page-header settings-heading">
            <h1>Settings</h1>
          </header>

          <section className="settings-group" id="instance" aria-labelledby="settings-instance-heading">
            <h2 id="settings-instance-heading">Instance</h2>
            <ErrorNotice error={runtime.error} />
            <div className="instance-grid">
              <section className="surface details-card">
                <div className="card-heading">
                  <Server size={19} />
                  <h3>Docker runtime</h3>
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
              <div className="settings-instance-side">
                <section className="surface details-card">
                  <div className="card-heading">
                    <ShieldCheck size={19} />
                    <h3>Workspace access</h3>
                  </div>
                  <div className="detail-row">
                    <span>Signed in as</span>
                    <strong>{user.email}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Role</span>
                    <strong className="capitalize">{user.role}</strong>
                  </div>
                </section>
                {admin ? <HostMetricsCard /> : null}
                {admin ? <UpdateSettings /> : null}
              </div>
            </div>
          </section>

          {admin ? <>
            <section className="settings-group" id="connectivity" aria-labelledby="settings-connectivity-heading">
              <h2 id="settings-connectivity-heading">Connectivity</h2>
              <HostDomainSettings />
              <HttpsSettings configured={runtime.data?.httpsConfigured === true} access={runtime.data?.httpsAccess} recoveryRequired={runtime.data?.ingressRecoveryRequired === true} busy={runtime.data?.ingressBusy === true} />
              <GithubSettings />
              <AlertsSettings />
              <BuildConcurrencySettings />
            </section>

            <section className="settings-group" id="settings-backups" aria-labelledby="settings-backups-heading">
              <h2 id="settings-backups-heading">Backups</h2>
              <BackupStorageSettings />
              <InstallationBackupSettings userId={user.id} />
            </section>

            <HostAdminPanel />
            <PlatformSettings />
          </> : null}

          <section className="settings-group" id="account-access" aria-labelledby="settings-account-heading">
            <h2 id="settings-account-heading">Account &amp; access</h2>
            <LocalPasswordSettings />
            <TwoFactorSettings />
            <ApiTokenSettings canCreateProject={admin} />
            {admin ? <ProjectAccess /> : null}
          </section>
        </div>
      </div>
    </div>
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
  validateSearch: (search: Record<string, unknown>): { tab?: ProjectTab } => ({
    tab: typeof search.tab === "string" && (PROJECT_TABS as readonly string[]).includes(search.tab) ? (search.tab as ProjectTab) : undefined,
  }),
  component: ProjectPage,
});
const serviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/services/$serviceId",
  validateSearch: (search: Record<string, unknown>): { tab?: ServiceTab; action?: string } => ({
    tab: serviceTabs.find((item) => item.id === search.tab)?.id,
    action: typeof search.action === "string" ? search.action : undefined,
  }),
  component: ServicePage,
});
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  validateSearch: (search: Record<string, unknown>): { action?: string } => ({
    action: typeof search.action === "string" ? search.action : undefined,
  }),
  component: ActivityPage,
});
const monitorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/monitor",
  component: MonitorRoutePage,
});
const domainsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/domains",
  component: DomainsRoutePage,
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
    monitorRoute,
    domainsRoute,
    settingsRoute,
  ]),
  defaultPreload: "intent",
  defaultViewTransition: typeof CSS !== "undefined" && CSS.supports("selector(:active-view-transition-type(a))")
    ? { types: ({ fromLocation, pathChanged }) => fromLocation && pathChanged ? [] : false }
    : false,
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <AuthGate />
          <PanelNotifications />
        </I18nProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
