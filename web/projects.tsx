import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react';
import type {
  inspectProject,
  listProjects,
  ProjectOverviewEntry,
} from '../src/projects/service.js';
import { api, hasSession } from './api.js';
import { apiError } from './types.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input, Label } from './components/ui/fields.js';
import { ThemeToggle } from './theme.js';

type ProjectList = Awaited<ReturnType<typeof listProjects>>;
type ProjectDetail = Awaited<ReturnType<typeof inspectProject>>;

const count = (value: number | null) => (value === null ? 'Unknown' : value.toLocaleString());
const money = (value: number | null) => (value === null ? 'Unknown' : `$${value.toFixed(4)}`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never');

function projectHref(id?: string) {
  return id ? `/projects?project=${encodeURIComponent(id)}` : '/projects';
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="brand" href="/" aria-label="Latchkit workspace">
          <span className="brand-mark" aria-hidden="true">
            l<span>k</span>
          </span>
          <span>
            latchkit<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="sidebar-caption">DEVELOPER WORKSPACE</div>
        <nav aria-label="Primary">
          <a className="nav-item" href="/#workspace">
            <span aria-hidden="true">◈</span>Workspace
          </a>
          <a className="nav-item active" href="/projects" aria-current="page">
            <span aria-hidden="true">▤</span>Projects
          </a>
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
        <div className="sidebar-note">
          <span className="connection-dot" aria-hidden="true" />
          Local to your machine
          <p>
            Every project you touch,
            <br />
            in one overview.
          </p>
          <span className="version">OPEN SOURCE · 1.0 RELEASE CANDIDATE</span>
        </div>
      </aside>
      <main id="workspace">{children}</main>
    </div>
  );
}

function StatusBadge({ entry }: { entry: ProjectOverviewEntry }) {
  return (
    <span className={`state-badge ${entry.status}`}>
      {entry.status}
      {entry.activityStale ? ' · stale' : ''}
    </span>
  );
}

function AddProjectForm({ onAdded, busy }: { onAdded: () => Promise<void>; busy: boolean }) {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  return (
    <form
      className="project-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        const root = String(values.get('root') || '').trim();
        const displayName = String(values.get('displayName') || '').trim();
        if (!root) return;
        setSubmitting(true);
        setError(undefined);
        void api('projects', {
          method: 'POST',
          body: { root, ...(displayName ? { displayName } : {}) },
        })
          .then(async () => {
            form.reset();
            await onAdded();
          })
          .catch((failure) => setError(apiError(failure).message))
          .finally(() => setSubmitting(false));
      }}
    >
      <Label>
        Project path
        <Input name="root" required placeholder="C:\path\to\project or /path/to/project" />
      </Label>
      <Label>
        Display name (optional)
        <Input name="displayName" placeholder="Defaults to the folder name" />
      </Label>
      <Button type="submit" disabled={busy || submitting}>
        Add existing project
      </Button>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function ProjectCard({
  entry,
  onRemoved,
  busy,
}: {
  entry: ProjectOverviewEntry;
  onRemoved: () => Promise<void>;
  busy: boolean;
}) {
  const [removing, setRemoving] = useState(false);
  return (
    <Card className="project-card">
      <div className="project-card-top">
        <strong>{entry.displayName}</strong>
        <StatusBadge entry={entry} />
      </div>
      <code className="project-root">{entry.root}</code>
      <p className="section-note">
        {entry.identity.kind === 'git'
          ? entry.identity.isMainCheckout
            ? 'Main checkout'
            : 'Linked worktree'
          : entry.identity.kind === 'plain'
            ? 'Not a Git repository'
            : `Unavailable: ${entry.identity.reason}`}
        {entry.groupMemberIds.length > 1
          ? ` · ${entry.groupMemberIds.length - 1} other registered worktree(s) grouped here`
          : ''}
      </p>
      <p className="section-note">
        {count(entry.activity.openTasks)} open task(s) of {count(entry.activity.totalTasks)} ·{' '}
        {count(entry.activity.openWorkflows)} open workflow(s) · last activity{' '}
        {when(entry.activity.lastActivityAt)}
      </p>
      <div className="project-card-actions">
        <Button asChild variant="outline">
          <a href={projectHref(entry.id)}>Open</a>
        </Button>
        <Button
          variant="destructive"
          disabled={busy || removing}
          onClick={() => {
            if (!confirm(`Remove "${entry.displayName}" from the overview? Its files are kept.`))
              return;
            setRemoving(true);
            void api(`projects/${entry.id}`, { method: 'DELETE' })
              .then(onRemoved)
              .finally(() => setRemoving(false));
          }}
        >
          Remove
        </Button>
      </div>
    </Card>
  );
}

function ProjectGrid() {
  const [list, setList] = useState<ProjectList>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      setList(await api<ProjectList>('projects'));
      setError(undefined);
    } catch (failure) {
      setError(apiError(failure).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const representative = list?.projects.filter((entry) => entry.isRepresentative) ?? [];
  return (
    <>
      <header className="topbar">
        <div>
          <span className="breadcrumb">PROJECTS</span>
          <span className="slash">/</span>
          <span>All projects</span>
        </div>
        <div className="topbar-actions">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
          <ThemeToggle />
        </div>
      </header>
      <section className="intro">
        <div>
          <p className="eyebrow">EVERY PROJECT, ONE PLACE</p>
          <h1>
            Your projects,
            <br />
            <span>at a glance.</span>
          </h1>
          <p className="intro-copy">
            Every project Latchkit has initialized, opened, or run work through — plus any you add
            explicitly. A main checkout and its linked worktrees are grouped as one project so
            totals are never double-counted; open one to inspect it on its own.
          </p>
        </div>
      </section>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      <section className="config-section" aria-labelledby="add-project-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ADD A PROJECT</p>
            <h2 id="add-project-heading">Point at an existing project.</h2>
            <p>Registering never moves, copies, or modifies the project's own files.</p>
          </div>
        </div>
        <AddProjectForm busy={loading} onAdded={load} />
      </section>
      <section className="config-section" aria-labelledby="projects-grid-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{representative.length} PROJECT(S)</p>
            <h2 id="projects-grid-heading">Registered projects</h2>
          </div>
        </div>
        {loading && !list ? (
          <p className="section-note">Loading the project registry…</p>
        ) : !representative.length ? (
          <p className="section-note">
            No projects are registered yet. Run <code>latchkit init</code> or{' '}
            <code>latchkit ui</code> in a project, or add one explicitly above.
          </p>
        ) : (
          <div className="project-grid">
            {representative.map((entry) => (
              <ProjectCard key={entry.id} entry={entry} busy={loading} onRemoved={load} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function TaskSummaryList({ tasks }: { tasks: NonNullable<ProjectDetail['tasks']> }) {
  if (!tasks.length) return <p className="section-note">No durable tasks have been recorded.</p>;
  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task.id} className="task-card">
          <div className="evidence-summary">
            <span>{task.title}</span>
            <span className={`state-badge ${task.state}`}>{task.state}</span>
          </div>
          <p className="section-note">
            Revision {task.revision} · updated {when(task.updatedAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function WorkflowSummaryList({
  workflows,
}: {
  workflows: NonNullable<ProjectDetail['workflows']>;
}) {
  if (!workflows.length)
    return <p className="section-note">No delivery workflows have been recorded.</p>;
  return (
    <ul className="task-list">
      {workflows.map((workflow) => (
        <li key={workflow.workflowId} className="task-card">
          <div className="evidence-summary">
            <span>
              {workflow.phase} · task {workflow.taskId}
            </span>
            <span className={`state-badge ${workflow.status}`}>{workflow.status}</span>
          </div>
          <p className="section-note">Updated {when(workflow.updatedAt)}</p>
        </li>
      ))}
    </ul>
  );
}

function ProjectDetailView({ id }: { id: string }) {
  const [detail, setDetail] = useState<ProjectDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      setDetail(await api<ProjectDetail>(`projects/${encodeURIComponent(id)}`));
      setError(undefined);
    } catch (failure) {
      setError(apiError(failure).message);
      setDetail(undefined);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // A different `id` is a different project: this effect always re-fetches from scratch for
    // the current URL rather than reusing another project's in-memory state.
  }, [id]);
  return (
    <>
      <header className="topbar">
        <div>
          <a className="breadcrumb" href="/projects">
            PROJECTS
          </a>
          <span className="slash">/</span>
          <span>{detail?.project.displayName ?? id}</span>
        </div>
        <div className="topbar-actions">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
          <ThemeToggle />
        </div>
      </header>
      <section className="intro">
        <div>
          <Button asChild variant="outline">
            <a href="/projects">
              <ArrowLeft aria-hidden="true" /> All projects
            </a>
          </Button>
        </div>
      </section>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      {!detail ? (
        loading && <p className="section-note">Loading project…</p>
      ) : (
        <>
          <Card className="workspace-card">
            <span className="mini-label">PROJECT</span>
            <strong>{detail.project.displayName}</strong>
            <code>{detail.project.root}</code>
            <div className="workspace-meta">
              <StatusBadge entry={detail.project} />
              <span>
                {detail.project.identity.kind === 'git'
                  ? detail.project.identity.isMainCheckout
                    ? 'Main checkout'
                    : 'Linked worktree'
                  : detail.project.identity.kind === 'plain'
                    ? 'Not a Git repository'
                    : `Unavailable: ${detail.project.identity.reason}`}
              </span>
            </div>
          </Card>
          {detail.project.status === 'unavailable' && (
            <div className="notice notice-error" role="alert">
              This project's location is unavailable (moved, deleted, or unreadable). Its specs,
              tasks, memory, and usage cannot be shown until the path is restored.
            </div>
          )}
          {detail.group.length > 1 && (
            <section className="config-section" aria-labelledby="group-heading">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">SAME REPOSITORY</p>
                  <h2 id="group-heading">Registered worktrees in this group</h2>
                </div>
              </div>
              <ul className="task-list">
                {detail.group.map((member) => (
                  <li key={member.id} className="task-card">
                    <div className="evidence-summary">
                      <a href={projectHref(member.id)}>{member.displayName}</a>
                      <StatusBadge entry={member} />
                    </div>
                    <code className="project-root">{member.root}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!detail.worktrees.length && (
            <section className="config-section" aria-labelledby="worktrees-heading">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">GIT WORKTREES</p>
                  <h2 id="worktrees-heading">Relevant worktrees</h2>
                  <p>
                    Read from Git directly; a worktree not yet in the registry can be added above.
                  </p>
                </div>
              </div>
              <ul className="task-list">
                {detail.worktrees.map((worktree) => (
                  <li key={worktree.path} className="task-card">
                    <div className="evidence-summary">
                      <code className="project-root">{worktree.path}</code>
                      <span className="state-badge">{worktree.isMain ? 'main' : 'linked'}</span>
                    </div>
                    <p className="section-note">
                      Branch: {worktree.branch ?? 'detached'}
                      {worktree.isRegistered
                        ? worktree.registeredProjectId && (
                            <>
                              {' '}
                              ·{' '}
                              <a href={projectHref(worktree.registeredProjectId)}>
                                open its registered entry
                              </a>
                            </>
                          )
                        : ' · not registered'}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="config-section" aria-labelledby="specs-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">SPECS AND PLANS</p>
                <h2 id="specs-heading">Durable plans</h2>
              </div>
            </div>
            {!detail.specs.length ? (
              <p className="section-note">
                No durable plans under docs/plans/ or .latchkit/notes/.
              </p>
            ) : (
              <ul className="task-list">
                {detail.specs.map((spec) => (
                  <li key={spec.path} className="task-card">
                    <code className="project-root">{spec.path}</code>
                    <p className="section-note">
                      {spec.bytes.toLocaleString()} bytes · modified {when(spec.modifiedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="config-section" aria-labelledby="detail-tasks-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">TASK STATE</p>
                <h2 id="detail-tasks-heading">Tasks</h2>
              </div>
            </div>
            {detail.tasks ? (
              <TaskSummaryList tasks={detail.tasks} />
            ) : (
              <p className="section-note">Task state is unavailable for this project.</p>
            )}
          </section>
          <section className="config-section" aria-labelledby="detail-workflows-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">DELIVERY WORKFLOWS</p>
                <h2 id="detail-workflows-heading">Workflows</h2>
              </div>
            </div>
            {detail.workflows ? (
              <WorkflowSummaryList workflows={detail.workflows} />
            ) : (
              <p className="section-note">Workflow state is unavailable for this project.</p>
            )}
          </section>
          <section className="config-section" aria-labelledby="detail-memory-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">PROJECT MEMORY</p>
                <h2 id="detail-memory-heading">Memory</h2>
              </div>
            </div>
            <p className="section-note">
              {detail.memory
                ? `${detail.memory.count} record(s) · revision ${detail.memory.revision}`
                : 'Project memory is unavailable for this project.'}
            </p>
          </section>
          <section className="config-section" aria-labelledby="detail-usage-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">USAGE</p>
                <h2 id="detail-usage-heading">Usage overview</h2>
              </div>
            </div>
            {detail.usage.status === 'unavailable' ? (
              <p className="section-note">Usage is unavailable: {detail.usage.reason}</p>
            ) : (
              <p className="section-note">
                {count(detail.usage.overview.totals.recordCount)} session(s) · input{' '}
                {count(detail.usage.overview.totals.tokens.input)} / output{' '}
                {count(detail.usage.overview.totals.tokens.output)} tokens · estimated{' '}
                {money(detail.usage.overview.totals.estimatedUsd)}
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}

export function ProjectsConsole() {
  const [projectId, setProjectId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('project'),
  );
  useEffect(() => {
    const onNavigate = () => setProjectId(new URLSearchParams(location.search).get('project'));
    window.addEventListener('popstate', onNavigate);
    return () => window.removeEventListener('popstate', onNavigate);
  }, []);
  if (!hasSession()) {
    return (
      <Shell>
        <div className="notice notice-error" role="alert">
          Open the complete session URL printed by Latchkit to connect this dashboard.
        </div>
      </Shell>
    );
  }
  return <Shell>{projectId ? <ProjectDetailView id={projectId} /> : <ProjectGrid />}</Shell>;
}
