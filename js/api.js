// Catalogo carte da TCGdex (https://tcgdex.dev), in italiano.
// Ogni risposta viene salvata in IndexedDB: se sei offline si usa l'ultima copia.
import { db } from './db.js';

const BASE = 'https://api.tcgdex.net/v2/it';
const DAY = 24 * 60 * 60 * 1000;

async function json(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`TCGdex ${res.status} su ${path}`);
  return res.json();
}

async function cached(key, loader, maxAge) {
  const hit = await db.get('cache', key);
  if (hit && Date.now() - hit.ts < maxAge) return hit.data;
  try {
    const data = await loader();
    await db.put('cache', { key, data, ts: Date.now() });
    return data;
  } catch (err) {
    if (hit) return hit.data;
    throw err;
  }
}

// Correzioni ai nomi dei set che su TCGdex hanno refusi o maiuscole sbagliate.
const SET_NAMES = {
  '30th-c': 'Collezione Classica del 30°',
  '2011bw': "McDonald's Collection 2011",
  'tk-ex-m': 'EX Trainer Kit (Minun)',
  'tk-dp-l': 'Diamante & Perla Trainer Kit (Lucario)',
  'tk-dp-m': 'Diamante & Perla Trainer Kit (Manaphy)',
  'tk-sm-r': 'Sole e Luna Trainer Kit (Raichu di Alola)',
  'xya': 'Carta Alternativa A Gialla',
  'sm6': 'Apocalisse di Luce',
  'sm7.5': 'Trionfo dei Draghi',
};
const fixName = s => {
  s.name = SET_NAMES[s.id] ?? s.name.replace('trainer Kit', 'Trainer Kit');
  return s;
};

// Serie con i relativi set, dalla più recente alla più vecchia.
// Pokémon Pocket (tcgp) è escluso: è il gioco digitale, non carte fisiche.
export async function getCatalog() {
  const catalog = await loadCatalog();
  for (const serie of catalog) serie.sets.forEach(fixName);
  return catalog;
}

function loadCatalog() {
  return cached('catalog', async () => {
    const list = await json('/series');
    const series = await Promise.all(list.map(s => json('/series/' + encodeURIComponent(s.id))));
    return series
      .filter(s => s.id !== 'tcgp')
      .reverse()
      .map(s => ({ id: s.id, name: s.name, sets: [...s.sets].reverse() }));
  }, DAY);
}

export async function getSet(id) {
  return fixName(await cached('set:' + id, () => json('/sets/' + encodeURIComponent(id)), 7 * DAY));
}

// Ricerca carte per nome in tutte le espansioni (serve la connessione).
export function searchCards(name) {
  return json('/cards?name=' + encodeURIComponent(name));
}

// Dettaglio carta: rarità, varianti disponibili e prezzi. force = ignora la cache.
export function getCard(id, force = false) {
  return cached('card:' + id, () => json('/cards/' + encodeURIComponent(id)), force ? 0 : DAY);
}
