import { LocalRepository } from './repository';
import type { Binding, JoinPlan } from './remote-repository';
import { samePin } from '../sync/remote.js';
import { GoogleDriveAuthorization, loadGoogleIdentityServices } from './google-drive-auth';
import { GoogleDriveBootstrap, type DriveCandidate } from './google-drive-bootstrap';
import { decodeDriveLocator, GoogleDriveClient, GoogleDriveTransport } from './google-drive-transport';
import { SyncRunner } from './sync-runner';
import { TransportError } from './sync-transport';
import { userError } from './ui-copy';

/** Product coordination only. All synchronization state/transitions belong to the existing runner/repository. */
export class GoogleDriveSync {
  readonly authorization: GoogleDriveAuthorization;
  readonly bootstrap: GoogleDriveBootstrap;
  readonly transport: GoogleDriveTransport;
  private runner: SyncRunner;
  private listeners = new Set<() => void>();
  private epoch = 0;
  private abort?: AbortController;
  private stopped = false;
  private account: string | null = null;
  private selectedDatasetId: string | null = null;
  private setupAccount: string | undefined;
  private pendingJoin: JoinPlan | null = null;
  private connection: Awaited<ReturnType<ReturnType<LocalRepository['remote']>['bindingState']>> | null = null;
  busy = false;
  ready = false;
  status = 'Local only';
  message = '';
  candidates: DriveCandidate[] | null = null;
  discoveryComplete = false;
  lastSynced: number | null = null;
  private lastSyncedTarget: string | null = null;
  needsReconnect = false;
  hasCreationIntent = false;
  get joining() { return this.pendingJoin !== null; }
  constructor(readonly repository: LocalRepository, readonly clientId: string,
    authorization?: GoogleDriveAuthorization, client?: GoogleDriveClient) {
    this.authorization = authorization ?? new GoogleDriveAuthorization({ clientId });
    const api = client ?? new GoogleDriveClient(account => this.authorization.credentials(account));
    this.bootstrap = new GoogleDriveBootstrap(api, repository.remote());
    this.transport = new GoogleDriveTransport(api);
    this.runner = new SyncRunner(repository.remote(), this.transport);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { if (!this.stopped) for (const listener of this.listeners) listener(); }
  get connected() { return !!this.connection?.binding; }
  get retained() { return !!this.connection?.lastBinding; }
  get authorized() {
    if (!this.account) return false;
    try { this.authorization.credentials(this.account); return true; } catch { return false; }
  }
  async initialize(loadLibrary = true) {
    await this.refresh();
    if (this.clientId && loadLibrary) {
      try { await loadGoogleIdentityServices(); this.ready = true; }
      catch { this.message = 'Google Drive couldn’t open. Check your connection and try again.'; }
    } else this.ready = !!this.clientId;
    this.emit();
  }
  async refresh() {
    const remote = this.repository.remote();
    this.connection = await remote.bindingState();
    const intent = await remote.getBootstrapIntent();
    this.pendingJoin = await this.repository.pendingJoin();
    this.setupAccount = this.pendingJoin?.account ?? intent?.account;
    this.hasCreationIntent = !!intent;
    const selected = (await this.repository.view()).collection.descriptor.datasetId;
    if (this.lastSyncedTarget !== this.destination(this.connection.binding)) this.lastSynced = null;
    this.selectedDatasetId = selected;
    const status = await remote.status();
    const recoverable = ['access', 'missing-dataset', 'missing-object'].includes(this.connection.blocked ?? '');
    this.needsReconnect = !!(this.connected || this.retained) && (!this.authorized || this.connection.error === 'authorization' || recoverable);
    this.status = status === 'Local only' ? 'Local only'
      : typeof navigator !== 'undefined' && navigator.onLine === false ? 'Offline'
      : this.connection.blocked || ['access', 'missing-dataset', 'missing-object', 'integrity', 'unsupported', 'malformed'].includes(this.connection.error ?? '') ? 'Sync needs attention'
      : this.needsReconnect ? 'Reconnect'
      : status === 'Synced' ? 'Synced'
      : status === 'Syncing' && this.busy ? 'Syncing'
      : 'Changes saved on this device';
    this.emit();
  }
  private context() {
    if (!this.connection) throw new TransportError('retryable');
    return { generation: this.connection.bindingGeneration,
      target: this.connection.binding?.locator ?? this.connection.lastBinding?.locator,
      datasetId: this.selectedDatasetId };
  }
  private destination(binding: Binding | null) {
    return binding ? JSON.stringify([binding.provider, binding.account, binding.locator, binding.datasetId]) : null;
  }
  private async assertContext(expected: ReturnType<GoogleDriveSync['context']>, epoch: number) {
    if (epoch !== this.epoch || this.stopped || this.abort?.signal.aborted) throw new TransportError('authorization');
    const current = await this.repository.remote().bindingState();
    const selected = (await this.repository.view()).collection.descriptor.datasetId;
    if (current.bindingGeneration !== expected.generation
      || (current.binding?.locator ?? current.lastBinding?.locator) !== expected.target
      || selected !== expected.datasetId) throw new TransportError('authorization');
  }
  private failure(error: unknown) {
    const code = error instanceof TransportError ? error.code : (error as { code?: string })?.code;
    if (code === 'authorization') { this.authorization.clear(); this.account = null; }
    this.message = code === 'authorization' ? 'Reconnect Google Drive using the account you connected before.'
      : code === 'access' ? 'Google Drive access was denied. Check access to your saved history, then reconnect.'
      : code === 'missing-dataset' || code === 'missing-object' ? 'Your saved history couldn’t be reached. Check Google Drive and reconnect. Your sessions are kept on this device.'
      : code === 'integrity' || code === 'malformed' || code === 'unsupported' ? 'Your saved history needs attention. Keep a full data archive before trying recovery.'
      : code === 'active-not-idle' ? 'Finish or reset the timer before changing your connected history.'
      : code === 'stale-binding' || code === 'stale-join' ? 'Your connected history changed in another tab. Reconnect to review it.'
      : code === 'join-incomplete' ? 'Your saved history hasn’t finished downloading. Reconnect to continue. Your current history is still available.'
      : code === 'join-in-progress' ? 'Continue the history setup already in progress, or cancel it in Sync options.'
      : error instanceof TransportError ? 'Sync couldn’t finish. Your changes are kept on this device. Try again when you’re online.'
      : userError(error);
  }
  private async work(action: (epoch: number, signal: AbortSignal) => Promise<void>) {
    if (this.busy || this.stopped) return;
    const epoch = ++this.epoch;
    this.abort = new AbortController(); this.busy = true; this.message = ''; this.emit();
    try { await action(epoch, this.abort.signal); }
    catch (error) { if (epoch === this.epoch && !this.stopped) this.failure(error); }
    finally {
      if (epoch === this.epoch && !this.stopped) { this.busy = false; await this.refresh(); }
    }
  }
  /** Called directly by a button: GIS request starts before any asynchronous persistence read. */
  connect() {
    const expected = this.context();
    const retained = this.connection!.binding ?? this.connection!.lastBinding;
    return this.work(async (epoch, signal) => {
      const identity = await this.authorization.authorize({ expectedAccount: retained?.account ?? this.setupAccount,
        isCurrent: () => epoch === this.epoch && !this.stopped, signal });
      await this.assertContext(expected, epoch);
      this.account = identity.account;
      const bootstrapOptions = { signal, assertCurrent: () => this.assertContext(expected, epoch) };
      if (retained) {
        const descriptor = (await this.repository.view()).collection.descriptor;
        const candidate = await this.bootstrap.inspect(identity.account, decodeDriveLocator(retained.locator), { ...bootstrapOptions, expectedDescriptor: descriptor });
        await this.assertContext(expected, epoch);
        const blocked = this.connection!.blocked;
        if (blocked && !['access', 'missing-dataset', 'missing-object'].includes(blocked)) throw new TransportError(blocked as 'integrity');
        if (!this.connection!.binding || blocked) await this.repository.remote().bind({ provider: 'google-drive', account: identity.account,
          locator: candidate.locator!, descriptor: candidate.descriptor!, expectedGeneration: expected.generation, resumePublications: true });
        this.candidates = null;
        if (blocked) {
          await this.runner.run({ signal, maxPublications: 0 });
          const recovery = await this.repository.remote().bindingState();
          if (recovery.error || recovery.blocked) throw new TransportError((recovery.error ?? recovery.blocked) as 'retryable');
        }
        await this.run(signal);
      } else if (this.pendingJoin) {
        const candidate = await this.bootstrap.inspect(identity.account, decodeDriveLocator(this.pendingJoin.locator),
          { ...bootstrapOptions, expectedDescriptor: this.pendingJoin.descriptor });
        await this.hydrateJoin(candidate, expected, epoch, signal);
      } else {
        const result = await this.bootstrap.discover(identity.account, bootstrapOptions);
        await this.assertContext(expected, epoch);
        this.candidates = result.candidates;
        this.discoveryComplete = result.complete;
        if (!result.complete) throw new TransportError('retryable');
      }
    });
  }
  discover() {
    return this.work(async (epoch, signal) => {
      if (!this.account) throw new TransportError('authorization');
      const expected = this.context();
      const result = await this.bootstrap.discover(this.account, { signal, assertCurrent: () => this.assertContext(expected, epoch) });
      await this.assertContext(expected, epoch); this.candidates = result.candidates;
      this.discoveryComplete = result.complete;
      if (!result.complete) throw new TransportError('retryable');
    });
  }
  create() {
    return this.work(async (epoch, signal) => {
      if (!this.account || this.retained || this.pendingJoin) throw new TransportError('authorization');
      const expected = this.context();
      const bootstrapOptions = { signal, assertCurrent: () => this.assertContext(expected, epoch) };
      const descriptor = (await this.repository.view()).collection.descriptor;
      if (!await this.repository.remote().getBootstrapIntent()) await this.bootstrap.prepare(this.account, descriptor,
        { ...bootstrapOptions, expectedGeneration: expected.generation });
      await this.assertContext(expected, epoch);
      const { candidate, discovery } = await this.bootstrap.create(this.account, bootstrapOptions);
      await this.assertContext(expected, epoch);
      await this.repository.remote().bind({ provider: 'google-drive', account: this.account, locator: candidate.locator!,
        descriptor: candidate.descriptor!, expectedGeneration: expected.generation });
      this.discoveryComplete = discovery.complete;
      this.candidates = discovery.candidates.length > 1 || !discovery.complete ? discovery.candidates : null;
      if (this.candidates) this.message = 'More than one saved history is available. You’re using the history you just created.';
      if (!discovery.complete) this.message = 'Your history was saved. Google Drive couldn’t finish checking for other saved histories. Check again later.';
      await this.run(signal);
    });
  }
  join(candidate: DriveCandidate) {
    return this.work(async (epoch, signal) => {
      if (!this.account || candidate.status !== 'ready' || this.retained) throw new TransportError('authorization');
      const expected = this.context();
      const selected = await this.bootstrap.inspect(this.account, decodeDriveLocator(candidate.locator!), { signal,
        expectedDescriptor: candidate.descriptor, assertCurrent: () => this.assertContext(expected, epoch) });
      await this.hydrateJoin(selected, expected, epoch, signal);
    });
  }
  private async hydrateJoin(selected: DriveCandidate, expected: ReturnType<GoogleDriveSync['context']>, epoch: number, signal: AbortSignal) {
    await this.assertContext(expected, epoch);
    const source = expected.datasetId!;
    if (source === selected.descriptor!.datasetId) {
      await this.repository.remote().bind({ provider: 'google-drive', account: this.account!, locator: selected.locator!,
        descriptor: selected.descriptor!, expectedGeneration: expected.generation, resumePublications: true });
    } else {
      const stage = await this.repository.stageJoin({ provider: 'google-drive', account: this.account!,
        locator: selected.locator!, descriptor: selected.descriptor!, expectedSourceDatasetId: source, expectedGeneration: expected.generation });
      await new SyncRunner(stage.repository, this.transport).run({ signal, maxPublications: 0 });
      await this.assertContext(expected, epoch);
      await this.repository.commitJoin(stage.plan.id);
    }
    this.runner = new SyncRunner(this.repository.remote(), this.transport);
    this.lastSynced = null;
    this.candidates = null; await this.run(signal);
  }
  async cancelJoin() {
    this.cancel();
    if (this.pendingJoin) await this.repository.cancelJoin(this.pendingJoin.id);
    await this.refresh();
  }
  private async run(signal: AbortSignal) {
    this.status = 'Syncing'; this.emit();
    const pin = await this.repository.remote().captureBinding();
    const result = await this.runner.run({ signal });
    if (signal.aborted) return;
    const state = await this.repository.remote().bindingState();
    if (result === 'Synced' && samePin(pin, state.binding)) {
      this.lastSynced = Date.now(); this.lastSyncedTarget = this.destination(state.binding);
    }
    if (state.error) this.failure(new TransportError(state.error as ConstructorParameters<typeof TransportError>[0]));
  }
  sync() { return this.work(async (_epoch, signal) => { await this.run(signal); }); }
  async opportunity() {
    if (this.busy || this.stopped) return;
    await this.refresh();
    if (this.connected && this.authorized && !this.needsReconnect && this.status !== 'Sync needs attention'
      && (typeof navigator === 'undefined' || navigator.onLine !== false)) await this.sync();
  }
  cancel() { this.abort?.abort(); }
  async disconnect() {
    this.abort?.abort(); this.authorization.clear(); this.account = null; this.epoch++; this.busy = false;
    this.lastSynced = null;
    try { await this.repository.remote().disconnect(); this.candidates = null; this.message = ''; }
    catch (error) { this.failure(error); }
    await this.refresh();
  }
  stop() { this.stopped = true; this.epoch++; this.abort?.abort(); this.authorization.clear(); this.listeners.clear(); }
}
