import { db } from './db.js';
import { getCatalog, getSet, getCard, searchCards } from './api.js';
import { LOGOS } from './logos.js';
import { IMAGES } from './images.js';
import { APP_VERSION } from './version.js';
import { captureFromVideo, canvasFromFile, readCard, findCards, parseNumber } from './scan.js';

// ---------------------------------------------------------------------------
// Personalizzazioni rapide: cambia queste liste per adattare l'app.
// ---------------------------------------------------------------------------
const VARIANTS = {
  normal: 'Normale',
  holo: 'Holo',
  reverse: 'Reverse',
  firstEdition: 'Prima Edizione',
  wPromo: 'Promo W',
};
const CONDITIONS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
const LANGS = ['IT', 'EN', 'JP', 'DE', 'FR', 'ES'];
const SET_FILTERS = { all: 'Tutte', own: 'Possedute', miss: 'Mancanti', dup: 'Doppioni' };

// ---------------------------------------------------------------------------
const $ = sel => document.querySelector(sel);
const view = $('#view');
const sheet = $('#sheet');

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const options = (list, sel) => list.map(([v, label]) =>
  `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`).join('');

// Collezione in memoria (cardId -> record), specchio dello store "cards".
// Record: { cardId, setId, name, localId, image, rarity, variants, price, wish,
//           copies: [{ variant, qty, condition, lang, grade, note }] }
const coll = new Map();
// Dati minimi delle carte viste a schermo, per aprirle senza altre richieste.
const briefs = new Map();

const qty = rec => rec ? rec.copies.reduce((a, c) => a + c.qty, 0) : 0;

function unitPrice(rec, variant) {
  const p = rec.price;
  if (!p) return 0;
  // Cardmarket distingue solo "non foil" e "foil". Una carta che esiste solo
  // holo ha il suo prezzo nel campo non foil.
  const plain = variant === 'normal' || (variant !== 'reverse' && rec.variants && !rec.variants.normal);
  return (plain ? p.nonFoil || p.foil : p.foil || p.nonFoil) || 0;
}
const recValue = rec => rec.copies.reduce((a, c) => a + c.qty * unitPrice(rec, c.variant), 0);

function applyDetail(rec, d) {
  rec.rarity = d.rarity;
  rec.category = d.category;
  rec.variants = d.variants;
  rec.setId ??= d.set?.id;
  const cm = d.pricing?.cardmarket;
  rec.price = cm ? {
    nonFoil: cm.trend || cm.avg || null,
    foil: cm['trend-holo'] || cm['avg-holo'] || null,
    updated: cm.updated,
  } : null;
}

function recFor(id) {
  const b = briefs.get(id) ?? {};
  return coll.get(id) ?? {
    cardId: id, setId: b.setId, name: b.name, localId: b.localId, image: b.image,
    wish: false, copies: [],
  };
}

function newCopy(rec) {
  const variant = rec.variants ? Object.keys(VARIANTS).find(k => rec.variants[k]) ?? 'normal' : 'normal';
  return { variant, qty: 1, condition: 'NM', lang: 'IT', grade: '', note: '' };
}

// Piccoli contatori fuori dal database: data dell'ultimo backup e modifiche fatte da allora.
const meta = {
  get: k => { try { return +localStorage.getItem(k) || 0; } catch { return 0; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* memoria non disponibile */ } },
};
// Dopo quante modifiche non salvate compare il promemoria nella schermata iniziale.
const BACKUP_REMINDER = 20;

// Presente solo dentro l'APK Android (vedi android/…/MainActivity.java): lì la copia di sicurezza
// la scrive l'app da sola, poco dopo ogni modifica, nella cartella Download/GAPokemon del telefono.
const native = window.Android;
let autoBackupTimer;
function autoBackup() {
  if (!native) return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(() => {
    if (native.saveBackup(backupJson())) {
      meta.set('lastBackup', Date.now());
      meta.set('dirty', 0);
    }
  }, 1500);
}

// Aggiornamenti dell'APK: all'avvio si confronta la versione installata con l'ultima release
// su GitHub; se ce n'è una più nuova compare un avviso e l'APK la scarica e la installa.
// (Il contenuto dell'app invece si aggiorna da solo, arriva da GitHub Pages.)
const RELEASES = 'https://api.github.com/repos/Gavao/ga-pokemon/releases/latest';
let apkUpdate = null;   // { version, url } se c'è un APK più nuovo
const apkVersion = () => native && (native.appVersion ? native.appVersion() : '1.0');

function isNewer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function checkApkUpdate() {
  if (!native) return;
  try {
    const rel = await (await fetch(RELEASES)).json();
    const version = rel.tag_name.replace(/^v/, '');
    const asset = rel.assets.find(a => a.name.endsWith('.apk'));
    apkUpdate = asset && isNewer(version, apkVersion()) ? { version, url: asset.browser_download_url } : null;
  } catch { /* offline o GitHub non raggiungibile: si riprova al prossimo avvio */ }
  const slot = $('#updateSlot');
  if (slot) slot.innerHTML = updateBanner();
}

function updateBanner() {
  if (!apkUpdate) return '';
  // Il primo APK (1.0) non sa ancora aggiornarsi da solo: va scaricato a mano un'ultima volta.
  return native.installUpdate
    ? `<button class="warn" data-act="update">È disponibile la versione ${esc(apkUpdate.version)} dell'app. Tocca per aggiornare.</button>`
    : `<p class="warn">È disponibile la versione ${esc(apkUpdate.version)} dell'app: scaricala da GitHub
        (github.com/Gavao/ga-pokemon, sezione Releases) e installala sopra a questa.</p>`;
}

async function save(rec) {
  meta.set('dirty', meta.get('dirty') + 1);
  autoBackup();
  rec.copies = rec.copies.filter(c => c.qty > 0);
  if (!rec.copies.length && !rec.wish) {
    coll.delete(rec.cardId);
    await db.del('cards', rec.cardId);
  } else {
    coll.set(rec.cardId, rec);
    await db.put('cards', rec);
  }
}

function ownedBySet() {
  const m = new Map();
  for (const rec of coll.values())
    if (qty(rec)) m.set(rec.setId, (m.get(rec.setId) ?? 0) + 1);
  return m;
}

// ---------------------------------------------------------------------------
// Componenti
// ---------------------------------------------------------------------------
// Immagine della carta: quella italiana di TCGdex, altrimenti l'alternativa da js/images.js.
// Ogni fonte ha il suo formato di indirizzo. Limitless e TCGplayer non mandano gli header CORS,
// quindi lì niente crossorigin. L'immagine non parte subito: la carica imageQueue (più sotto).
function cardImg(id, image, size, cls = '') {
  // IMAGES contiene solo carte senza immagine italiana o con l'immagine italiana rotta: vince lei.
  const src = IMAGES[id] ?? image;
  if (!src) return '';
  const limitless = src.includes('limitlesstcg'), tcgplayer = src.includes('tcgplayer');
  const url = limitless ? (size === 'high' ? src.replace('_SM.png', '_LG.png') : src)
    : tcgplayer ? (size === 'high' ? src : src.replace('.com/', '.com/fit-in/437x437/'))
    : src.includes('scrydex') ? `${src}/${size === 'high' ? 'large' : 'small'}`
    : `${src}/${size}.webp`;
  // Riserva: se l'immagine italiana non arriva, la stessa carta dall'archivio inglese.
  const alt = url.includes('assets.tcgdex.net/it/') ? url.replace('/it/', '/en/') : '';
  return `<img class="${cls}" ${limitless || tcgplayer ? '' : 'crossorigin="anonymous"'}
    data-src="${esc(url)}" ${alt ? `data-alt="${esc(alt)}"` : ''} alt="">`;
}

// Caricamento delle immagini delle carte. Aprendo un set ne servono centinaia: chiederle tutte
// insieme fa rifiutare dal server parte delle richieste, e quelle carte restavano senza immagine.
// Qui si caricano solo quelle vicine allo schermo, poche alla volta; se una fallisce si riprova a
// intervalli crescenti, poi si passa alla versione inglese, e solo alla fine si mostra il nome.
const imageQueue = (() => {
  // 6 tentativi a 1, 2, 4… 32 secondi: quando il server è carico risponde "occupato" anche per un
  // minuto, e passare subito all'inglese vorrebbe dire perdere l'immagine italiana che c'è.
  const MAX_ACTIVE = 6, RETRIES = 6;
  const waiting = [];
  let active = 0;

  const near = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      near.unobserve(e.target);
      waiting.push(e.target);
    }
    pump();
  }, { rootMargin: '800px 0px' });

  function pump() {
    while (active < MAX_ACTIVE && waiting.length) {
      const img = waiting.shift();
      if (img.isConnected) start(img);
    }
  }

  function start(img) {
    active++;
    img.onload = () => {
      img.onload = img.onerror = null;
      active--;
      pump();
    };
    img.onerror = () => {
      img.onload = img.onerror = null;
      active--;
      const tries = +(img.dataset.tries ?? 0);
      if (tries < RETRIES) {
        img.dataset.tries = tries + 1;
        setTimeout(() => { if (img.isConnected) { waiting.unshift(img); pump(); } }, 1000 * 2 ** tries);
      } else if (img.dataset.alt) {
        img.dataset.src = img.dataset.alt;
        delete img.dataset.alt;
        img.dataset.tries = 0;
        waiting.unshift(img);
      } else if (img.closest('.tile')) {
        img.closest('.tile').classList.add('noimg');
      } else {
        img.style.visibility = 'hidden';
      }
      pump();
    };
    img.removeAttribute('src');
    img.src = img.dataset.src;
  }

  // Ogni immagine nuova nella pagina entra in osservazione.
  new MutationObserver(() => {
    for (const img of document.querySelectorAll('img[data-src]:not([data-queued])')) {
      img.dataset.queued = '';
      near.observe(img);
    }
  }).observe(document.body, { childList: true, subtree: true });

  return { pending: () => waiting.length + active };
})();

function tile(b) {
  const rec = coll.get(b.id);
  const n = qty(rec);
  const img = cardImg(b.id, b.image, 'low');
  return `<div class="tile ${n ? 'own' : ''} ${img ? '' : 'noimg'}" data-card="${esc(b.id)}">
    ${img}
    <span class="name">${esc(b.name)}</span>
    <span class="num">${esc(b.localId)}</span>
    ${n ? `<span class="qty">×${n}</span>` : ''}
    ${rec?.wish ? '<span class="wish">★</span>' : ''}
    <button class="add" data-add="${esc(b.id)}" aria-label="Aggiungi una copia">+</button>
  </div>`;
}

const recBrief = rec => {
  const b = { id: rec.cardId, setId: rec.setId, name: rec.name, localId: rec.localId, image: rec.image };
  briefs.set(b.id, b);
  return b;
};

// Logo del set: alternativa da js/logos.js, poi logo italiano di TCGdex, altrimenti un'etichetta.
function setLogo(s) {
  const url = LOGOS[s.id] ?? (s.logo && s.logo + '.webp');
  if (url) return `<img crossorigin="anonymous" loading="lazy" src="${esc(url)}" alt="">`;
  const label = s.name.match(/\d+/)?.[0] ?? s.name.split(/\s+/).map(w => w[0]).join('').slice(0, 4).toUpperCase();
  return `<span class="badge">${esc(label)}</span>`;
}

const bar = (n, tot) => `<div class="bar"><i style="width:${tot ? Math.min(100, n / tot * 100) : 0}%"></i></div>`;
const loading = '<p class="empty">Caricamento…</p>';
const failed = err => `<p class="empty">Impossibile caricare i dati.<br><small>${esc(err.message)}</small><br>
  Serve la connessione la prima volta che apri una pagina.</p>`;

// ---------------------------------------------------------------------------
// Viste
// ---------------------------------------------------------------------------
let catalog = null, homeQuery = '', searchSeq = 0, searchTimer;
const setNames = new Map();
// Serie aperte dall'utente: valgono solo finché l'app resta aperta, all'avvio sono tutte chiuse.
const openSeries = new Set();

const setRow = (s, owned) => {
  const n = owned.get(s.id) ?? 0, tot = s.cardCount.total;
  return `<a class="setrow" href="#/set/${encodeURIComponent(s.id)}">
    <span class="logo">${setLogo(s)}</span>
    <span class="info"><b>${esc(s.name)}</b>${bar(n, tot)}</span>
    <span class="count">${n}/${tot}</span>
  </a>`;
};

async function home() {
  view.innerHTML = loading;
  catalog = await getCatalog();
  for (const serie of catalog) for (const s of serie.sets) setNames.set(s.id, s.name);
  const dirty = meta.get('dirty');
  view.innerHTML = `<header class="top"><h1>GA Pokémon</h1>
      <button class="chip on" data-act="scan">Scansiona</button></header>
    <div id="updateSlot">${updateBanner()}</div>
    ${!native && coll.size && dirty >= BACKUP_REMINDER
      ? `<a class="warn" href="#/more">${dirty} modifiche non ancora salvate in un backup. Tocca per salvarle.</a>` : ''}
    <div class="tools"><input id="hq" type="search" placeholder="Cerca un set o una carta" value="${esc(homeQuery)}"></div>
    <div id="homeBody"></div>`;
  renderHome();
}

// Senza testo: elenco delle serie. Con testo: set e carte trovati in tutte le espansioni.
function renderHome() {
  const body = $('#homeBody');
  if (!body) return;
  const owned = ownedBySet();
  const q = homeQuery.trim().toLowerCase();
  const seq = ++searchSeq;

  if (!q) {
    body.innerHTML = catalog.map(serie => {
      const started = serie.sets.filter(s => owned.get(s.id)).length;
      return `<details class="serie" data-serie="${esc(serie.id)}" ${openSeries.has(serie.id) ? 'open' : ''}>
        <summary>${esc(serie.name)}<small>${started ? `${started}/` : ''}${serie.sets.length} set</small></summary>
        ${serie.sets.map(s => setRow(s, owned)).join('')}
      </details>`;
    }).join('');
    return;
  }

  const sets = catalog.flatMap(serie => serie.sets).filter(s => s.name.toLowerCase().includes(q));
  body.innerHTML = `<h2>Set</h2>${sets.map(s => setRow(s, owned)).join('') || '<p class="note">Nessun set trovato.</p>'}
    <h2>Carte</h2><div id="cardResults"><p class="note">${q.length < 3 ? 'Scrivi almeno 3 lettere per cercare le carte.' : 'Ricerca…'}</p></div>`;
  if (q.length < 3) return;

  searchCards(q).then(found => {
    if (seq !== searchSeq) return;
    const cards = found.map(c => ({ ...c, setId: c.id.slice(0, c.id.lastIndexOf('-')) }))
      .filter(c => setNames.has(c.setId));
    for (const c of cards) briefs.set(c.id, c);
    const shown = cards.slice(0, 150);
    $('#cardResults').innerHTML = cards.length
      ? `<p class="note">${cards.length} carte trovate${cards.length > shown.length ? `, mostrate le prime ${shown.length}` : ''}.</p>
         <div class="grid">${shown.map(tile).join('')}</div>`
      : '<p class="note">Nessuna carta trovata.</p>';
  }).catch(() => {
    if (seq === searchSeq) $('#cardResults').innerHTML = '<p class="note">Per cercare le carte serve la connessione.</p>';
  });
}

let curSet = null, setFilter = 'all', setQuery = '';

async function setView(id) {
  if (curSet?.id !== id) {
    view.innerHTML = loading;
    curSet = await getSet(id);
    setFilter = 'all';
    setQuery = '';
    for (const c of curSet.cards) briefs.set(c.id, { ...c, setId: id });
    setNames.set(id, curSet.name);
  }
  view.innerHTML = `<header class="top">
      <a class="back" href="#/" aria-label="Indietro">‹</a>
      <div><h1>${esc(curSet.name)}</h1><div id="prog"></div></div>
    </header>
    <div class="tools">
      <input id="q" type="search" placeholder="Cerca per nome o numero" value="${esc(setQuery)}">
      <div class="chips">${Object.entries(SET_FILTERS).map(([k, label]) =>
        `<button class="chip ${k === setFilter ? 'on' : ''}" data-filter="${k}">${label}</button>`).join('')}</div>
    </div>
    <div class="grid" id="grid"></div>`;
  renderProgress();
  renderGrid();
}

function renderProgress() {
  const el = $('#prog');
  if (!el || !curSet) return;
  const cards = curSet.cards.filter(c => qty(coll.get(c.id)));
  const value = cards.reduce((a, c) => a + recValue(coll.get(c.id)), 0);
  el.innerHTML = `${bar(cards.length, curSet.cards.length)}
    <small>${cards.length}/${curSet.cards.length} carte · ${eur(value)}</small>`;
}

function renderGrid() {
  const q = setQuery.trim().toLowerCase();
  const cards = curSet.cards.filter(c => {
    const n = qty(coll.get(c.id));
    if (setFilter === 'own' && !n) return false;
    if (setFilter === 'miss' && n) return false;
    if (setFilter === 'dup' && n < 2) return false;
    return !q || c.name.toLowerCase().includes(q) || c.localId.toLowerCase().includes(q);
  });
  $('#grid').innerHTML = cards.map(tile).join('') || '<p class="empty">Nessuna carta.</p>';
}

// Rarità TCGdex in italiano, dalla più comune alla più pregiata (le sconosciute vanno in fondo).
const RARITY_ORDER = ['Comune', 'Non comune', 'Rara', 'Olografica Rara', 'Rara Lucente', 'Rara doppia',
  'Olografica Rara V', 'Olografica Rara VMAX', 'Olografica Rara VSTAR', 'rara ASSO TATTICO',
  'Allenatore d\'arte completa', 'Rara illustrazione', 'Ultrarara', 'Shiny rare', 'Shiny rare V',
  'Shiny rare VMAX', 'ultrarara cromatica', 'Rara Bianco e Nero', 'Segreto rara',
  'Rara illustrazione speciale', 'Mega Attack Rare', 'Rara iper', 'Mega Iper Raro'];
const rarityRank = r => RARITY_ORDER.indexOf(r);
const rarityLabel = r => !r || r === 'Nessuna' ? 'Senza rarità' : r[0].toUpperCase() + r.slice(1);

// Tipo di carta, dal nome: Charizard ex, Mewtwo EX, Pikachu V, Mega Lucario…
function cardKind(rec) {
  const words = (rec.name ?? '').split(/[\s-]+/);
  const last = words.at(-1);
  if (words[0] === 'Mega' || /^M$/.test(words[0])) return 'Mega';
  const kinds = { ex: 'Pokémon-ex', EX: 'Pokémon-EX', GX: 'Pokémon-GX', V: 'Pokémon V', VMAX: 'Pokémon VMAX',
    VSTAR: 'Pokémon VSTAR', BREAK: 'Pokémon BREAK', 'LV.X': 'Pokémon LV.X', Prime: 'Pokémon Prime' };
  if (kinds[last]) return kinds[last];
  if (rec.category === 'Allenatore') return 'Allenatore';
  if (rec.category === 'Energia') return 'Energia';
  return rec.category ? 'Pokémon base' : 'Da scoprire';
}

// Rarità e tipo arrivano dal dettaglio della carta: per le carte aggiunte senza connessione o
// importate da un backup lo si scarica qui, poche alla volta, senza contarle come modifiche.
const detailsTried = new Set();   // una sola volta per carta e per sessione, anche se offline
async function fillDetails(recs, onProgress) {
  const queue = recs.filter(r => r.category === undefined && !detailsTried.has(r.cardId));
  if (!queue.length) return;
  for (const r of queue) detailsTried.add(r.cardId);
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let rec; (rec = queue.shift());) {
      try {
        applyDetail(rec, await getCard(rec.cardId));
        await db.put('cards', rec);
      } catch { /* offline: resterà "Da scoprire" */ }
    }
  }));
  onProgress?.();
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Gruppo apribile di carte: riga con conteggi e valore, sotto le carte del gruppo.
function group(label, recs, extra = '') {
  const copies = recs.reduce((a, r) => a + qty(r), 0);
  const value = recs.reduce((a, r) => a + recValue(r), 0);
  return `<details class="group">
    <summary><span>${esc(label)}</span><small>${plural(recs.length, 'carta', 'carte')} · ${plural(copies, 'copia', 'copie')}${extra}${value ? ' · ' + eur(value) : ''}</small></summary>
    <div class="grid">${recs.sort((a, b) => recValue(b) - recValue(a)).map(r => tile(recBrief(r))).join('')}</div>
  </details>`;
}

async function stats() {
  const recs = [...coll.values()].filter(qty);
  const copies = recs.reduce((a, r) => a + qty(r), 0);
  const value = recs.reduce((a, r) => a + recValue(r), 0);
  const names = new Map();
  try {
    for (const serie of await getCatalog())
      for (const s of serie.sets) names.set(s.id, s);
  } catch { /* offline senza catalogo: si mostrano gli id */ }

  const bySet = new Map();
  for (const r of recs) {
    const s = bySet.get(r.setId) ?? { n: 0, value: 0 };
    s.n++;
    s.value += recValue(r);
    bySet.set(r.setId, s);
  }
  const top = recs.map(r => ({ r, v: recValue(r) })).filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v).slice(0, 12);

  const groupBy = keyOf => {
    const m = new Map();
    for (const r of recs) for (const k of [].concat(keyOf(r))) m.set(k, [...(m.get(k) ?? []), r]);
    return m;
  };
  const byRarity = [...groupBy(r => rarityLabel(r.rarity))]
    .sort((a, b) => rarityRank(b[1][0].rarity) - rarityRank(a[1][0].rarity));
  const byKind = [...groupBy(cardKind)].sort((a, b) => b[1].length - a[1].length);
  // Per variante contano le copie: la stessa carta può esserci sia normale sia reverse.
  const byVariant = Object.entries(VARIANTS).map(([k, label]) => {
    const withVariant = recs.filter(r => r.copies.some(c => c.variant === k));
    const n = withVariant.reduce((a, r) => a + r.copies.filter(c => c.variant === k).reduce((s, c) => s + c.qty, 0), 0);
    return [label, withVariant, n];
  }).filter(([, list]) => list.length);
  const missingDetails = recs.filter(r => r.category === undefined && !detailsTried.has(r.cardId)).length;

  view.innerHTML = `<header class="top"><h1>Collezione</h1></header>
    <div class="kpis">
      <div><b>${eur(value)}</b><small>Valore stimato</small></div>
      <div><b>${recs.length}</b><small>Carte diverse</small></div>
      <div><b>${copies}</b><small>Copie totali</small></div>
      <div><b>${copies - recs.length}</b><small>Doppioni</small></div>
    </div>
    ${recs.length ? `<p class="note">Valori: prezzo medio di vendita su Cardmarket (trend) per una copia
      in buone condizioni. Sono indicativi: lingua, condizione e gradazione possono cambiarli molto.</p>`
      : '<p class="empty">Non hai ancora aggiunto carte.<br>Apri un set e tocca + su una carta.</p>'}
    ${top.length ? `<h2>Carte di maggior valore</h2><div class="grid">${top.map(x => tile(recBrief(x.r))).join('')}</div>` : ''}
    ${missingDetails ? `<p class="note" id="detailsNote">Recupero rarità e tipo di ${missingDetails} carte…</p>` : ''}
    ${byRarity.length ? `<h2>Per rarità</h2>${byRarity.map(([label, list]) => group(label, list)).join('')}` : ''}
    ${byVariant.length ? `<h2>Per variante</h2>${byVariant.map(([label, list, n]) => group(label, list, ` · ${plural(n, 'copia', 'copie')} in questa variante`)).join('')}` : ''}
    ${byKind.length ? `<h2>Per tipo di carta</h2>${byKind.map(([label, list]) => group(label, list)).join('')}` : ''}
    ${bySet.size ? `<h2>Per set</h2>` + [...bySet].sort((a, b) => b[1].value - a[1].value).map(([id, s]) => {
      const tot = names.get(id)?.cardCount.total;
      return `<a class="setrow" href="#/set/${encodeURIComponent(id)}">
        <span class="logo">${names.has(id) ? setLogo(names.get(id)) : ''}</span>
        <span class="info"><b>${esc(names.get(id)?.name ?? id)}</b>${bar(s.n, tot)}</span>
        <span class="count">${s.n}${tot ? '/' + tot : ''}<br>${eur(s.value)}</span>
      </a>`;
    }).join('') : ''}`;

  if (missingDetails) fillDetails(recs, () => { if (location.hash === '#/stats' && !sheet.open) stats(); });
}

// ---------------------------------------------------------------------------
// Album: come sistemare fisicamente le carte
// ---------------------------------------------------------------------------
// Soglie di protezione, modificabili dalla pagina e ricordate sul dispositivo.
const protection = {
  get toploader() { return meta.get('tlEuro') || 10; },
  get sleeve() { return meta.get('slEuro') || 1; },
};
// Rarità che meritano comunque la bustina / il toploader, a prescindere dal prezzo.
const SLEEVE_RARITY = rarityRank('Rara illustrazione');
const TOPLOADER_RARITY = rarityRank('Rara illustrazione speciale');

// Dove tenere una carta: in base alla copia di valore più alto e alla rarità.
function protectionOf(rec) {
  const best = Math.max(0, ...rec.copies.map(c => unitPrice(rec, c.variant)));
  const rank = rarityRank(rec.rarity);
  if (best >= protection.toploader || rank >= TOPLOADER_RARITY) return 'toploader';
  if (best >= protection.sleeve || rank >= SLEEVE_RARITY) return 'sleeve';
  return 'album';
}

let albumSet = '', albumPockets = 9, albumGaps = true;

async function album() {
  const recs = [...coll.values()].filter(qty);
  if (!recs.length) {
    view.innerHTML = `<header class="top"><h1>Album</h1></header>
      <p class="empty">Aggiungi qualche carta alla collezione:<br>qui ti aiuto a sistemarle.</p>`;
    return;
  }
  const names = new Map();
  try {
    for (const serie of await getCatalog()) for (const s of serie.sets) names.set(s.id, s);
  } catch { /* offline */ }
  const owned = ownedBySet();
  const sets = [...owned.keys()].sort((a, b) => (names.get(a)?.name ?? a).localeCompare(names.get(b)?.name ?? b));
  if (!owned.has(albumSet)) albumSet = sets[0];

  const tiers = { toploader: [], sleeve: [], album: [] };
  for (const r of recs) tiers[protectionOf(r)].push(r);
  const copiesOf = list => list.reduce((a, r) => a + qty(r), 0);
  const doubles = recs.filter(r => qty(r) > 1);

  const toComplete = sets.map(id => {
    const tot = names.get(id)?.cardCount.total ?? 0;
    return { id, n: owned.get(id), tot, pct: tot ? owned.get(id) / tot : 0 };
  }).sort((a, b) => b.pct - a.pct);

  view.innerHTML = `<header class="top"><h1>Album</h1></header>

    <h2>Protezione consigliata</h2>
    <p class="note">In base al valore della copia migliore e alla rarità. Il toploader (custodia rigida) va
      sempre usato con la bustina dentro.</p>
    ${group(`Toploader + bustina`, tiers.toploader, ` · ${copiesOf(tiers.toploader)} toploader`)}
    ${group('Bustina (sleeve) nell\'album', tiers.sleeve, ` · ${plural(copiesOf(tiers.sleeve), 'bustina', 'bustine')}`)}
    ${group('Album, senza bustina', tiers.album)}
    <div class="settings">
      <label>Toploader da <input type="number" min="1" step="1" data-setting="tlEuro" value="${protection.toploader}"> €</label>
      <label>Bustina da <input type="number" min="0" step="0.5" data-setting="slEuro" value="${protection.sleeve}"> €</label>
    </div>

    <h2>Pagine dell'album</h2>
    <p class="note">Le carte nell'ordine del set, pagina per pagina. I posti vuoti sono le carte che ti
      mancano: lasciali liberi e, quando le trovi, sai già dove vanno.</p>
    <div class="settings">
      <select id="albumSet">${options(sets.map(id => [id, names.get(id)?.name ?? id]), albumSet)}</select>
      <select id="albumPockets">${options([[4, '4 tasche (2×2)'], [9, '9 tasche (3×3)'], [12, '12 tasche (3×4)']], albumPockets)}</select>
      <label><input type="checkbox" id="albumGaps" ${albumGaps ? 'checked' : ''}> Lascia i posti per le mancanti</label>
    </div>
    <div id="albumPages"><p class="note">Caricamento…</p></div>

    <h2>Set da completare</h2>
    ${toComplete.map(s => `<div class="setrow">
      <span class="logo">${names.has(s.id) ? setLogo(names.get(s.id)) : ''}</span>
      <span class="info"><a href="#/set/${encodeURIComponent(s.id)}"><b>${esc(names.get(s.id)?.name ?? s.id)}</b></a>
        ${bar(s.n, s.tot)}<small data-cost="${esc(s.id)}">${s.tot - s.n === 1 ? 'manca 1 carta' : `mancano ${s.tot - s.n} carte`}</small></span>
      <button class="chip" data-act="cost" data-set="${esc(s.id)}">Quanto costa?</button>
    </div>`).join('')}

    <h2>Doppioni</h2>
    ${doubles.length ? group('Copie in più, da scambiare', doubles,
      ` · ${copiesOf(doubles) - doubles.length} in più`) : '<p class="note">Nessun doppione.</p>'}`;

  renderAlbumPages();
}

async function renderAlbumPages() {
  const box = $('#albumPages');
  if (!box || !albumSet) return;
  let set;
  try { set = await getSet(albumSet); } catch (err) { box.innerHTML = failed(err); return; }
  for (const c of set.cards) briefs.set(c.id, { ...c, setId: set.id });
  const cards = albumGaps ? set.cards : set.cards.filter(c => qty(coll.get(c.id)));
  const cols = albumPockets === 4 ? 2 : 3;
  const pages = [];
  for (let i = 0; i < cards.length; i += albumPockets) pages.push(cards.slice(i, i + albumPockets));
  box.innerHTML = pages.map((page, p) => `<div class="page">
      <small>Pagina ${p + 1}${p % 2 ? ' (retro)' : ' (fronte)'} · ${page[0].localId}–${page.at(-1).localId}</small>
      <div class="pockets" style="grid-template-columns:repeat(${cols},1fr)">
        ${page.map(c => {
          const rec = coll.get(c.id);
          if (!qty(rec)) return `<div class="pocket empty" data-card="${esc(c.id)}"><b>${esc(c.localId)}</b><span>${esc(c.name)}</span></div>`;
          const tier = protectionOf(rec);
          return `<div class="pocket" data-card="${esc(c.id)}">${cardImg(c.id, c.image, 'low')}
            ${tier === 'toploader' ? '<i class="tag">TL</i>' : tier === 'sleeve' ? '<i class="tag sl">B</i>' : ''}</div>`;
        }).join('')}
      </div>
    </div>`).join('') + `<p class="note">TL = va nel toploader (puoi lasciare il posto libero o un segnaposto) ·
      B = mettila nell'album dentro una bustina.</p>`;
}

// Stima del costo per completare un set: somma dei prezzi trend delle carte mancanti.
async function completionCost(setId, label) {
  const set = await getSet(setId);
  const missing = set.cards.filter(c => !qty(coll.get(c.id)));
  let total = 0, unpriced = 0, done = 0;
  const queue = [...missing];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let c; (c = queue.shift());) {
      try {
        const cm = (await getCard(c.id)).pricing?.cardmarket;
        const price = cm && (cm.trend || cm.avg || cm['trend-holo'] || cm['avg-holo']);
        if (price) total += price; else unpriced++;
      } catch { unpriced++; }
      label.textContent = `calcolo… ${++done}/${missing.length}`;
    }
  }));
  label.textContent = (missing.length === 1 ? 'manca 1 carta' : `mancano ${missing.length} carte`) + ` · circa ${eur(total)}`
    + (unpriced ? ` (${unpriced} senza prezzo)` : '');
}

function wish() {
  const recs = [...coll.values()].filter(r => r.wish);
  view.innerHTML = `<header class="top"><h1>Wishlist</h1></header>` + (recs.length
    ? `<div class="grid">${recs.map(r => tile(recBrief(r))).join('')}</div>`
    : '<p class="empty">Nessuna carta in wishlist.<br>Apri una carta e tocca ★.</p>');
}

function backupStatus() {
  const last = meta.get('lastBackup'), dirty = meta.get('dirty');
  if (!coll.size) return 'La collezione è vuota: niente da salvare.';
  const when = last && new Date(last).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
  if (native) return 'Copia automatica attiva: Download/GAPokemon/ga-pokemon-backup.json'
    + (last ? ` · ultimo salvataggio ${when}` : '');
  if (!last) return 'Non hai ancora fatto un backup.';
  return `Ultimo backup: ${when} · ` + (dirty ? `${dirty} modifiche da allora` : 'tutto salvato');
}

function more() {
  view.innerHTML = `<header class="top"><h1>Altro</h1></header>
    <h2>Backup della collezione</h2>
    <p class="note" id="backupStatus">${backupStatus()}</p>
    <div class="list">
      ${shareFile() ? '<button data-act="share">Salva backup su Drive, email o altra app</button>' : ''}
      <button data-act="export">${native ? 'Salva adesso la copia di sicurezza' : 'Scarica backup come file'}</button>
      <button data-act="import">Ripristina da un backup</button>
      <input type="file" id="file" accept="application/json,text/plain,.json,.txt" hidden>
    </div>
    ${native ? `<h2>App</h2>
    <p class="note">Versione installata: ${esc(apkVersion())} · contenuti: ${esc(APP_VERSION)}</p>
    <div class="list"><button data-act="checkUpdate">Controlla aggiornamenti</button></div>` : ''}
    <h2>Manutenzione</h2>
    <div class="list">
      <button data-act="prices">Aggiorna i prezzi della collezione</button>
      <button data-act="cache">Svuota la cache del catalogo</button>
    </div>
    <p class="note" id="msg"></p>
    <p class="note">La collezione resta salvata su questo dispositivo anche chiudendo l'app. Il backup serve
      se cambi telefono o cancelli i dati del browser.<br>
      Dati e immagini: TCGdex. Prezzi: trend Cardmarket.</p>`;
}

// ---------------------------------------------------------------------------
// Scheda carta
// ---------------------------------------------------------------------------
let cur = null;

async function openCard(id) {
  cur = structuredClone(recFor(id));
  renderSheet();
  sheet.showModal();
  try {
    const d = await getCard(id);
    if (cur?.cardId !== id) return;
    applyDetail(cur, d);
    if (coll.has(id)) await save(cur);
    renderSheet();
  } catch { /* offline: si lavora con quello che c'è */ }
}

function renderSheet() {
  const p = cur.price;
  const variantList = Object.entries(VARIANTS);
  sheet.innerHTML = `<div class="sheet-head">
      <div><h2>${esc(cur.name)}</h2><small>${setNames.has(cur.setId) ? esc(setNames.get(cur.setId)) + ' · ' : ''}N° ${esc(cur.localId)}${cur.rarity && cur.rarity !== 'Nessuna' ? ' · ' + esc(cur.rarity) : ''}</small></div>
      <button class="icon ${cur.wish ? 'on' : ''}" data-wish aria-label="Wishlist">★</button>
      <button class="icon" data-close aria-label="Chiudi">✕</button>
    </div>
    ${cardImg(cur.cardId, cur.image, 'high', 'big')}
    <p class="prices">${p && (p.nonFoil || p.foil)
      ? [p.nonFoil && `${cur.variants && !cur.variants.normal ? 'Prezzo' : 'Normale'} ${eur(p.nonFoil)}`, p.foil && `Foil ${eur(p.foil)}`].filter(Boolean).join(' · ')
      : 'Prezzo non disponibile'}</p>
    <h3>Le mie copie <span>${qty(cur)}</span></h3>
    ${cur.copies.map((c, i) => `<div class="copy" data-i="${i}">
      <select data-f="variant">${options(variantList.filter(([k]) =>
        !cur.variants || cur.variants[k] || k === c.variant), c.variant)}</select>
      <select data-f="condition">${options(CONDITIONS.map(x => [x, x]), c.condition)}</select>
      <select data-f="lang">${options(LANGS.map(x => [x, x]), c.lang)}</select>
      <div class="stepper"><button data-step="-1">−</button><b>${c.qty}</b><button data-step="1">+</button></div>
      <input data-f="grade" placeholder="Gradazione (es. PSA 10)" value="${esc(c.grade)}">
      <input data-f="note" placeholder="Note" value="${esc(c.note)}">
    </div>`).join('')}
    <button class="primary" data-newcopy>+ Aggiungi copia</button>`;
}

sheet.addEventListener('click', async e => {
  if (e.target === sheet || e.target.closest('[data-close]')) {
    sheet.close();
    return afterClose();
  }
  if (!cur) return;
  if (e.target.closest('[data-wish]')) cur.wish = !cur.wish;
  else if (e.target.closest('[data-newcopy]')) cur.copies.push(newCopy(cur));
  else if (e.target.closest('[data-step]')) {
    const i = +e.target.closest('.copy').dataset.i;
    cur.copies[i].qty += +e.target.closest('[data-step]').dataset.step;
  } else return;
  await save(cur);
  renderSheet();
});

sheet.addEventListener('change', async e => {
  const f = e.target.dataset.f;
  if (!f || !cur) return;
  cur.copies[+e.target.closest('.copy').dataset.i][f] = e.target.value.trim();
  await save(cur);
});

// Alla chiusura si aggiorna solo la carta toccata, così la pagina sotto non salta in cima.
// Collezione e Wishlist invece vanno ricalcolate per intero.
function afterClose() {
  if (!cur) return;
  const id = cur.cardId;
  cur = null;
  const page = location.hash.replace(/^#\/?/, '').split('/')[0];
  if (page === 'stats' || page === 'wish' || page === 'album') route();
  else refreshCard(id);
}
// L'evento "close" copre il tasto Indietro del telefono; può arrivare in ritardo, quindi
// la chiusura dal pulsante aggiorna subito senza aspettarlo.
sheet.addEventListener('close', afterClose);

// Chiamata dall'APK quando si preme Indietro: true = gestito qui (c'era la scheda carta aperta).
window.appBack = () => {
  if (sheet.open) {
    sheet.close();
    afterClose();
    return true;
  }
  if (scanner.open) {
    closeScanner();
    return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Scansione di una carta con la fotocamera (riconoscimento in js/scan.js)
// ---------------------------------------------------------------------------
const scanner = $('#scanner');
const scanVideo = scanner.querySelector('video');
let scanStream = null;

async function openScanner() {
  $('#scanMsg').textContent = '';
  $('#scanResults').innerHTML = '';
  scanner.showModal();
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    scanVideo.srcObject = scanStream;
    await scanVideo.play();
    scanner.classList.remove('nocam');
  } catch {
    scanner.classList.add('nocam');
    // Le versioni dell'APK prima della 1.2 non hanno il permesso per la fotocamera.
    $('#scanMsg').textContent = apkUpdate
      ? 'Per usare la fotocamera aggiorna l\'app (avviso nella schermata iniziale). Intanto puoi usare una foto della carta.'
      : 'Fotocamera non disponibile o permesso negato: puoi usare una foto della carta.';
  }
}

function stopCamera() {
  scanStream?.getTracks().forEach(t => t.stop());
  scanStream = null;
}

function closeScanner() {
  stopCamera();
  if (scanner.open) scanner.close();
}

let scanning = false, lastReading = null;
async function recognize(card) {
  if (scanning) return;
  scanning = true;
  const msg = $('#scanMsg');
  $('#scanResults').innerHTML = '';
  $('#scanFix').hidden = true;
  try {
    lastReading = await readCard(card, status => { msg.textContent = status; });
    await showMatches(lastReading);
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    scanning = false;
  }
}

async function showMatches(reading) {
  const msg = $('#scanMsg');
  msg.textContent = 'Cerco nel catalogo…';
  const found = await findCards(reading);
  for (const c of found) briefs.set(c.id, c);
  const n = reading.number;
  const numberText = n ? `Ho letto il numero ${n.prefix}${n.num}${n.total ? '/' + n.total : ''}. ` : 'Non sono riuscito a leggere il numero. ';
  msg.textContent = found.length
    ? numberText + 'Tocca la carta giusta per aprirla, oppure + per aggiungerla subito.'
    : numberText + 'Nessuna carta trovata: riprova con più luce e la carta dritta e ferma, o scrivi il numero qui sotto.';
  $('#scanFix').hidden = false;
  $('#scanNumber').value = '';
  $('#scanResults').innerHTML = found.length ? `<div class="grid">${found.map(c =>
    `<div class="result">${tile(c)}<small>${esc(c.setName)}</small></div>`).join('')}</div>` : '';
}

// Correzione a mano del numero letto male: stessa ricerca, con il nome letto dalla foto.
$('#scanFix').addEventListener('submit', async e => {
  e.preventDefault();
  const number = parseNumber($('#scanNumber').value);
  if (!number) {
    $('#scanMsg').textContent = 'Scrivi il numero come sulla carta, es. 81/198 oppure TG12/TG30.';
    return;
  }
  await showMatches({ number, nameText: lastReading?.nameText ?? '' });
});

scanner.addEventListener('click', e => {
  if (e.target === scanner || e.target.closest('[data-close-scan]')) return closeScanner();
  if (e.target.closest('[data-shot]')) {
    if (!scanStream) return $('#scanFile').click();
    return recognize(captureFromVideo(scanVideo, scanner.querySelector('.frame')));
  }
  const add = e.target.closest('[data-add]');
  if (add) return quickAdd(add.dataset.add);
  const card = e.target.closest('[data-card]');
  if (card) openCard(card.dataset.card);   // la scheda si apre sopra: chiudendola si torna a scansionare
});

scanner.addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (e.target.id !== 'scanFile' || !file) return;
  e.target.value = '';
  recognize(await canvasFromFile(file));
});

scanner.addEventListener('close', stopCamera);

function refreshCard(id) {
  const b = briefs.get(id);
  if (b) for (const el of document.querySelectorAll(`[data-card="${CSS.escape(id)}"]`)) el.outerHTML = tile(b);
  renderProgress();
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------
// Le aggiunte rapide vanno in fila: due tocchi veloci sulla stessa carta devono contare due copie.
let addQueue = Promise.resolve();
const quickAdd = id => (addQueue = addQueue.then(() => addCopy(id)).catch(() => {}));

async function addCopy(id) {
  const rec = structuredClone(recFor(id));
  if (!rec.variants) {
    try { applyDetail(rec, await getCard(id)); } catch { /* offline */ }
  }
  if (rec.copies[0]) rec.copies[0].qty++;
  else rec.copies.push(newCopy(rec));
  await save(rec);
  refreshCard(id);
}

async function refreshPrices(msg) {
  const recs = [...coll.values()];
  let done = 0, errors = 0;
  const queue = [...recs];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let rec; (rec = queue.shift());) {
      try {
        applyDetail(rec, await getCard(rec.cardId, true));
        await db.put('cards', rec);
      } catch { errors++; }
      msg.textContent = `Aggiornamento prezzi… ${++done}/${recs.length}`;
    }
  }));
  msg.textContent = `Prezzi aggiornati: ${done - errors} carte` + (errors ? `, ${errors} non riuscite.` : '.');
}

const backupJson = () => JSON.stringify({ app: 'pokecollezione', version: 1, cards: [...coll.values()] });
const backupName = ext => `ga-pokemon-${new Date().toISOString().slice(0, 10)}.${ext}`;

// File di backup che il telefono accetta di condividere con altre app (Drive, email, WhatsApp…),
// oppure null se la condivisione di file non è disponibile. Non tutti accettano i .json: si prova anche .txt.
function shareFile() {
  for (const [ext, type] of [['json', 'application/json'], ['txt', 'text/plain']]) {
    const file = new File([backupJson()], backupName(ext), { type });
    if (navigator.canShare?.({ files: [file] })) return file;
  }
  return null;
}

function backupDone() {
  meta.set('lastBackup', Date.now());
  meta.set('dirty', 0);
  $('#backupStatus').textContent = backupStatus();
}

async function shareBackup(msg) {
  try {
    await navigator.share({ files: [shareFile()], title: 'Backup GA Pokémon' });
    backupDone();
  } catch (err) {
    if (err.name !== 'AbortError') msg.textContent = 'Condivisione non riuscita: prova a scaricare il file.';
  }
}

function exportBackup(msg) {
  if (native) {
    const path = native.saveBackup(backupJson());
    msg.textContent = path ? `Copia salvata in ${path}.` : 'Salvataggio non riuscito.';
    if (path) backupDone();
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([backupJson()], { type: 'application/json' }));
  a.download = backupName('json');
  a.click();
  URL.revokeObjectURL(a.href);
  backupDone();
}

async function importBackup(file, msg) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'pokecollezione' || !Array.isArray(data.cards)) throw new Error('formato non riconosciuto');
    for (const rec of data.cards) {
      if (!rec.cardId || !Array.isArray(rec.copies)) continue;
      coll.set(rec.cardId, rec);
      await db.put('cards', rec);
    }
    autoBackup();
    msg.textContent = `Carte importate: ${data.cards.length}.`;
    $('#backupStatus').textContent = backupStatus();
  } catch (err) {
    msg.textContent = 'Importazione non riuscita: ' + err.message;
  }
}

view.addEventListener('click', async e => {
  const add = e.target.closest('[data-add]');
  if (add) return quickAdd(add.dataset.add);
  const card = e.target.closest('[data-card]');
  if (card) return openCard(card.dataset.card);
  const filter = e.target.closest('[data-filter]');
  if (filter) {
    setFilter = filter.dataset.filter;
    for (const c of view.querySelectorAll('[data-filter]')) c.classList.toggle('on', c === filter);
    return renderGrid();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  const msg = $('#msg');
  if (act === 'prices') await refreshPrices(msg);
  if (act === 'scan') openScanner();
  if (act === 'cost') {
    const btn = e.target.closest('[data-act]');
    btn.remove();
    await completionCost(btn.dataset.set, view.querySelector(`[data-cost="${CSS.escape(btn.dataset.set)}"]`));
  }
  if (act === 'update') {
    const button = e.target.closest('[data-act]');
    button.removeAttribute('data-act');   // un solo download anche con più tocchi
    setTimeout(() => button.setAttribute('data-act', 'update'), 10000);
    native.installUpdate(apkUpdate.url);
    button.textContent = 'Download in corso: al termine si apre l\'installazione. '
      + 'Se Android chiede il permesso di installare app, attivalo e tocca di nuovo qui.';
  }
  if (act === 'checkUpdate') {
    msg.textContent = 'Controllo in corso…';
    await checkApkUpdate();
    msg.innerHTML = apkUpdate ? updateBanner() : 'Hai già l\'ultima versione.';
  }
  if (act === 'share') await shareBackup(msg);
  if (act === 'export') exportBackup(msg);
  if (act === 'import') $('#file').click();
  if (act === 'cache') {
    await db.clear('cache');
    curSet = null;
    msg.textContent = 'Cache svuotata: il catalogo verrà riscaricato.';
  }
});

view.addEventListener('input', e => {
  if (e.target.id === 'hq') {
    homeQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderHome, 300);
    return;
  }
  if (e.target.id !== 'q') return;
  setQuery = e.target.value;
  renderGrid();
});

view.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'file' && t.files[0]) importBackup(t.files[0], $('#msg'));
  if (t.id === 'albumSet') { albumSet = t.value; renderAlbumPages(); }
  if (t.id === 'albumPockets') { albumPockets = +t.value; renderAlbumPages(); }
  if (t.id === 'albumGaps') { albumGaps = t.checked; renderAlbumPages(); }
  if (t.dataset.setting && +t.value >= 0) { meta.set(t.dataset.setting, +t.value); album(); }
});

// Loghi dei set non caricati: si riprova qualche volta, poi si nasconde l'icona di immagine rotta.
// (Le immagini delle carte hanno la loro coda, imageQueue.)
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG' || img.dataset.src !== undefined) return;
  const tries = +(img.dataset.tries ?? 0);
  if (tries < 3) {
    img.dataset.tries = tries + 1;
    setTimeout(() => { if (img.isConnected) img.src = img.src; }, 1500 * (tries + 1));
  } else {
    img.style.visibility = 'hidden';
  }
}, true);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route() {
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const tab = page === 'set' ? 'home' : page || 'home';
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.tab === tab);
  try {
    if (page === 'set') await setView(decodeURIComponent(arg));
    else if (page === 'stats') await stats();
    else if (page === 'wish') wish();
    else if (page === 'album') await album();
    else if (page === 'more') more();
    else await home();
  } catch (err) {
    view.innerHTML = failed(err);
  }
}

// Ogni pagina ricorda dov'era lo scorrimento: tornando indietro da un set si ritrova il punto di prima.
const scrollPos = new Map();
addEventListener('hashchange', async e => {
  scrollPos.set(new URL(e.oldURL).hash, scrollY);
  await route();
  scrollTo(0, scrollPos.get(location.hash) ?? 0);
});

// Apertura e chiusura delle serie ("toggle" non risale la pagina, quindi si ascolta in cattura).
view.addEventListener('toggle', e => {
  const id = e.target.dataset?.serie;
  if (!id) return;
  if (e.target.open) openSeries.add(id);
  else openSeries.delete(id);
}, true);

// Nuova versione pubblicata (version.txt diverso da quella caricata): si ricarica l'app, così la
// modifica arriva anche se l'app era rimasta aperta in secondo piano. Mai con una scheda o la
// fotocamera aperte, e una sola volta per versione (se qualcosa va storto non si entra in un ciclo).
async function checkWebUpdate() {
  if (APP_VERSION === 'dev') return;
  try {
    const latest = (await (await fetch('version.txt', { cache: 'no-store' })).text()).trim();
    if (!latest || latest === APP_VERSION || sheet.open || scanner.open) return;
    if (sessionStorage.getItem('reloadedFor') === latest) return;
    sessionStorage.setItem('reloadedFor', latest);
    location.reload();
  } catch { /* offline: si riprova al prossimo ritorno */ }
}

// Se l'app resta in secondo piano più di qualche minuto, al ritorno riparte da capo come appena
// aperta: schermata iniziale, serie chiuse, ricerca vuota. Le uscite brevi (fotocamera, scelta
// di un file, un messaggio) invece non toccano nulla.
const RESET_AFTER = 5 * 60 * 1000;
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  checkWebUpdate();
  if (!hiddenAt || Date.now() - hiddenAt < RESET_AFTER) return;
  openSeries.clear();
  scrollPos.clear();
  homeQuery = '';
  if (sheet.open) {
    sheet.close();
    afterClose();
  }
  if (location.hash === '#/') route();
  else location.hash = '#/';
  scrollTo(0, 0);
});

// All'avvio si parte sempre dalla schermata iniziale, anche se l'app era rimasta su un set.
history.replaceState(null, '', location.pathname + location.search + '#/');

for (const rec of await db.all('cards')) coll.set(rec.cardId, rec);
navigator.storage?.persist?.();
// updateViaCache "none": il telefono controlla sempre sul server se il service worker è cambiato.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
route();
checkApkUpdate();
checkWebUpdate();
