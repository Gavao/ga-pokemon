// Catalogo carte da TCGdex (https://tcgdex.dev), in italiano; dove l'italiano manca si completa
// con l'inglese. Ogni risposta viene salvata in IndexedDB: se sei offline si usa l'ultima copia.
import { db } from './db.js';

const BASE = 'https://api.tcgdex.net/v2/';
const DAY = 24 * 60 * 60 * 1000;

async function json(path, lang = 'it') {
  const res = await fetch(BASE + lang + path);
  if (!res.ok) throw Object.assign(new Error(`TCGdex ${res.status} su ${path}`), { status: res.status });
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

// Carte di un set. Per molti set vecchi (e alcune promo) TCGdex non ha l'elenco in italiano o ce
// l'ha incompleto: le carte mancanti si prendono dall'elenco inglese, con nome e immagine inglesi.
export async function getSet(id) {
  const set = await cached('set2:' + id, async () => {
    const it = await json('/sets/' + encodeURIComponent(id));
    if (it.cards.length >= it.cardCount.total) return it;
    let en;
    try { en = await json('/sets/' + encodeURIComponent(id), 'en'); } catch { return it; }
    const itById = new Map(it.cards.map(c => [c.id, c]));
    const cards = en.cards.map(c => {
      const itCard = itById.get(c.id);
      if (!itCard) return { ...c, lang: 'en' };
      return itCard.image || !c.image ? itCard : { ...itCard, image: c.image };
    });
    const enIds = new Set(en.cards.map(c => c.id));
    for (const c of it.cards) if (!enIds.has(c.id)) cards.push(c);
    return { ...it, cards };
  }, 7 * DAY);
  return fixName(set);
}

// Ricerca carte per nome in tutte le espansioni (serve la connessione): italiano più le carte
// che esistono solo nell'elenco inglese.
export async function searchCards(name) {
  const q = '/cards?name=' + encodeURIComponent(name);
  const [it, en] = await Promise.all([json(q), json(q, 'en').catch(() => [])]);
  const itIds = new Set(it.map(c => c.id));
  return [...it, ...en.filter(c => !itIds.has(c.id)).map(c => ({ ...c, lang: 'en' }))];
}

// Dettaglio carta: rarità, varianti disponibili e prezzi. force = ignora la cache.
// Se la carta non esiste in italiano si usa la scheda inglese.
export function getCard(id, force = false) {
  const path = '/cards/' + encodeURIComponent(id);
  return cached('card:' + id, () => json(path).catch(err => {
    if (err.status === 404) return json(path, 'en');
    throw err;
  }), force ? 0 : DAY);
}
