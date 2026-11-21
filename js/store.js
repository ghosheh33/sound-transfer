// Received items kept in IndexedDB so they survive closing the page.
// Falls back to memory when storage is unavailable (private mode).

const DB = 'sound-transfer';
const STORE = 'received';
let dbp = null;
const memory = [];
let memKey = 1;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key', autoIncrement: true });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbp;
}

function tx(db, mode, fn) {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** item: { name, kind, mime, blob, size, time, error } -> key */
export async function addItem(item) {
  const db = await open();
  if (db) {
    const key = await tx(db, 'readwrite', (s) => s.add(item));
    if (key != null) return key;
  }
  const key = `m${memKey++}`;
  memory.push({ ...item, key });
  return key;
}

/** Newest first. */
export async function listItems() {
  const db = await open();
  const stored = db ? (await tx(db, 'readonly', (s) => s.getAll())) || [] : [];
  return [...stored, ...memory].sort((a, b) => b.time - a.time);
}

export async function deleteItem(key) {
  const i = memory.findIndex((m) => m.key === key);
  if (i >= 0) { memory.splice(i, 1); return; }
  const db = await open();
  if (db) await tx(db, 'readwrite', (s) => s.delete(key));
}

export async function clearItems() {
  memory.length = 0;
  const db = await open();
  if (db) await tx(db, 'readwrite', (s) => s.clear());
}
