import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import type { inspectOnboarding } from '../src/onboarding/service.js';
import { api } from './api.js';
import { createConsoleStore } from './console-store.js';
import { Card } from './components/ui/card.js';
import { Shell, ShellPlaceholder, Topbar } from './shell.js';

const store = createConsoleStore();

type OnboardingSummary = Awaited<ReturnType<typeof inspectOnboarding>>;

const TAGLINE = (
  <>
    One workflow.
    <br />
    Your choice of agent.
  </>
);

function OnboardingStatusCard() {
  const [summary, setSummary] = useState<OnboardingSummary>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<OnboardingSummary>('onboarding')
      .then(setSummary)
      .catch(() => setFailed(true));
  }, []);
  const status = summary?.progress.status;
  const headline = failed
    ? 'Unavailable'
    : !summary
      ? 'Checking…'
      : status === 'completed'
        ? 'Complete'
        : status === 'dismissed'
          ? 'Dismissed'
          : 'In progress';
  return (
    <Card className="summary-card">
      <span className="mini-label">GET STARTED</span>
      <div>
        <strong className="status-word">{headline}</strong>
        <span>
          {status === 'completed' ? (
            'All onboarding steps are done'
          ) : (
            <a href="/settings#onboarding">Open onboarding in Settings</a>
          )}
        </span>
      </div>
    </Card>
  );
}

function Summary() {
  const snapshot = store.getSnapshot();
  const state = snapshot.state;
  if (!state) return null;
  const detected = state.doctor.providers.filter((item) => item.detected).length;
  const saved = !store.dirty();
  return (
    <section className="summary-grid" aria-label="Workspace summary">
      <Card className="summary-card">
        <span className="mini-label">CONNECTED TOOLS</span>
        <div>
          <strong>{detected}</strong>
          <span>detected on this machine</span>
        </div>
        <ArrowUpRight className="summary-icon" aria-hidden="true" />
      </Card>
      <Card className="summary-card">
        <span className="mini-label">YOUR WORKFLOW</span>
        <div>
          <strong>{snapshot.selection.skills.length}</strong>
          <span>skills selected · manage in Settings</span>
        </div>
        <span className="summary-icon" aria-hidden="true">
          ✳
        </span>
      </Card>
      <Card className="summary-card">
        <span className="mini-label">SYNC STATUS</span>
        <div>
          <strong className="status-word">{saved ? 'Ready' : 'Edited'}</strong>
          <span>{saved ? 'Preview before applying' : 'Save your selection in Settings'}</span>
        </div>
        <RefreshCw className="summary-icon" aria-hidden="true" />
      </Card>
      <OnboardingStatusCard />
    </section>
  );
}

export function OverviewConsole() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const state = snapshot.state;
  useEffect(() => {
    void store.initialize();
    const timer = window.setInterval(() => store.poll(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!state)
    return (
      <ShellPlaceholder
        active="overview"
        tagline={TAGLINE}
        breadcrumb="WORKSPACE"
        label="Overview"
        title="Your agents, in sync."
        message={snapshot.notice?.message}
      />
    );
  const connection =
    snapshot.connection === 'Loading workspace…'
      ? (state.doctor.project
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() ?? state.doctor.project)
      : snapshot.connection;
  return (
    <Shell active="overview" tagline={TAGLINE}>
      <Topbar breadcrumb="WORKSPACE" label="Overview" />
      <section className="intro">
        <div>
          <p className="eyebrow">LESS SETUP. MORE SHIPPING.</p>
          <h1>
            Your agents,
            <br />
            <span>in sync.</span>
          </h1>
          <p className="intro-copy">
            Give every coding agent a familiar workflow.
            <br />
            Configuration, specs and tasks, memory, and usage each have their own page now — start
            here for the big picture.
          </p>
        </div>
        <Card className="workspace-card">
          <span className="mini-label">CURRENT PROJECT</span>
          <strong>{connection}</strong>
          <code>{state.doctor.project}</code>
          <div className="workspace-meta">
            <span>{state.doctor.platform}</span>
            <span>{state.doctor.runtime}</span>
          </div>
        </Card>
      </section>
      {snapshot.notice && (
        <div
          className={`notice ${snapshot.notice.error ? 'notice-error' : ''}`}
          role={snapshot.notice.error ? 'alert' : 'status'}
          aria-live="polite"
          tabIndex={-1}
        >
          {snapshot.notice.message}
        </div>
      )}
      <Summary />
      <section className="config-section" aria-labelledby="overview-pages-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">FIND YOUR WAY AROUND</p>
            <h2 id="overview-pages-heading">Every concern has its own page.</h2>
            <p>
              Projects, Specs &amp; Tasks, Memory, Usage, and Settings are each directly linked.
            </p>
          </div>
        </div>
        <div className="page-links-grid">
          <a className="page-link-card" href="/projects">
            <strong>Projects</strong>
            <span className="section-note">
              Every project Latchkit has touched, grouped by repository.
            </span>
          </a>
          <a className="page-link-card" href="/specs">
            <strong>Specs &amp; Tasks</strong>
            <span className="section-note">
              Durable tasks, delivery workflows, and acceptance evidence.
            </span>
          </a>
          <a className="page-link-card" href="/memory">
            <strong>Memory</strong>
            <span className="section-note">Local, inspectable records with bounded recovery.</span>
          </a>
          <a className="page-link-card" href="/usage">
            <strong>Usage</strong>
            <span className="section-note">
              Local counters, trends, and explicit savings baselines.
            </span>
          </a>
          <a className="page-link-card" href="/settings">
            <strong>Settings</strong>
            <span className="section-note">
              Agents, skills, task workspace, FCC/tools, and onboarding.
            </span>
          </a>
        </div>
      </section>
    </Shell>
  );
}
