import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import { Icon, ServusMark, type IconName } from './icons';
import { WorkspaceShowcase } from './WorkspaceShowcase';

const INSTALL_COMMAND = 'curl -fsSL https://servus.run/install.sh | sudo bash';
const REPO_URL = 'https://github.com/raxon/servus';
const RELEASE_URL = 'https://github.com/raxon/servus/releases/tag/v0.1.58';

interface FeatureItem {
  icon: IconName;
  eyebrow: string;
  title: string;
  description: string;
  tags: string[];
}

const PIPELINE_STEPS = [
  {
    step: '01',
    title: 'Connect your source',
    description:
      'Pull a Docker image, connect public or private Git via GitHub, SSH deploy key, or PAT, or paste Docker Compose YAML.',
    detail: 'Image · Git · Compose · 5 templates',
  },
  {
    step: '02',
    title: 'Build with guardrails',
    description:
      'Cap build CPU and memory, stream live output, cancel queued or active builds, and keep saved config separate from deployed revisions.',
    detail: 'Resource limits · Build cancel · .env',
  },
  {
    step: '03',
    title: 'Roll out safely',
    description:
      'Run custom container healthchecks, choose start-first or stop-first updates, and revert automatically when a release fails verification.',
    detail: 'Healthcheck · Rollback · Stateful guard',
  },
  {
    step: '04',
    title: 'Route traffic with Traefik',
    description:
      'Issue automatic ACME HTTPS certificates, add path prefixes, IP allow-lists, Basic Auth, redirects, or publish admin-controlled TCP/UDP ports.',
    detail: 'Auto TLS · Middlewares · DNSRR',
  },
];

const FEATURES: FeatureItem[] = [
  {
    icon: 'layers',
    eyebrow: 'WORKLOADS',
    title: 'Apps, Git repos & Compose',
    description:
      'Run Docker images, Dockerfile builds, or multi-container Compose stacks from inline YAML or Git. Start faster with verified templates for WordPress, n8n, Uptime Kuma, Grafana, and MinIO.',
    tags: ['GitHub webhooks', 'SSH & PAT', 'Force rebuild', 'Compose templates'],
  },
  {
    icon: 'database',
    eyebrow: 'DATA',
    title: 'Private managed databases',
    description:
      'Provision PostgreSQL 17, MariaDB 11.4, and Redis 7 on isolated project networks with persistent volumes, optional admin-only external TCP access, logical exports, and candidate-verified restore.',
    tags: ['PostgreSQL 17', 'MariaDB 11.4', 'Redis 7', 'Verified restore'],
  },
  {
    icon: 'globe',
    eyebrow: 'NETWORKING',
    title: 'Traefik routing & edge controls',
    description:
      'Configure HTTPS domains with ACME TLS alongside path-prefix matching, strip-prefix, IPv4/IPv6 CIDR allow-lists, htpasswd Basic Auth, redirect rules, and Swarm DNSRR.',
    tags: ['Automatic HTTPS', 'IP allow-list', 'Basic Auth', 'TCP/UDP ports'],
  },
  {
    icon: 'hard-drive',
    eyebrow: 'RECOVERY',
    title: 'Encrypted backups & snapshots',
    description:
      'Schedule database and volume backups to local storage, S3, or Cloudflare R2 with AES-256-GCM encryption and count, age, or GFS retention. Verify installation snapshots before recovery.',
    tags: ['S3 & Cloudflare R2', 'AES-256-GCM', 'GFS retention', 'Integrity checks'],
  },
  {
    icon: 'activity',
    eyebrow: 'OBSERVABILITY',
    title: 'Metrics, log archive & alerts',
    description:
      'Track 24-hour service CPU/RAM graphs, host disk usage, live browser container console, and a 7-day redacted log archive. Send threshold alerts to HMAC webhooks, SMTP, Telegram, Discord, or Slack.',
    tags: ['24h history', '7d log search', 'Browser shell', '5 alert channels'],
  },
  {
    icon: 'key',
    eyebrow: 'ACCESS & AUTOMATION',
    title: 'RBAC, CLI, API & MCP server',
    description:
      'Require TOTP MFA with recovery codes, assign project roles (admin, editor, viewer), mint project-scoped read or deploy tokens, and automate via OpenAPI 3.1, CLI, or stdio MCP.',
    tags: ['TOTP MFA', 'Project RBAC', 'OpenAPI 3.1', 'CLI & MCP'],
  },
];

const QUICKSTART_STEPS = [
  {
    step: '01 / INSTALL',
    title: 'Bootstrap your Linux VPS',
    description:
      'Run install.sh as root on an Ubuntu or Debian amd64 host. It verifies GitHub release attestations, configures Docker Swarm, and prints your one-time setup token.',
  },
  {
    step: '02 / SECURE',
    title: 'Create admin & enable TOTP',
    description:
      'Open the panel URL printed by the installer, claim your administrator account with the setup token, attach your domain with ACME HTTPS, and turn on TOTP MFA.',
  },
  {
    step: '03 / DEPLOY',
    title: 'Launch an app or template',
    description:
      'Create a project, attach a Docker image, Git repo, or Compose template, connect a private database, and schedule your first encrypted S3 or R2 backup.',
  },
];

function CopyCommand({ variant = 'hero' }: { variant?: 'hero' | 'terminal' }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'select'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleCopy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setStatus('copied');
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setStatus('select');
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus('idle'), 3200);
  }

  return (
    <div className={`command-box command-${variant}`}>
      <div className="command-row">
        <span className="command-prompt" aria-hidden="true">
          $
        </span>
        <input
          ref={inputRef}
          className="command-input"
          aria-label="Servus installation command"
          value={INSTALL_COMMAND}
          readOnly
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="copy-button"
          onClick={() => void handleCopy()}
          aria-label={status === 'copied' ? 'Command copied' : 'Copy installation command'}
        >
          <Icon name={status === 'copied' ? 'check' : 'copy'} size={15} />
          <span>{status === 'copied' ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <span className="command-feedback" role="status" aria-live="polite">
        {status === 'copied'
          ? 'Copied installation command to clipboard.'
          : status === 'select'
            ? 'Selected command. Press Ctrl+C or Command+C to copy.'
            : ''}
      </span>
    </div>
  );
}

function SiteHeader() {
  const headerRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [isWide, setIsWide] = useState(true);

  useEffect(() => {
    const header = headerRef.current;
    const inner = innerRef.current;
    const menu = menuRef.current;
    if (!header || !inner || !menu) return;

    let rafId = 0;

    function syncLayout() {
      if (!header || !inner || !menu) return;
      const supportsPopover = Object.hasOwn(HTMLElement.prototype, 'popover');
      const wasOpen = supportsPopover && menu.matches(':popover-open');

      header.classList.add('is-measuring', 'is-wide');
      menu.removeAttribute('popover');

      const fits = inner.scrollWidth <= inner.clientWidth + 1;
      setIsWide(fits);

      if (fits) {
        header.classList.add('is-wide');
        menu.removeAttribute('popover');
      } else {
        header.classList.remove('is-wide');
        if (supportsPopover) {
          menu.setAttribute('popover', 'auto');
          if (wasOpen) {
            try {
              menu.showPopover();
            } catch {
              // Ignore if popover cannot be re-opened during resize.
            }
          }
        }
      }

      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        header.classList.remove('is-measuring');
      });
    }

    syncLayout();

    const observer = new ResizeObserver(() => syncLayout());
    observer.observe(header);
    observer.observe(menu);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  function closePopoverIfOpen() {
    const menu = menuRef.current;
    if (!menu) return;
    if (Object.hasOwn(HTMLElement.prototype, 'popover') && menu.matches(':popover-open')) {
      try {
        menu.hidePopover();
      } catch {
        // Ignore if already closed.
      }
    }
  }

  return (
    <header ref={headerRef} className={`site-header${isWide ? ' is-wide' : ''}`}>
      <div ref={innerRef} className="shell header-inner">
        <a className="brand-link" href="#top" aria-label="Servus home">
          <ServusMark size={24} />
          <span>Servus</span>
        </a>

        <nav className="site-nav" aria-label="Primary">
          <button
            className="menu-button"
            type="button"
            popoverTarget="site-menu"
            popoverTargetAction="toggle"
            aria-controls="site-menu"
          >
            <Icon name="menu" size={18} />
            <span>Menu</span>
          </button>

          <ul
            ref={menuRef}
            id="site-menu"
            className="site-menu"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('a')) {
                closePopoverIfOpen();
              }
            }}
          >
            <li>
              <a href="#workspace">Workspace</a>
            </li>
            <li>
              <a href="#features">Features</a>
            </li>
            <li>
              <a href="#architecture">Architecture</a>
            </li>
            <li>
              <a href="#quickstart">Quickstart</a>
            </li>
            <li>
              <a href={REPO_URL} target="_blank" rel="noreferrer" className="nav-external">
                <Icon name="github" size={15} />
                <span>GitHub</span>
              </a>
            </li>
            <li className="nav-cta-item">
              <a className="button button-primary button-sm" href="#install">
                <span>Install Servus</span>
                <Icon name="arrow" size={15} />
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}

function ArchitectureDiagram() {
  return (
    <div className="arch-diagram" aria-label="Servus process isolation architecture">
      <div className="arch-tier">
        <span className="arch-tier-label">CONTROL SURFACES</span>
        <div className="arch-row arch-row-3">
          <div className="arch-node">
            <strong>Web Panel</strong>
            <small>React UI + Console</small>
          </div>
          <div className="arch-node">
            <strong>CLI & OpenAPI</strong>
            <small>Scoped deploy tokens</small>
          </div>
          <div className="arch-node">
            <strong>MCP Server</strong>
            <small>stdio automation</small>
          </div>
        </div>
      </div>

      <div className="arch-connector" aria-hidden="true">
        <span />
      </div>

      <div className="arch-tier">
        <span className="arch-tier-label">EDGE & API BOUNDARY</span>
        <div className="arch-row arch-row-2">
          <div className="arch-node arch-node-accent">
            <strong>Traefik Ingress</strong>
            <small>ACME HTTPS · IP Allow-list · Basic Auth · Redirects</small>
          </div>
          <div className="arch-node arch-node-accent">
            <strong>Servus API</strong>
            <small>TOTP MFA · Project RBAC · AES-256-GCM secrets</small>
          </div>
        </div>
      </div>

      <div className="arch-connector" aria-hidden="true">
        <span />
      </div>

      <div className="arch-tier">
        <span className="arch-tier-label">ISOLATED EXECUTION & HOST LIFECYCLE</span>
        <div className="arch-row arch-row-3">
          <div className="arch-node">
            <strong>Worker</strong>
            <small>Git builds · S3/R2 backups · Alerts</small>
          </div>
          <div className="arch-node">
            <strong>Docker Agent</strong>
            <small>Swarm services · Logs · Metrics</small>
          </div>
          <div className="arch-node">
            <strong>systemd Supervisor</strong>
            <small>Attested updates · Recovery</small>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <SiteHeader />

      <main id="main">
        <section className="hero-section" id="top">
          <div className="hero-grid-bg" aria-hidden="true" />
          <div className="shell hero-inner">
            <a className="release-pill" href={RELEASE_URL} target="_blank" rel="noreferrer">
              <span className="pill-tag">Beta v0.1.58</span>
              <span className="pill-copy">
                Signed linux/amd64 releases
                <Icon name="arrow-up-right" size={14} />
              </span>
            </a>

            <h1>
              Deploy apps and databases
              <br />
              <span>on your own Linux server.</span>
            </h1>

            <p className="hero-subtitle">
              Servus is a self-hosted Docker control plane for a single VPS. Build from Git or Compose,
              run private PostgreSQL, MariaDB, and Redis instances, schedule encrypted S3/R2 backups,
              and monitor logs, metrics, and alerts from one workspace.
            </p>

            <div className="hero-actions">
              <a className="button button-primary" href="#install">
                <span>Install on your VPS</span>
                <Icon name="arrow" size={16} />
              </a>
              <a className="button button-secondary" href={REPO_URL} target="_blank" rel="noreferrer">
                <Icon name="github" size={16} />
                <span>View source on GitHub</span>
              </a>
            </div>

            <div className="hero-command">
              <CopyCommand variant="hero" />
              <div className="hero-command-meta">
                <span>Ubuntu & Debian Linux (amd64) · Root access required</span>
                <a href="/install.sh">
                  <span>Inspect install.sh</span>
                  <Icon name="arrow-up-right" size={14} />
                </a>
              </div>
            </div>

            <ul className="fact-strip" aria-label="Core capabilities">
              <li>
                <Icon name="server" size={15} />
                <span>Docker Swarm</span>
              </li>
              <li>
                <Icon name="globe" size={15} />
                <span>Automatic Traefik HTTPS</span>
              </li>
              <li>
                <Icon name="shield" size={15} />
                <span>AES-256-GCM S3 & R2 Backups</span>
              </li>
              <li>
                <Icon name="terminal" size={15} />
                <span>OpenAPI, CLI & MCP</span>
              </li>
            </ul>
          </div>
        </section>

        <section className="showcase-section shell" id="workspace">
          <div className="section-intro section-intro-split">
            <div>
              <span className="eyebrow">THE CONTROL PLANE</span>
              <h2>One interface for shipping, inspecting, and recovering.</h2>
            </div>
            <p>
              Switch between services, 24-hour resource graphs, encrypted backup jobs, and redacted logs
              without leaving the project.
            </p>
          </div>

          <WorkspaceShowcase />

          <div className="stack-strip">
            <span className="stack-strip-label">Runs any container or Dockerfile</span>
            <ul className="stack-pills">
              <li>Node.js</li>
              <li>Python</li>
              <li>Go</li>
              <li>PHP</li>
              <li>PostgreSQL 17</li>
              <li>MariaDB 11.4</li>
              <li>Redis 7</li>
              <li>Docker Compose</li>
            </ul>
          </div>
        </section>

        <section className="pipeline-section" id="workflow">
          <div className="shell">
            <div className="section-intro">
              <span className="eyebrow">DEPLOYMENT PIPELINE</span>
              <h2>From source to verified container.</h2>
              <p>
                Every deployment follows an explicit, recorded sequence so you know what changed, why a
                build stopped, and what version is serving traffic.
              </p>
            </div>

            <ol className="pipeline-grid">
              {PIPELINE_STEPS.map((item) => (
                <li className="pipeline-card" key={item.step}>
                  <span className="pipeline-step">{item.step}</span>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                  <code>{item.detail}</code>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="features-section shell" id="features">
          <div className="section-intro">
            <span className="eyebrow">CAPABILITIES</span>
            <h2>Everything your server needs. Nothing rented.</h2>
            <p>
              No hosted management plane sitting between you and your VPS. Servus runs beside your
              workloads on your own hardware.
            </p>
          </div>

          <div className="features-grid">
            {FEATURES.map((feature) => (
              <article className="feature-card" key={feature.title}>
                <div className="feature-head">
                  <span className="feature-icon">
                    <Icon name={feature.icon} size={19} />
                  </span>
                  <span className="feature-eyebrow">{feature.eyebrow}</span>
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
                <ul className="feature-tags">
                  {feature.tags.map((tag) => (
                    <li key={tag}>{tag}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="architecture-section" id="architecture">
          <div className="shell architecture-grid">
            <div className="architecture-copy">
              <span className="eyebrow">SECURITY & ISOLATION</span>
              <h2>Split privileges across the host.</h2>
              <p>
                Instead of handing full root and Docker socket control to a single web process, Servus
                separates API requests, build/backup workers, container execution, and host updates into
                dedicated components.
              </p>

              <dl className="architecture-points">
                <div>
                  <dt>
                    <Icon name="shield" size={16} />
                    <span>Signed releases verified before boot</span>
                  </dt>
                  <dd>
                    The installer checks GitHub artifact attestations for published linux/amd64 images
                    and records installed versions for controlled upgrades.
                  </dd>
                </div>
                <div>
                  <dt>
                    <Icon name="key" size={16} />
                    <span>Encrypted secrets & redacted archives</span>
                  </dt>
                  <dd>
                    Environment variables, Git credentials, alert channels, and S3/R2 profiles are sealed
                    with AES-256-GCM. Secrets are redacted before writing to the 7-day log archive.
                  </dd>
                </div>
                <div>
                  <dt>
                    <Icon name="hard-drive" size={16} />
                    <span>Candidate-verified database recovery</span>
                  </dt>
                  <dd>
                    Database restores validate candidate dumps before switching data, and installation
                    snapshots support integrity checks and last-snapshot deletion protection.
                  </dd>
                </div>
              </dl>
            </div>

            <ArchitectureDiagram />
          </div>
        </section>

        <section className="install-section shell" id="install">
          <div className="install-card">
            <div className="install-head">
              <div>
                <span className="eyebrow">SELF-HOSTED INSTALL</span>
                <h2>Up and running in one command.</h2>
                <p>
                  Run the installer on a clean Linux VPS with root access. You can read every line of the
                  script before executing it.
                </p>
              </div>
              <a className="button button-secondary button-sm" href="/install.sh">
                <Icon name="terminal" size={15} />
                <span>Read install.sh</span>
              </a>
            </div>

            <CopyCommand variant="terminal" />

            <div className="install-specs">
              <div>
                <span>Target OS</span>
                <strong>Ubuntu / Debian Linux</strong>
              </div>
              <div>
                <span>Architecture</span>
                <strong>linux/amd64</strong>
              </div>
              <div>
                <span>Runtime</span>
                <strong>Single-server Docker Swarm</strong>
              </div>
              <div>
                <span>License</span>
                <strong>PolyForm Noncommercial 1.0.0</strong>
              </div>
            </div>
          </div>

          <div className="quickstart-block" id="quickstart">
            <div className="section-intro section-intro-split">
              <div>
                <span className="eyebrow">QUICKSTART</span>
                <h2>Three steps to your first live service.</h2>
              </div>
              <a className="text-link" href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer">
                <span>Read repository docs</span>
                <Icon name="arrow-up-right" size={15} />
              </a>
            </div>

            <div className="quickstart-grid">
              {QUICKSTART_STEPS.map((item) => (
                <article className="quickstart-card" key={item.step}>
                  <span className="quickstart-step">{item.step}</span>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="status-banner" id="status">
            <div className="status-banner-badge">
              <Icon name="git" size={15} />
              <span>CURRENT RELEASE · v0.1.58 (BETA)</span>
            </div>
            <p>
              Servus is in active beta for single-server Linux (amd64) Docker Swarm hosts. Validate
              backups, alerts, and upgrades on a dedicated VPS before running critical production
              workloads. Source code and issue tracking live on{' '}
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                GitHub
              </a>
              .
            </p>
          </div>
        </section>

        <section className="closing-section shell">
          <div className="closing-card">
            <span className="eyebrow">READY WHEN YOUR SERVER IS</span>
            <h2>Own the server. Keep the workflow.</h2>
            <p>Install Servus directly on your VPS or inspect the codebase on GitHub.</p>
            <div className="hero-actions">
              <a className="button button-primary" href="#install">
                <span>Install Servus</span>
                <Icon name="arrow" size={16} />
              </a>
              <a className="button button-secondary" href={REPO_URL} target="_blank" rel="noreferrer">
                <Icon name="github" size={16} />
                <span>Explore repository</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="shell footer-inner">
          <div className="footer-brand">
            <a className="brand-link" href="#top" aria-label="Servus home">
              <ServusMark size={22} />
              <span>Servus</span>
            </a>
            <p>Self-hosted Docker deployment panel for your own Linux server.</p>
          </div>

          <div className="footer-links">
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={RELEASE_URL} target="_blank" rel="noreferrer">
              v0.1.58 Release
            </a>
            <a href="/install.sh">install.sh</a>
            <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
              License
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
