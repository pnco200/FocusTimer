import { TransportError } from './sync-transport';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
interface TokenResponse { access_token?: string; expires_in?: number | string; scope?: string; error?: string }
export interface GoogleIdentityServices {
  initTokenClient(config: {
    client_id: string; scope: string; include_granted_scopes: false;
    callback: (response: TokenResponse) => void; error_callback: (error: unknown) => void;
  }): { requestAccessToken(options: { prompt: 'select_account' }): void };
}
interface GoogleWindow { google?: { accounts?: { oauth2?: GoogleIdentityServices } } }
export interface AuthorizationOptions { expectedAccount?: string; isCurrent?: () => boolean; signal?: AbortSignal }
export interface DriveCredentials { accessToken: string; assertCurrent: () => void }
interface Session { token: string; account: string; expiresAt: number; generation: number }
let loading: Promise<GoogleIdentityServices> | undefined;

/** Load the public GIS library ahead of a user gesture; tokens never enter a script URL. */
export function loadGoogleIdentityServices(): Promise<GoogleIdentityServices> {
  const existing = (globalThis as GoogleWindow).google?.accounts?.oauth2;
  if (existing) return Promise.resolve(existing);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.onload = () => {
      const gis = (globalThis as GoogleWindow).google?.accounts?.oauth2;
      if (gis) resolve(gis);
      else { loading = undefined; script.remove(); reject(new TransportError('authorization')); }
    };
    script.onerror = () => { loading = undefined; script.remove(); reject(new TransportError('authorization')); };
    document.head.appendChild(script);
  });
  return loading;
}

/** User-driven GIS token flow. This instance is the only credential store, in memory. */
export class GoogleDriveAuthorization {
  private generation = 0;
  private session: Session | null = null;
  private cancelPending?: () => void;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(private config: { clientId: string; gis?: GoogleIdentityServices; fetcher?: typeof fetch; now?: () => number }) {
    this.fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = config.now ?? Date.now;
  }

  clear(): void {
    this.generation++;
    this.session = null;
    this.cancelPending?.();
    this.cancelPending = undefined;
  }

  credentials(account: string): DriveCredentials {
    const session = this.session;
    const assertCurrent = () => {
      if (!session || this.session !== session || session.generation !== this.generation
        || session.account !== account || this.now() >= session.expiresAt) throw new TransportError('authorization');
    };
    assertCurrent();
    return { accessToken: session!.token, assertCurrent };
  }

  /** Must be invoked directly from a user action, after GIS has loaded. */
  authorize(options: AuthorizationOptions = {}): Promise<{ account: string }> {
    this.clear();
    const generation = this.generation;
    const gis = this.config.gis ?? (globalThis as GoogleWindow).google?.accounts?.oauth2;
    if (!gis || !this.config.clientId || options.signal?.aborted) return Promise.reject(new TransportError('authorization'));
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      let callbackReceived = false;
      const current = () => {
        if (settled || generation !== this.generation || options.signal?.aborted || options.isCurrent?.() === false) {
          throw new TransportError('authorization');
        }
      };
      const finish = (error?: unknown, account?: string) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', cancel);
        if (this.cancelPending === cancel) this.cancelPending = undefined;
        if (error) reject(error); else resolve({ account: account! });
      };
      const cancel = () => { controller.abort(); finish(new TransportError('authorization')); };
      this.cancelPending = cancel;
      options.signal?.addEventListener('abort', cancel, { once: true });
      const callback = async (response: TokenResponse) => {
        // GIS may deliver a late callback after a second popup or disconnect.
        if (callbackReceived || settled) return;
        callbackReceived = true;
        try {
          current();
          const scopes = new Set(typeof response.scope === 'string' ? response.scope.split(/\s+/).filter(Boolean) : []);
          const lifetime = Number(response.expires_in);
          if (response.error || typeof response.access_token !== 'string' || !response.access_token
            || !Number.isFinite(lifetime) || lifetime <= 0 || scopes.size !== 1 || !scopes.has(DRIVE_FILE_SCOPE)) {
            throw new TransportError('authorization');
          }
          const expiresAt = this.now() + lifetime * 1000;
          if (!Number.isFinite(expiresAt)) throw new TransportError('authorization');
          const accountResponse = await this.fetcher('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)', {
            signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
            headers: { Authorization: `Bearer ${response.access_token}` },
          });
          current();
          if (accountResponse.status !== 200) {
            throw await accountFailure(accountResponse, controller.signal);
          }
          const account = await accountIdentity(accountResponse, controller.signal);
          current();
          if (options.expectedAccount !== undefined && account !== options.expectedAccount) throw new TransportError('authorization');
          if (this.now() >= expiresAt) throw new TransportError('authorization');
          this.session = { token: response.access_token, account, expiresAt, generation };
          finish(undefined, account);
        } catch (error) {
          finish(error instanceof TransportError ? error : new TransportError('authorization'));
        }
      };
      try {
        current();
        const client = gis.initTokenClient({ client_id: this.config.clientId, scope: DRIVE_FILE_SCOPE,
          include_granted_scopes: false, callback: response => { void callback(response); },
          error_callback: () => finish(new TransportError('authorization')) });
        client.requestAccessToken({ prompt: 'select_account' });
      } catch { finish(new TransportError('authorization')); }
    });
  }
}

async function accountPayload(response: Response, signal: AbortSignal): Promise<any> {
  if (!response.body || response.headers.has('content-range')) throw new TransportError('authorization');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const declared = response.headers.get('content-length');
  const identityEncoding = !response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity';
  const expectedLength = declared !== null && /^\d+$/.test(declared) && identityEncoding ? BigInt(declared) : null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (declared !== null && !/^(0|[1-9][0-9]*)$/.test(declared)) throw new TransportError('authorization');
    if (signal.aborted || (expectedLength !== null && expectedLength > 4096n)) throw new TransportError('authorization');
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 4096) throw new TransportError('authorization');
      chunks.push(next.value);
    }
    if (signal.aborted || (expectedLength !== null && expectedLength !== BigInt(length))) throw new TransportError('authorization');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    await reader.cancel().catch(() => {});
    throw new TransportError('authorization');
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

async function accountIdentity(response: Response, signal: AbortSignal): Promise<string> {
  const body = await accountPayload(response, signal);
  if (typeof body?.user?.permissionId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(body.user.permissionId)) throw new TransportError('authorization');
  return body.user.permissionId;
}

async function accountFailure(response: Response, signal: AbortSignal): Promise<TransportError> {
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {}); return new TransportError('authorization');
  }
  let reasons: string[] = [];
  try {
    const body = await accountPayload(response, signal);
    if (Array.isArray(body?.error?.errors)) reasons = body.error.errors.map((entry: { reason?: string }) => entry.reason);
  } catch { /* Keep provider bodies and messages out of diagnostics. */ }
  if (reasons.includes('authError') || reasons.includes('insufficientPermissions')) return new TransportError('authorization');
  if (response.status === 403 && reasons.some(reason => ['appNotAuthorizedToFile', 'insufficientFilePermissions', 'domainPolicy'].includes(reason))) {
    return new TransportError('access');
  }
  return new TransportError('retryable');
}
