import { historyOrder, type Session } from './model';

export function clockText(ms: number | bigint): string {
  const seconds = BigInt(typeof ms === 'bigint' ? ms : Math.trunc(ms)) / 1000n;
  return [seconds / 3600n, seconds / 60n % 60n, seconds % 60n].map(value => value.toString().padStart(2, '0')).join(':');
}
export function focusText(ms: number | bigint): string {
  const value = BigInt(typeof ms === 'bigint' ? ms : Math.trunc(ms));
  if (value > 0n && value < 1000n) return '< 1 sec';
  if (value < 60_000n) return `${value / 1000n} sec`;
  if (value < 3_600_000n) return `${value / 60_000n} min`;
  return `${value / 3_600_000n} hr ${value / 60_000n % 60n} min`;
}
/** Readable editor precision; stored and exported milliseconds are never changed. */
export function sessionDurationText(ms: number): string {
  if (ms < 3_600_000) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds ? `${seconds} sec` : 'Less than 1 sec';
    return `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} sec` : ''}`;
  }
  return focusText(ms);
}
function localDate(date: Date) {
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}
export function statistics(sessions: Session[], now = new Date()) {
  const today = localDate(now);
  const mondayDate = new Date(now); mondayDate.setDate(now.getDate() - (now.getDay() + 6) % 7);
  const monday = localDate(mondayDate);
  const totals = { today: { ms: 0n, count: 0 }, week: { ms: 0n, count: 0 }, all: { ms: 0n, count: 0 } };
  for (const session of sessions) {
    const day = localDate(new Date(session.endedAt));
    const duration = BigInt(session.focusDurationMs);
    totals.all.ms += duration; totals.all.count++;
    if (day === today) { totals.today.ms += duration; totals.today.count++; }
    if (day >= monday && day <= today) { totals.week.ms += duration; totals.week.count++; }
  }
  return totals;
}
export function localTimestamp(utc: string) {
  const date = new Date(utc);
  const offset = -date.getTimezoneOffset();
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
const cell = (value: string) => `"${(/^[=+\-@\t\r\n]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;
export function csvExport(sessions: Session[]): string {
  const lines = [...sessions].sort(historyOrder).map(session => [cell(session.description), cell(localTimestamp(session.startedAt)),
    cell(localTimestamp(session.endedAt)), cell(clockText(session.focusDurationMs)),
    `${Math.floor(session.focusDurationMs / 1000)}.${(session.focusDurationMs % 1000).toString().padStart(3, '0')}`].join(','));
  return '\uFEFFTitle,Started (local),Finished (local),Effective time,Effective seconds\r\n' + lines.map(line => line + '\r\n').join('');
}
export function historyExport(sessions: Session[]): string {
  return JSON.stringify({ format: 'focus-timer-history', formatVersion: 1, sessions: [...sessions].sort(historyOrder) }, null, 2);
}
export function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
