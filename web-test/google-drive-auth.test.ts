import { expect, it, vi } from 'vitest';
import { DRIVE_FILE_SCOPE, GoogleDriveAuthorization, type GoogleIdentityServices } from '../src/web/google-drive-auth';

const token = { access_token: 'private-test-access-token', expires_in: 3600, scope: DRIVE_FILE_SCOPE };
function fixture(fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ user: { permissionId: 'account-A' } })))) {
  const callbacks: Parameters<GoogleIdentityServices['initTokenClient']>[0][] = [];
  const request = vi.fn();
  const gis: GoogleIdentityServices = { initTokenClient: config => { callbacks.push(config); return { requestAccessToken: request }; } };
  let now = 1000;
  const auth = new GoogleDriveAuthorization({ clientId: 'official-web-client', gis, fetcher, now: () => now });
  return { auth, callbacks, request, fetcher, expire: () => { now = 3_601_000; } };
}

it('requests only drive.file through a user-driven popup and verifies the observed account before exposing transient credentials', async () => {
  const f = fixture();
  const pending = f.auth.authorize();
  expect(f.callbacks[0]).toMatchObject({ client_id: 'official-web-client', scope: DRIVE_FILE_SCOPE, include_granted_scopes: false });
  expect(f.request).toHaveBeenCalledWith({ prompt: 'select_account' });
  expect(() => f.auth.credentials('account-A')).toThrow();
  f.callbacks[0].callback(token);
  await expect(pending).resolves.toEqual({ account: 'account-A' });
  expect(f.auth.credentials('account-A').accessToken).toBe(token.access_token);
  expect(f.fetcher).toHaveBeenCalledWith('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)', expect.objectContaining({
    cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${token.access_token}` },
  }));
});

it.each(['', 'https://www.googleapis.com/auth/drive', `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive.readonly`, 'openid'])
('rejects the actual insufficient or broader scope grant %s before an account request', async scope => {
  const f = fixture(); const pending = f.auth.authorize();
  const result = expect(pending).rejects.toMatchObject({ code: 'authorization' });
  f.callbacks[0].callback({ ...token, scope }); await result;
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(() => f.auth.credentials('account-A')).toThrow();
});

it('rejects another account without replacing the retained account context', async () => {
  const f = fixture(); const pending = f.auth.authorize({ expectedAccount: 'retained-account' });
  const result = expect(pending).rejects.toMatchObject({ code: 'authorization' });
  f.callbacks[0].callback(token); await result;
  expect(() => f.auth.credentials('account-A')).toThrow();
});

it('expires credentials and fences previously captured accessors on disconnect', async () => {
  const f = fixture(); const pending = f.auth.authorize(); f.callbacks[0].callback(token); await pending;
  const credentials = f.auth.credentials('account-A');
  expect(() => f.auth.credentials('another-account')).toThrow();
  f.expire(); expect(credentials.assertCurrent).toThrow();
  f.auth.clear(); expect(credentials.assertCurrent).toThrow();
});

it('fences a stale GIS callback after a newer authorization request', async () => {
  const f = fixture(); const first = f.auth.authorize();
  const stale = expect(first).rejects.toMatchObject({ code: 'authorization' });
  const second = f.auth.authorize(); await stale;
  f.callbacks[0].callback(token);
  expect(f.fetcher).not.toHaveBeenCalled();
  f.callbacks[1].callback(token); await second;
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it('fences a stale account-verification response after disconnect', async () => {
  let release!: (response: Response) => void;
  const f = fixture(vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const pending = f.auth.authorize(); const result = expect(pending).rejects.toMatchObject({ code: 'authorization' });
  f.callbacks[0].callback(token); f.auth.clear();
  release(new Response(JSON.stringify({ user: { permissionId: 'account-A' } })));
  await result; expect(() => f.auth.credentials('account-A')).toThrow();
});

it('fences a changed binding generation before and after account verification', async () => {
  let current = true;
  const f = fixture(vi.fn(async () => { current = false; return new Response(JSON.stringify({ user: { permissionId: 'account-A' } })); }));
  const pending = f.auth.authorize({ isCurrent: () => current });
  const result = expect(pending).rejects.toMatchObject({ code: 'authorization' });
  f.callbacks[0].callback(token); await result;
  expect(() => f.auth.credentials('account-A')).toThrow();
});

it.each([401, 403, 503])('sanitizes an account-verification HTTP %s without retaining provider data', async status => {
  const f = fixture(vi.fn(async () => new Response('private provider body', { status })));
  const pending = f.auth.authorize(); const result = expect(pending).rejects.toMatchObject({
    code: status === 401 ? 'authorization' : 'retryable', message: expect.not.stringContaining('private'),
  });
  f.callbacks[0].callback(token); await result;
});

it.each([
  ['insufficientPermissions', 'authorization'], ['insufficientFilePermissions', 'access'], ['userRateLimitExceeded', 'retryable'],
])('uses only bounded structured authorization-error reason %s', async (reason, code) => {
  const f = fixture(vi.fn(async () => new Response(JSON.stringify({ error: { errors: [{ reason }], message: 'private provider details' } }), { status: 403 })));
  const pending = f.auth.authorize(); const result = expect(pending).rejects.toMatchObject({ code, message: code });
  f.callbacks[0].callback(token); await result;
});

it.each([
  new Response(JSON.stringify({ user: { permissionId: 'account-A' } }), { headers: { 'Content-Length': '1000' } }),
  new Response(' '.repeat(4097)), new Response(JSON.stringify({ user: { emailAddress: 'private@example.test' } })),
])('rejects incomplete, oversized or unidentified account responses', async response => {
  const f = fixture(vi.fn(async () => response)); const pending = f.auth.authorize();
  const result = expect(pending).rejects.toMatchObject({ code: 'authorization' });
  f.callbacks[0].callback(token); await result;
});

it('cancels a pending identity stream even when a fetch mock ignores abort', async () => {
  const cancelled = vi.fn(); const controller = new AbortController();
  const f = fixture(vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }))));
  const pending = f.auth.authorize({ signal: controller.signal });
  const result = expect(pending).rejects.toMatchObject({ code: 'authorization' });
  f.callbacks[0].callback(token);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
  controller.abort(); await result;
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
});

it('sanitizes popup cancellation and library failures', async () => {
  const f = fixture(); const pending = f.auth.authorize();
  const result = expect(pending).rejects.toMatchObject({ code: 'authorization', message: 'authorization' });
  f.callbacks[0].error_callback({ message: 'private popup details' }); await result;
});
