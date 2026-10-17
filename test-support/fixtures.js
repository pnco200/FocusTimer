// Test fixture builders live outside test/ so Node does not count this helper as a test.
export const ids = {
  dataset: '11000000-0000-4000-8000-000000000001',
  writer: '22000000-0000-4000-8000-000000000001',
  otherWriter: '22000000-0000-4000-8000-000000000002',
  entity: '44000000-0000-4000-8000-000000000001',
  segment: '55000000-0000-4000-8000-000000000001',
};

export function uuid(number, prefix = '33000000') {
  return `${prefix}-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
}

export function session(overrides = {}) {
  return { id: ids.entity, startedAt: '2026-10-17T15:20:00.000Z', endedAt: '2026-10-17T16:43:10.000Z', focusDurationMs: 4085000, description: 'Database study', ...overrides };
}

export function upsert(number = 1, counter = number, overrides = {}) {
  return { protocolVersion: 1, schemaVersion: 1, opId: uuid(number), datasetId: ids.dataset, deviceId: ids.writer, entityType: 'focusSession', entityId: ids.entity, operation: 'UPSERT', lamportCounter: counter, payload: session(), ...overrides };
}

export function deletion(number = 2, counter = number, overrides = {}) {
  const { payload, ...result } = upsert(number, counter, overrides);
  return { ...result, operation: 'DELETE' };
}

export function segment(operations = [upsert()], overrides = {}) {
  return { protocolVersion: 1, datasetId: ids.dataset, deviceId: ids.writer, segmentId: ids.segment, operations, ...overrides };
}

export function random(seed = 0x12345678) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
}

export function shuffle(values, next) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
