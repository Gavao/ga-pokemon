import { db } from './db.js';
import { getCatalog, getSet, getCard, searchCards } from './api.js';
import { LOGOS } from './logos.js';
import { IMAGES } from './images.js';

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
// quindi lì niente crossorigin.
function cardImg(id, image, size, cls = '') {
  const src = image ?? IMAGES[id];
  if (!src) return '';
  const limitless = src.includes('limitlesstcg'), tcgplayer = src.includes('tcgplayer');
  const url = limitless ? (size === 'high' ? src.replace('_SM.png', '_LG.png') : src)
    : tcgplayer ? (size === 'high' ? src : src.replace('.com/', '.com/fit-in/437x437/'))
    : src.includes('scrydex') ? `${src}/${size === 'high' ? 'large' : 'small'}`
    : `${src}/${size}.webp`;
  return `<img class="${cls}" ${limitless || tcgplayer ? '' : 'crossorigin="anonymous"'} loading="lazy" src="${esc(url)}" alt="">`;
}

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
  view.innerHTML = `<header class="top"><h1>GA Pokémon</h1></header>
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
    body.innerHTML = catalog.map((serie, i) => {
      const started = serie.sets.filter(s => owned.get(s.id)).length;
      return `<details class="serie" ${i === 0 || started ? 'open' : ''}>
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

  view.innerHTML = `<header class="top"><h1>Collezione</h1></header>
    <div class="kpis">
      <div><b>${eur(value)}</b><small>Valore stimato</small></div>
      <div><b>${recs.length}</b><small>Carte diverse</small></div>
      <div><b>${copies}</b><small>Copie totali</small></div>
      <div><b>${copies - recs.length}</b><small>Doppioni</small></div>
    </div>
    ${recs.length ? '' : '<p class="empty">Non hai ancora aggiunto carte.<br>Apri un set e tocca + su una carta.</p>'}
    ${bySet.size ? `<h2>Per set</h2>` + [...bySet].sort((a, b) => b[1].value - a[1].value).map(([id, s]) => {
      const tot = names.get(id)?.cardCount.total;
      return `<a class="setrow" href="#/set/${encodeURIComponent(id)}">
        <span class="logo">${names.has(id) ? setLogo(names.get(id)) : ''}</span>
        <span class="info"><b>${esc(names.get(id)?.name ?? id)}</b>${bar(s.n, tot)}</span>
        <span class="count">${s.n}${tot ? '/' + tot : ''}<br>${eur(s.value)}</span>
      </a>`;
    }).join('') : ''}
    ${top.length ? `<h2>Carte di maggior valore</h2><div class="grid">${top.map(x => tile(recBrief(x.r))).join('')}</div>` : ''}`;
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
  if (page === 'stats' || page === 'wish') route();
  else refreshCard(id);
}
// L'evento "close" copre il tasto Indietro del telefono; può arrivare in ritardo, quindi
// la chiusura dal pulsante aggiorna subito senza aspettarlo.
sheet.addEventListener('close', afterClose);

// Chiamata dall'APK quando si preme Indietro: true = gestito qui (c'era la scheda carta aperta).
window.appBack = () => {
  if (!sheet.open) return false;
  sheet.close();
  afterClose();
  return true;
};

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
  if (e.target.id === 'file' && e.target.files[0]) importBackup(e.target.files[0], $('#msg'));
});

// Immagine non caricata: il server a volte rifiuta le richieste quando ne arrivano tante insieme,
// quindi si riprova qualche volta; solo dopo si mostra il nome della carta.
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG') return;
  const tries = +(img.dataset.tries ?? 0);
  if (tries < 3) {
    img.dataset.tries = tries + 1;
    setTimeout(() => { if (img.isConnected) img.src = img.src; }, 1500 * (tries + 1));
  } else if (img.closest('.tile')) {
    img.closest('.tile').classList.add('noimg');
  } else {
    img.style.visibility = 'hidden';   // logo o immagine grande: niente icona di immagine rotta
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

for (const rec of await db.all('cards')) coll.set(rec.cardId, rec);
navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
route();
