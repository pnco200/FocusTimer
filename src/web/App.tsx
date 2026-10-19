import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MAX_COUNTER, scalarCount } from '../protocol/index.js';
import { TimerClient } from './client';
import { LocalRepository } from './repository';
import { LocalError, prepareSessionEdit, type HistoryEntry, type Session } from './model';
import { clockText, csvExport, download, focusText, historyExport, sessionDurationText, statistics } from './reporting';
import { ownershipNotice, startupHeading, userError } from './ui-copy';
import { createUuid } from './ids';
import { GoogleDrivePanel } from './GoogleDrivePanel';

function Modal({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={ref} onCancel={event => { event.preventDefault(); close(); }} aria-labelledby="dialog-title">
    <div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}>×</button></div>
    {children}
  </dialog>;
}

function Editor({ entry, save, close }: { entry: HistoryEntry; save(session: Session): Promise<boolean>; close(): void }) {
  const base = entry.winner.payload!;
  const [description, setDescription] = useState(base.description);
  const [adjustment, setAdjustment] = useState('0');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  let preview: Session | undefined;
  let validationError = '';
  let validationCode = '';
  try { preview = prepareSessionEdit(base, description, adjustment); }
  catch (reason) { validationError = userError(reason, 'edit'); if (reason instanceof LocalError) validationCode = reason.code; }
  return <Modal title="Edit session" close={close}>
    <form onSubmit={async event => {
      event.preventDefault(); setSaving(true); setError('');
      try {
        const success = await save(prepareSessionEdit(base, description, adjustment));
        if (success) close(); else setError('We couldn’t save this session. Keep the editor open and try again.');
      } catch (reason) { setError(userError(reason, 'edit')); }
      finally { setSaving(false); }
    }}>
      <label>Description<input value={description} onChange={event => setDescription(event.target.value)} aria-invalid={validationCode === 'edit-description'} aria-describedby="description-help" /></label>
      <p id="description-help" className="field-help">Up to 120 characters.</p>
      <dl className="session-details">
        <div><dt>Started</dt><dd><time dateTime={base.startedAt}>{new Date(base.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></dd></div>
        <div><dt>Finished</dt><dd><time dateTime={base.endedAt}>{new Date(base.endedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></dd></div>
        <div><dt>Duration</dt><dd>{sessionDurationText(base.focusDurationMs)}</dd></div>
      </dl>
      <label>Adjust duration<input id="duration-adjustment" value={adjustment} onChange={event => { setAdjustment(event.target.value); setError(''); }} aria-invalid={!!validationError && !['edit-description', 'edit-dates'].includes(validationCode)} aria-describedby="adjustment-help editor-error" required /></label>
      <p id="adjustment-help" className="field-help">Add or subtract whole minutes, such as +5 or -3. Use 0 to keep the duration.</p>
      {preview && <p className="duration-preview">New duration: <output htmlFor="duration-adjustment" aria-label="New duration">{sessionDurationText(preview.focusDurationMs)}</output></p>}
      {(validationError || error) && <p id="editor-error" className="form-error" role="alert">{validationError || error}</p>}
      <div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button className="primary" disabled={saving || !!validationError}>{saving ? 'Saving…' : 'Save changes'}</button></div>
    </form>
  </Modal>;
}

function SessionRows({ entries, edit, remove }: { entries: HistoryEntry[]; edit(entry: HistoryEntry): void; remove(entry: HistoryEntry): void }) {
  return <ul className="session-list">{entries.map(entry => {
    const session = entry.winner.payload!;
    return <li key={session.id} className="session-row">
      <div className="session-mark" aria-hidden="true">✓</div>
      <div className="session-info"><span className="session-title">{session.description || 'Untitled session'}</span>
        <time dateTime={session.endedAt}>{new Date(session.endedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></div>
      <strong className="session-duration" title={sessionDurationText(session.focusDurationMs)}>{focusText(session.focusDurationMs)}</strong>
      <div className="row-actions"><button aria-label={`Edit ${session.description || 'session'}`} onClick={() => edit(entry)}>Edit</button>
        <button className="quiet danger-text" aria-label={`Delete ${session.description || 'session'}`} onClick={() => remove(entry)}>Delete</button></div>
    </li>;
  })}</ul>;
}

export default function App() {
  const [client, setClient] = useState<TimerClient | null>(null);
  const [, render] = useState(0);
  const [startupError, setStartupError] = useState<unknown>(null);
  const [creatingHistory, setCreatingHistory] = useState(false);
  const repository = useRef<LocalRepository | null>(null);
  const [page, setPage] = useState<'timer' | 'history'>('timer');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<HistoryEntry | null>(null);
  const [deleting, setDeleting] = useState<HistoryEntry | null>(null);
  const [reset, setReset] = useState<{ resume: boolean } | null>(null);
  const [recover, setRecover] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [storageStatus, setStorageStatus] = useState('');
  const [storageProtected, setStorageProtected] = useState(false);
  const [syncStatus, setSyncStatus] = useState('Local only');
  const [offlineStatus, setOfflineStatus] = useState(import.meta.env.DEV ? 'Offline use isn’t available in this preview.' : 'serviceWorker' in navigator ? 'Getting Focus Timer ready for offline use…' : 'Offline reopening isn’t available at this address. Keep this tab open, or use an HTTPS address.');
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem('focus-timer-theme') === 'dark' || (!localStorage.getItem('focus-timer-theme') && matchMedia('(prefers-color-scheme: dark)').matches); } catch { return false; }
  });
  useEffect(() => {
    const ready = () => setOfflineStatus('Focus Timer is ready to use offline.');
    const unavailable = () => setOfflineStatus('Offline use isn’t ready. Keep this tab open; reopening may need an internet connection.');
    window.addEventListener('focus-timer-offline-ready', ready);
    window.addEventListener('focus-timer-offline-unavailable', unavailable);
    return () => { window.removeEventListener('focus-timer-offline-ready', ready); window.removeEventListener('focus-timer-offline-unavailable', unavailable); };
  }, []);
  useEffect(() => {
    let active = true;
    if (dataOpen && navigator.storage?.persisted) {
      void navigator.storage.persisted().then(granted => {
        if (active && granted) { setStorageProtected(true); setStorageStatus('Local data protection enabled.'); }
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [dataOpen]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('focus-timer-theme', dark ? 'dark' : 'light'); } catch { /* optional local preference */ }
  }, [dark]);
  useEffect(() => {
    let disposed = false;
    let current: TimerClient | null = null;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const repo = await LocalRepository.open(); repository.current = repo;
        current = new TimerClient(repo);
        unsubscribe = current.subscribe(() => { if (!disposed) render(value => value + 1); });
        await current.initialize();
        if (disposed) current.stop(); else setClient(current);
      } catch (error) {
        console.error('Focus Timer startup failed.', error);
        if (!disposed) setStartupError(error ?? new Error('Local storage could not be opened.'));
      }
    })();
    return () => { disposed = true; unsubscribe?.(); current?.stop(); };
  }, []);

  const blocked = !client?.owner || client.busy;
  const active = client?.active;
  const sessions = client?.view?.history.map(entry => entry.winner.payload!) ?? [];
  const stats = statistics(sessions);
  const entries = client?.view?.history ?? [];
  const filtered = entries.filter(entry => entry.winner.payload!.description.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const toggle = () => {
    if (blocked || !client?.stopwatch) return;
    void client.run(() => client.stopwatch!.active.state === 'running' ? client.stopwatch!.pause() : client.stopwatch!.start());
  };
  const finish = () => { if (!blocked && client?.stopwatch && client.elapsed >= 1) void client.run(() => client.stopwatch!.finish()); };
  const requestReset = async () => {
    if (!client?.stopwatch || blocked) return;
    const resume = active?.state === 'running';
    if (client.elapsed > 0) {
      const result = await client.run(async () => { await client.stopwatch!.pause(); return true; });
      if (result) setReset({ resume });
    } else void client.run(() => client.stopwatch!.reset());
  };
  const cancelReset = () => {
    const resume = reset?.resume; setReset(null);
    if (resume && client?.owner) void client.run(() => client.stopwatch!.start());
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, button, [contenteditable="true"], dialog') || document.querySelector('dialog[open]') || event.repeat) return;
      if (event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); toggle(); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  });

  const exportFile = async (format: 'csv' | 'history' | 'archive') => {
    if (!client) return;
    try {
      // Fresh committed projection, always independent of the active search filter.
      const view = await client.repository.view(); const values = view.history.map(entry => entry.winner.payload!);
      const content = format === 'csv' ? csvExport(values) : format === 'history' ? historyExport(values) : JSON.stringify(await client.repository.archive(), null, 2);
      download(content, `focus-timer-${format}-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : 'json'}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8');
    } catch (error) { client.fail(error, false, 'export'); }
  };

  return <div className="app-shell">
    <header className="app-header"><a className="brand" href="#" onClick={event => { event.preventDefault(); setPage('timer'); }}><span className="brand-icon" aria-hidden="true">◷</span>Focus Timer</a>
      <nav aria-label="Main navigation"><button className={page === 'timer' ? 'nav-active' : ''} aria-current={page === 'timer' ? 'page' : undefined} onClick={() => setPage('timer')}>Timer</button>
        <button className={page === 'history' ? 'nav-active' : ''} aria-current={page === 'history' ? 'page' : undefined} onClick={() => setPage('history')}>History</button></nav>
      <div className="header-actions"><span className="local-badge"><span aria-hidden="true">●</span> {syncStatus}</span><button className="icon-button theme-toggle" aria-label={`Use ${dark ? 'light' : 'dark'} theme`} onClick={() => setDark(!dark)}>{dark ? '☀' : '☾'}</button></div>
    </header>
    <main>
      {startupError ? <section className="card recovery-card"><h1>{startupHeading(startupError)}</h1><p role="alert">{userError(startupError, 'open')}</p>
        <button onClick={() => location.reload()}>Try opening again</button>
        <details className="advanced-options"><summary>Advanced recovery</summary><p>If you need to keep using Focus Timer, you can start an empty history. Your previous history will be kept for recovery, but won’t appear there.</p><button onClick={async () => {
          if (!confirm('Start a new, empty history? Your previous history will be kept for recovery and won’t appear in the new history.')) return;
          setCreatingHistory(true);
          try {
            if (!repository.current) throw new LocalError('storage-unavailable', 'No open local repository.');
            await repository.current.newCollection();
            await repository.current.initialize();
            location.reload();
          } catch (error) {
            console.error('Focus Timer could not create a new history.', error);
            setStartupError(error);
          } finally { setCreatingHistory(false); }
        }} disabled={!repository.current || creatingHistory}>Start a new history</button></details></section>
        : !client ? <p className="loading" role="status">Opening your sessions…</p> : <>
          {client.error && <div className="notice error-notice" role="alert"><span>{client.error}</span><button onClick={() => void client.run(() => client.stopwatch ? client.stopwatch.checkpoint() : client.refresh())}>Retry save</button></div>}
          {client.notice && <div className="notice" role="status"><span>{client.notice}</span><button className="quiet" onClick={() => { client.notice = ''; client.emit(); }}>Dismiss</button></div>}
          {!client.owner && <div className="notice owner-notice"><span>{ownershipNotice(client.hasRecentOwnerSample)}</span><button onClick={() => setRecover(true)}>Continue here</button></div>}
          <GoogleDrivePanel client={client} onStatus={setSyncStatus} />
          {page === 'timer' ? <>
            <div className="page-intro"><p className="eyebrow">ONE THING AT A TIME</p><h1>Make room for focus.</h1><p>Start when you’re ready. Your time is yours.</p></div>
            <div className="workspace-grid"><section className="card timer-card" aria-label="Focus stopwatch">
              <div className="timer-topline"><span className={`state-pill ${active?.state === 'running' ? 'is-running' : ''}`}><span aria-hidden="true">{active?.state === 'running' ? '●' : active?.state === 'paused' ? 'Ⅱ' : '○'}</span> {active?.state === 'running' ? 'Focusing' : active?.state === 'paused' ? 'Paused' : 'Ready to focus'}</span><span className="stopwatch-label">STOPWATCH</span></div>
              <div className="timer-readout" role="timer" aria-label="Focused time" aria-live="off">{clockText(client.elapsed)}</div>
              <p className="timer-caption">{active?.state === 'paused' ? 'Take your time. Paused time doesn’t count.' : active?.state === 'running' ? 'A little progress, one moment at a time.' : 'No countdown. Just space to do your best work.'}</p>
              <label className="description-label" htmlFor="description">What are you focusing on?<span>optional</span></label>
              <input id="description" className="description-input" value={client.description} onChange={event => client.draft(event.target.value)} disabled={!client.owner || client.busy} placeholder="Read a chapter, write a draft…" autoComplete="off" />
              <div className="draft-status"><span>{client.error ? 'Some changes haven’t been saved' : client.description !== active?.description ? 'Saving description…' : active?.state === 'running' ? 'Saving as you focus' : 'Saved on this device'}</span><span aria-label={`${scalarCount(client.description)} of 120 characters`}>{scalarCount(client.description)}/120</span></div>
              <div className="timer-actions"><button className="primary start-button" onClick={toggle} disabled={blocked}><span aria-hidden="true">{active?.state === 'running' ? 'Ⅱ' : '▶'}</span> {active?.state === 'running' ? 'Pause' : active?.state === 'paused' ? 'Resume' : 'Start focus'}</button><button onClick={finish} disabled={blocked || client.elapsed < 1}>Finish session</button><button className="reset-button" aria-label="Reset timer" onClick={() => void requestReset()} disabled={blocked || active?.state === 'idle'}>↺</button></div>
              <p className="keyboard-hint"><kbd>space</kbd> to {active?.state === 'running' ? 'pause' : 'start or resume'} outside text fields</p>
            </section><aside className="stats-column" aria-label="Completed focus totals"><div className="section-kicker">YOUR FOCUS, SO FAR</div>
              {(['today', 'week', 'all'] as const).map((key, index) => <section className={`stat-card stat-${key}`} key={key}><div className="stat-heading"><h2>{['Today', 'This week', 'All time'][index]}</h2><span aria-hidden="true">{['◌', '▤', '∞'][index]}</span></div><strong>{focusText(stats[key].ms)}</strong><p>{stats[key].count} completed {stats[key].count === 1 ? 'session' : 'sessions'}</p></section>)}
            </aside></div>
            <section className="recent-section"><div className="section-heading"><div><p className="eyebrow">A LITTLE PROGRESS ADDS UP</p><h2>Recent sessions</h2></div><button className="text-button" onClick={() => setPage('history')}>View all history <span aria-hidden="true">→</span></button></div>
              {entries.length ? <SessionRows entries={entries.slice(0, 3)} edit={setEditor} remove={setDeleting} /> : <div className="empty-state"><span aria-hidden="true">◷</span><h3>Your first session starts here.</h3><p>Finish a focus session and it will appear here.</p></div>}
            </section>
          </> : <>
            <div className="page-intro history-intro"><p className="eyebrow">YOUR TIME, WELL SPENT</p><h1>Session history</h1><p>Completed focus, kept on this device.</p></div>
            <section className="card history-card"><div className="history-toolbar"><label className="search-label">Search history<input type="search" placeholder="Find a session…" value={query} onChange={event => setQuery(event.target.value)} /></label><button onClick={() => setDataOpen(true)}>Export data ↗</button></div>
              <div className="history-summary">{filtered.length} of {entries.length} sessions <span>•</span> {focusText(stats.all.ms)} total focus</div>
              {filtered.length ? <SessionRows entries={filtered} edit={setEditor} remove={setDeleting} /> : <div className="empty-state"><h3>{query ? 'No matching sessions.' : 'A fresh start.'}</h3><p>{query ? 'Try another description.' : 'Your completed sessions will be waiting here.'}</p></div>}
            </section>
          </>}
          <footer><p><span aria-hidden="true">⌁</span> Saved on this device. Sync is optional. No account needed.</p><button className="text-button" onClick={() => setDataOpen(true)}>Data & storage</button></footer>
          {editor && <Editor entry={editor} close={() => setEditor(null)} save={async candidate => {
            const result = await client.run(async () => { await client.repository.edit(editor.datasetId, editor.winner.opId, candidate); return true; });
            if (!result) throw client.lastError ?? new Error('Session edit failed.');
            return true;
          }} />}
          {deleting && <Modal title="Delete this session?" close={() => setDeleting(null)}><p>“{deleting.winner.payload!.description || 'Untitled session'}” will be removed from your history. This can’t be undone.</p>{client.error && <p className="form-error" role="alert">{client.error}</p>}<div className="dialog-actions"><button onClick={() => setDeleting(null)}>Keep session</button><button className="danger" disabled={client.busy} onClick={async () => {
            const result = await client.run(async () => { await client.repository.delete(deleting.datasetId, deleting.id, deleting.winner.opId); return true; }); if (result) setDeleting(null);
          }}>Delete session</button></div></Modal>}
          {reset && <Modal title="Reset this timer?" close={cancelReset}><p>Discard this session’s time? Your description and finished sessions will be kept.</p>{client.error && <p className="form-error" role="alert">{client.error}</p>}<div className="dialog-actions"><button onClick={cancelReset}>Keep session</button><button className="danger" onClick={async () => {
            const result = await client.run(async () => { await client.stopwatch!.reset(); return true; }); if (result) setReset(null);
          }}>Reset timer</button></div></Modal>}
          {recover && <Modal title="Continue in this tab?" close={() => setRecover(false)}><p>Your session will be paused at its last saved point. Unsaved time or description changes may be lost. If another tab is running the timer, it will stop.</p><div className="dialog-actions"><button onClick={() => setRecover(false)}>Cancel</button><button className="primary" onClick={async () => { await client.recoverHere(); setRecover(false); }}>Continue here</button></div></Modal>}
          {dataOpen && <Modal title="Your data, on your device" close={() => setDataOpen(false)}>
            <p>Your sessions are stored on this device. Export a backup anytime to keep a separate copy.</p>
            <div className="export-options"><button onClick={() => void exportFile('csv')}><strong>Export CSV</strong><span>Open your session history in a spreadsheet.</span></button><button onClick={() => void exportFile('history')}><strong>Export history</strong><span>Save a portable copy of all your finished sessions.</span></button></div>
            <section className="storage-section" aria-labelledby="storage-heading"><h3 id="storage-heading">Local storage</h3><p>{offlineStatus}</p><p>Clearing this browser’s data will remove your sessions. Keep a backup.</p>{storageStatus && <p role="status">{storageStatus}</p>}<button disabled={storageProtected} onClick={async () => {
              try {
                if (!navigator.storage?.persist) { setStorageStatus('Extra protection isn’t available in this browser. Keep a backup of your sessions.'); return; }
                const granted = await navigator.storage.persist();
                setStorageProtected(granted);
                setStorageStatus(granted ? 'Local data protection enabled.' : 'Your browser couldn’t enable extra protection. Export a backup to keep a separate copy.');
              } catch { setStorageStatus('Protection couldn’t be enabled. Try again or export a backup.'); }
            }}>Protect local data</button></section>
            <details className="timing-details"><summary>Timer recovery</summary><p>If Focus Timer closes during a session, it will reopen paused from its last saved point. Some unsaved time may be missing. For the most accurate timing, pause before closing the app or putting your device to sleep.</p></details>
            <details className="advanced-options" open={client.view?.collection.highWater === MAX_COUNTER}><summary>Advanced</summary>
              <div className="export-options"><button onClick={() => void exportFile('archive')}><strong>Export full data archive</strong><span>Create a complete archive for backup or recovery.</span></button></div>
              {client.view?.collection.highWater === MAX_COUNTER && <div className="notice"><p>This history can’t accept more changes. Finish this session in a new history. Your existing history will be kept.</p><button onClick={() => {
                if (confirm('Finish this session in a new history? Your existing history will be kept, but won’t appear there.')) void client.run(() => client.stopwatch!.finish(createUuid()));
              }} disabled={!client.owner || client.elapsed < 1}>Finish in a new history</button></div>}
            </details>
          </Modal>}
        </>}
    </main>
  </div>;
}
