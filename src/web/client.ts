import { LocalError, type Active, type LocalView } from './model';
import { LocalRepository } from './repository';
import { Stopwatch } from './timer';
import { userError } from './ui-copy';
import { createUuid } from './ids';

export class TimerClient {
  view: LocalView | null = null;
  stopwatch: Stopwatch | null = null;
  error = '';
  // Deliberately separate diagnostics from the text rendered in the product.
  lastError: unknown = null;
  notice = '';
  owner = false;
  busy = false;
  responsive = true;
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = null;
  private release: (() => void) | null = null;
  private abortLock = new AbortController();
  private intervals: ReturnType<typeof setInterval>[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private token = createUuid();
  private followerSample: { active: Active; elapsed: number; at: number; description: string } | null = null;
  private lastOwnerMessage = performance.now();
  private suspended = false;
  private errorFromBackground = false;
  private draftInvalid = false;

  constructor(public repository: LocalRepository) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  emit() { for (const listener of this.listeners) listener(); }
  get active() { return this.stopwatch?.active ?? this.followerSample?.active ?? this.view?.active; }
  get description() { return this.stopwatch?.description ?? this.followerSample?.description ?? this.view?.active.description ?? ''; }
  get hasRecentOwnerSample() { return this.followerSample !== null && this.responsive; }
  get elapsed() {
    try {
      if (this.stopwatch) return this.stopwatch.elapsed();
      if (this.followerSample) return this.followerSample.elapsed + (this.followerSample.active.state === 'running' && this.responsive ? performance.now() - this.followerSample.at : 0);
      return this.view?.active.focusMs ?? 0;
    } catch { return this.stopwatch?.active.focusMs ?? 0; }
  }

  async initialize() {
    this.view = await this.repository.initialize();
    this.repository.db.onversionchange = () => {
      this.error = 'Focus Timer has been updated. Reload this tab to continue.';
      this.stop(); this.emit();
    };
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`focus-timer:${this.repository.db.name}`);
      this.channel.onmessage = event => {
        const data = event.data;
        if (data?.kind === 'sample' && !this.owner && data.active?.datasetId === this.view?.installation.selectedDatasetId &&
          data.active.owner?.generation >= (this.view?.active.owner?.generation ?? 0) &&
          data.active.revision >= (this.followerSample?.active.revision ?? 0)) {
          this.followerSample = { active: data.active, elapsed: data.elapsed, description: data.description, at: performance.now() };
          this.lastOwnerMessage = performance.now(); this.responsive = true; this.emit();
        }
        if (data?.kind === 'changed') void this.refresh().catch(error => this.fail(error));
        if (data?.kind === 'hello') this.broadcast();
      };
      this.channel.postMessage({ kind: 'hello' });
    }
    if (navigator.locks) this.requestLock(false);
    else {
      try { await this.becomeOwner(true); }
      catch (error) {
        if (!(error instanceof LocalError) || error.code !== 'stale-owner') throw error;
        await this.refresh();
      }
    }
    this.intervals.push(setInterval(() => { this.broadcast(); this.emit(); }, 250));
    this.intervals.push(setInterval(() => {
      if (this.owner && this.active?.state === 'running') void this.run(() => this.stopwatch!.checkpoint(), false);
      else void this.refresh().catch(error => this.fail(error));
      if (!this.owner && performance.now() - this.lastOwnerMessage > 12_000) { this.responsive = false; this.emit(); }
    }, 5000));
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener('freeze', this.onFreeze);
    document.addEventListener('resume', this.onResume);
    window.addEventListener('pageshow', this.onPageShow);
    this.emit();
  }

  private requestLock(steal: boolean) {
    const options = steal ? { steal: true } : { signal: this.abortLock.signal };
    // This pending request automatically acquires after genuine owner death, never a heartbeat timeout.
    void navigator.locks.request(`focus-timer-owner:${this.repository.db.name}`, options, async () => {
      if (this.stopped) return;
      await this.becomeOwner();
      if (this.stopped) return;
      await new Promise<void>(resolve => { this.release = resolve; });
      this.release = null;
    }).catch(error => { if (!this.stopped && error.name !== 'AbortError') this.fail(error); });
  }

  private async becomeOwner(requireIdle = false) {
    const { active, recovered } = await this.repository.acquireOwner(this.token, requireIdle);
    if (this.stopped) return;
    this.owner = true; this.followerSample = null;
    this.stopwatch = new Stopwatch(active, this.repository);
    this.notice = recovered ? 'Your session is paused at its last saved point. Time while the app was closed hasn’t been added; some unsaved time may be missing.' : '';
    await this.refresh(); this.changed(); this.emit();
  }

  async recoverHere() {
    if (this.owner) return;
    this.abortLock.abort();
    if (navigator.locks) this.requestLock(true);
    else await this.becomeOwner();
  }

  async refresh() {
    const view = await this.repository.view();
    if (this.owner && view.active.owner?.token !== this.token) {
      this.owner = false; this.stopwatch = null;
      this.release?.();
      this.notice = 'You’re now using the timer in another tab.';
      if (navigator.locks && !this.stopped) {
        this.abortLock = new AbortController();
        this.requestLock(false);
      }
    }
    this.view = view;
    if (!this.owner && this.followerSample && view.active.revision > this.followerSample.active.revision) this.followerSample = null;
    this.emit();
  }

  private broadcast() {
    if (!this.owner || !this.stopwatch) return;
    this.channel?.postMessage({ kind: 'sample', active: this.stopwatch.active, elapsed: this.elapsed, description: this.description });
  }
  changed() { this.channel?.postMessage({ kind: 'changed' }); this.broadcast(); }
  fail(error: unknown, background = false, context: 'save' | 'export' = 'save') {
    this.lastError = error;
    this.error = userError(error, context);
    this.errorFromBackground = background;
    this.draftInvalid = false;
    if (error instanceof LocalError && error.code === 'stale-owner') void this.refresh().catch(() => {});
    this.emit();
  }
  run<T>(work: () => Promise<T>, interactive = true): Promise<T | undefined> {
    const execution = this.stopwatch;
    const task = async () => {
      if (this.stopped) return;
      if (interactive) this.busy = true;
      this.emit();
      try {
        if (execution && execution !== this.stopwatch) throw new LocalError('stale-owner', 'Timer ownership changed before this command could run. Review the current timer before trying again.');
        const result = await work();
        if (interactive || this.errorFromBackground) { this.error = ''; this.errorFromBackground = false; }
        await this.refresh(); this.changed(); return result;
      }
      catch (error) { this.fail(error, !interactive); return undefined; }
      finally { if (interactive) this.busy = false; this.emit(); }
    };
    const pending = this.queue.then(task);
    this.queue = pending;
    return pending;
  }
  draft(value: string) {
    try {
      this.stopwatch?.setDescription(value);
      if (this.draftInvalid) { this.error = ''; this.draftInvalid = false; }
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => { void this.run(() => this.stopwatch!.checkpoint(), false); }, 700);
      this.emit();
    } catch (error) { this.lastError = error; this.error = userError(error, 'description'); this.errorFromBackground = false; this.draftInvalid = true; this.emit(); }
  }
  private onPageHide = () => {
    if (this.owner && this.stopwatch) void this.run(async () => { await this.stopwatch!.pause(); await this.stopwatch!.checkpoint(); }, false);
  };
  private onVisibilityChange = () => {
    // Mobile browsers may discard a hidden page without a later close event.
    // Save while execution is available; hiding alone does not pause or release ownership.
    if (document.visibilityState === 'hidden' && this.owner && this.stopwatch) {
      void this.run(() => this.stopwatch!.checkpoint(), false);
    }
  };
  private onFreeze = () => {
    this.suspended = true;
    // Save a proven checkpoint while lifecycle execution is available.
    if (this.owner && this.stopwatch) void this.run(() => this.stopwatch!.checkpoint(), false);
  };
  private onResume = () => {
    if (this.suspended && this.owner && this.stopwatch) void this.run(async () => {
      await this.stopwatch!.conservativePause();
      this.notice = 'Your session was interrupted. It’s paused at the last saved point; some time may be missing.';
    }, false);
    this.suspended = false;
  };
  private onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) { this.onResume(); void this.refresh().catch(error => this.fail(error)); }
  };
  stop() {
    this.stopped = true;
    for (const interval of this.intervals) clearInterval(interval);
    if (this.debounce) clearTimeout(this.debounce);
    this.abortLock.abort(); this.release?.(); this.channel?.close(); this.repository.close();
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener('freeze', this.onFreeze);
    document.removeEventListener('resume', this.onResume);
    window.removeEventListener('pageshow', this.onPageShow);
  }
}
