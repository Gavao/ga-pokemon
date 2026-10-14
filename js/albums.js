// Album fisici: dove va ogni carta. Un album ha una capienza, un numero di tasche per facciata e una
// lista di set in ordine; dentro ogni set le carte seguono il numero di collezione.
//  - "una copia per numero" (predefinito): un posto per numero, con la copia più bella che hai;
//  - "master set": un posto per ogni variante (normale, holo, reverse, prima edizione).
// Le posizioni si contano in "posti" dall'inizio dell'album: posto 0 = facciata 1, riga 1, colonna 1.
import { db } from './db.js';
import { getSet, getSetVariants } from './api.js';

export const DEFAULT_ALBUM = { capacity: 432, perSide: 9, newSide: true, gaps: true, master: false };

/** Album salvati; la prima volta si parte dal vecchio album unico, se c'era. */
export async function loadAlbums() {
  const saved = await db.get('settings', 'albums');
  if (saved) return saved.value;
  let old = null;
  try { old = JSON.parse(localStorage.getItem('albumConfig')); } catch { /* niente */ }
  const { capacity, perSide, newSide, gaps, sets = null } = old ?? {};
  return [{ id: 'a1', name: 'Album 1', ...DEFAULT_ALBUM,
    ...(old ? { capacity, perSide, newSide, gaps } : {}), sets }];
}

export async function saveAlbums(albums) {
  await db.put('settings', { key: 'albums', value: albums });
}

export const columns = perSide => (perSide === 4 ? 2 : 3);

/** Posizione leggibile di un posto: facciata, foglio, fronte/retro, riga e colonna. */
export function spot(album, slot) {
  const side = Math.floor(slot / album.perSide) + 1, inSide = slot % album.perSide;
  const cols = columns(album.perSide);
  return { side, sheet: Math.ceil(side / 2), front: side % 2 === 1, row: Math.floor(inSide / cols) + 1, col: inSide % cols + 1 };
}

/**
 * Posti di un set: elenco ordinato di { card, variant } (variant null = una copia per numero).
 * owned(cardId, variant) dice se la carta c'è, per gli album senza posti per le mancanti.
 */
async function setSlots(album, setId, owned) {
  const set = await getSet(setId);
  let slots;
  if (album.master) {
    const variants = await getSetVariants(setId);
    slots = set.cards.flatMap(c => (variants[c.id] ?? ['normal']).map(variant => ({ card: c, variant })));
  } else {
    slots = set.cards.map(card => ({ card, variant: null }));
  }
  return album.gaps ? slots : slots.filter(s => owned(s.card.id, s.variant));
}

/**
 * Disposizione dell'album: per ogni set i suoi posti, da quale posto parte e in quali facciate sta.
 * Con newSide ogni set inizia su una facciata nuova.
 */
export async function albumLayout(album, owned) {
  const totalSides = Math.floor(album.capacity / album.perSide);
  const rows = [];
  let pos = 0;
  for (const setId of album.sets ?? []) {
    let slots = [], error = null;
    try { slots = await setSlots(album, setId, owned); } catch (err) { error = err.message; }
    if (album.newSide) pos = Math.ceil(pos / album.perSide) * album.perSide;
    const start = pos;
    pos += slots.length;
    rows.push({
      setId, slots, start, error,
      firstSide: Math.floor(start / album.perSide) + 1,
      lastSide: Math.max(Math.floor((pos - 1) / album.perSide) + 1, Math.floor(start / album.perSide) + 1),
      fits: pos <= totalSides * album.perSide,
    });
  }
  return {
    album, rows, totalSides,
    usedSides: Math.ceil(pos / album.perSide),
    overflow: Math.max(0, pos - totalSides * album.perSide),
  };
}
