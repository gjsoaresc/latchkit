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
let busy = false;
let plan;
const providerInitials = { claude: 'C', codex: 'O', gemini: 'G', cursor: '↗', 'cursor-cli': '>_' };
const skillIcons = { spec: '◇', fix: '⌁', review: '◎', handoff: '⇢' };

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

async function api(route, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The local server returned an unreadable response.');
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function showNotice(message, isError = false) {
  $('notice').textContent = message;
  $('notice').className = `notice ${isError ? 'notice-error' : 'notice-success'}`;
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
  return Boolean(savedConfig) && JSON.stringify(selection()) !== JSON.stringify(savedConfig);
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
        : 'Configuration saved. Ready to preview.';
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
    const top = el('div', 'provider-top');
    top.append(
      el('span', 'provider-symbol', providerInitials[provider.id] || provider.label.slice(0, 1)),
      input,
    );
    label.append(top, el('strong', 'provider-name', provider.label));
    const detection = el(
      'span',
      `detection ${detected ? 'is-detected' : ''}`,
      detected ? 'Detected' : 'Not detected',
    );
    if (diagnostic?.path) detection.title = diagnostic.path;
    label.append(detection, el('code', 'skill-directory', provider.skillDirectory));
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

function renderState() {
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
  updateActions();
}

function renderPlan(nextPlan) {
  plan = { changes: nextPlan.changes || [], conflicts: nextPlan.conflicts || [] };
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

async function action(operation) {
  if (busy) return;
  busy = true;
  updateActions();
  try {
    await operation();
  } catch (error) {
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
    state.config = savedConfig;
    renderProviders();
    renderSkills();
    showNotice('Configuration saved. Preview your sync to review the generated files.');
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
    await api('sync', { method: 'POST', body: {} });
    renderPlan(await api('plan'));
    showNotice('Skills synced. Reload skills or restart your coding agent to pick up the changes.');
  }),
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
    state = await api('state');
    savedConfig = state.config;
    renderState();
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
