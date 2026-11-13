import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';

const installCommand = 'curl -fsSL https://servus.run/install.sh | sudo bash';
const repository = 'https://github.com/raxon/servus';

function Icon({ name, size = 20 }: { name: 'arrow' | 'copy' | 'check' | 'menu' | 'close' | 'box' | 'database' | 'grid' | 'activity' | 'settings' | 'terminal' | 'code' | 'github' | 'chevron'; size?: number }) {
  const paths = {
    arrow: 'M5 12h14m-5-5 5 5-5 5',
    copy: 'M9 9h11v11H9V9ZM15 5V3H3v12h2',
    check: 'm5 12 4 4L19 6',
    menu: 'M4 6h16M4 12h16M4 18h16',
    close: 'm6 6 12 12M6 18 18 6',
    box: 'm12 3 9 5v8l-9 5-9-5V8l9-5Zm0 9 9-4M12 12 3 8m9 4v9',
    database: 'M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3Zm0 0v12c0 2-4 3-8 3s-8-1-8-3V6m0 6c0 2 4 3 8 3s8-1 8-3',
    grid: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',
    activity: 'M2 12h4l4-9 4 18 4-9h4',
    settings: 'M4 6h16M4 18h16M8 3v6m8 6v6',
    terminal: 'm4 5 6 7-6 7m10 0h6',
    code: 'm7 5-6 7 6 7M17 5l6 7-6 7M14 3l-4 18',
    github: 'M9 19c-4 1-4-2-6-2m12 5v-4a3 3 0 0 0-1-2c4 0 7-2 7-6a5 5 0 0 0-2-4 5 5 0 0 0 0-4s-2-1-5 2a15 15 0 0 0-5 0C6 1 4 2 4 2a5 5 0 0 0 0 4 5 5 0 0 0-2 4c0 4 3 6 7 6a3 3 0 0 0-1 2v4',
    chevron: 'm9 5 7 7-7 7',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function Brand({ light = false }: { light?: boolean }) {
  return <span className={`brand${light ? ' brand-light' : ''}`}><img src="/brand/servus.svg" width="30" height="30" alt="" /><span>Servus</span></span>;
}

function CopyCommand({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(installCommand);
      setState('copied');
    } catch {
      input.current?.focus();
      input.current?.select();
      setState('select');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 3500);
  }

  return <div className={`command-box${compact ? ' command-compact' : ''}`}>
    <div className="command-line"><span className="prompt" aria-hidden="true">$</span><input ref={input} aria-label="Servus installation command" value={installCommand} readOnly spellCheck={false} /><button className="copy-button" onClick={() => void copy()} aria-label={state === 'copied' ? 'Command copied' : 'Copy installation command'}><Icon name={state === 'copied' ? 'check' : 'copy'} size={17} /><span>{state === 'copied' ? 'Copied' : 'Copy'}</span></button></div>
    <span className="copy-status" role="status">{state === 'select' ? 'Command selected. Press Ctrl+C or Command+C to copy.' : state === 'copied' ? 'Installation command copied to clipboard.' : ''}</span>
  </div>;
}

const examples = [
  { name: 'web', icon: 'box' as const, kind: 'Application', source: 'Git / Dockerfile', detail: 'fieldnotes.example.com' },
  { name: 'postgres', icon: 'database' as const, kind: 'PostgreSQL', source: 'Private network', detail: 'Persistent volume' },
  { name: 'redis', icon: 'database' as const, kind: 'Redis', source: 'Private network', detail: 'Persistent volume' },
];

function WorkspacePreview() {
  const [tab, setTab] = useState('Services');
  return <div className="workspace-preview" aria-label="Illustrative Servus workspace">
    <div className="preview-browser"><div className="browser-dots" aria-hidden="true"><i /><i /><i /></div><span>your-server / workspace</span><span className="preview-caption">Example workspace</span></div>
    <div className="preview-body">
      <aside className="preview-sidebar" aria-hidden="true"><Brand /><div className="workspace-selector"><span>F</span><div>Fieldnotes<small>Personal workspace</small></div><Icon name="chevron" size={15} /></div><small className="preview-label">WORKSPACE</small><div className="preview-nav selected"><Icon name="grid" size={17} />Projects</div><div className="preview-nav"><Icon name="activity" size={17} />Activity</div><div className="preview-nav"><Icon name="settings" size={17} />Instance</div><div className="preview-sidebar-bottom"><span className="status-dot" /> Docker connected</div></aside>
      <div className="preview-content"><div className="preview-breadcrumb">Projects <span>/</span> fieldnotes</div><div className="preview-project-heading"><div><span className="project-label">YOUR NEXT PROJECT</span><h3>Fieldnotes</h3><p>A little space for a big idea.</p></div><span className="preview-project-icon"><Icon name="box" size={26} /></span></div>
        <div className="preview-tabs" role="tablist" aria-label="Workspace example views">{['Services', 'Deployments', 'Logs'].map(item => <button key={item} type="button" role="tab" id={`preview-tab-${item}`} aria-selected={tab === item} aria-controls="preview-panel" onClick={() => setTab(item)} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const items = ['Services', 'Deployments', 'Logs']; const next = items[(items.indexOf(item) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; setTab(next); document.getElementById(`preview-tab-${next}`)?.focus(); } }}>{item}</button>)}</div>
        <div className="preview-panel" id="preview-panel" role="tabpanel" aria-labelledby={`preview-tab-${tab}`} tabIndex={0}>
          {tab === 'Services' ? <div className="service-list">{examples.map(service => <div className="service-row" key={service.name}><span className="service-icon"><Icon name={service.icon} size={22} /></span><div className="service-title"><strong>{service.name}</strong><small>{service.kind}</small></div><div className="service-detail"><span>{service.source}</span><small>{service.detail}</small></div><span className="service-running"><span className="status-dot" />Running</span></div>)}</div> : tab === 'Deployments' ? <div className="preview-deployments"><div><span className="deploy-check"><Icon name="check" size={20} /></span><span><strong>Deploy web</strong><small>Dockerfile build · main</small></span><span className="service-running">Succeeded</span></div><ol><li>Fetch source</li><li>Build image</li><li>Start container</li><li>Check HTTP response</li></ol></div> : <div className="preview-logs"><span>Example application output</span><code><em>web</em> Listening on 0.0.0.0:3000<br /><em>web</em> Connected to PostgreSQL<br /><em>web</em> Redis connection ready<br /><em>web</em> GET /health 200<br /><em>web</em> Ready for the next request.</code></div>}
        </div><div className="preview-bottom"><span><span className="status-dot" />All services on your infrastructure</span><span>Docker Engine<Icon name="check" size={14} /></span></div>
      </div>
    </div>
  </div>;
}

function Header() {
  const [open, setOpen] = useState(false);
  return <header className="site-header"><div className="shell header-inner"><a className="brand-link" href="#top" aria-label="Servus home"><Brand /></a><button className="mobile-menu" type="button" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen(!open)}><Icon name={open ? 'close' : 'menu'} /></button><nav id="site-navigation" className={open ? 'navigation is-open' : 'navigation'} aria-label="Main navigation" onClick={() => setOpen(false)} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus(); } }}><a href="#how-it-works">How it works</a><a href="#quickstart">Quickstart</a><a href={repository} target="_blank" rel="noreferrer">GitHub<Icon name="github" size={17} /></a><a className="button button-dark button-small" href="#install">Install Servus<Icon name="arrow" size={16} /></a></nav></div></header>;
}

function App() {
  return <><a className="skip-link" href="#main">Skip to content</a><Header /><main id="main">
    <section className="hero shell" id="top"><div className="hero-copy"><a className="release-pill" href="#status"><span className="status-dot" />A self-hosted panel, taking shape<Icon name="chevron" size={13} /></a><h1>A home for <br />what you <span>ship.</span></h1><p className="hero-description">Run your apps and private databases on a server you control, with deployments, environment settings, and the tools for inspecting a failing container gathered in the same workspace.</p><div className="hero-actions"><a className="button button-dark" href="#install">Start on your server<Icon name="arrow" size={18} /></a><a className="text-link" href="#workspace">Take a look<Icon name="chevron" size={15} /></a></div><div className="hero-footnote"><span className="tiny-server" aria-hidden="true"><i /><i /></span>Docker underneath. Your infrastructure throughout.</div></div><div className="hero-aside"><div className="hero-orbit" aria-hidden="true"><div className="orbit-center"><img src="/brand/servus.svg" alt="" /></div><div className="orbit-item orbit-web"><Icon name="box" size={23} /><span>Your app</span></div><div className="orbit-item orbit-db"><Icon name="database" size={22} /><span>Your data</span></div><div className="orbit-item orbit-code"><Icon name="code" size={22} /><span>Your source</span></div><svg className="orbit-lines" viewBox="0 0 440 400" fill="none"><path d="M90 98h86q44 0 44 44v64M352 194h-70q-62 0-62 12M168 337v-71q0-38 52-38" /></svg><span className="orbit-note">One place to keep things moving.</span></div></div></section>
    <section className="workspace-section shell" id="workspace"><div className="section-eyebrow"><span>THE EVERYDAY VIEW</span><span className="example-label">An illustrative workspace, built to explore</span></div><WorkspacePreview /><div className="stack-strip"><span>Bring a Dockerfile.<br /><strong>Keep your favorite stack.</strong></span><div className="stack-names"><span>Node.js</span><span>Python</span><span>Go</span><span>PHP</span><span>PostgreSQL</span><span>Redis</span></div></div></section>
    <section className="workflow-section" id="how-it-works"><div className="shell workflow-grid"><div className="workflow-intro"><span className="eyebrow">A SMALLER DISTANCE TO RUNNING</span><h2>From your source <br />to your server.</h2><p>Give an application a project, a source, and the configuration it needs. Servus handles the Docker work and records what happened along the way.</p><a className="text-link" href="#quickstart">Walk through your first deploy<Icon name="arrow" size={17} /></a></div><div className="workflow-steps"><article><span className="step-number">01</span><div><h3>Bring an image or a repository</h3><p>Use a public Docker image, or point to a public Git repository with a Dockerfile.</p><code>main <span>/</span> Dockerfile</code></div></article><article><span className="step-number">02</span><div><h3>Give it the right surroundings</h3><p>Add environment variables, HTTP domains, and persistent storage. Connect a private database in the same project.</p><div className="step-tags"><span>Environment</span><span>Domains</span><span>Volumes</span></div></div></article><article><span className="step-number">03</span><div><h3>Deploy, then see what happened</h3><p>Follow the operation, read the logs, or open a container shell. Saved changes reach the application when you deploy them.</p><span className="step-outcome"><Icon name="check" size={17} />Deployment history stays with the project</span></div></article></div></div></section>
    <section className="tools-section shell"><div className="tools-heading"><span className="eyebrow">THE WORK AROUND THE DEPLOY</span><h2>Stay close to <br />your applications.</h2><p>Change an environment variable, connect a database, or inspect a failing request without leaving the project.</p></div><dl className="tools-list"><div><dt><Icon name="database" />Private databases</dt><dd>PostgreSQL, Redis, and MariaDB presets with project networking and persistent volumes.</dd></div><div><dt><Icon name="settings" />Configuration you can follow</dt><dd>Separate saved and deployed revisions, encrypted secret storage, and explicit deployment actions.</dd></div><div><dt><Icon name="terminal" />A view inside</dt><dd>Live application logs, a container terminal, and current CPU, memory, and network samples.</dd></div><div><dt><Icon name="activity" />Operations with a record</dt><dd>Start, stop, restart, and inspect failed deployments. An unsuccessful app update can restore its previous runtime configuration.</dd></div></dl></section>
    <section className="install-section" id="install"><div className="shell"><div className="install-heading"><span className="eyebrow">MAKE ROOM FOR YOUR NEXT PROJECT</span><h2>Your server is a good place to start.</h2><p>Run the installer on a dedicated Linux VPS with root access. It prepares Docker and starts the Servus components.</p></div><div className="install-terminal"><div className="terminal-heading"><span><Icon name="terminal" size={17} />Server terminal</span><a href="/install.sh">Read the script<Icon name="arrow" size={15} /></a></div><CopyCommand /><div className="terminal-footer"><span>One command on your VPS</span><span>Keep the setup token private</span></div></div><p className="installer-publication-note">The command above is prepared for the servus.run release. Until the public installer is published, follow the <a href={`${repository}#run-locally`} target="_blank" rel="noreferrer">repository setup instructions</a>.</p><div className="install-detail" id="status"><span className="pilot-badge">CURRENT STATUS · LOCAL PILOT</span><p>Servus is under active development. Test it on a dedicated server before trusting it with important workloads. Application HTTPS, backups, and private Git credentials are still outside the current implementation.</p></div></div></section>
    <section className="quickstart-section shell" id="quickstart"><div className="quickstart-heading"><span className="eyebrow">FIRST STEPS</span><h2>Get a small app running.</h2><a className="text-link" href={`${repository}#readme`} target="_blank" rel="noreferrer">Full documentation<Icon name="arrow" size={17} /></a></div><div className="quickstart-content"><article><span>01 / INSTALL & SIGN IN</span><h3>Set up your workspace</h3><p>Run the installer, then follow its connection instructions. Use the setup token to create the first administrator account.</p></article><article><span>02 / CREATE A SERVICE</span><h3>Start with a Docker image</h3><p>Create a project and add an application. For a first test, use <code>nginx:alpine</code> with container port <code>80</code>.</p></article><article><span>03 / CONFIGURE & DEPLOY</span><h3>Send a request to your app</h3><p>Add a hostname, point its DNS at your server, and deploy. Application routing currently uses HTTP on the ingress port shown by your installation.</p></article></div></section>
    <section className="closing-section shell"><p>Something worth shipping?</p><h2>Give it a home.</h2><a className="button button-dark" href="#install">Install Servus<Icon name="arrow" size={18} /></a></section>
  </main><footer className="site-footer shell"><div><a className="brand-link" href="#top" aria-label="Servus home"><Brand /></a><p>A workspace on your own server.</p></div><div className="footer-links"><a href={repository} target="_blank" rel="noreferrer">Source on GitHub</a><a href={`${repository}/blob/main/LICENSE`} target="_blank" rel="noreferrer">Noncommercial license</a><span>servus.run</span></div></footer></>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
