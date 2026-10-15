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

// Nomi delle carte prese dall'elenco inglese: si traducono solo le parti fisse, quelle sicure
// (energie, "Oscuro", "Lucente", "del Team Rocket", "di Brock"…). I nomi dei Pokémon in italiano sono
// gli stessi dell'inglese; gli Allenatori restano in inglese per non inventare nomi sbagliati.
const ENERGY = { Grass: 'Erba', Fire: 'Fuoco', Water: 'Acqua', Lightning: 'Lampo', Psychic: 'Psico', Fighting: 'Lotta',
  Darkness: 'Oscurità', Metal: 'Metallo', Fairy: 'Folletto', Colorless: 'Incolore' };
const OWNERS = /^(Brock|Misty|Lt\. Surge|Erika|Koga|Sabrina|Blaine|Giovanni|Lance|Rocket|Team Magma|Team Aqua|Holon)'s (.+)$/;
export function italianize(name) {
  let m;
  if ((m = name.match(/^(?:Basic )?(\w+) Energy$/)) && ENERGY[m[1]]) return `Energia ${ENERGY[m[1]]}`;
  if (name === 'Double Colorless Energy') return 'Energia Doppia Incolore';
  if ((m = name.match(/^Dark (.+)$/))) return `${m[1]} Oscuro`;
  if ((m = name.match(/^Light (.+)$/))) return `${m[1]} Luminoso`;
  if ((m = name.match(/^Shining (.+)$/))) return `${m[1]} Lucente`;
  if ((m = name.match(/^Team Rocket's (.+)$/))) return `${m[1]} del Team Rocket`;
  if ((m = name.match(OWNERS))) return `${m[2]} di ${m[1]}`;
  return name;
}
const italianCard = c => (c.lang === 'en' ? { ...c, name: italianize(c.name) } : c);

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
  return fixName({ ...set, cards: set.cards.map(italianCard) });
}

// Ricerca carte per nome in tutte le espansioni (serve la connessione): italiano più le carte
// che esistono solo nell'elenco inglese.
export async function searchCards(name) {
  const q = '/cards?name=' + encodeURIComponent(name);
  const [it, en] = await Promise.all([json(q), json(q, 'en').catch(() => [])]);
  const itIds = new Set(it.map(c => c.id));
  return [...it, ...en.filter(c => !itIds.has(c.id)).map(c => italianCard({ ...c, lang: 'en' }))];
}

// Varianti di ogni carta di un set (cardId -> ['normal', 'holo', 'reverse', 'firstEdition']), per gli
// album "master set" che hanno un posto per ognuna. L'elenco del set non le riporta, quindi si leggono
// le schede delle carte; il risultato vale un mese. Se qualche scheda non arriva non si salva nulla,
// così alla prossima occasione si riprova invece di tenersi dati incompleti.
export const MASTER_VARIANTS = ['normal', 'holo', 'reverse', 'firstEdition'];
export function getSetVariants(setId, onProgress) {
  return cached('variants:' + setId, async () => {
    const set = await getSet(setId);
    const out = {}, queue = [...set.cards];
    let done = 0, failed = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let c; (c = queue.shift());) {
        try {
          const v = (await getCard(c.id)).variants ?? {};
          const list = MASTER_VARIANTS.filter(k => v[k]);
          out[c.id] = list.length ? list : ['normal'];
        } catch { failed++; }
        onProgress?.(++done, set.cards.length);
      }
    }));
    if (failed) throw new Error(`Varianti non disponibili per ${failed} carte`);
    return out;
  }, 30 * DAY);
}

// Ricerca nel catalogo con filtri (nome, tipo, rarità, illustratore, categoria): TCGdex li accetta
// come parametri. Al massimo 250 risultati.
export function filterCards(filters) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  qs.set('pagination:itemsPerPage', '250');
  return json('/cards?' + qs);
}

// Carte di una rarità, per gli esempi della guida alle rarità; from = testo che il codice carta deve
// contenere (es. 'sv0' = solo Scarlatto e Violetto). L'elenco cambia di rado: si tiene per 30 giorni.
export function rarityCards(rarity, from = '') {
  const qs = new URLSearchParams({ rarity: 'eq:' + rarity, 'pagination:itemsPerPage': '250' });
  if (from) qs.set('id', from);
  return cached(`rarity:${rarity}:${from}`, () => json('/cards?' + qs), 30 * DAY);
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
