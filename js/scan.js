// Riconoscimento di una carta da foto, tutto sul telefono: si legge il testo stampato (OCR con
// Tesseract.js) e lo si confronta con il catalogo.
//  - in basso il numero, es. "045/198", "TG12/TG30", "SV045/SV122": il totale dice il set;
//  - in alto il nome: serve a scegliere tra più set con lo stesso totale.
import { getCatalog, getSet, searchCards } from './api.js';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const CARD_RATIO = 88 / 63;   // altezza / larghezza di una carta

let worker;
async function ocrWorker() {
  if (worker) return worker;
  if (!window.Tesseract) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Impossibile scaricare il lettore di testo: serve la connessione la prima volta.'));
      document.head.append(s);
    });
  }
  worker = await window.Tesseract.createWorker('eng');
  return worker;
}

// ---------------------------------------------------------------------------
// Immagini
// ---------------------------------------------------------------------------
/** Ritaglia dal video la parte dentro il riquadro guida (il video è mostrato con object-fit: cover). */
export function captureFromVideo(video, frame) {
  const v = video.getBoundingClientRect(), f = frame.getBoundingClientRect();
  const scale = Math.max(v.width / video.videoWidth, v.height / video.videoHeight);
  const ox = (video.videoWidth * scale - v.width) / 2, oy = (video.videoHeight * scale - v.height) / 2;
  const sx = (f.left - v.left + ox) / scale, sy = (f.top - v.top + oy) / scale;
  const sw = f.width / scale, sh = f.height / scale;
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = Math.round(900 * CARD_RATIO);
  canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Foto dalla galleria: si suppone che la carta riempia quasi tutta l'immagine. */
export async function canvasFromFile(file) {
  const img = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Ritaglio di una zona della carta (in frazioni di larghezza e altezza), ingrandito finché il testo
 * è alto abbastanza per l'OCR e messo in bianco e nero contrastato.
 */
function region(card, [x0, x1, y0, y1], targetHeight, filter = 'grayscale(1) contrast(1.8)') {
  const sx = card.width * x0, sy = card.height * y0;
  const sw = card.width * (x1 - x0), sh = card.height * (y1 - y0);
  const scale = Math.max(1, targetHeight / sh);
  const out = document.createElement('canvas');
  out.width = Math.round(sw * scale);
  out.height = Math.round(sh * scale);
  const ctx = out.getContext('2d');
  ctx.filter = filter;
  ctx.drawImage(card, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

// Tentativi di lettura del numero, dal più efficace in media. Il numero è minuscolo e cambia posto
// con l'epoca (in basso a sinistra sulle recenti, a destra sulle vecchie): nessuna impostazione
// da sola funziona su tutte, quindi si prova finché non esce un numero di un set che esiste.
// zone = [x0, x1, y0, y1] in frazioni della carta; psm = modalità di Tesseract (11 testo sparso, 7 riga singola).
const NUMBER_TRIES = [
  { zone: [0, 1, 0.86, 1], height: 260, psm: '11' },
  { zone: [0.5, 1, 0.92, 1], height: 260, psm: '11' },
  { zone: [0, 0.5, 0.92, 1], height: 260, psm: '11' },
  { zone: [0.72, 1, 0.945, 0.995], height: 100, psm: '7', filter: 'none' },
  { zone: [0, 0.45, 0.945, 0.995], height: 100, psm: '7', filter: 'none' },
  { zone: [0, 1, 0.9, 1], height: 160, psm: '11', filter: 'none' },
];
const NAME_ZONE = [0, 1, 0.02, 0.13];

// ---------------------------------------------------------------------------
// Lettura
// ---------------------------------------------------------------------------
const norm = s => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Numero di collezione letto dal testo: { prefix, num, total } oppure null. */
export function parseNumber(text) {
  const t = text.toUpperCase().replace(/[|\\]/g, '/').replace(/O(?=\d)|(?<=\d)O/g, '0');
  const m = t.match(/\b([A-Z]{0,4})\s?(\d{1,3})\s?\/\s?([A-Z]{0,4})\s?(\d{2,3})\b/);
  if (m) return { prefix: m[1], num: +m[2], total: +m[4] };
  const promo = t.match(/\b(SWSH|SVP|SM|XY|BW|MEP)\s?(\d{1,3})\b/);
  if (promo) return { prefix: promo[1], num: +promo[2], total: 0 };
  return null;
}

/** Fa le due letture (nome in alto, numero in basso) sulla carta già ritagliata. */
export async function readCard(card, onStatus) {
  onStatus?.('Preparo il lettore di testo…');
  const w = await ocrWorker();
  onStatus?.('Leggo il numero…');
  const totals = new Set((await getCatalog()).flatMap(s => s.sets).flatMap(s => [s.cardCount.official, s.cardCount.total]));
  let bottom = '', number = null;
  for (const t of NUMBER_TRIES) {
    await w.setParameters({ tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ ', tessedit_pageseg_mode: t.psm });
    const text = (await w.recognize(region(card, t.zone, t.height, t.filter))).data.text;
    bottom += text + '\n';
    const n = parseNumber(text);
    if (n && n.num <= Math.max(n.total, 400) && (totals.has(n.total) || !n.total)) { number = n; break; }
    number ??= n;   // se nessuna lettura torna con un set, si tiene la prima trovata
  }
  onStatus?.('Leggo il nome…');
  await w.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '6' });
  const top = (await w.recognize(region(card, NAME_ZONE, 200))).data.text;
  return { number, nameText: top, raw: { top, bottom } };
}

// ---------------------------------------------------------------------------
// Confronto con il catalogo
// ---------------------------------------------------------------------------
function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** Quanto il nome di una carta somiglia al testo letto in alto (0…1). */
function nameScore(name, text) {
  const n = norm(name);
  if (!n) return 0;
  const words = text.split(/\s+/).map(norm).filter(Boolean);
  let best = 0;
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < Math.min(words.length, i + 4); j++) {
      joined += words[j];
      best = Math.max(best, 1 - levenshtein(n, joined) / Math.max(n.length, joined.length));
    }
  }
  return best;
}

const idNumber = localId => {
  const m = String(localId).toUpperCase().match(/^([A-Z]*)(\d+)/);
  return m ? { prefix: m[1], num: +m[2] } : null;
};

/**
 * Carte che corrispondono alla lettura, dalla più probabile: { ...brief, setId, setName, score }.
 * Con il numero si cercano i set con quel totale; senza, si cerca per nome.
 */
export async function findCards({ number, nameText }) {
  const results = [];
  if (number?.total) {
    const sets = (await getCatalog()).flatMap(s => s.sets)
      .filter(s => s.cardCount.official === number.total || s.cardCount.total === number.total);
    for (const s of sets) {
      let set;
      try { set = await getSet(s.id); } catch { continue; }
      for (const c of set.cards) {
        const n = idNumber(c.localId);
        if (!n || n.num !== number.num) continue;
        if (number.prefix && n.prefix && n.prefix !== number.prefix) continue;
        results.push({ ...c, setId: s.id, setName: s.name, score: 1 + nameScore(c.name, nameText) });
      }
    }
  }
  if (!results.length || Math.max(...results.map(r => r.score)) < 1.4) {
    // Numero illeggibile o nome che non torna: si cerca per nome con le parole più lunghe lette in alto
    // (lì c'è anche altro testo, es. "Si evolve da…", quindi se ne provano alcune).
    const guesses = [...new Set(nameText.split(/\s+/).map(w => w.replace(/[^\p{L}]/gu, '')).filter(w => w.length >= 4))]
      .sort((a, b) => b.length - a.length).slice(0, 3);
    const sets = new Map((await getCatalog()).flatMap(s => s.sets).map(s => [s.id, s.name]));
    for (const guess of guesses) {
      for (const c of await searchCards(guess.slice(0, 8)).catch(() => [])) {
        const setId = c.id.slice(0, c.id.lastIndexOf('-'));
        if (!sets.has(setId) || results.some(r => r.id === c.id)) continue;
        const n = idNumber(c.localId);
        const numberBonus = number && n?.num === number.num ? 0.5 : 0;
        results.push({ ...c, setId, setName: sets.get(setId), score: nameScore(c.name, nameText) + numberBonus });
      }
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 12);
}
