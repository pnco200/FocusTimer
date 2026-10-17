/** A wire/identity failure. Messages deliberately omit session descriptions. */
export class ProtocolError extends Error {
  constructor(classification, message) {
    super(message);
    this.name = 'ProtocolError';
    this.classification = classification;
  }
}

/** Application input-budget refusal, separate from a protocol validity decision. */
export class ResourceLimitError extends Error {
  constructor(limit, actual) {
    super('Input byte resource limit exceeded');
    this.name = 'ResourceLimitError';
    this.code = 'resource-limit';
    this.resource = 'input-bytes';
    this.limit = limit;
    this.actual = actual;
  }
}

export function malformed(message) {
  throw new ProtocolError('malformed', message);
}

export function unsupported(message) {
  throw new ProtocolError('unsupported', message);
}

export function integrity(message) {
  throw new ProtocolError('integrity', message);
}
