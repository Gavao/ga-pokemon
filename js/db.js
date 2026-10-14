// Wrapper minimale su IndexedDB.
// Store "cards": la collezione (un record per carta). Store "cache": risposte dell'API.
// Store "settings": impostazioni da conservare e salvare nel backup (es. gli album).
const DB_NAME = 'pokecollezione';
const DB_VERSION = 2;

let opening;

function open() {
  return opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const conn = req.result;
      if (!conn.objectStoreNames.contains('cards')) conn.createObjectStore('cards', { keyPath: 'cardId' });
      if (!conn.objectStoreNames.contains('cache')) conn.createObjectStore('cache', { keyPath: 'key' });
      if (!conn.objectStoreNames.contains('settings')) conn.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(store, mode, fn) {
  const conn = await open();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', s => s.get(key)),
  all: store => run(store, 'readonly', s => s.getAll()),
  put: (store, value) => run(store, 'readwrite', s => s.put(value)),
  del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
  clear: store => run(store, 'readwrite', s => s.clear()),
};
