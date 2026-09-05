const $ = (id) => document.getElementById(id);
const sessionKey = `latchkit-session:${location.host}`;
const fragment = location.hash.slice(1);
let token = /^[a-f0-9]{64}$/.test(fragment) ? fragment : '';
try {
  if (token) sessionStorage.setItem(sessionKey, token);
  else token = sessionStorage.getItem(sessionKey) || '';
} catch {
  /* The launch URL still works when browser storage is disabled. */
}
if (/^[a-f0-9]{64}$/.test(fragment)) history.replaceState(null, '', location.pathname);

let state;
let savedConfig;
let configRevision;
let busy = false;
let plan;
const API_VERSION = 1;
const providerInitials = {
  claude: 'C',
  codex: 'O',
  antigravity: 'A',
  cursor: '↗',
  'cursor-cli': '>_',
};
const skillIcons = { spec: '◇', fix: '⌁', review: '◎', handoff: '⇢' };

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

async function api(route, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`/api/${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(route === 'config' && method === 'PUT' ? { 'If-Match': configRevision } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(
      'The local server is unavailable. Check the terminal running Latchkit and retry.',
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The local server returned an unreadable response.');
  }
  if (!response.ok) {
    const message =
      response.status === 401
        ? 'This session key has expired. Reopen the complete URL printed by Latchkit.'
        : data.error || `Request failed (${response.status}).`;
    const error = new Error(message);
    Object.assign(error, data);
    error.status = response.status;
    throw error;
  }
  if (data.apiVersion !== API_VERSION)
    throw new Error('This console needs a newer local API. Restart Latchkit.');
  return data;
}

function showNotice(message, isError = false) {
  const notice = $('notice');
  notice.textContent = message;
  notice.className = `notice ${isError ? 'notice-error' : 'notice-success'}`;
  notice.setAttribute('role', isError ? 'alert' : 'status');
  notice.focus({ preventScroll: true });
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function comparable(config) {
  return JSON.stringify({
    ...config,
    providers: sorted(config.providers || []),
    skills: sorted(config.skills || []),
  });
}

function selection() {
  return {
    ...savedConfig,
    providers: [...document.querySelectorAll('input[name="provider"]:checked')].map(
      (input) => input.value,
    ),
    skills: [...document.querySelectorAll('input[name="skill"]:checked')].map(
      (input) => input.value,
    ),
  };
}

function isDirty() {
  return Boolean(savedConfig) && comparable(selection()) !== comparable(savedConfig);
}

function updateActions() {
  const dirty = isDirty();
  $('save').disabled = busy || !state || !dirty;
  $('preview').disabled = busy || !state || dirty;
  $('apply').disabled =
    busy ||
    dirty ||
    !plan ||
    plan.conflicts.length > 0 ||
    !plan.changes.some((change) => change.action !== 'unchanged');
  document.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.disabled = busy;
  });
  $('selection-status').textContent = busy
    ? 'Working on your workspace…'
    : !state
      ? 'Connect this session to load configuration.'
      : dirty
        ? 'You have unsaved changes.'
        : selection().providers.length && selection().skills.length
          ? 'Configuration saved. Ready to preview.'
          : 'Configuration saved with an empty selection. Preview will remove managed skills.';
  if (state) $('skill-count').textContent = selection().skills.length;
}

function invalidatePlan() {
  plan = undefined;
  $('plan-panel').classList.add('hidden');
  $('sync-status').textContent = 'Changed';
  $('sync-caption').textContent = 'Save and preview to sync';
  updateActions();
}

function renderProviders() {
  const container = $('providers');
  container.replaceChildren();
  for (const provider of state.providers) {
    const diagnostic = state.doctor.providers.find((item) => item.id === provider.id);
    const detected = Boolean(diagnostic?.detected);
    const label = el('label', `provider-card provider-${provider.id}`);
    const input = el('input');
    input.type = 'checkbox';
    input.name = 'provider';
    input.value = provider.id;
    input.checked = savedConfig.providers.includes(provider.id);
    input.setAttribute('aria-describedby', `provider-${provider.id}-details`);
    const top = el('div', 'provider-top');
    top.append(
      el('span', 'provider-symbol', providerInitials[provider.id] || provider.label.slice(0, 1)),
      input,
    );
    label.append(top, el('strong', 'provider-name', provider.label));
    const detection = el(
      'span',
      `detection ${detected ? 'is-detected' : ''}`,
      detected ? 'Executable on PATH' : 'Executable not found on PATH',
    );
    if (diagnostic?.path) detection.title = diagnostic.path;
    const details = el(
      'span',
      'sr-only',
      `${provider.label} status: ${detected ? 'executable on PATH' : 'executable not found on PATH'}. Skill export is supported; integration is not verified.`,
    );
    details.id = `provider-${provider.id}-details`;
    label.append(detection, el('code', 'skill-directory', provider.skillDirectory), details);
    input.addEventListener('change', invalidatePlan);
    container.append(label);
  }
}

function renderSkills() {
  const container = $('skills');
  container.replaceChildren();
  for (const skill of state.skills) {
    const label = el('label', 'skill-card');
    const input = el('input');
    input.type = 'checkbox';
    input.name = 'skill';
    input.value = skill.id;
    input.checked = savedConfig.skills.includes(skill.id);
    input.setAttribute('aria-label', `${skill.label}: ${skill.description}`);
    const top = el('div', 'skill-top');
    top.append(el('span', 'skill-icon', skillIcons[skill.id] || '◇'), input);
    label.append(
      top,
      el('strong', 'skill-name', skill.label),
      el('p', 'skill-description', skill.description),
    );
    input.addEventListener('change', invalidatePlan);
    container.append(label);
  }
}

function renderState({ preserveSelection = null } = {}) {
  const project = String(state.doctor.project || 'Current project');
  $('project-name').textContent = project.split(/[\\/]/).filter(Boolean).at(-1) || project;
  $('project-path').textContent = project;
  $('project-path').title = project;
  const platformNames = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
  $('platform-label').textContent =
    platformNames[state.doctor.platform] || String(state.doctor.platform);
  $('runtime-label').textContent = `${state.doctor.runtime || 'Node'} · ${state.doctor.node || ''}`;
  $('installed-count').textContent = state.doctor.providers.filter(
    (provider) => provider.detected,
  ).length;
  renderProviders();
  renderSkills();
  if (preserveSelection) {
    document.querySelectorAll('input[name="provider"]').forEach((input) => {
      input.checked = preserveSelection.providers.includes(input.value);
    });
    document.querySelectorAll('input[name="skill"]').forEach((input) => {
      input.checked = preserveSelection.skills.includes(input.value);
    });
  }
  updateActions();
}

function renderPlan(nextPlan) {
  plan = {
    changes: nextPlan.changes || [],
    conflicts: nextPlan.conflicts || [],
    planId: nextPlan.planId,
  };
  const changes = plan.changes.filter((change) => change.action !== 'unchanged');
  const unchanged = plan.changes.length - changes.length;
  $('plan-summary').textContent = `${changes.length} pending · ${unchanged} unchanged`;
  const list = $('plan-changes');
  list.replaceChildren();
  for (const change of changes) {
    const row = el('li', 'plan-row');
    row.append(
      el('span', `change-action action-${change.action}`, change.action),
      el('code', 'change-path', change.path),
    );
    list.append(row);
  }
  if (!changes.length)
    list.append(
      el('li', 'empty-plan', 'Everything is already in place. No file changes are needed.'),
    );
  $('conflicts').replaceChildren();
  $('conflicts').classList.toggle('hidden', !plan.conflicts.length);
  if (plan.conflicts.length) {
    $('conflicts').append(el('strong', '', 'Resolve these conflicts before syncing.'));
    for (const conflict of plan.conflicts)
      $('conflicts').append(el('p', '', `${conflict.path}: ${conflict.reason}`));
  }
  $('plan-note').textContent = plan.conflicts.length
    ? 'Existing files need your attention. No changes have been applied.'
    : 'Review these paths before applying the sync.';
  $('plan-panel').classList.remove('hidden');
  $('sync-status').textContent = plan.conflicts.length
    ? 'Conflict'
    : changes.length
      ? 'Pending'
      : 'In sync';
  $('sync-caption').textContent = plan.conflicts.length
    ? `${plan.conflicts.length} conflicts to resolve`
    : changes.length
      ? `${changes.length} file changes ready`
      : 'Your workflow is up to date';
  updateActions();
}

function artifactLocation(evidence) {
  try {
    const artifact = JSON.parse(evidence.artifact || '{}');
    return typeof artifact.location === 'string' &&
      artifact.location.startsWith('.latchkit/tasks/acceptance-evidence/')
      ? artifact.location
      : null;
  } catch {
    return null;
  }
}

function sameSource(left, right) {
  return left?.revision === right?.revision && left?.dirtyFingerprint === right?.dirtyFingerprint;
}

function renderAcceptance(tasks = []) {
  const container = $('acceptance-evidence');
  container.replaceChildren();
  const rows = [];
  for (const task of tasks) {
    for (const criterion of task.criteria || []) {
      const evidence = [...(task.evidence || [])]
        .reverse()
        .find(
          (item) =>
            item.criterionId === criterion.id && item.criterionRevision === criterion.revision,
        );
      if (!evidence) continue;
      const location = artifactLocation(evidence);
      const outcome = sameSource(evidence.source, task.reconciliation?.currentSource)
        ? evidence.outcome
        : 'stale';
      const row = el('article', 'evidence-row');
      const summary = el('div', 'evidence-summary');
      summary.append(
        el('strong', '', criterion.description),
        el('span', `evidence-outcome outcome-${outcome}`, outcome),
      );
      row.append(summary);
      if (location) row.append(el('code', 'evidence-location', location));
      rows.push(row);
    }
  }
  if (rows.length) container.append(...rows);
  else container.append(el('p', 'section-note', 'No task evidence has been recorded.'));
}

function renderTasks(tasks = []) {
  const container = $('task-list');
  container.replaceChildren();
  if (!tasks.length) {
    container.append(
      el('p', 'section-note', 'No durable tasks have been recorded in this project.'),
    );
    return;
  }
  for (const task of tasks) {
    const card = el('details', 'task-card');
    const summary = el('summary');
    summary.append(el('span', '', task.title), el('span', `state-badge ${task.state}`, task.state));
    card.append(summary);
    const detail = el('div', 'task-detail');
    detail.append(
      el(
        'p',
        'section-note',
        `Revision ${task.revision} · process ${task.reconciliation?.recordedProcess ?? 'unknown'}`,
      ),
    );
    const criteria = el('ul');
    for (const criterion of task.criteria || []) {
      const evidence = [...(task.evidence || [])]
        .reverse()
        .find(
          (item) =>
            item.criterionId === criterion.id && item.criterionRevision === criterion.revision,
        );
      criteria.append(el('li', '', `${criterion.description} — ${evidence?.outcome ?? 'missing'}`));
    }
    detail.append(el('strong', '', 'Acceptance criteria'), criteria);
    const review = el('section', 'task-review');
    review.append(el('strong', '', 'Revision-bound review feedback'));
    const annotationForm = el('form', 'annotation-form');
    const annotationPath = el('input');
    annotationPath.required = true;
    annotationPath.placeholder = 'Task-worktree path';
    annotationPath.setAttribute('aria-label', 'Review feedback file path');
    const annotationLine = el('input');
    annotationLine.required = true;
    annotationLine.type = 'number';
    annotationLine.min = '1';
    annotationLine.value = '1';
    annotationLine.setAttribute('aria-label', 'Review feedback line number');
    const annotationBody = el('input');
    annotationBody.required = true;
    annotationBody.placeholder = 'Untrusted review feedback';
    annotationBody.setAttribute('aria-label', 'Review feedback text');
    const annotate = el('button', 'button button-secondary', 'Add feedback');
    annotate.type = 'submit';
    annotationForm.append(annotationPath, annotationLine, annotationBody, annotate);
    const feedback = el(
      'div',
      'annotation-list',
      'Load feedback to inspect the current diff revision.',
    );
    const loadFeedback = el('button', 'button button-secondary', 'Load review feedback');
    loadFeedback.type = 'button';
    loadFeedback.addEventListener('click', () =>
      action(async () => {
        const data = await api(`annotations?taskId=${encodeURIComponent(task.id)}`);
        feedback.replaceChildren();
        if (!data.annotations.length)
          feedback.append(el('p', 'section-note', 'No review feedback is recorded.'));
        for (const annotation of data.annotations) {
          const row = el('article', `annotation annotation-${annotation.status}`);
          row.append(
            el('code', '', `${annotation.path}:${annotation.line} (${annotation.side})`),
            el('p', '', annotation.body),
            el(
              'span',
              'section-note',
              annotation.stale ? 'Stale: the reviewed revision changed.' : annotation.status,
            ),
          );
          if (annotation.status === 'open') {
            const evidence = el('input', 'annotation-evidence');
            evidence.type = 'text';
            evidence.placeholder = 'Current task evidence ID required to resolve';
            evidence.setAttribute('aria-label', 'Evidence ID proving this feedback was resolved');
            const resolve = el(
              'button',
              'button button-secondary',
              'Resolve with current revision',
            );
            resolve.type = 'button';
            resolve.addEventListener('click', () =>
              action(async () => {
                await api('annotations/action', {
                  method: 'POST',
                  body: {
                    taskId: task.id,
                    annotationId: annotation.id,
                    action: 'resolve',
                    expectedStoreRevision: data.revision,
                    evidenceRevision: data.currentRevision,
                    evidenceId: evidence.value.trim(),
                  },
                });
                loadFeedback.click();
              }),
            );
            row.append(evidence, resolve);
          } else if (annotation.status === 'resolved') {
            const reopen = el('button', 'button button-secondary', 'Reopen');
            reopen.type = 'button';
            reopen.addEventListener('click', () =>
              action(async () => {
                await api('annotations/action', {
                  method: 'POST',
                  body: {
                    taskId: task.id,
                    annotationId: annotation.id,
                    action: 'reopen',
                    expectedStoreRevision: data.revision,
                  },
                });
                loadFeedback.click();
              }),
            );
            row.append(reopen);
          }
          feedback.append(row);
        }
      }),
    );
    annotationForm.addEventListener('submit', (event) => {
      event.preventDefault();
      action(async () => {
        const [diff, annotations] = await Promise.all([
          api(`diff?taskId=${encodeURIComponent(task.id)}`),
          api(`annotations?taskId=${encodeURIComponent(task.id)}`),
        ]);
        await api('annotations', {
          method: 'POST',
          body: {
            taskId: task.id,
            path: annotationPath.value,
            side: 'right',
            line: Number(annotationLine.value),
            body: annotationBody.value,
            expectedRevision: diff.revision,
            expectedStoreRevision: annotations.revision,
          },
        });
        annotationForm.reset();
        loadFeedback.click();
      });
    });
    review.append(annotationForm, loadFeedback, feedback);
    detail.append(review);
    if (task.checkpoints?.length) {
      const last = task.checkpoints.at(-1);
      detail.append(el('p', 'section-note', `Latest checkpoint: ${last.summary}`));
    }
    if (task.state !== 'cancelled' && task.state !== 'verified') {
      const actions = el('div', 'task-action-row');
      const cancel = el('button', 'button button-secondary', 'Cancel task');
      cancel.type = 'button';
      cancel.addEventListener('click', () =>
        action(async () => {
          const result = await api('tasks/cancel', {
            method: 'POST',
            body: {
              taskId: task.id,
              expectedRevision: task.revision,
              mutationId: crypto.randomUUID(),
              reason: 'Cancelled from local workbench.',
            },
          });
          showNotice(
            result.cancelledProcess
              ? 'Task and its owned local process were cancelled.'
              : 'Task was cancelled; no owned process was running.',
          );
          await reloadWorkbench();
        }),
      );
      actions.append(cancel);
      detail.append(actions);
    }
    card.append(detail);
    container.append(card);
  }
}

function renderMemory(page) {
  const container = $('memory-list');
  container.replaceChildren();
  if (!page.memories?.length) {
    container.append(
      el(
        'p',
        'section-note',
        page.query ? 'No local memory matched that search.' : 'No local memory has been captured.',
      ),
    );
    return;
  }
  for (const item of page.memories) {
    const memory = item.memory;
    const card = el('article', 'memory-card');
    card.append(el('h3', '', memory.title), el('p', '', memory.text));
    const footer = el('footer');
    footer.append(el('span', 'section-note', `${memory.kind} · revision ${memory.revision}`));
    const remove = el('button', 'button button-secondary', 'Delete');
    remove.type = 'button';
    remove.addEventListener('click', () =>
      action(async () => {
        await api(`memory/${memory.id}`, {
          method: 'DELETE',
          body: { expectedRevision: memory.revision },
        });
        showNotice('Memory deleted locally. Existing exports and Git history are not changed.');
        await reloadWorkbench();
      }),
    );
    footer.append(remove);
    card.append(footer);
    container.append(card);
  }
}

async function reloadWorkbench() {
  const data = await api('workbench');
  renderTasks(data.tasks?.tasks || []);
  renderMemory(data.memory);
  renderAcceptance(data.tasks?.tasks || []);
  $('workbench-status').textContent =
    `Authoritative local state: task revision ${data.tasks?.revision ?? 0}, memory revision ${data.memory?.revision ?? 0}.`;
  const selected = $('recovery-provider');
  const prior = selected.value;
  selected.replaceChildren();
  for (const provider of state.providers.filter((item) =>
    savedConfig.providers.includes(item.id),
  )) {
    const option = el('option', '', provider.label);
    option.value = provider.id;
    selected.append(option);
  }
  if (prior && [...selected.options].some((option) => option.value === prior))
    selected.value = prior;
  $('recover-memory').disabled = !selected.value;
}

async function action(operation) {
  if (busy) return;
  busy = true;
  updateActions();
  try {
    await operation();
  } catch (error) {
    if (error.code === 'CONFIG_REVISION_CONFLICT' || error.code === 'SYNC_PLAN_STALE') {
      const pendingSelection = selection();
      await reloadState({ preserveSelection: pendingSelection });
      invalidatePlan();
      showNotice(
        'Workspace changed elsewhere. Your edits were kept. Review them, save again, and create a new preview.',
        true,
      );
      return;
    }
    if (error.status === 401) token = '';
    showNotice(error.message, true);
  } finally {
    busy = false;
    updateActions();
  }
}

$('save').addEventListener('click', () =>
  action(async () => {
    const data = await api('config', { method: 'PUT', body: selection() });
    savedConfig = data.config;
    configRevision = data.configRevision;
    state.config = savedConfig;
    renderProviders();
    renderSkills();
    showNotice(
      selection().providers.length && selection().skills.length
        ? 'Configuration saved. Preview your sync to review the generated files.'
        : 'Configuration saved with an empty selection. Preview will remove managed skills.',
    );
  }),
);

$('preview').addEventListener('click', () =>
  action(async () => {
    renderPlan(await api('plan'));
    showNotice(
      plan.conflicts.length
        ? 'Sync preview found conflicts. Review the details below.'
        : 'Sync preview is ready. Review the file changes below.',
      plan.conflicts.length > 0,
    );
  }),
);

$('apply').addEventListener('click', () =>
  action(async () => {
    await api('sync', { method: 'POST', body: { planId: plan.planId } });
    renderPlan(await api('plan'));
    showNotice('Skills synced. Reload skills or restart your coding agent to pick up the changes.');
  }),
);

async function reloadState(options = {}) {
  state = await api('state');
  savedConfig = state.config;
  configRevision = state.configRevision;
  renderState(options);
  await reloadWorkbench();
}

$('refresh-workbench').addEventListener('click', () =>
  action(async () => {
    await reloadWorkbench();
    showNotice('Local task and memory state refreshed.');
  }),
);

$('memory-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action(async () => {
    await api('memory', {
      method: 'POST',
      body: {
        title: $('memory-title').value,
        kind: $('memory-kind').value,
        text: $('memory-text').value,
      },
    });
    $('memory-form').reset();
    showNotice('Memory recorded locally.');
    await reloadWorkbench();
  });
});

$('search-memory').addEventListener('click', () =>
  action(async () => {
    const query = $('memory-query').value.trim();
    renderMemory(await api(`memory?query=${encodeURIComponent(query)}`));
  }),
);

$('recover-memory').addEventListener('click', () =>
  action(async () => {
    const result = await api('memory/recover', {
      method: 'POST',
      body: {
        providerId: $('recovery-provider').value,
        query: $('memory-query').value.trim(),
        budget: 4000,
      },
    });
    const output = $('recovery-context');
    output.textContent = result.context || result.reason;
    output.classList.remove('hidden');
    showNotice(
      result.mode === 'on-demand'
        ? 'Bounded historical context was built; revalidate its sources.'
        : result.reason,
    );
  }),
);

$('export-memory').addEventListener('click', () =>
  action(async () => {
    const exported = await api('memory/export');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(
      new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
    );
    link.download = 'latchkit-project-memory.json';
    link.click();
    URL.revokeObjectURL(link.href);
    showNotice('Memory export downloaded for your review. It was not uploaded.');
  }),
);

window.addEventListener('beforeunload', (event) => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener('online', () =>
  action(async () => {
    await reloadWorkbench();
    showNotice('Connection restored and authoritative local state was refreshed.');
  }),
);
window.addEventListener('offline', () =>
  showNotice('Connection lost. Your current edits are still on this page.', true),
);

async function initialize() {
  if (!token) {
    showNotice(
      'Open the complete session URL printed by Latchkit to connect this dashboard.',
      true,
    );
    $('project-name').textContent = 'Session key required';
    $('project-path').textContent = 'Run latchkit ui in your project';
    updateActions();
    return;
  }
  busy = true;
  try {
    await reloadState();
  } catch (error) {
    showNotice(error.message, true);
    $('project-name').textContent = 'Unable to connect';
    $('project-path').textContent = 'Check the terminal running Latchkit';
  } finally {
    busy = false;
    updateActions();
  }
}

initialize();

setInterval(() => {
  if (!token || busy || document.hidden) return;
  reloadWorkbench().catch(() => {
    $('workbench-status').textContent =
      'Local state refresh is unavailable; the displayed state may be stale.';
  });
}, 10_000);
