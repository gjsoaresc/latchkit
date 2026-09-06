import { useState } from 'react';
import { api } from './api.js';
import type { ConsoleStore } from './console-store.js';
import type { MemoryPage, RecoveryContext } from './types.js';
import { Button } from './components/ui/button.js';
import { Input, Textarea, NativeSelect, Label } from './components/ui/fields.js';

export function MemoryConsole({
  store,
  page,
  providers,
  busy,
}: {
  store: ConsoleStore;
  page?: MemoryPage;
  providers: { id: string; label: string }[];
  busy: boolean;
}) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const selected = providers.some((item) => item.id === provider)
    ? provider
    : providers[0]?.id || '';
  const [context, setContext] = useState<string>();
  return (
    <>
      <form
        id="memory-form"
        className="memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          void store.action(async () => {
            await api('memory', {
              method: 'POST',
              body: {
                title: values.get('title'),
                kind: values.get('kind'),
                text: values.get('text'),
              },
            });
            form.reset();
            store.notice('Memory recorded locally.');
            await store.reloadWorkbench();
          });
        }}
      >
        <Label>
          Title <Input id="memory-title" name="title" required maxLength={16384} />
        </Label>
        <Label>
          Kind
          <NativeSelect id="memory-kind" name="kind">
            <option value="discovery">Discovery</option>
            <option value="decision">Decision</option>
            <option value="constraint">Constraint</option>
            <option value="resolved-defect">Resolved defect</option>
          </NativeSelect>
        </Label>
        <Label className="memory-text-label">
          Record
          <Textarea id="memory-text" name="text" required maxLength={16384} />
        </Label>
        <Button type="submit" disabled={busy}>
          Add memory
        </Button>
      </form>
      <form
        className="memory-controls"
        onSubmit={(event) => {
          event.preventDefault();
          void store.search(query);
        }}
      >
        <Label htmlFor="memory-query">Search local memory</Label>
        <Input
          id="memory-query"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button id="search-memory" variant="outline" type="submit" disabled={busy}>
          Search
        </Button>
        <Label htmlFor="recovery-provider">Recovery provider</Label>
        <NativeSelect
          id="recovery-provider"
          value={selected}
          onChange={(event) => setProvider(event.target.value)}
        >
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </NativeSelect>
        <Button
          id="recover-memory"
          variant="outline"
          disabled={busy || !selected}
          onClick={() =>
            void store.action(async () => {
              const result = await api<RecoveryContext>('memory/recover', {
                method: 'POST',
                body: { providerId: selected, query: query.trim(), budget: 4000 },
              });
              setContext(result.context || result.reason);
              store.notice(
                result.mode === 'on-demand'
                  ? 'Bounded historical context was built; revalidate its sources.'
                  : result.reason,
              );
            })
          }
        >
          Build bounded context
        </Button>
      </form>
      <div id="memory-list" className="memory-list" aria-live="polite">
        {!page?.memories.length ? (
          <p className="section-note">
            {page?.query
              ? 'No local memory matched that search.'
              : 'No local memory has been captured.'}
          </p>
        ) : (
          page.memories.map(({ memory }) => (
            <article key={memory.id} className="memory-card">
              <h3>{memory.title}</h3>
              <p>{memory.text}</p>
              <footer>
                <span className="section-note">
                  {memory.kind} · revision {memory.revision}
                </span>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void store.action(async () => {
                      await api(`memory/${memory.id}`, {
                        method: 'DELETE',
                        body: { expectedRevision: memory.revision },
                      });
                      store.notice(
                        'Memory deleted locally. Existing exports and Git history are not changed.',
                      );
                      await store.reloadWorkbench();
                    })
                  }
                >
                  Delete
                </Button>
              </footer>
            </article>
          ))
        )}
      </div>
      {context !== undefined && (
        <pre
          id="recovery-context"
          className="recovery-context"
          aria-label="Bounded historical context"
        >
          {context}
        </pre>
      )}
    </>
  );
}

export async function exportMemory(store: ConsoleStore) {
  await store.action(async () => {
    const exported = await api('memory/export');
    const link = document.createElement('a');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
    );
    link.href = url;
    link.download = 'latchkit-project-memory.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    store.notice('Memory export downloaded for your review. It was not uploaded.');
  });
}
