import React, { useRef, useState } from 'react';
import { Icon, ServusMark, type IconName } from './icons';

type TabId = 'services' | 'metrics' | 'backups' | 'logs';

interface TabItem {
  id: TabId;
  label: string;
  icon: IconName;
}

const TABS: TabItem[] = [
  { id: 'services', label: 'Services', icon: 'box' },
  { id: 'metrics', label: 'Metrics', icon: 'activity' },
  { id: 'backups', label: 'Backups', icon: 'hard-drive' },
  { id: 'logs', label: 'Logs & Alerts', icon: 'terminal' },
];

const SERVICES = [
  {
    name: 'web',
    kind: 'Application',
    icon: 'box' as IconName,
    source: 'GitHub · main / Dockerfile',
    target: 'https://app.example.com',
    meta: 'HTTPS · Healthcheck ok',
    status: 'Running',
  },
  {
    name: 'postgres',
    kind: 'PostgreSQL 17',
    icon: 'database' as IconName,
    source: 'Private project network',
    target: 'postgres:5432',
    meta: 'Persistent volume · Daily R2',
    status: 'Running',
  },
  {
    name: 'redis',
    kind: 'Redis 7',
    icon: 'database' as IconName,
    source: 'Private project network',
    target: 'redis:6379',
    meta: 'Append-only storage',
    status: 'Running',
  },
  {
    name: 'n8n',
    kind: 'Compose template',
    icon: 'layers' as IconName,
    source: 'Verified template · YAML',
    target: 'https://flows.example.com',
    meta: 'IP allow-list · Basic Auth',
    status: 'Running',
  },
];

const BACKUPS = [
  {
    name: 'postgres-daily',
    target: 'Cloudflare R2',
    policy: 'GFS retention · AES-256-GCM',
    time: 'Today 03:00 UTC',
    size: '412 MB',
    state: 'Verified',
  },
  {
    name: 'web-uploads',
    target: 'S3 bucket',
    policy: 'Keep last 14 · Volume archive',
    time: 'Today 02:30 UTC',
    size: '1.18 GB',
    state: 'Verified',
  },
  {
    name: 'installation-snapshot',
    target: 'Local encrypted store',
    policy: 'Panel config & state',
    time: 'Yesterday 22:15 UTC',
    size: '18.4 MB',
    state: 'Integrity OK',
  },
];

const LOG_LINES = [
  { time: '14:22:08', service: 'web', level: 'INFO', text: 'Listening on 0.0.0.0:3000 (generation #14)' },
  { time: '14:22:10', service: 'traefik', level: 'INFO', text: 'ACME TLS certificate valid for app.example.com' },
  { time: '14:22:14', service: 'web', level: 'INFO', text: 'DATABASE_URL=[REDACTED] connected in 11ms' },
  { time: '14:22:41', service: 'worker', level: 'INFO', text: 'Snapshot archive verified (sha256 match)' },
  { time: '14:23:02', service: 'alerts', level: 'ARMED', text: 'Rules active: CPU > 85%, Disk > 90% -> Webhook, Telegram' },
];

export function WorkspaceShowcase() {
  const [activeTab, setActiveTab] = useState<TabId>('services');
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({
    services: null,
    metrics: null,
    backups: null,
    logs: null,
  });

  function selectTab(id: TabId, focusTab = false) {
    setActiveTab(id);
    const element = tabRefs.current[id];
    if (element) {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (focusTab) element.focus();
    }
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TABS.length - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      selectTab(TABS[nextIndex].id, true);
    }
  }

  return (
    <div className="workspace-frame" aria-label="Illustrative Servus panel interface">
      <div className="frame-chrome">
        <div className="chrome-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="chrome-address">
          <Icon name="shield" size={14} />
          <span>panel.your-vps.example / projects / storefront</span>
        </div>
        <span className="chrome-tag">Illustrative preview</span>
      </div>

      <div className="workspace-shell">
        <aside className="workspace-sidebar" aria-hidden="true">
          <div className="sidebar-brand">
            <ServusMark size={20} />
            <span>Servus</span>
            <span className="sidebar-version">v0.3.0</span>
          </div>

          <div className="sidebar-host">
            <span className="host-avatar">S</span>
            <div>
              <strong>eu-vps-01</strong>
              <small>Linux amd64 · Swarm</small>
            </div>
          </div>

          <div className="sidebar-group">
            <span className="sidebar-heading">Workspace</span>
            <div className="sidebar-item is-active">
              <Icon name="box" size={16} />
              <span>Projects</span>
            </div>
            <div className="sidebar-item">
              <Icon name="hard-drive" size={16} />
              <span>Backups</span>
            </div>
            <div className="sidebar-item">
              <Icon name="bell" size={16} />
              <span>Alerts</span>
            </div>
            <div className="sidebar-item">
              <Icon name="activity" size={16} />
              <span>Host metrics</span>
            </div>
            <div className="sidebar-item">
              <Icon name="key" size={16} />
              <span>Access & API</span>
            </div>
          </div>

          <div className="sidebar-footer">
            <div className="status-pill">
              <Icon name="check" size={13} />
              <span>Docker Swarm healthy</span>
            </div>
            <small>Traefik ACME · Auto TLS</small>
          </div>
        </aside>

        <div className="workspace-main">
          <div className="workspace-header">
            <div>
              <div className="workspace-breadcrumb">
                <span>Projects</span>
                <span aria-hidden="true">/</span>
                <strong>storefront</strong>
              </div>
              <h3>Storefront production stack</h3>
            </div>
            <div className="workspace-badges">
              <span className="meta-chip">
                <Icon name="globe" size={14} />
                <span>HTTPS active</span>
              </span>
              <span className="meta-chip">
                <Icon name="shield" size={14} />
                <span>TOTP + RBAC</span>
              </span>
            </div>
          </div>

          <div className="workspace-tablist" role="tablist" aria-label="Illustrative workspace views">
            {TABS.map((tab, index) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(node) => {
                    tabRefs.current[tab.id] = node;
                  }}
                  type="button"
                  role="tab"
                  id={`workspace-tab-${tab.id}`}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  className="workspace-tab"
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  <Icon name={tab.icon} size={15} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          <div className="workspace-panels">
            <div
              role="tabpanel"
              aria-labelledby="workspace-tab-services"
              hidden={activeTab !== 'services'}
              tabIndex={activeTab === 'services' ? 0 : undefined}
            >
              <div className="panel-inner">
                <div className="service-list">
                  {SERVICES.map((service) => (
                    <div className="service-row" key={service.name}>
                      <div className="service-identity">
                        <span className="service-icon">
                          <Icon name={service.icon} size={18} />
                        </span>
                        <div className="service-copy">
                          <strong>{service.name}</strong>
                          <small>{service.kind}</small>
                        </div>
                      </div>

                      <div className="service-source">
                        <span>{service.source}</span>
                        <small>{service.target}</small>
                      </div>

                      <div className="service-meta">
                        <span className="service-note">{service.meta}</span>
                        <span className="state-badge state-running">
                          <Icon name="check" size={13} />
                          <span>{service.status}</span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div
              role="tabpanel"
              aria-labelledby="workspace-tab-metrics"
              hidden={activeTab !== 'metrics'}
              tabIndex={activeTab === 'metrics' ? 0 : undefined}
            >
              <div className="panel-inner">
                <div className="metrics-summary">
                  <div className="metric-card">
                    <span>Host CPU</span>
                    <strong>18.4%</strong>
                    <small>4 vCPU · 24h avg 14.2%</small>
                  </div>
                  <div className="metric-card">
                    <span>Memory</span>
                    <strong>3.1 / 8.0 GB</strong>
                    <small>web 410 MB · postgres 680 MB</small>
                  </div>
                  <div className="metric-card">
                    <span>Disk usage</span>
                    <strong>41%</strong>
                    <small>32.8 / 80 GB · Alert at 90%</small>
                  </div>
                </div>

                <div className="metrics-chart-card">
                  <div className="metrics-chart-header">
                    <div>
                      <strong>web · 24h CPU & memory history</strong>
                      <small>Includes restart generation marker and sampling gap indicator</small>
                    </div>
                    <div className="chart-legend" aria-hidden="true">
                      <span>
                        <i className="legend-swatch legend-cpu" />
                        CPU %
                      </span>
                      <span>
                        <i className="legend-swatch legend-mem" />
                        Memory
                      </span>
                    </div>
                  </div>
                  <svg
                    className="metrics-svg"
                    viewBox="0 0 640 156"
                    role="img"
                    aria-label="Illustrative 24-hour CPU and memory chart with deployment marker"
                  >
                    <defs>
                      <linearGradient id="cpuFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#5eead4" stopOpacity="0.28" />
                        <stop offset="100%" stopColor="#5eead4" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <g stroke="rgba(255,255,255,0.08)" strokeWidth="1">
                      <line x1="0" y1="30" x2="640" y2="30" />
                      <line x1="0" y1="74" x2="640" y2="74" />
                      <line x1="0" y1="118" x2="640" y2="118" />
                    </g>
                    <rect x="336" y="16" width="22" height="122" fill="rgba(255,255,255,0.05)" />
                    <line
                      x1="444"
                      y1="14"
                      x2="444"
                      y2="138"
                      stroke="#5eead4"
                      strokeDasharray="4 4"
                      strokeWidth="1.2"
                    />
                    <text x="451" y="26" fill="#99f6e4" fontSize="11" fontFamily="monospace">
                      deploy #14
                    </text>
                    <text x="322" y="150" fill="#94a3b8" fontSize="10" fontFamily="monospace">
                      gap
                    </text>
                    <path
                      d="M0 106 L54 98 L108 104 L162 84 L216 90 L270 78 L324 88 L336 88 L336 138 L0 138 Z"
                      fill="url(#cpuFill)"
                    />
                    <path
                      d="M358 92 L412 86 L444 68 L498 80 L552 74 L606 79 L640 72 L640 138 L358 138 Z"
                      fill="url(#cpuFill)"
                    />
                    <path
                      d="M0 106 L54 98 L108 104 L162 84 L216 90 L270 78 L324 88 L336 88"
                      fill="none"
                      stroke="#5eead4"
                      strokeWidth="2.2"
                    />
                    <path
                      d="M358 92 L412 86 L444 68 L498 80 L552 74 L606 79 L640 72"
                      fill="none"
                      stroke="#5eead4"
                      strokeWidth="2.2"
                    />
                    <path
                      d="M0 64 L108 62 L216 58 L324 60 L336 60 M358 61 L444 52 L552 55 L640 54"
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth="1.6"
                      strokeDasharray="5 3"
                    />
                  </svg>
                </div>
              </div>
            </div>

            <div
              role="tabpanel"
              aria-labelledby="workspace-tab-backups"
              hidden={activeTab !== 'backups'}
              tabIndex={activeTab === 'backups' ? 0 : undefined}
            >
              <div className="panel-inner">
                <div className="backup-list">
                  {BACKUPS.map((item) => (
                    <div className="backup-row" key={item.name}>
                      <div className="backup-main">
                        <strong>{item.name}</strong>
                        <small>{item.policy}</small>
                      </div>
                      <div className="backup-target">
                        <span>{item.target}</span>
                        <small>
                          {item.time} · {item.size}
                        </small>
                      </div>
                      <span className="state-badge state-running">
                        <Icon name="shield" size={13} />
                        <span>{item.state}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div
              role="tabpanel"
              aria-labelledby="workspace-tab-logs"
              hidden={activeTab !== 'logs'}
              tabIndex={activeTab === 'logs' ? 0 : undefined}
            >
              <div className="panel-inner">
                <div className="logs-toolbar">
                  <span className="logs-filter">
                    <Icon name="terminal" size={14} />
                    <span>Archive: last 7 days · secrets redacted before storage</span>
                  </span>
                  <span className="logs-channels">Webhook · SMTP · Telegram · Discord · Slack</span>
                </div>
                <div className="logs-stream">
                  {LOG_LINES.map((line) => (
                    <div className="log-line" key={`${line.time}-${line.service}-${line.text}`}>
                      <span className="log-time">{line.time}</span>
                      <span className="log-service">{line.service}</span>
                      <span className="log-level">{line.level}</span>
                      <span className="log-text">{line.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="workspace-statusbar">
            <span>Single-server Docker Swarm · No external SaaS control plane</span>
            <span>OpenAPI 3.1 · CLI · stdio MCP</span>
          </div>
        </div>
      </div>
    </div>
  );
}
