import { useEffect, useState } from 'react';
import { GoogleDriveSync } from './google-drive-sync';
import { TimerClient } from './client';
import { download } from './reporting';

export function GoogleDrivePanel({ client, onStatus }: { client: TimerClient; onStatus(status: string): void }) {
  const [sync] = useState(() => new GoogleDriveSync(client.repository, import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''));
  const [, render] = useState(0);
  const [retained, setRetained] = useState<{ descriptor: { datasetId: string } }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let disposed = false;
    const unsubscribe = sync.subscribe(() => { if (!disposed) { render(value => value + 1); onStatus(sync.status); } });
    void sync.initialize().catch(error => client.fail(error));
    const opportunity = () => { if (document.visibilityState === 'visible') void sync.opportunity().then(() => client.refresh()).catch(error => client.fail(error)); };
    const online = () => { void sync.refresh().then(opportunity).catch(error => client.fail(error)); };
    const offline = () => { void sync.refresh().catch(error => client.fail(error)); };
    const interval = setInterval(opportunity, 60_000);
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', opportunity);
    return () => {
      disposed = true; unsubscribe(); sync.stop(); clearInterval(interval);
      window.removeEventListener('online', online); window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', opportunity);
    };
  }, [client, onStatus, sync]);
  useEffect(() => {
    void sync.opportunity().then(() => client.refresh()).catch(error => client.fail(error));
  }, [client.view?.collection.highWater, client, sync]);
  const execute = async (action: () => Promise<void>) => {
    try { await action(); await client.refresh(); client.changed(); }
    catch (error) { client.fail(error); }
  };
  const active = client.active?.state !== 'idle';
  return <section id="drive-sync" className="sync-section" aria-label="Google Drive sync">
    <div className="sync-heading"><div><h2>Google Drive</h2><p aria-live="polite">{sync.busy ? 'Syncing…' : sync.status === 'Offline' ? 'Offline — changes saved on this device' : sync.status}</p></div>
      <div className="sync-actions">
        {sync.busy ? <button onClick={() => sync.cancel()}>Cancel sync</button>
          : !sync.authorized || sync.needsReconnect || sync.joining ? <button disabled={!sync.ready} onClick={() => void execute(() => sync.connect())}>{sync.joining ? 'Continue setup' : sync.retained ? 'Reconnect Google Drive' : 'Connect Google Drive'}</button>
          : sync.connected ? <button onClick={() => void execute(() => sync.sync())}>Sync</button> : null}
        <button className="quiet" aria-expanded={open} aria-controls="sync-options" onClick={() => setOpen(!open)}>Sync options</button>
      </div>
    </div>
    {sync.message && <p className="sync-message" role="alert">{sync.message}</p>}
    {sync.lastSynced && <p className="field-help">Last synced <time dateTime={new Date(sync.lastSynced).toISOString()}>{new Date(sync.lastSynced).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</time></p>}
    {!sync.clientId && open && <p>Google Drive isn’t available in this installation. Your timer and history work locally.</p>}
    {!!sync.clientId && !sync.ready && open && <button onClick={() => void execute(() => sync.initialize())}>Try connecting again</button>}
    {sync.joining && <p>Your saved history is being prepared. Your current history stays available until setup finishes.</p>}
    {sync.candidates !== null && !sync.connected && !sync.joining && <div className="sync-candidates">
      <h3>Choose your saved history</h3>
      <p>{!sync.discoveryComplete ? 'Google Drive couldn’t finish checking for saved histories. Check again before choosing one.' : sync.candidates.length ? 'Choose a history to use on this device. Existing saved values take priority when sessions overlap.' : 'No saved history was found for this account. You can check again or save this device’s history to Google Drive.'}</p>
      {sync.candidates.map((candidate, index) => <div className="sync-candidate" key={candidate.rootId}>
        <span>Saved history {index + 1} — {candidate.status === 'ready' ? 'Available' : candidate.status === 'incomplete' ? 'Setup incomplete' : candidate.status === 'unreadable' ? 'Can’t be opened' : 'Needs attention'}</span>
        {candidate.status === 'ready' && <button disabled={sync.busy || active || !sync.discoveryComplete} onClick={() => {
          if (confirm('Use this saved history? Your local sessions will be added where they aren’t already present. Your current history will also be kept for recovery.')) void execute(() => sync.join(candidate));
        }}>Use this history</button>}
      </div>)}
      <p className="field-help">An unavailable history won’t be replaced automatically. Check access in Google Drive, then try again.</p>
      <div className="sync-actions"><button disabled={sync.busy} onClick={() => void execute(() => sync.discover())}>Check again</button>
        <button disabled={sync.busy || active} onClick={() => {
          if (confirm(sync.hasCreationIntent ? 'Continue saving this device’s history to Google Drive?' : 'Save this device’s history as a separate history in Google Drive? Other saved histories will stay separate.')) void execute(() => sync.create());
        }}>{sync.hasCreationIntent ? 'Continue setup' : 'Save this history to Google Drive'}</button></div>
      {active && <p>Finish or reset the timer before choosing a history.</p>}
    </div>}
    {open && <div id="sync-options" className="sync-options">
      <p>Sync shares finished sessions, edits and deletions. Your running timer stays on this device.</p>
      <p>Reconnect when Google asks. Sync runs while this app is open and connected.</p>
      {(sync.connected || sync.retained) && <button disabled={active} onClick={() => void execute(() => sync.disconnect())}>Disconnect Google Drive</button>}
      {sync.joining && <button disabled={sync.busy} onClick={() => void execute(() => sync.cancelJoin())}>Cancel history setup</button>}
      {active && (sync.connected || sync.retained) && <p className="field-help">Finish or reset the timer before disconnecting.</p>}
      <details onToggle={event => {
        if (event.currentTarget.open) void client.repository.retainedCollections().then(setRetained).catch(error => client.fail(error));
      }}><summary>Previous histories</summary><p>Your previous histories stay on this device. Export a full archive for backup or recovery.</p>
        {retained.length ? retained.map((value, index) => <button key={value.descriptor.datasetId} onClick={() => void execute(async () => {
          const archive = await client.repository.archiveCollection(value.descriptor.datasetId);
          download(JSON.stringify(archive, null, 2), `focus-timer-previous-history-${index + 1}.json`, 'application/json;charset=utf-8');
        })}>Export previous history {index + 1}</button>) : <p>No previous histories on this device.</p>}
      </details>
    </div>}
  </section>;
}
