import type { WorkflowRecord } from '../src/workflows/contracts.js';

type Api = <T>(route: string, options?: { method?: string; body?: unknown }) => Promise<T>;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function field(label: string, input: HTMLElement) {
  const wrapper = node('label', label);
  input.setAttribute('aria-label', label);
  wrapper.append(input);
  return wrapper;
}

export function createWorkflowConsole(
  api: Api,
  notice: (message: string, error?: boolean) => void,
) {
  const container = document.getElementById('workflow-console');
  if (!container) throw new Error('Workflow console is missing.');
  const form = node('form');
  form.className = 'memory-form';
  const prompt = node('textarea');
  prompt.required = true;
  prompt.maxLength = 16_384;
  const provider = node('select');
  provider.required = true;
  const reviewer = node('select');
  reviewer.append(new Option('Use selected provider', ''));
  const authorized = node('input');
  authorized.type = 'checkbox';
  authorized.required = true;
  const run = node('button', 'Start requirements');
  run.type = 'submit';
  run.className = 'button button-primary';
  form.append(
    field('What should be delivered?', prompt),
    field('Coding provider', provider),
    field('Independent reviewer', reviewer),
    field(
      'Authorize local coding-tool execution. Implementation waits for plan approval.',
      authorized,
    ),
    run,
  );
  const refresh = node('button', 'Refresh workflows');
  refresh.type = 'button';
  refresh.className = 'button button-secondary';
  const list = node('div');
  list.className = 'task-list';
  container.append(form, refresh, list);

  async function action(operation: () => Promise<void>) {
    try {
      await operation();
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error), true);
    }
  }

  function display(workflow: WorkflowRecord) {
    const card = node('article');
    card.className = 'task-card';
    card.append(
      node('h3', workflow.initialPrompt),
      node('p', `${workflow.status} · ${workflow.phase} · Repairs ${workflow.repairAttempts}/3`),
    );
    card.append(node('p', workflow.lastOutcome.summary));
    for (const [title, content] of [
      ['Requirements', workflow.requirements?.artifact],
      ['Plan', workflow.plan?.artifact],
      [
        'Acceptance checks',
        workflow.plan ? JSON.stringify(workflow.plan.checks, null, 2) : undefined,
      ],
    ]) {
      if (!content) continue;
      const details = node('details');
      details.open = workflow.status === 'awaiting-approval';
      details.append(node('summary', title), node('pre', content));
      card.append(details);
    }
    if (workflow.status === 'awaiting-approval' && workflow.plan && workflow.requirements) {
      const approval = node('form');
      approval.className = 'memory-form';
      const scope = node('textarea');
      scope.required = true;
      scope.maxLength = 4_000;
      const reference = node('input');
      reference.required = true;
      reference.maxLength = 1_000;
      const approve = node('button', 'Approve this plan and acceptance checks');
      approve.className = 'button button-primary';
      approval.append(
        field('Authorized change scope', scope),
        field('Approval reference', reference),
        approve,
      );
      approval.addEventListener('submit', (event) => {
        event.preventDefault();
        void action(async () => {
          approve.disabled = true;
          try {
            await api('workflows/approve', {
              method: 'POST',
              body: {
                taskId: workflow.taskId,
                expectedRevision: workflow.revision,
                planDigest: workflow.plan?.digest,
                requirementsDigest: workflow.requirements?.digest,
                checksDigest: workflow.plan?.checksDigest,
                scope: scope.value,
                reference: reference.value,
              },
            });
            await reload();
          } finally {
            approve.disabled = false;
          }
        });
      });
      card.append(approval);
    }
    if (['awaiting-input', 'blocked', 'interrupted'].includes(workflow.status)) {
      const resume = node('form');
      resume.className = 'memory-form';
      const answer = node('textarea');
      answer.maxLength = 16_384;
      const permission = node('input');
      permission.type = 'checkbox';
      permission.required = true;
      const decision = node('select');
      const evidence = node('input');
      if (workflow.pendingAction) {
        decision.required = true;
        decision.append(
          new Option('Choose how to resolve the interrupted action', ''),
          new Option('Supply observed result', 'observed'),
          new Option('Abandon this action', 'abandon'),
          new Option('Explicitly authorize retry', 'retry'),
        );
        evidence.placeholder = 'Persisted task evidence ID';
        resume.append(field('Interrupted action', decision), field('Observed evidence', evidence));
      }
      const button = node('button', 'Resume workflow');
      button.className = 'button button-secondary';
      resume.append(
        field('Answers or updated requirements', answer),
        field('Authorize local coding-tool execution', permission),
        button,
      );
      resume.addEventListener('submit', (event) => {
        event.preventDefault();
        void action(async () => {
          button.disabled = true;
          try {
            await api('workflows/resume', {
              method: 'POST',
              body: {
                taskId: workflow.taskId,
                expectedRevision: workflow.revision,
                executionAuthorized: permission.checked,
                ...(answer.value.trim() ? { prompt: answer.value } : {}),
                ...(workflow.pendingAction
                  ? {
                      resolution: {
                        actionId: workflow.pendingAction.actionId,
                        decision: decision.value,
                        ...(decision.value === 'observed' ? { evidenceId: evidence.value } : {}),
                      },
                    }
                  : {}),
              },
            });
            await reload();
          } finally {
            button.disabled = false;
          }
        });
      });
      card.append(resume);
    }
    if (!['cancelled', 'completed', 'verified'].includes(workflow.status)) {
      const cancel = node('button', 'Cancel workflow');
      cancel.className = 'button button-secondary';
      cancel.addEventListener(
        'click',
        () =>
          void action(async () => {
            await api('workflows/cancel', {
              method: 'POST',
              body: { taskId: workflow.taskId, expectedRevision: workflow.revision },
            });
            await reload();
          }),
      );
      card.append(cancel);
    }
    return card;
  }

  async function reload() {
    const response = await api<{ workflows: WorkflowRecord[] }>('workflows');
    list.replaceChildren(...response.workflows.map(display));
    if (!response.workflows.length) list.append(node('p', 'No delivery workflows yet.'));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void action(async () => {
      run.disabled = true;
      try {
        await api('workflows/run', {
          method: 'POST',
          body: {
            prompt: prompt.value,
            providerId: provider.value,
            ...(reviewer.value ? { reviewProviderId: reviewer.value } : {}),
            executionAuthorized: authorized.checked,
          },
        });
        form.reset();
        await reload();
      } finally {
        run.disabled = false;
      }
    });
  });
  refresh.addEventListener('click', () => void action(reload));
  return {
    reload,
    configure(providers: { id: string; label: string }[]) {
      const selected = provider.value;
      const selectedReviewer = reviewer.value;
      provider.replaceChildren(...providers.map((item) => new Option(item.label, item.id)));
      reviewer.replaceChildren(
        new Option('Use selected provider', ''),
        ...providers.map((item) => new Option(item.label, item.id)),
      );
      if (providers.some((item) => item.id === selected)) provider.value = selected;
      reviewer.value = selectedReviewer;
    },
  };
}
