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
      if (!known.has(r.id)) all.push({ id: r.id, preset: r.preset, score: r.score, date: r.played_at, slow: r.slow || [], synced: true });
    }
    all.sort((a, b) => new Date(a.date) - new Date(b.date));
    storeSessions(all);
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
    if (localDay(s.date) !== today) continue;
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
  $('copy-today').hidden = !todaySummary(sessions);
  $('copy-today-status').textContent = '';
}

// ---------- Home ----------
const HISTORY_SHORT = 5;
const HISTORY_LONG = 30;
let historyExpanded = false;

function renderHome() {
  const sessions = loadSessions();
  renderRoutine(sessions);

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
    li.querySelector('.p').textContent = preset ? preset.name : s.preset;
    li.querySelector('strong').textContent = s.score;
    history.append(li);
  }

  renderAccount();
}

// One line per day for the diary: best score per preset, in preset order.
function todaySummary(sessions) {
  const today = localDay(Date.now());
  const parts = [];
  for (const preset of PRESETS) {
    const scores = sessions.filter((s) => s.preset === preset.id && localDay(s.date) === today).map((s) => s.score);
    if (scores.length) parts.push(`${preset.name}: ${Math.max(...scores)}${scores.length > 1 ? ` (${scores.length} partite)` : ''}`);
  }
  return parts.length ? `${today} · ${parts.join(' · ')}` : '';
}

async function copyText(text, statusEl) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
  }
  statusEl.textContent = ok ? 'Copiato. Incollalo nella chat o nel diario.' : `Copia non riuscita. Testo: ${text}`;
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

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  window.scrollTo(0, 0);
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
  $('copy-result-status').textContent = '';

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
$('history-more').addEventListener('click', () => {
  historyExpanded = !historyExpanded;
  renderHome();
});
$('to-home').addEventListener('click', () => { renderHome(); show('home'); });
$('copy-result').addEventListener('click', () => {
  const s = loadSessions().at(-1);
  if (!s) return;
  copyText(`${localDay(s.date)} · ${presetById(s.preset).name}: ${s.score}`, $('copy-result-status'));
});
$('copy-today').addEventListener('click', () => {
  copyText(todaySummary(loadSessions()), $('copy-today-status'));
});

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
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
