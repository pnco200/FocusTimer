import { MAX_DURATION_MS, validateDescription } from '../protocol/index.js';
import { emptyActive, pin, type Active } from './model';
import { LocalRepository } from './repository';
import { createUuid } from './ids';

export interface Clock { monotonic(): number; utc(): string }
export const browserClock: Clock = { monotonic: () => performance.now(), utc: () => new Date().toISOString() };

/** No tick counters or wall-clock subtraction. Anchors remain local to this execution. */
export class Stopwatch {
  private anchor: number | null = null;
  description: string;
  constructor(public active: Active, private repository: LocalRepository, private clock: Clock = browserClock) {
    this.description = active.description;
    // Recovery is performed transactionally before constructing this object.
    if (active.state === 'running') throw new Error('A running checkpoint must be recovered paused.');
  }
  elapsed(at = this.clock.monotonic()): number {
    const delta = this.anchor === null ? 0 : at - this.anchor;
    const elapsed = this.active.focusMs + delta;
    if (!Number.isFinite(elapsed) || delta < 0 || elapsed > MAX_DURATION_MS) throw new Error('The measurement clock is outside its supported range. Pause and recover the durable checkpoint.');
    return elapsed;
  }
  setDescription(value: string) { validateDescription(value); this.description = value; }

  private async commit(next: Active, at: number) {
    const saved = await this.repository.saveActive(pin(this.active), next);
    this.active = saved;
    // Reanchor at sampling time, so time spent in IndexedDB remains counted while running.
    this.anchor = saved.state === 'running' ? at : null;
  }
  async start() {
    if (this.active.state === 'running') return;
    const at = this.clock.monotonic();
    await this.commit({ ...this.active, id: this.active.id ?? createUuid(),
      startedAt: this.active.startedAt ?? this.clock.utc(), state: 'running', description: this.description }, at);
  }
  async pause() {
    if (this.active.state !== 'running') return;
    const at = this.clock.monotonic();
    await this.commit({ ...this.active, focusMs: this.elapsed(at), state: 'paused', description: this.description }, at);
  }
  async checkpoint() {
    const at = this.clock.monotonic();
    await this.commit({ ...this.active, focusMs: this.elapsed(at), description: this.description }, at);
  }
  async reset() {
    const at = this.clock.monotonic();
    if (this.active.state === 'idle' && this.active.description === this.description) return;
    await this.commit(emptyActive(this.active.datasetId, this.active.revision, this.active.owner, this.description), at);
  }
  async finish(recoveryDatasetId?: string) {
    const at = this.clock.monotonic();
    const result = await this.repository.finish(pin(this.active), this.elapsed(at), this.clock.utc(), this.description, createUuid(), recoveryDatasetId);
    // Only a committed completion may clear the draft/measurement.
    this.active = emptyActive(recoveryDatasetId ?? this.active.datasetId, this.active.revision + 1, this.active.owner);
    this.description = ''; this.anchor = null;
    return result;
  }
  /** Ambiguous lifecycle/suspend gaps never become fabricated wall-clock focus. */
  async conservativePause() {
    const next = { ...this.active, state: this.active.state === 'idle' ? 'idle' as const : 'paused' as const, description: this.description };
    // active.focusMs is the last committed checkpoint, not the unproven live anchor.
    await this.commit(next, this.clock.monotonic());
  }
}
