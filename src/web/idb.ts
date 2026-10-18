export const STORES = ['meta', 'collections', 'active', 'history', 'operations', 'outbox', 'receipts', 'evidence',
  'remote', 'publications', 'segments', 'artifacts'] as const;
export type Store = typeof STORES[number];
export type Fault = (point: string, transaction: IDBTransaction) => void;
export const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error);
});

/** All production commands overlap: native IDB serializes their durable checks and writes. */
export async function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>, fault?: Fault): Promise<T> {
  const tx = db.transaction([...STORES], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Local save transaction was aborted.'));
    tx.onerror = () => {};
  });
  void done.catch(() => {});
  try {
    const result = await work(tx);
    if (mode === 'readwrite') fault?.('before-commit', tx);
    await done;
    if (mode === 'readwrite') fault?.('after-commit', tx);
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* completed or already aborted */ }
    await done.catch(() => {});
    throw error;
  }
}
