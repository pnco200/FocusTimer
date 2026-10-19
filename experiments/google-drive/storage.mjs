// Separate experimental database; no production stores, credentials or account history.
const NAME = 'focus-timer-google-drive-proof-v1';
export async function openProofStore() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('intents', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('proof-storage-open-failed'));
    request.onblocked = () => reject(new Error('proof-storage-blocked'));
  });
  db.onversionchange = () => db.close();
  const transaction = (mode, run) => new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('intents', mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
    catch { reject(new Error('proof-storage-transaction-failed')); return; }
    const request = run(tx.objectStore('intents'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(new Error('proof-storage-transaction-failed'));
    tx.onerror = () => {}; // abort decides the durable result.
  });
  return { all: () => transaction('readonly', store => store.getAll()),
    put: record => transaction('readwrite', store => store.put(record)) };
}
