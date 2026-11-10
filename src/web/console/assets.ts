// Static assets of the web console. No CDN, no inline script (CSP script-src 'self'),
// and every value from the fleet goes into the DOM through textContent only — letters
// and journals are text written by agents, never markup.

export const CONSOLE_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="console-token" content="__CONSOLE_TOKEN__">
<title>Консоль флота Xentra</title>
<link rel="stylesheet" href="/console/app.css">
</head>
<body>
<header>
  <div class="brand">Xentra Fleet</div>
  <nav id="tabs">
    <button data-tab="overview" class="active">Обзор</button>
    <button data-tab="tasks">Задачи</button>
    <button data-tab="sessions">Сессии</button>
    <button data-tab="analytics">Аналитика</button>
  </nav>
  <div id="conn" class="pill muted">подключение…</div>
</header>
<main>
  <section id="tab-overview" class="tab active">
    <div id="statusbar" class="statusbar"></div>
    <div class="card"><h2>Ждёт тебя</h2><div id="decisions"></div></div>
    <div class="card"><h2>Роли</h2><div id="roles"></div></div>
    <div class="card"><h2>Лимиты на сегодня</h2><div id="limits"></div></div>
  </section>
  <section id="tab-tasks" class="tab">
    <div class="split">
      <div class="card"><h2>Задачи команды (14 дней)</h2><div id="tasks"></div></div>
      <div class="card" id="thread-card"><h2 id="thread-title">Выбери задачу слева</h2><div id="thread"></div></div>
    </div>
  </section>
  <section id="tab-sessions" class="tab">
    <div class="split">
      <div class="card"><h2>Сессии агентов</h2><div id="sessions"></div></div>
      <div class="card"><h2 id="session-title">Выбери сессию слева</h2><div id="session-open"></div><pre id="session" class="stream"></pre></div>
    </div>
  </section>
  <section id="tab-analytics" class="tab">
    <div class="toolbar">Период:
      <select id="days"><option value="7">7 дней</option><option value="14" selected>14 дней</option><option value="30">30 дней</option></select>
    </div>
    <div id="analytics"></div>
  </section>
</main>
<script type="module" src="/console/app.js"></script>
</body>
</html>`;

export const CONSOLE_CSS = `
:root { --bg:#0f1218; --card:#171b23; --line:#262c38; --text:#e6e9ef; --muted:#8a93a6; --accent:#7aa2ff;
  --ok:#3fb27f; --warn:#e0a84b; --bad:#e5636b; --row:#1c212b; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
header { display:flex; align-items:center; gap:20px; padding:12px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; }
.brand { font-weight:700; color:var(--accent); }
nav button { background:none; border:0; color:var(--muted); font:inherit; padding:6px 10px; border-radius:6px; cursor:pointer; }
nav button.active { color:var(--text); background:var(--row); }
main { padding:16px 20px; max-width:1500px; margin:0 auto; }
.tab { display:none; } .tab.active { display:block; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:16px; min-width:0; }
.card h2 { margin:0 0 10px; font-size:15px; color:var(--accent); font-weight:600; }
.split { display:grid; grid-template-columns: minmax(320px, 2fr) 3fr; gap:16px; align-items:start; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
table { width:100%; border-collapse:collapse; }
th { text-align:left; color:var(--muted); font-weight:500; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
tr.clickable { cursor:pointer; } tr.clickable:hover td, tr.sel td { background:var(--row); }
.pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px; background:var(--row); color:var(--muted); white-space:nowrap; }
.pill.ok { color:var(--ok); } .pill.warn { color:var(--warn); } .pill.bad { color:var(--bad); }
.muted { color:var(--muted); }
.statusbar { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:14px; }
.item { border-top:1px solid var(--line); padding:10px 0; } .item:first-child { border-top:0; padding-top:0; }
.item .head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
.body { white-space:pre-wrap; word-break:break-word; margin:6px 0; color:#cfd5e1; max-height:320px; overflow:auto; }
button.act { background:var(--row); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:5px 11px; font:inherit; cursor:pointer; margin:4px 6px 0 0; }
button.act:hover { border-color:var(--accent); } button.act.primary { border-color:var(--accent); color:var(--accent); }
textarea { width:100%; min-height:60px; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; margin-top:6px; }
select { background:var(--row); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:4px 8px; font:inherit; }
.bar { height:8px; background:var(--row); border-radius:4px; overflow:hidden; min-width:120px; }
.bar > i { display:block; height:100%; background:var(--accent); }
.bar.warn > i { background:var(--warn); } .bar.bad > i { background:var(--bad); }
.dist { display:grid; grid-template-columns: 90px 1fr 40px; gap:6px 10px; align-items:center; margin-top:8px; }
.stream { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; max-height:70vh; overflow:auto; white-space:pre-wrap; word-break:break-word; font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; margin:8px 0 0; }
code { font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); padding:2px 6px; border-radius:4px; word-break:break-all; }
.toolbar { margin-bottom:12px; color:var(--muted); }
.grid3 { display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:16px; }
.big { font-size:22px; font-weight:600; }
.err { color:var(--bad); }
`;

export const CONSOLE_JS = `
const TOKEN = document.querySelector('meta[name="console-token"]').content;
const S = { snap: {}, tab: 'overview', thread: null, session: null, sessionNext: 0 };

// ── tiny DOM helper: text only, never HTML ──
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const put = (id, ...kids) => { const el = $(id); el.replaceChildren(...kids.flat().filter(Boolean)); };
const pill = (text, kind) => h('span', { class: 'pill ' + (kind || '') }, text);
function ago(iso) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return 'только что';
  if (m < 60) return m + ' мин';
  const hh = Math.floor(m / 60);
  return hh < 48 ? hh + ' ч ' + (m % 60) + ' мин' : Math.floor(hh / 24) + ' дн';
}
function clock(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
const when = (iso) => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const money = (x) => '$' + (x || 0).toFixed(2);
function bar(value, cap) {
  const pct = cap > 0 ? Math.min(100, Math.round((value / cap) * 100)) : 0;
  const el = h('div', { class: 'bar' + (pct >= 90 ? ' bad' : pct >= 70 ? ' warn' : '') }, h('i'));
  el.firstChild.style.width = pct + '%';
  return el;
}

async function post(path, body) {
  const res = await fetch('/api/console/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-token': TOKEN }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || ('Ошибка ' + res.status)); return false; }
  return true;
}
async function getJson(path) {
  const res = await fetch('/api/console/' + path);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ── tabs ──
for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => {
    S.tab = b.dataset.tab;
    for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('active', x === b);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === 'tab-' + S.tab);
    if (S.tab === 'sessions') loadSessions();
    if (S.tab === 'analytics') loadAnalytics();
  });
}

// ── overview ──
function renderStatus() {
  const lim = S.snap.limits, bot = S.snap.bot;
  if (!lim || !bot) return;
  const team = !lim.teamAlive ? pill('👥 команда не запущена', 'warn') : lim.paused ? pill('👥 команда на паузе', 'warn') : pill('👥 команда работает', 'ok');
  const botPill = bot.job ? pill('🤖 бот: ' + bot.job.issueKey + ' · ' + bot.job.phase + ' · итерация ' + bot.job.iteration + '/' + bot.job.maxIterations, 'ok') : pill(bot.running ? '🤖 бот: ищет тикеты' : '🤖 бот: свободен');
  const n = S.snap.decisions ? S.snap.decisions.letters.length + S.snap.decisions.pushes.length + S.snap.decisions.mergeReady.length + S.snap.decisions.holds.length + S.snap.decisions.conveyor.length : 0;
  put('statusbar', team, botPill, n ? pill('🙋 ждёт тебя: ' + n, 'warn') : pill('🙋 ничего не ждёт'), lim.override ? pill('⚡️ лимиты сняты на сегодня', 'warn') : null);
}

function renderDecisions() {
  const d = S.snap.decisions;
  if (!d) return;
  const items = [];
  for (const c of d.conveyor) {
    const what = { approval: 'план ждёт подтверждения', humanReview: 'нужен человек: посмотреть дифф', brief: 'вопрос разработчика' }[c.kind];
    items.push(h('div', { class: 'item' }, h('div', { class: 'head' }, pill('🤖 бот'), h('b', {}, c.issueKey + ' · ' + c.title)), h('div', { class: 'muted' }, what + ' — ответ кнопками в Telegram')));
  }
  for (const p of d.pushes) {
    items.push(h('div', { class: 'item' },
      h('div', { class: 'head' }, pill('🚀 push', 'warn'), h('b', {}, p.title)),
      h('div', { class: 'muted' }, p.requestedBy + ' просит запушить ' + p.branch + (p.hasMr ? ' (обновит MR)' : ' и открыть MR') + ' · ' + ago(p.requestedAt) + ' назад'),
      h('button', { class: 'act primary', onclick: async () => { if (confirm('Запушить ветку и открыть MR?')) await post('push', { thread: p.thread, decision: 'approve' }); } }, '🚀 Push и MR'),
      h('button', { class: 'act', onclick: () => post('push', { thread: p.thread, decision: 'decline' }) }, '✋ Не сейчас')));
  }
  for (const m of d.mergeReady) {
    items.push(h('div', { class: 'item' },
      h('div', { class: 'head' }, pill('🔀 готово к мержу', 'ok'), h('b', {}, m.title)),
      h('div', { class: 'muted' }, 'MR !' + m.mr.iid + ': CI зелёный, аудиторы без блокирующих'),
      h('button', { class: 'act primary', onclick: async () => { if (confirm('Смержить MR !' + m.mr.iid + '?')) await post('merge', { thread: m.thread }); } }, '🔀 Смержить')));
  }
  for (const x of d.holds) {
    items.push(h('div', { class: 'item' }, h('div', { class: 'head' }, pill('⛔ остановлено (зацикливание)', 'bad'), h('b', {}, x.title)),
      h('button', { class: 'act', onclick: () => post('release', { thread: x.thread }) }, '▶️ Снять остановку')));
  }
  for (const l of d.letters) {
    const ta = h('textarea', { placeholder: 'Ответ — уйдёт в эту задачу' });
    items.push(h('div', { class: 'item' },
      h('div', { class: 'head' }, pill('✉️ ' + l.fromName, l.priority === 'high' || l.priority === 'urgent' ? 'warn' : ''), h('b', {}, l.title), h('span', { class: 'muted' }, '«' + l.subject + '» · ' + ago(l.date) + ' назад')),
      h('div', { class: 'body' }, l.body), ta,
      h('button', { class: 'act primary', onclick: async () => { if (ta.value.trim() && await post('reply', { letterId: l.id, text: ta.value })) ta.value = ''; } }, 'Ответить'),
      h('button', { class: 'act', onclick: () => post('read', { letterId: l.id }) }, 'Прочитано')));
  }
  put('decisions', items.length ? items : h('div', { class: 'muted' }, 'Ничего не ждёт твоего решения.'));
}

function renderRoles() {
  const roles = S.snap.roles;
  if (!roles) return;
  const rows = roles.map((r) => h('tr', {},
    h('td', {}, h('b', {}, r.name), h('div', { class: 'muted' }, r.role)),
    h('td', {}, r.engine + ' / ' + r.model), h('td', {}, r.access),
    h('td', {}, pill(r.state, r.state === 'работает' ? 'ok' : r.state === 'пауза' ? 'warn' : '')),
    h('td', {}, String(r.inbox)),
    h('td', {}, r.current ? h('span', { class: 'link' }, r.current.title) : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'clock', 'data-since': r.current ? r.current.startedAt : '' }, r.current ? clock(r.current.startedAt) : ''),
    h('td', {}, String(r.sessionsToday)), h('td', {}, money(r.costToday))));
  put('roles', h('table', {}, h('thead', {}, h('tr', {}, ['Роль', 'Модель', 'Права', 'Состояние', 'Входящие', 'Текущая задача', 'В работе', 'Сессий сегодня', '$ сегодня'].map((t) => h('th', {}, t)))), h('tbody', {}, rows)));
}

function renderLimits() {
  const l = S.snap.limits;
  if (!l) return;
  const row = (name, value, cap, text) => h('tr', {}, h('td', {}, name), h('td', {}, bar(value, cap)), h('td', {}, text));
  const ctl = l.paused
    ? h('button', { class: 'act primary', onclick: () => post('resume', {}) }, '▶️ Возобновить команду')
    : h('button', { class: 'act', onclick: () => post('pause', {}) }, '⏸ Пауза команды');
  put('limits',
    h('table', {}, h('tbody', {},
      row('Claude — сессии', l.claude.sessions, l.claude.capSessions, l.claude.sessions + ' / ' + l.claude.capSessions),
      row('Claude — $ (оценка)', l.claude.costUsd, l.claude.capUsd, money(l.claude.costUsd) + ' / ' + money(l.claude.capUsd)),
      row('Codex — сессии', l.codex.sessions, l.codex.capSessions, l.codex.sessions + ' / ' + l.codex.capSessions),
      row('Бот — $ за день', l.bot.todayUsd, l.bot.dailyBudgetUsd, money(l.bot.todayUsd) + ' / ' + money(l.bot.dailyBudgetUsd)))),
    l.pausedRoles.length ? h('div', { class: 'muted' }, 'На паузе роли: ' + l.pausedRoles.join(', ')) : null,
    ctl,
    l.override ? null : h('button', { class: 'act', onclick: async () => { if (confirm('Снять дневные лимиты до конца дня?')) await post('override', {}); } }, '⚡️ Снять лимиты до конца дня'),
    h('div', { class: 'muted' }, 'Пауза и лимиты не прерывают идущие сессии — только не дают начать новые.'));
}

// ── tasks ──
function renderTasks() {
  const tasks = S.snap.tasks;
  if (!tasks) return;
  if (!tasks.length) return put('tasks', h('div', { class: 'muted' }, 'Пока нет задач у команды. Отдай задачу кнопкой «👥 Команда» в Telegram.'));
  const rows = tasks.map((t) => {
    const badges = [];
    if (t.working.length) badges.push(pill('▶️ ' + t.working.join(', '), 'ok'));
    if (t.waitingOwner) badges.push(pill('🙋 ждёт тебя', 'warn'));
    if (t.push && t.push.mr) badges.push(pill('MR !' + t.push.mr.iid));
    else if (t.push) badges.push(pill('push: ' + t.push.status));
    if (t.held) badges.push(pill('⛔ остановлен', 'bad'));
    return h('tr', { class: 'clickable' + (S.thread === t.thread ? ' sel' : ''), onclick: () => openThread(t.thread) },
      h('td', {}, h('b', {}, t.title), h('div', {}, badges), h('div', { class: 'muted' }, t.last.from + ' → ' + t.last.to + ': «' + t.last.subject + '»')),
      h('td', { class: 'muted' }, ago(t.lastAt)));
  });
  put('tasks', h('table', {}, h('tbody', {}, rows)));
}

async function openThread(thread) {
  S.thread = thread;
  renderTasks();
  const d = await getJson('thread?t=' + encodeURIComponent(thread));
  $('thread-title').textContent = d.title;
  const parts = [];
  if (d.push) parts.push(h('div', { class: 'muted' }, 'Ветка ' + d.push.branch + ' · push: ' + d.push.status + (d.push.mr ? ' · MR ' : '')), d.push && d.push.mr ? h('a', { href: d.push.mr.webUrl, target: '_blank', rel: 'noopener' }, '!' + d.push.mr.iid) : null);
  if (d.verdicts.length) parts.push(h('div', {}, d.verdicts.map((v) => pill(v.role + ': ' + (v.blocking ? 'есть блокирующие' : 'чисто') + ' @' + v.sha.slice(0, 8), v.blocking ? 'bad' : 'ok'))));
  if (d.memory) parts.push(h('details', {}, h('summary', {}, 'Память треда'), h('div', { class: 'body' }, d.memory)));
  for (const m of d.taskMemory) if (m.text) parts.push(h('details', {}, h('summary', {}, 'Память задачи ' + m.key), h('div', { class: 'body' }, m.text)));
  for (const l of d.letters) {
    parts.push(h('div', { class: 'item' },
      h('div', { class: 'head' }, h('b', {}, l.from + ' → ' + l.to), h('span', { class: 'muted' }, when(l.date))),
      h('div', {}, '«' + l.subject + '»'), h('div', { class: 'body' }, l.body)));
  }
  put('thread', parts);
}

// ── sessions ──
async function loadSessions() {
  const list = await getJson('sessions').catch(() => []);
  if (!list.length) return put('sessions', h('div', { class: 'muted' }, 'Сессий пока нет — агенты ещё не работали.'));
  put('sessions', h('table', {}, h('tbody', {}, list.map((s) => h('tr', { class: 'clickable' + (S.session && S.session.id === s.id ? ' sel' : ''), onclick: () => openSession(s) },
    h('td', {}, h('b', {}, s.role), h('div', { class: 'muted' }, s.title)), h('td', { class: 'muted' }, when(s.at)))))));
}

async function openSession(s) {
  S.session = s;
  S.sessionNext = 0;
  $('session-title').textContent = s.role + ' · ' + s.title;
  $('session').textContent = '';
  put('session-open', s.open ? [h('div', { class: 'muted' }, 'Открыть в терминале (копия, агенту не мешает):'), h('code', {}, s.open),
    h('button', { class: 'act', onclick: () => navigator.clipboard && navigator.clipboard.writeText(s.open) }, 'Скопировать')] : []);
  loadSessions();
  await tailSession();
}

async function tailSession() {
  const s = S.session;
  if (!s) return;
  const r = await getJson('session?id=' + encodeURIComponent(s.id) + '&from=' + S.sessionNext).catch(() => null);
  if (!r || S.session !== s) return;
  S.sessionNext = r.next;
  if (r.lines.length) {
    const el = $('session');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.append(document.createTextNode(r.lines.join('\\n') + '\\n'));
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
}
setInterval(() => { if (S.tab === 'sessions') tailSession(); }, 2000);

// ── analytics ──
function fmtMin(x) { if (x == null) return '—'; return x < 120 ? Math.round(x) + ' мин' : (x / 60).toFixed(1) + ' ч'; }
function distCard(title, d, extra) {
  const max = Math.max(1, ...d.buckets.map((b) => b.n));
  return h('div', { class: 'card' }, h('h2', {}, title),
    d.count ? h('div', {}, 'Медиана ', h('b', {}, fmtMin(d.median)), ', среднее ' + fmtMin(d.mean) + ', p90 ' + fmtMin(d.p90) + ', макс ' + fmtMin(d.max) + ' · случаев ' + d.count) : h('div', { class: 'muted' }, 'Пока нет данных.'),
    extra || null,
    h('div', { class: 'dist' }, d.buckets.map((b) => [h('div', { class: 'muted' }, b.label), bar(b.n, max), h('div', {}, String(b.n))])));
}
async function loadAnalytics() {
  const days = $('days').value;
  const a = await getJson('analytics?days=' + days).catch((e) => ({ error: e.message }));
  if (a.error) return put('analytics', h('div', { class: 'err' }, a.error));
  const roleRows = a.byRoleModel.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, r.model), h('td', {}, String(r.sessions)), h('td', {}, Math.round(r.okRate * 100) + '%'), h('td', {}, money(r.costUsd)), h('td', {}, money(r.avgCostUsd)), h('td', {}, r.avgDurationMin.toFixed(1) + ' мин')));
  put('analytics',
    h('div', { class: 'grid3' },
      h('div', { class: 'card' }, h('h2', {}, 'Итого за ' + a.days + ' дн.'), h('div', { class: 'big' }, a.sessions + ' сессий · ' + money(a.costUsd)), h('div', { class: 'muted' }, 'Возвратов на задачу (аудит + красный CI): ' + a.returnsPerThread.toFixed(1)), h('div', { class: 'muted' }, 'Тебе писем: ' + a.owner.lettersReceived + ', от тебя: ' + a.owner.lettersWritten + ', решений по push: ' + a.owner.pushDecisions)),
      distCard('Время решения человека: вопрос роли → твой ответ', a.ownerReply, a.ownerReply.unanswered ? h('div', { class: 'muted' }, 'Без ответа: ' + a.ownerReply.unanswered) : null),
      distCard('Время решения человека: запрос push → решение', a.pushDecision),
      distCard('От постановки задачи до MR', a.timeToMr)),
    h('div', { class: 'card' }, h('h2', {}, 'Роли и модели: сравнение'),
      roleRows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Роль', 'Модель', 'Сессий', 'Успех', '$ всего', '$ средн.', 'Длительность'].map((t) => h('th', {}, t)))), h('tbody', {}, roleRows)) : h('div', { class: 'muted' }, 'Пока нет сессий.')));
}
$('days').addEventListener('change', loadAnalytics);

// ── live stream ──
function renderAll() { renderStatus(); renderDecisions(); renderRoles(); renderLimits(); renderTasks(); }
function connect() {
  const es = new EventSource('/api/console/events');
  es.addEventListener('snapshot', (e) => { S.snap = JSON.parse(e.data); renderAll(); });
  es.addEventListener('delta', (e) => { const d = JSON.parse(e.data); S.snap[d.channel] = d.data; renderAll(); });
  es.onopen = () => { const c = $('conn'); c.textContent = 'на связи'; c.className = 'pill ok'; };
  es.onerror = () => { const c = $('conn'); c.textContent = 'переподключение…'; c.className = 'pill warn'; };
}
connect();
setInterval(() => { for (const td of document.querySelectorAll('td.clock')) if (td.dataset.since) td.textContent = clock(td.dataset.since); }, 1000);
`;
