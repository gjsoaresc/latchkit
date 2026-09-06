import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { ThemeToggle } from './theme.js';

/**
 * Shared console shell (issue #90): every top-level page is directly addressable by path
 * (see the ASSETS map in src/server.ts) and renders through this one sidebar/topbar shell so
 * navigation, active-page state, and the visual system stay consistent across pages. Each page
 * owns its own data loading; this module owns only the chrome around it.
 */
export type PageKey = 'overview' | 'projects' | 'specs' | 'memory' | 'usage' | 'settings';

interface NavEntry {
  key: PageKey;
  href: string;
  label: string;
  glyph: string;
}

const NAV_ITEMS: NavEntry[] = [
  { key: 'overview', href: '/', label: 'Overview', glyph: '◈' },
  { key: 'projects', href: '/projects', label: 'Projects', glyph: '▤' },
  { key: 'specs', href: '/specs', label: 'Specs & Tasks', glyph: '☰' },
  { key: 'memory', href: '/memory', label: 'Memory', glyph: '◆' },
  { key: 'usage', href: '/usage', label: 'Usage', glyph: '▲' },
  { key: 'settings', href: '/settings', label: 'Settings', glyph: '⚙' },
];

export function ConsoleNav({ active }: { active: PageKey }) {
  return (
    <nav aria-label="Primary">
      {NAV_ITEMS.map((item) => (
        <a
          key={item.key}
          className={`nav-item${active === item.key ? ' active' : ''}`}
          href={item.href}
          aria-current={active === item.key ? 'page' : undefined}
        >
          <span aria-hidden="true">{item.glyph}</span>
          {item.label}
        </a>
      ))}
      <a
        className="nav-item"
        href="https://github.com/willahealm/latchkit#readme"
        target="_blank"
        rel="noreferrer noopener"
      >
        <ExternalLink size={17} aria-hidden="true" />
        Documentation
      </a>
    </nav>
  );
}

/** The shared sidebar/topbar shell. Pages render their own topbar content as children so a page
 * can vary its breadcrumb (e.g. a clickable "back" breadcrumb) and actions without this module
 * needing to know about every page's specifics; use the `Topbar` component below for the common
 * case. */
export function Shell({
  active,
  tagline,
  children,
}: {
  active: PageKey;
  tagline: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="brand" href="/" aria-label="Latchkit workspace, go to overview">
          <span className="brand-mark" aria-hidden="true">
            l<span>k</span>
          </span>
          <span>
            latchkit<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="sidebar-caption">DEVELOPER WORKSPACE</div>
        <ConsoleNav active={active} />
        <div className="sidebar-note">
          <span className="connection-dot" aria-hidden="true" />
          Local to your machine
          <p>{tagline}</p>
          <span className="version">OPEN SOURCE · 1.0 RELEASE CANDIDATE</span>
        </div>
      </aside>
      <main id="workspace">
        {children}
        <footer>
          <span className="footer-brand">latchkit.</span>
          <span>Built for the way you work.</span>
          <span className="footer-right">Windows · Linux · macOS</span>
        </footer>
      </main>
    </div>
  );
}

export function Topbar({
  breadcrumb,
  breadcrumbHref,
  label,
  actions,
}: {
  breadcrumb: ReactNode;
  /** When set, the breadcrumb renders as a link back to that page instead of plain text. */
  breadcrumbHref?: string;
  label: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div>
        {breadcrumbHref ? (
          <a className="breadcrumb" href={breadcrumbHref}>
            {breadcrumb}
          </a>
        ) : (
          <span className="breadcrumb">{breadcrumb}</span>
        )}
        <span className="slash">/</span>
        <span>{label}</span>
      </div>
      <div className="topbar-actions">
        {actions}
        <span className="local-pill">
          <span className="connection-dot" aria-hidden="true" />
          Loopback session
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}

/** A page's loading/empty placeholder before its own data arrives. Every page uses the same
 * shape so a slow or missing session reads consistently everywhere (issue #90 criterion: clear
 * loading/empty/error states on every page). */
export function ShellPlaceholder({
  active,
  tagline,
  breadcrumb,
  label,
  title,
  message,
}: {
  active: PageKey;
  tagline: ReactNode;
  breadcrumb: string;
  label: string;
  title: string;
  message?: string;
}) {
  return (
    <Shell active={active} tagline={tagline}>
      <Topbar breadcrumb={breadcrumb} label={label} />
      <section className="intro">
        <div>
          <p className="eyebrow">LOADING</p>
          <h1>{title}</h1>
        </div>
      </section>
      {message && (
        <div className="notice notice-error" role="alert" tabIndex={-1}>
          {message}
        </div>
      )}
      {!message && (
        <p className="section-note" role="status">
          Connecting to local configuration…
        </p>
      )}
    </Shell>
  );
}
