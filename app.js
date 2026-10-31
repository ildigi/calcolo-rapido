'use strict';

// Problem generation mirrors Zetamac: subtraction is addition in reverse,
// division is multiplication in reverse, operations are picked uniformly.
const PRESETS = [
  {
    id: 't12', name: 'T12', title: 'Tabelline',
    desc: '× ÷ · 2–12 per 2–12',
    ops: ['mul', 'div'], mul: [[2, 12], [2, 12]],
  },
  {
    id: 't100', name: 'T100', title: 'Una cifra per due cifre',
    desc: '× ÷ · 2–12 per 2–100',
    ops: ['mul', 'div'], mul: [[2, 12], [2, 100]],
  },
  {
    id: 'def', name: 'Default', title: 'Come Zetamac',
    desc: '+ − × ÷ · standard',
    ops: ['add', 'sub', 'mul', 'div'], add: [[2, 100], [2, 100]], mul: [[2, 12], [2, 100]],
  },
];
const DURATION_MS = 120 * 1000;
const STORAGE_KEY = 'calcolo.v1.sessions';
const MAX_DIGITS = 5;

const $ = (id) => document.getElementById(id);
const screens = { login: $('login'), home: $('home'), game: $('game'), results: $('results') };

// ---------- Storage (wrapped: storage can be unavailable) ----------
// Each session: { id, preset, score, date, slow, synced }.
function loadSessions() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
function storeSessions(all) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(-1000)));
    return true;
  } catch {
    return false;
  }
}
function saveSession(session) {
  const all = loadSessions();
  all.push(session);
  return storeSessions(all);
}
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// Games saved before sync existed have no id: give them one so they upload too.
function migrateSessions() {
  const all = loadSessions();
  if (all.some((s) => !s.id)) storeSessions(all.map((s) => (s.id ? s : { ...s, id: newId(), synced: false })));
}

// ---------- Sync with Supabase ----------
const sync = { busy: false, error: '' };

function describeError(error) {
  if (!error || error.status === undefined) return 'Nessuna connessione: le partite restano sul telefono e partono appena torni online.';
  if (error.status === 401 || error.status === 403 || error.code === '42501') return 'Account non autorizzato a salvare i dati.';
  if (error.status === 429) return 'Troppe richieste: riprova tra qualche minuto.';
  return `Sincronizzazione non riuscita (${error.status}).`;
}

async function syncNow() {
  if (sync.busy || !Cloud.signedIn) return;
  sync.busy = true;
  sync.error = '';
  renderAccount();
  try {
    const pending = loadSessions().filter((s) => !s.synced);
    await Cloud.upload(pending.map((s) => ({
      id: s.id, preset: s.preset, score: s.score, played_at: s.date, slow: s.slow || [],
    })));
    const uploaded = new Set(pending.map((s) => s.id));
    // Merge games that exist only on the server (for example after reinstalling the app).
    const remote = await Cloud.download();
    const all = loadSessions().map((s) => (uploaded.has(s.id) ? { ...s, synced: true } : s));
    const known = new Set(all.map((s) => s.id));
    for (const r of remote) {
      if (!known.has(r.id)) all.push({ id: r.id, preset: r.preset, score: r.score, date: r.played_at, slow: r.slow || [], source: r.source || 'app', synced: true });
    }
    all.sort((a, b) => new Date(a.date) - new Date(b.date));
    storeSessions(all);
    // Keep this device's push subscription current on the server (it can change over time).
    const subscription = await currentSubscription().catch(() => null);
    if (subscription && Notification.permission === 'granted') await Cloud.savePushSubscription(subscription);
  } catch (error) {
    sync.error = describeError(error);
    if (!Cloud.signedIn) showLogin('La sessione è scaduta: accedi di nuovo.');
  } finally {
    sync.busy = false;
    if (!screens.home.hidden) renderHome(); else renderAccount();
  }
}

function renderAccount() {
  const pending = loadSessions().filter((s) => !s.synced).length;
  $('account-line').textContent = Cloud.signedIn ? `Accesso come ${Cloud.email}` : 'Non hai effettuato l\'accesso.';
  const status = $('sync-status');
  status.classList.toggle('problem', Boolean(sync.error));
  const pendingText = pending ? `${pending === 1 ? '1 partita da inviare' : `${pending} partite da inviare`}.` : '';
  if (sync.busy) status.textContent = 'Sincronizzazione in corso…';
  else if (sync.error) status.textContent = `${pendingText} ${sync.error}`.trim();
  else if (pending) status.textContent = pendingText;
  else status.textContent = 'Tutte le partite sono salvate online.';
  $('sync-now').disabled = sync.busy;
}

// ---------- Push reminders ----------
// Public half of the VAPID pair created by the "promemoria" Edge Function (the private half stays in Supabase Vault).
const VAPID_PUBLIC_KEY = 'BJWwc9WuLgFm4E-hvPKWREHzoRdhTK6dA6lHyh2hXYfKM6gN2_DVgMGwdgIQic5WKxwYRYd_ILYdD2hw5y3lj7c';
const pushState = { busy: false, message: '', problem: false };
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

function keyBytes(base64url) {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

async function renderPush() {
  const enable = $('push-enable');
  const test = $('push-test');
  const disable = $('push-disable');
  const status = $('push-status');
  enable.hidden = true;
  test.hidden = true;
  disable.hidden = true;
  status.classList.toggle('problem', pushState.problem);
  if (!pushSupported()) {
    status.textContent = isStandalone()
      ? 'Questo iPhone non supporta le notifiche delle web app: serve iOS 16.4 o successivo.'
      : 'Per ricevere i promemoria apri l\'app dall\'icona sulla schermata Home.';
    return;
  }
  if (Notification.permission === 'denied') {
    status.textContent = 'Notifiche bloccate. Riattivale in Impostazioni → Notifiche → Calcolo.';
    status.classList.add('problem');
    return;
  }
  const subscription = await currentSubscription().catch(() => null);
  const busyText = pushState.busy ? 'Un momento…' : '';
  if (subscription && Notification.permission === 'granted') {
    status.textContent = busyText || pushState.message || 'Promemoria attivi su questo dispositivo.';
    test.hidden = false;
    disable.hidden = false;
  } else {
    status.textContent = busyText || pushState.message || 'Promemoria non attivi su questo dispositivo.';
    enable.hidden = false;
  }
  for (const button of [enable, test, disable]) button.disabled = pushState.busy;
}

async function runPushAction(action) {
  if (pushState.busy) return;
  pushState.busy = true;
  pushState.message = '';
  pushState.problem = false;
  renderPush();
  try {
    pushState.message = await action();
  } catch (error) {
    pushState.problem = true;
    pushState.message = error && error.status !== undefined
      ? `Operazione non riuscita (${error.status}). Riprova tra poco.`
      : 'Operazione non riuscita: controlla la connessione e riprova.';
  } finally {
    pushState.busy = false;
    renderPush();
  }
}

function enablePush() {
  // iOS only shows the permission prompt when it is requested right inside the tap.
  const permission = Notification.requestPermission();
  runPushAction(async () => {
    const result = await permission;
    if (result !== 'granted') {
      pushState.problem = true;
      return 'Permesso non concesso: senza permesso iOS non mostra le notifiche.';
    }
    const registration = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('sw.js'));
    await navigator.serviceWorker.ready;
    const subscription = (await registration.pushManager.getSubscription())
      || (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
    await Cloud.savePushSubscription(subscription);
    return 'Promemoria attivi. Prova con "Invia una notifica di prova".';
  });
}

function testPush() {
  runPushAction(async () => {
    const result = await Cloud.sendTestPush();
    if (result.sent > 0) return 'Notifica inviata: dovrebbe arrivare tra pochi secondi.';
    pushState.problem = true;
    return 'Nessun dispositivo registrato: disattiva e riattiva i promemoria.';
  });
}

function disablePush() {
  runPushAction(async () => {
    const subscription = await currentSubscription();
    if (subscription) {
      await Cloud.deletePushSubscription(subscription.endpoint);
      await subscription.unsubscribe();
    }
    return 'Promemoria disattivati su questo dispositivo.';
  });
}

// ---------- Login ----------
function showLogin(message) {
  $('login-error').textContent = message || '';
  show('login');
}

async function handleLogin(event) {
  event.preventDefault();
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const errorEl = $('login-error');
  if (!email || !password) {
    errorEl.textContent = 'Inserisci email e password.';
    return;
  }
  const submit = $('login-submit');
  submit.disabled = true;
  submit.textContent = 'Accesso in corso…';
  errorEl.textContent = '';
  try {
    await Cloud.signIn(email, password);
    $('login-password').value = '';
    renderHome();
    show('home');
    syncNow();
  } catch (error) {
    if (error.status === undefined) errorEl.textContent = 'Nessuna connessione. Riprova quando sei online.';
    else if (error.status === 400) errorEl.textContent = 'Email o password non corrette.';
    else if (error.status === 429) errorEl.textContent = 'Troppi tentativi: riprova tra qualche minuto.';
    else errorEl.textContent = `Accesso non riuscito (${error.status}).`;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Accedi';
  }
}

// ---------- Helpers ----------
const presetById = (id) => PRESETS.find((p) => p.id === id);
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const localDay = (date) => {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const secondsIt = (ms) => (ms / 1000).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function makeProblem(preset) {
  const op = pick(preset.ops);
  if (op === 'add' || op === 'sub') {
    const a = randInt(...preset.add[0]);
    const b = randInt(...preset.add[1]);
    return op === 'add'
      ? { text: `${a} + ${b}`, answer: a + b }
      : { text: `${a + b} − ${a}`, answer: b };
  }
  const a = randInt(...preset.mul[0]);
  const b = randInt(...preset.mul[1]);
  return op === 'mul'
    ? { text: `${a} × ${b}`, answer: a * b }
    : { text: `${a * b} ÷ ${a}`, answer: b };
}

function statsFor(presetId, sessions) {
  const mine = sessions.filter((s) => s.preset === presetId);
  if (!mine.length) return null;
  return {
    best: Math.max(...mine.map((s) => s.score)),
    last: mine[mine.length - 1].score,
    count: mine.length,
  };
}

// ---------- Daily routine ----------
// The diary routine: 1 × T12 warm-up, 2 × T100, 1 × Default. Today's games fill the slots in order.
const ROUTINE = ['t12', 't100', 't100', 'def'];
const ORDINALS = ['', 'prima', 'seconda', 'terza'];

function routineToday(sessions) {
  const today = localDay(Date.now());
  const slots = ROUTINE.map((preset, i) => ({
    preset,
    score: null,
    nth: ROUTINE.slice(0, i + 1).filter((p) => p === preset).length,
    repeats: ROUTINE.filter((p) => p === preset).length > 1,
  }));
  for (const s of sessions) {
    if (localDay(s.date) !== today || s.source === 'diario') continue;
    const slot = slots.find((x) => x.preset === s.preset && x.score === null);
    if (slot) slot.score = s.score;
  }
  const next = slots.find((x) => x.score === null) || null;
  return { slots, next, done: slots.filter((x) => x.score !== null).length };
}

function slotLabel(slot) {
  const name = presetById(slot.preset).name;
  return slot.repeats ? `${name}, ${ORDINALS[slot.nth]} partita` : name;
}

function renderRoutine(sessions) {
  const { slots, next, done } = routineToday(sessions);
  $('routine-count').textContent = `${done} di ${slots.length}`;
  const list = $('routine-steps');
  list.replaceChildren();
  for (const slot of slots) {
    const li = document.createElement('li');
    const state = slot.score !== null ? 'done' : slot === next ? 'current' : 'todo';
    li.className = `step ${state}`;
    li.innerHTML = '<span class="step-name"></span><span class="step-score"></span>';
    li.querySelector('.step-name').textContent = presetById(slot.preset).name;
    li.querySelector('.step-score').textContent = slot.score !== null ? `✓ ${slot.score}` : state === 'current' ? 'adesso' : '';
    li.setAttribute('aria-label', `${slotLabel(slot)}: ${slot.score !== null ? `fatta, ${slot.score} punti` : state === 'current' ? 'la prossima' : 'da fare'}`);
    list.append(li);
  }
  const start = $('routine-start');
  start.hidden = !next;
  $('routine-done').hidden = Boolean(next);
  if (next) {
    start.textContent = `Inizia ${presetById(next.preset).name}${next.repeats ? ` (${ORDINALS[next.nth]})` : ''}`;
    start.dataset.preset = next.preset;
  }
}

// ---------- Streak ----------
// A day counts when at least one game was played (in the app or written in the diary).
const dayNumber = (date) => {
  const d = new Date(date);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
};

function streakStats(sessions) {
  const days = [...new Set(sessions.map((s) => dayNumber(s.date)))].sort((a, b) => a - b);
  const set = new Set(days);
  const today = dayNumber(Date.now());
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  // Today not played yet: the streak is still alive if yesterday was.
  let current = 0;
  let cursor = set.has(today) ? today : today - 1;
  while (set.has(cursor)) { current += 1; cursor -= 1; }
  return { current, best, playedToday: set.has(today) };
}

function renderStreak(sessions) {
  const { current, best, playedToday } = streakStats(sessions);
  const box = $('streak');
  box.classList.toggle('active', current > 0 && playedToday);
  $('streak-count').textContent = current;
  $('streak-unit').textContent = current === 1 ? 'giorno di fila' : 'giorni di fila';
  let status;
  if (current === 0) status = sessions.length ? 'Gioca oggi per ripartire.' : 'Gioca la prima partita per iniziare.';
  else if (playedToday) status = 'Oggi fatto. Torna domani per allungarla.';
  else status = 'Gioca oggi per non perderla.';
  $('streak-status').textContent = status;
  const record = $('streak-record');
  record.hidden = best < 2;
  record.textContent = `Record: ${best} ${best === 1 ? 'giorno' : 'giorni'}`;
  box.setAttribute('aria-label', `Streak: ${current} ${$('streak-unit').textContent}. ${status}${best > 1 ? ` Record: ${best} giorni.` : ''}`);
}

// ---------- Trend chart ----------
const CHART_KEY = 'calcolo.v1.chart';
let chartPreset = (() => { try { return localStorage.getItem(CHART_KEY) || 't100'; } catch { return 't100'; } })();
let chartPoints = [];
let chartFocus = -1;

// Best score per day for one preset; the marker shows where that best came from.
function chartData(sessions, presetId) {
  const byDay = new Map();
  for (const s of sessions) {
    if (s.preset !== presetId) continue;
    const day = dayNumber(s.date);
    const entry = byDay.get(day) || { day, date: s.date, best: -1, source: 'app', games: 0 };
    entry.games += 1;
    if (s.score > entry.best || (s.score === entry.best && s.source !== 'diario')) {
      entry.best = s.score;
      entry.source = s.source === 'diario' ? 'diario' : 'app';
    }
    byDay.set(day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day);
}

const dayLabel = (date) => new Date(date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.append(el);
  return el;
}

function renderChart(sessions) {
  for (const button of document.querySelectorAll('#chart-presets button')) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === chartPreset));
  }
  const preset = presetById(chartPreset);
  const points = chartData(sessions, chartPreset);
  chartPoints = points;
  chartFocus = -1;
  const stats = statsFor(chartPreset, sessions);
  $('chart-title').textContent = `${preset.name}: migliore punteggio del giorno`;
  $('chart-summary').textContent = stats ? `Record ${stats.best} · ${points.length} ${points.length === 1 ? 'giorno' : 'giorni'}` : '';
  $('chart-legend').hidden = !points.some((p) => p.source === 'diario');
  hideTooltip();

  const svg = $('chart');
  svg.replaceChildren();
  $('chart-empty').hidden = points.length > 0;
  document.querySelector('.chart-data').hidden = points.length === 0;
  svg.style.display = points.length ? '' : 'none';
  renderChartTable(points);
  if (!points.length) return;

  const width = Math.max(260, svg.parentElement.clientWidth);
  const height = 180;
  const pad = { top: 16, right: 30, bottom: 26, left: 30 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('height', height);

  const maxScore = Math.max(...points.map((p) => p.best));
  // Top tick a multiple of two steps, so the middle gridline is a round number too,
  // with a little headroom above the highest point.
  const step = maxScore > 60 ? 25 : maxScore > 30 ? 10 : 5;
  let yMax = Math.max(step * 2, Math.ceil(maxScore / (step * 2)) * step * 2);
  if (maxScore > yMax * 0.97) yMax += step * 2;
  const first = points[0].day;
  const last = points[points.length - 1].day;
  const x = (day) => (first === last
    ? pad.left + (width - pad.left - pad.right) / 2
    : pad.left + ((day - first) / (last - first)) * (width - pad.left - pad.right));
  const y = (v) => pad.top + (1 - v / yMax) * (height - pad.top - pad.bottom);

  // Recessive hairline grid: 0, half, top.
  for (const v of [0, yMax / 2, yMax]) {
    svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: 'grid' }, svg);
    svgEl('text', { x: pad.left - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = Math.round(v);
  }
  svgEl('text', { x: x(first), y: height - 6, class: 'tick', 'text-anchor': first === last ? 'middle' : 'start' }, svg).textContent = dayLabel(points[0].date);
  if (first !== last) {
    svgEl('text', { x: x(last), y: height - 6, class: 'tick', 'text-anchor': 'end' }, svg).textContent = dayLabel(points[points.length - 1].date);
  }

  if (points.length > 1) {
    svgEl('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.best).toFixed(1)}`).join(' '), class: 'series-line' }, svg);
  }
  svgEl('line', { x1: 0, x2: 0, y1: pad.top, y2: height - pad.bottom, class: 'crosshair', id: 'chart-crosshair', visibility: 'hidden' }, svg);
  points.forEach((p, i) => {
    p.cx = x(p.day);
    p.cy = y(p.best);
    svgEl('circle', { cx: p.cx, cy: p.cy, r: 4, class: p.source === 'diario' ? 'dot hollow' : 'dot', 'data-index': i }, svg);
  });
  // Direct label on the latest value only.
  const lastPoint = points[points.length - 1];
  svgEl('text', { x: lastPoint.cx + 8, y: lastPoint.cy + 4, class: 'end-label' }, svg).textContent = lastPoint.best;
  svg.setAttribute('aria-label', `Andamento ${preset.name}: ${points.length} giorni, ultimo ${lastPoint.best}, record ${stats.best}. Tocca il grafico o usa le frecce per leggere i valori.`);
}

function renderChartTable(points) {
  const body = $('chart-table-body');
  body.replaceChildren();
  for (const p of [...points].reverse()) {
    const tr = document.createElement('tr');
    for (const text of [dayLabel(p.date), String(p.best), p.source === 'diario' ? 'Zetamac (diario)' : 'App', String(p.games)]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    body.append(tr);
  }
}

function showTooltip(index) {
  const p = chartPoints[index];
  if (!p) return;
  chartFocus = index;
  const svg = $('chart');
  const cross = $('chart-crosshair');
  cross.setAttribute('x1', p.cx);
  cross.setAttribute('x2', p.cx);
  cross.setAttribute('visibility', 'visible');
  for (const dot of svg.querySelectorAll('.dot')) dot.classList.toggle('focus', Number(dot.dataset.index) === index);
  const tip = $('chart-tooltip');
  tip.replaceChildren();
  const value = document.createElement('strong');
  value.textContent = `${p.best} punti`;
  const detail = document.createElement('span');
  detail.textContent = `${dayLabel(p.date)} · ${p.source === 'diario' ? 'Zetamac (diario)' : 'app'} · ${p.games} ${p.games === 1 ? 'partita' : 'partite'}`;
  tip.append(value, detail);
  tip.hidden = false;
  // Position in CSS pixels: the SVG viewBox matches its rendered width.
  const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
  const left = Math.min(Math.max(p.cx * scale - tip.offsetWidth / 2, 0), svg.clientWidth - tip.offsetWidth);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(0, p.cy * scale - tip.offsetHeight - 14)}px`;
}

function hideTooltip() {
  const tip = $('chart-tooltip');
  if (tip) tip.hidden = true;
  const cross = document.getElementById('chart-crosshair');
  if (cross) cross.setAttribute('visibility', 'hidden');
  for (const dot of document.querySelectorAll('#chart .dot.focus')) dot.classList.remove('focus');
}

function nearestPoint(event) {
  const svg = $('chart');
  const rect = svg.getBoundingClientRect();
  const px = ((event.clientX - rect.left) / rect.width) * svg.viewBox.baseVal.width;
  let best = 0;
  chartPoints.forEach((p, i) => { if (Math.abs(p.cx - px) < Math.abs(chartPoints[best].cx - px)) best = i; });
  return best;
}

// ---------- Home ----------
const HISTORY_SHORT = 5;
const HISTORY_LONG = 30;
let historyExpanded = false;

function renderHome() {
  const sessions = loadSessions();
  renderStreak(sessions);
  renderRoutine(sessions);
  renderChart(sessions);
  renderPush();

  const list = $('preset-list');
  list.replaceChildren();
  for (const preset of PRESETS) {
    const stats = statsFor(preset.id, sessions);
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset-row';
    button.setAttribute('aria-label',
      `Gioca ${preset.name}, ${preset.title}, ${preset.desc}. ${stats ? `Record ${stats.best}.` : 'Nessuna partita ancora.'}`);
    button.innerHTML = `
      <span class="preset-name" aria-hidden="true"></span>
      <span class="preset-text" aria-hidden="true">
        <span class="preset-title"></span>
        <span class="preset-desc"></span>
      </span>
      <span class="preset-stats" aria-hidden="true"></span>
      <svg class="chevron" viewBox="0 0 8 14" aria-hidden="true"><path d="M1.5 1.5L6.5 7l-5 5.5"/></svg>`;
    button.querySelector('.preset-name').textContent = preset.name;
    button.querySelector('.preset-title').textContent = preset.title;
    button.querySelector('.preset-desc').textContent = preset.desc;
    const statsEl = button.querySelector('.preset-stats');
    if (stats) {
      statsEl.innerHTML = '<strong></strong><span>record</span>';
      statsEl.querySelector('strong').textContent = stats.best;
    }
    button.addEventListener('click', () => startGame(preset.id));
    li.append(button);
    list.append(li);
  }

  const history = $('history-list');
  history.replaceChildren();
  const limit = historyExpanded ? HISTORY_LONG : HISTORY_SHORT;
  const recent = sessions.slice(-limit).reverse();
  const more = $('history-more');
  more.hidden = sessions.length <= HISTORY_SHORT;
  more.textContent = historyExpanded ? 'Mostra meno' : `Mostra le ultime ${Math.min(sessions.length, HISTORY_LONG)}`;
  more.setAttribute('aria-expanded', String(historyExpanded));
  if (!recent.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Le tue partite compariranno qui.';
    history.append(li);
  }
  for (const s of recent) {
    const preset = presetById(s.preset);
    const li = document.createElement('li');
    const d = new Date(s.date);
    li.innerHTML = '<span class="when"></span><span class="what"><span class="p"></span> <strong></strong></span>';
    li.querySelector('.when').textContent =
      d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) + ' · ' +
      d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    li.querySelector('.p').textContent = `${preset ? preset.name : s.preset}${s.source === 'diario' ? ' · Zetamac' : ''}`;
    li.querySelector('strong').textContent = s.score;
    history.append(li);
  }

  renderAccount();
}

// ---------- Game ----------
const game = {
  preset: null,
  running: false,
  paused: false,
  startAt: 0,       // performance.now() when the clock started, shifted by pauses
  problemAt: 0,     // when the current problem appeared, shifted by pauses
  pausedAt: 0,
  problem: null,
  input: '',
  score: 0,
  log: [],
  raf: 0,
  countdownTimer: 0,
};

let updatePending = false;
function applyPendingUpdate() {
  if (updatePending && (!screens.home.hidden || !screens.login.hidden)) location.reload();
}

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  window.scrollTo(0, 0);
  applyPendingUpdate();
}

function startGame(presetId) {
  const preset = presetById(presetId);
  Object.assign(game, { preset, running: false, paused: false, input: '', score: 0, log: [], problem: null });
  $('game-preset').textContent = preset.name;
  $('score').textContent = '0';
  $('timer').textContent = '2:00';
  $('timebar').style.transform = 'scaleX(1)';
  $('problem').textContent = '';
  renderAnswer();
  $('pause').hidden = true;
  show('game');
  runCountdown(3);
}

function runCountdown(n) {
  const el = $('countdown');
  const problem = $('problem');
  const answer = $('answer');
  problem.hidden = true;
  answer.hidden = true;
  el.hidden = false;
  el.textContent = n;
  clearTimeout(game.countdownTimer);
  game.countdownTimer = setTimeout(function tick() {
    n -= 1;
    if (n > 0) {
      el.textContent = n;
      game.countdownTimer = setTimeout(tick, 700);
    } else {
      el.hidden = true;
      problem.hidden = false;
      answer.hidden = false;
      beginClock();
    }
  }, 700);
}

function beginClock() {
  game.running = true;
  game.startAt = performance.now();
  nextProblem();
  game.raf = requestAnimationFrame(tickClock);
}

function nextProblem() {
  let p;
  do { p = makeProblem(game.preset); } while (game.problem && p.text === game.problem.text);
  game.problem = p;
  game.problemAt = performance.now();
  game.input = '';
  $('problem').textContent = p.text;
  renderAnswer();
}

function tickClock() {
  if (!game.running || game.paused) return;
  const left = Math.max(0, DURATION_MS - (performance.now() - game.startAt));
  const secs = Math.ceil(left / 1000);
  $('timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  $('timebar').style.transform = `scaleX(${left / DURATION_MS})`;
  if (left <= 0) {
    endGame();
    return;
  }
  game.raf = requestAnimationFrame(tickClock);
}

function renderAnswer() {
  const el = $('answer');
  if (game.input) {
    el.textContent = game.input;
  } else {
    el.innerHTML = '<span class="answer-placeholder" aria-hidden="true">?</span>';
  }
}

function press(key) {
  if (!game.running || game.paused) return;
  if (key === 'clear') {
    game.input = '';
  } else if (key === 'back') {
    game.input = game.input.slice(0, -1);
  } else if (/^\d$/.test(key)) {
    if (game.input.length >= MAX_DIGITS) return;
    if (game.input === '' && key === '0') return;
    game.input += key;
  }
  renderAnswer();
  if (game.input && Number(game.input) === game.problem.answer) correct();
}

function correct() {
  const now = performance.now();
  game.log.push({ text: `${game.problem.text} = ${game.problem.answer}`, ms: Math.round(now - game.problemAt) });
  game.score += 1;
  $('score').textContent = game.score;
  const stage = document.querySelector('.stage');
  stage.classList.add('flash');
  requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.remove('flash')));
  nextProblem();
}

function pauseGame(reason) {
  if (!game.running || game.paused) return;
  game.paused = true;
  game.pausedAt = performance.now();
  cancelAnimationFrame(game.raf);
  $('pause-text').textContent = reason === 'left'
    ? "Il tempo si è fermato quando sei uscito dall'app."
    : 'Il tempo è fermo finché non riprendi.';
  $('pause').hidden = false;
  $('resume').focus();
}

function resumeGame() {
  if (!game.paused) return;
  const gap = performance.now() - game.pausedAt;
  game.startAt += gap;
  game.problemAt += gap;
  game.paused = false;
  $('pause').hidden = true;
  game.raf = requestAnimationFrame(tickClock);
}

function quitGame() {
  clearTimeout(game.countdownTimer);
  cancelAnimationFrame(game.raf);
  game.running = false;
  game.paused = false;
  renderHome();
  show('home');
}

function endGame() {
  game.running = false;
  cancelAnimationFrame(game.raf);
  const before = loadSessions();
  const prev = statsFor(game.preset.id, before);
  const slow = [...game.log].sort((a, b) => b.ms - a.ms).slice(0, 5);
  const session = { id: newId(), preset: game.preset.id, score: game.score, date: new Date().toISOString(), slow, synced: false };
  const saved = saveSession(session);
  renderResults(session, prev, saved);
  show('results');
  syncNow();
}

// ---------- Results ----------
function renderResults(session, prev, saved) {
  const preset = presetById(session.preset);
  $('results-preset').textContent = `${preset.name} · ${preset.title}`;
  $('results-score').textContent = session.score;
  $('results-rate').textContent = session.score
    ? `${secondsIt(DURATION_MS / session.score)} s a domanda in media`
    : 'Nessuna risposta in 120 secondi.';

  const record = $('results-record');
  record.classList.remove('new');
  if (!saved) {
    record.textContent = 'Partita non salvata: la memoria del browser non è disponibile.';
  } else if (!prev) {
    record.textContent = 'Prima partita con questo allenamento.';
  } else if (session.score > prev.best) {
    record.textContent = `Nuovo record (prima era ${prev.best})`;
    record.classList.add('new');
  } else {
    const diff = session.score - prev.last;
    const sign = diff > 0 ? `+${diff}` : `${diff}`;
    record.textContent = `Record ${prev.best} · ultima volta ${prev.last} (${diff === 0 ? 'uguale' : sign})`;
  }

  const list = $('slow-list');
  list.replaceChildren();
  if (!session.slow.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nessuna domanda completata.';
    list.append(li);
  }
  for (const item of session.slow) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="q"></span><span class="t"></span>';
    li.querySelector('.q').textContent = item.text;
    li.querySelector('.t').textContent = `${secondsIt(item.ms)} s`;
    list.append(li);
  }

  // One prominent action: the next routine step if there is one, otherwise play again.
  const { slots, next, done } = routineToday(loadSessions());
  const nextButton = $('next-step');
  const again = $('again');
  $('results-routine').textContent = next
    ? `Scaletta di oggi: ${done} di ${slots.length}. Prossima: ${slotLabel(next)}.`
    : `Scaletta di oggi completata (${slots.length} di ${slots.length}).`;
  if (next) {
    nextButton.hidden = false;
    nextButton.textContent = `Continua: ${presetById(next.preset).name}${next.repeats ? ` (${ORDINALS[next.nth]})` : ''}`;
    nextButton.dataset.preset = next.preset;
    again.hidden = next.preset === session.preset;
    again.classList.remove('primary');
  } else {
    nextButton.hidden = true;
    again.hidden = false;
    again.classList.add('primary');
  }
  again.textContent = `Rigioca ${preset.name}`;
  (next ? nextButton : again).focus();
}

// ---------- Events ----------
$('keypad').addEventListener('pointerdown', (event) => {
  const key = event.target.closest('.key');
  if (!key) return;
  event.preventDefault();
  key.classList.add('down');
  setTimeout(() => key.classList.remove('down'), 90);
  press(key.dataset.key);
});
// Keyboard and assistive tech activate buttons with click (detail 0), not pointerdown.
$('keypad').addEventListener('click', (event) => {
  const key = event.target.closest('.key');
  if (key && event.detail === 0) press(key.dataset.key);
});

document.addEventListener('keydown', (event) => {
  if (screens.game.hidden) return;
  if (event.key === 'Escape') {
    if (game.paused) resumeGame(); else pauseGame();
    return;
  }
  if (game.paused) return;
  if (/^\d$/.test(event.key)) press(event.key);
  else if (event.key === 'Backspace') press('back');
  else if (event.key === 'Delete') press('clear');
  else return;
  event.preventDefault();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseGame('left');
  else if (!game.running) syncNow();
});
window.addEventListener('online', () => { if (!game.running) syncNow(); });

$('login-form').addEventListener('submit', handleLogin);
$('sync-now').addEventListener('click', syncNow);
$('sign-out').addEventListener('click', async () => {
  await Cloud.signOut();
  sync.error = '';
  showLogin('');
});

$('quit').addEventListener('click', () => {
  if (game.running) pauseGame(); else quitGame();
});
$('resume').addEventListener('click', resumeGame);
$('pause-quit').addEventListener('click', quitGame);
$('again').addEventListener('click', () => startGame(game.preset.id));
$('next-step').addEventListener('click', (event) => startGame(event.currentTarget.dataset.preset));
$('routine-start').addEventListener('click', (event) => startGame(event.currentTarget.dataset.preset));
$('push-enable').addEventListener('click', enablePush);
$('push-test').addEventListener('click', testPush);
$('push-disable').addEventListener('click', disablePush);
$('chart-presets').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-preset]');
  if (!button) return;
  chartPreset = button.dataset.preset;
  try { localStorage.setItem(CHART_KEY, chartPreset); } catch { /* remembered for this session only */ }
  renderChart(loadSessions());
});
$('chart').addEventListener('pointerdown', (event) => { if (chartPoints.length) showTooltip(nearestPoint(event)); });
$('chart').addEventListener('pointermove', (event) => { if (chartPoints.length) showTooltip(nearestPoint(event)); });
$('chart').addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse') hideTooltip(); });
$('chart').addEventListener('blur', hideTooltip);
$('chart').addEventListener('keydown', (event) => {
  if (!chartPoints.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const lastIndex = chartPoints.length - 1;
  const from = chartFocus < 0 ? lastIndex + (event.key === 'ArrowLeft' ? 1 : 0) : chartFocus;
  const next = { ArrowLeft: from - 1, ArrowRight: from + 1, Home: 0, End: lastIndex }[event.key];
  showTooltip(Math.min(Math.max(next, 0), lastIndex));
});
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!screens.home.hidden) renderChart(loadSessions()); }, 150);
});
$('history-more').addEventListener('click', () => {
  historyExpanded = !historyExpanded;
  renderHome();
});
$('to-home').addEventListener('click', () => { renderHome(); show('home'); });

// ---------- Start ----------
migrateSessions();
if (Cloud.signedIn) {
  renderHome();
  show('home');
  syncNow();
} else {
  showLogin('');
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  // A new release takes control in the background: reload once to show it,
  // only from the home or sign-in screen so a game or its results are never cut off.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install: the page is already current
    updatePending = true;
    applyPendingUpdate();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
