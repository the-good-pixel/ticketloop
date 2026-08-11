// ticketloop dashboard — dependency-free vanilla JS.

const POLL_MS = 4000;
const FAST_POLL_MS = 1500;
// Keep in sync with STAGE_ORDER in src/types.ts (used as the pill order + a
// fallback when the server's stageOrder isn't loaded).
const STAGE_ORDER = ['triage', 'clarify', 'export', 'locate', 'reproduce', 'plan', 'prepare', 'fix', 'verify', 'review', 'ship', 'deploy-dev', 'verify-dev', 'comment'];

// ---- tiny DOM helpers ----
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ---- formatting ----
function fmtTokens(n) {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  return String(n);
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '$0.0000';
  return '$' + Number(n).toFixed(4);
}

function fmtClock(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString();
}

function fmtRelative(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const future = diff < 0;
  let s = Math.round(Math.abs(diff) / 1000);
  let out;
  if (s < 45) out = s + 's';
  else if (s < 3600) out = Math.round(s / 60) + 'm';
  else if (s < 86400) out = Math.round(s / 3600) + 'h';
  else out = Math.round(s / 86400) + 'd';
  return future ? 'in ' + out : out + ' ago';
}

function fmtResetsLine(ms) {
  if (!ms) return 'resets ~ unknown';
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return 'resets ~' + time + ' (' + fmtRelative(ms) + ')';
}

function fmtDuration(startMs, endMs) {
  if (!startMs) return '';
  const end = endMs || Date.now();
  let s = Math.max(0, Math.round((end - startMs) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return m + 'm ' + rs + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function fillClass(pct) {
  if (pct > 90) return 'fill-red';
  if (pct >= 70) return 'fill-amber';
  return 'fill-green';
}

// ---- API ----
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return res.json();
}

// Mutation helper: parses the JSON body even on non-2xx so server
// {error:"..."} messages surface instead of a generic status error.
async function mutate(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new Error('network error');
  }
  let body = null;
  try {
    body = await res.json();
  } catch (_e) { /* no/invalid body */ }
  if (body && body.error) throw new Error(body.error);
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return body || {};
}

// ---- state ----
const state = {
  expanded: new Set(), // run ids currently expanded
  detailCache: new Map(), // id -> RunRecord (full)
  runsById: new Map(),
};

let connOk = true;
function setConn(ok) {
  connOk = ok;
  $('#connState').hidden = ok;
}

// ---- rendering: header/status ----
function renderStatus(s) {
  $('#statusDot').classList.toggle('running', !!s.running);
  $('#statusDot').classList.toggle('paused', !!s.paused);
  $('#statusDot').title = s.paused ? 'loop paused' : s.running ? 'loop running' : 'loop idle';
  const pauseBtn = $('#pauseBtn');
  if (pauseBtn) {
    pauseBtn.textContent = s.paused ? '▶ Resume' : '⏸ Pause';
    pauseBtn.classList.toggle('is-paused', !!s.paused);
    pauseBtn.dataset.paused = s.paused ? '1' : '';
  }
  const plan = s.plan || '—';
  const mode = s.authMode === 'api' ? 'API' : 'subscription';
  $('#planBadge').textContent = plan + ' · ' + mode;

  const warnBox = $('#warnings');
  const warnings = Array.isArray(s.warnings) ? s.warnings.filter(Boolean) : [];
  if (warnings.length) {
    warnBox.hidden = false;
    warnBox.replaceChildren();
    warnBox.appendChild(el('h3', null, 'Attention'));
    const ul = el('ul');
    warnings.forEach((w) => ul.appendChild(el('li', null, w)));
    warnBox.appendChild(ul);
  } else {
    warnBox.hidden = true;
  }
}

// ---- rendering: quota meter card ----
function renderMeterCard(node, title, m, buckets, bucketLabel, realWin, realAsOf) {
  node.replaceChildren();
  m = m || {};
  // Real Claude subscription % only — no estimate fallback.
  const hasReal = realWin && typeof realWin.pct === 'number';
  const pct = hasReal ? Math.max(0, Math.min(100, Math.round(realWin.pct))) : 0;

  const head = el('div', 'meter-head');
  const tw = el('span', 'meter-title');
  tw.appendChild(document.createTextNode(title));
  tw.appendChild(el('span', 'meter-src ' + (hasReal ? 'src-real' : 'src-est'), hasReal ? 'real' : 'no data'));
  head.appendChild(tw);
  head.appendChild(el('span', 'meter-pct mono', hasReal ? pct + '%' : '—'));
  node.appendChild(head);

  const bar = el('div', 'meter-bar');
  const fill = el('div', 'meter-fill ' + fillClass(pct));
  fill.style.width = (hasReal ? pct : 0) + '%';
  bar.appendChild(fill);
  node.appendChild(bar);

  // Secondary: the loop's OWN consumption this window (always real loop data).
  const stats = el('div', 'meter-stats');
  const tok = el('span');
  tok.appendChild(el('span', 'mono', fmtTokens(m.used)));
  tok.appendChild(document.createTextNode(' '));
  tok.appendChild(el('span', 'label', 'loop tokens'));
  stats.appendChild(tok);
  const cost = el('span');
  cost.appendChild(el('span', 'mono', fmtMoney(m.costUsd)));
  cost.appendChild(document.createTextNode(' '));
  cost.appendChild(el('span', 'label', 'loop cost'));
  stats.appendChild(cost);
  node.appendChild(stats);

  if (hasReal) {
    const resetLine = fmtResetsLine(realWin.resetsAt) + (realAsOf ? '  ·  as of ' + fmtRelative(realAsOf) : '');
    const resets = el('div', 'meter-resets', resetLine);
    resets.title = fmtClock(realWin.resetsAt);
    node.appendChild(resets);
  } else {
    node.appendChild(el('div', 'meter-resets', 'waiting for Claude Code usage data…'));
  }

  node.appendChild(renderChart(buckets || [], bucketLabel));
}

function renderChart(buckets, label) {
  const wrap = el('div');
  const chart = el('div', 'chart');
  const max = buckets.reduce((mx, b) => Math.max(mx, b.tokens || 0), 0) || 1;
  if (!buckets.length) {
    chart.appendChild(el('div', 'chart-label', 'no data'));
  } else {
    buckets.forEach((b) => {
      const col = el('div', 'col');
      const h = Math.max(2, Math.round(((b.tokens || 0) / max) * 100));
      col.style.height = h + '%';
      col.title = fmtClock(b.t) + ' · ' + fmtTokens(b.tokens) + ' tokens';
      chart.appendChild(col);
    });
  }
  wrap.appendChild(chart);
  if (label) wrap.appendChild(el('div', 'chart-label', label));
  return wrap;
}

function renderUsage(u) {
  const series = u.series || {};
  const real = u.real || null;
  renderMeterCard($('#windowCard'), '5-hour window', u.window, series.buckets, 'tokens / 15-min bucket · last 5h', real && real.fiveHour, real && real.asOf);
  renderMeterCard($('#weeklyCard'), 'Weekly', u.weekly, series.days, 'tokens / day · last 7d', real && real.sevenDay, real && real.asOf);
}

// ---- rendering: stage tracker (compact pills) ----
function stageStatusMap(stages) {
  const map = new Map();
  (stages || []).forEach((s) => map.set(s.stage, s.status));
  return map;
}

function renderStageTracker(stages) {
  const wrap = el('div', 'stages');
  const map = stageStatusMap(stages);
  // Show the known pipeline order, then any stage the run has that we don't know
  // about (future-proof against new stages the frontend list hasn't caught up to).
  const known = new Set(STAGE_ORDER);
  const extra = (Array.isArray(stages) ? stages : []).map((s) => s && s.stage).filter((n) => n && !known.has(n));
  [...STAGE_ORDER, ...extra].forEach((name) => {
    const status = map.get(name);
    let cls = 'stage-none';
    if (status === 'ok') cls = 'stage-ok';
    else if (status === 'failed') cls = 'stage-failed';
    else if (status === 'running') cls = 'stage-running';
    else if (status === 'skipped') cls = 'stage-skipped';
    wrap.appendChild(el('span', 'stage-pill ' + cls, name));
  });
  return wrap;
}

// ---- rendering: one run row ----
function renderRun(r) {
  const li = el('li', 'run');
  li.dataset.id = r.id;

  const head = el('div', 'run-head');

  // main column
  const main = el('div', 'run-main');
  const titleLine = el('div', 'run-titleline');
  const ticket = el('a', 'run-ticket', r.ticket || '');
  if (r.ticketUrl) {
    ticket.href = r.ticketUrl;
    ticket.target = '_blank';
    ticket.rel = 'noopener';
    ticket.addEventListener('click', (e) => e.stopPropagation());
  }
  titleLine.appendChild(ticket);
  titleLine.appendChild(el('span', 'run-title', r.ticketTitle || '(untitled)'));
  main.appendChild(titleLine);

  const sub = el('div', 'run-sub');
  if (r.project) sub.appendChild(el('span', null, r.project));
  if (r.autonomy) sub.appendChild(el('span', null, r.autonomy));
  main.appendChild(sub);
  main.appendChild(renderStageTracker(r.stages));
  if (r.error) main.appendChild(el('div', 'run-error', r.error));
  // Resume / Restart on a ticket's LATEST run when it stopped short — failed,
  // paused, or blocked (quota/rate-limit).
  if ((r.outcome === 'failed' || r.outcome === 'paused' || r.outcome === 'blocked') && newestRunIds.has(r.id)) {
    const key = (r.project || '') + ':' + (r.ticket || '');
    const actions = el('div', 'run-actions');
    const resume = el('button', 'btn btn-ghost btn-sm', '▶ Resume');
    resume.title = 'Continue from the checkpoint (already-done stages are reused)';
    resume.addEventListener('click', (e) => { e.stopPropagation(); doRetry(key, false); });
    const fresh = el('button', 'btn btn-ghost btn-sm', '↻ Restart fresh');
    fresh.title = 'Discard the checkpoint and re-run the whole ticket under the current workflow';
    fresh.addEventListener('click', (e) => { e.stopPropagation(); doRetry(key, true); });
    actions.appendChild(resume);
    actions.appendChild(fresh);
    main.appendChild(actions);
  }
  head.appendChild(main);

  // side column
  const side = el('div', 'run-side');
  side.appendChild(el('span', 'badge badge-' + (r.outcome || 'skipped'), r.outcome || '—'));
  const metrics = el('div', 'run-metrics');
  metrics.appendChild(el('span', null, fmtTokens(r.totalTokens) + ' tok'));
  metrics.appendChild(el('span', null, fmtMoney(r.costUsd)));
  side.appendChild(metrics);
  const running = r.outcome === 'running' || !r.endedAt;
  const timeStr = running ? fmtDuration(r.startedAt, r.endedAt) : fmtRelative(r.endedAt || r.startedAt);
  const time = el('span', 'run-time', timeStr);
  time.title = 'started ' + fmtClock(r.startedAt) + (r.endedAt ? '\nended ' + fmtClock(r.endedAt) : '');
  side.appendChild(time);
  head.appendChild(side);

  head.addEventListener('click', () => toggleExpand(r.id));
  li.appendChild(head);

  if (state.expanded.has(r.id)) {
    li.appendChild(renderDetail(r.id));
  }
  return li;
}

// ---- rendering: expanded detail ----
function renderDetail(id) {
  const box = el('div', 'run-detail');
  const full = state.detailCache.get(id);
  if (!full) {
    box.appendChild(el('div', 'detail-loading', 'Loading detail…'));
    return box;
  }

  const links = el('div', 'detail-links');
  if (Array.isArray(full.prs) && full.prs.length) {
    // multi-repo: one link per repo (or a failed/skipped marker)
    full.prs.forEach((p) => {
      if (p.url) links.appendChild(mkLink(p.url, p.repo + ' PR ↗'));
      else links.appendChild(el('span', 'detail-pr-bad', p.repo + ': ' + (p.status || 'no PR')));
    });
  } else if (full.prUrl) {
    links.appendChild(mkLink(full.prUrl, 'Pull request ↗'));
  }
  if (full.commentUrl) links.appendChild(mkLink(full.commentUrl, 'Comment ↗'));
  if (full.ticketUrl) links.appendChild(mkLink(full.ticketUrl, 'Ticket ↗'));
  if (links.childNodes.length) box.appendChild(links);

  const stages = full.stages || [];
  if (!stages.length) box.appendChild(el('div', 'detail-loading', 'No stage data.'));
  stages.forEach((s) => box.appendChild(renderStageDetail(s)));
  return box;
}

function mkLink(href, text) {
  const a = el('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function renderStageDetail(s) {
  const row = el('div', 'stage-row');
  const h = el('div', 'stage-row-head');
  h.appendChild(el('span', 'stage-name', s.stage || '—'));
  let cls = 'stage-none';
  if (s.status === 'ok') cls = 'stage-ok';
  else if (s.status === 'failed') cls = 'stage-failed';
  else if (s.status === 'running') cls = 'stage-running';
  else if (s.status === 'skipped') cls = 'stage-skipped';
  h.appendChild(el('span', 'stage-pill ' + cls, s.status || '—'));

  const meta = [];
  if (s.model) meta.push(s.model);
  if (s.totalTokens != null) meta.push(fmtTokens(s.totalTokens) + ' tok');
  if (s.costUsd != null) meta.push(fmtMoney(s.costUsd));
  const dur = fmtDuration(s.startedAt, s.endedAt);
  if (dur) meta.push(dur);
  if (meta.length) h.appendChild(el('span', 'stage-meta', meta.join('  ·  ')));
  row.appendChild(h);

  if (s.summary) row.appendChild(el('div', 'stage-summary', s.summary));
  if (s.detail) row.appendChild(el('div', 'stage-detail', s.detail));
  return row;
}

// ---- expand / collapse ----
// Which feed the shared row renderer is currently painting into.
function rerenderFeed() {
  if (activeView === 'history') {
    renderHistoryFeed();
    updateExpandAllBtn();
  } else {
    renderFeedFromState();
  }
}

// Fetch the full record (stage detail) once, then swap the one detail box.
async function ensureDetail(id) {
  if (state.detailCache.has(id)) return;
  try {
    const full = await api('/api/activity/' + encodeURIComponent(id));
    state.detailCache.set(id, full);
  } catch (e) {
    state.detailCache.set(id, { stages: [], _error: String(e) });
  }
  replaceDetail(id);
}

async function toggleExpand(id) {
  if (state.expanded.has(id)) {
    state.expanded.delete(id);
    rerenderFeed();
    return;
  }
  state.expanded.add(id);
  rerenderFeed();
  await ensureDetail(id);
}

function replaceDetail(id) {
  const li = document.querySelector('.run[data-id="' + cssEsc(id) + '"]');
  if (!li || !state.expanded.has(id)) return;
  const existing = li.querySelector('.run-detail');
  const fresh = renderDetail(id);
  if (existing) existing.replaceWith(fresh);
  else li.appendChild(fresh);
}

function cssEsc(v) {
  return String(v).replace(/["\\]/g, '\\$&');
}

// ---- feed ----
let lastRuns = [];

function renderFeedFromState() {
  const feed = $('#feed');
  const empty = $('#emptyState');
  // Preserve scroll position across the rebuild so polling doesn't jump the
  // page to the top while you're reading.
  const y = window.scrollY;
  if (!lastRuns.length) {
    feed.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const frag = document.createDocumentFragment();
  lastRuns.forEach((r) => frag.appendChild(renderRun(r)));
  feed.replaceChildren(frag);
  window.scrollTo({ top: y });
}

// A cheap signature of what the feed actually displays; if unchanged between
// polls we skip re-rendering entirely (no DOM churn, no scroll disturbance).
function feedSignature(runs, expanded) {
  return runs
    .map(
      (r) =>
        r.id +
        ':' +
        r.outcome +
        ':' +
        (r.totalTokens || 0) +
        ':' +
        (expanded.has(r.id) ? 'x' : '') +
        ':' +
        (r.stages || []).map((s) => s.stage + s.status).join(','),
    )
    .join('|');
}

// Newest run id per ticket (project:ticket). Retry buttons show only on a
// ticket's LATEST run, so a stale older failed attempt never offers them.
let newestRunIds = new Set();

function renderActivity(runs) {
  lastRuns = Array.isArray(runs) ? runs : [];
  state.runsById.clear();
  lastRuns.forEach((r) => state.runsById.set(r.id, r));
  newestRunIds = new Set();
  const seenTickets = new Set();
  for (const r of lastRuns) {
    // lastRuns is newest-first → first time we see a ticket is its latest run.
    const key = (r.project || '') + ':' + (r.ticket || '');
    if (!seenTickets.has(key)) { seenTickets.add(key); newestRunIds.add(r.id); }
  }
  // Drop expanded ids that no longer exist.
  for (const id of [...state.expanded]) {
    if (!state.runsById.has(id)) state.expanded.delete(id);
  }
  $('#activityMeta').textContent = lastRuns.length
    ? lastRuns.length + ' run' + (lastRuns.length === 1 ? '' : 's')
    : '';
  const sig = feedSignature(lastRuns, state.expanded);
  if (sig === state.feedSig) return; // nothing visible changed — don't touch the DOM
  state.feedSig = sig;
  renderFeedFromState();
}

// ---- "Now processing" live monitor ----
function isLive(status, activity) {
  if (status && status.scanning) return true;
  const runs = Array.isArray(activity) ? activity : [];
  return runs.some((r) => r && r.outcome === 'running');
}

// The in-progress run driving the strip: prefer the one matching activeTicket,
// otherwise the first run whose outcome is "running".
function findRunningRun(activity, activeTicket) {
  const running = (Array.isArray(activity) ? activity : []).filter((r) => r && r.outcome === 'running');
  if (!running.length) return null;
  if (activeTicket) {
    const match = running.find((r) => r.ticket === activeTicket);
    if (match) return match;
  }
  return running[0];
}

// Name of the currently-running stage within a run (e.g. "fix"), or null.
function runningStageName(run) {
  if (!run || !Array.isArray(run.stages)) return null;
  const s = run.stages.find((x) => x && x.status === 'running');
  return s ? s.stage : null;
}

let pauseNote = ''; // transient warning shown after a ticket resume that can't run yet

function renderLiveMonitor(status, activity) {
  const box = $('#liveMonitor');
  status = status || {};
  const live = isLive(status, activity);
  if (!live && !pauseNote) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  // Parallel runs: one row per active run (one per project). Fall back to the
  // running runs in the activity feed if the daemon didn't report activeRuns.
  const runs = Array.isArray(status.activeRuns) && status.activeRuns.length
    ? status.activeRuns.map((a) => ({ project: a.project, ticket: a.ticket, run: findRunByTicket(activity, a.ticket) }))
    : (Array.isArray(activity) ? activity : [])
        .filter((r) => r && r.outcome === 'running')
        .map((r) => ({ project: r.project, ticket: r.ticket, run: r }));

  box.replaceChildren();
  if (pauseNote) box.appendChild(el('div', 'live-note', pauseNote));
  if (runs.length > 1) box.appendChild(el('div', 'live-head mono', runs.length + ' running in parallel'));

  runs.forEach(({ project, ticket, run }) => {
    const step = runningStageName(run) || '…';
    const row = el('div', 'live-row');
    const dot = el('span', 'live-dot');
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);
    row.appendChild(el('span', 'live-label', 'Processing'));
    const who = project && ticket ? project + ' · ' + ticket : project || ticket;
    if (who) row.appendChild(el('span', 'live-ticket', who));
    row.appendChild(el('span', 'live-step-chip', step));
    const btn = el('button', 'btn btn-ghost btn-sm live-pause', '⏸');
    btn.title = 'Pause this ticket at its next stage boundary';
    btn.addEventListener('click', () => doTicketPause(project + ':' + ticket, true));
    row.appendChild(btn);
    box.appendChild(row);
  });

  box.hidden = false;
}

// Pause/resume a single ticket; surface the one-per-project warning inline.
async function doTicketPause(ticketKey, paused) {
  try {
    const r = await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused, ticketKey }) });
    pauseNote = r && r.warning ? r.warning : '';
    await poll();
  } catch (e) {
    setConn(false);
  }
}

// Resume (fresh=false) or restart-fresh (fresh=true) a failed/paused ticket now.
async function doRetry(ticketKey, fresh) {
  try {
    const r = await api('/api/retry', { method: 'POST', body: JSON.stringify({ ticketKey, fresh }) });
    pauseNote = r && r.error ? r.error : '';
    await poll();
  } catch (e) {
    setConn(false);
  }
}

// The running run for a given ticket in the activity feed (for its live stage).
function findRunByTicket(activity, ticket) {
  return (Array.isArray(activity) ? activity : []).find((r) => r && r.ticket === ticket && r.outcome === 'running') || null;
}

// ---- poll loop ----
let activeView = 'activity';
let pollTimer = null;

// Single self-scheduling timer: fast cadence while live, normal otherwise.
// Called directly by doScan()/setView() too, so it clears any pending timer
// first to guarantee no overlapping timers.
async function poll() {
  clearTimeout(pollTimer);
  if (activeView !== 'activity') return; // pause polling on Setup
  let live = false;
  try {
    const [status, usage, activity] = await Promise.all([
      api('/api/status'),
      api('/api/usage'),
      api('/api/activity?limit=50'),
    ]);
    setConn(true);
    renderStatus(status);
    renderUsage(usage);
    renderActivity(activity);
    renderLiveMonitor(status, activity);
    live = isLive(status, activity);
  } catch (e) {
    setConn(false); // keep last-good UI, show reconnecting
  }
  // Reschedule only if still on Activity (view may have switched during await).
  if (activeView === 'activity') {
    pollTimer = setTimeout(poll, live ? FAST_POLL_MS : POLL_MS);
  }
}

// ---- scan button ----
async function doScan() {
  const btn = $('#scanBtn');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Scanning…';
  try {
    await api('/api/scan', { method: 'POST' });
    await poll();
  } catch (e) {
    setConn(false);
  } finally {
    btn.textContent = prev;
    btn.disabled = false;
  }
}

// ---- pause / resume button ----
async function doPauseToggle() {
  const btn = $('#pauseBtn');
  if (!btn) return;
  const paused = btn.dataset.paused === '1';
  btn.disabled = true;
  try {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: !paused }) });
    await poll();
  } catch (e) {
    setConn(false);
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// History view — query-driven archive (never polled)
// ============================================================

const SORTS = ['started_desc', 'started_asc', 'cost_desc', 'tokens_desc', 'duration_desc'];
const PAGE_SIZES = [25, 50, 100];
const DEFAULT_SORT = 'started_desc';
const DEFAULT_LIMIT = 25;
const DEBOUNCE_MS = 300;

const hist = {
  filters: newFilters(),
  facets: null,
  runs: [],
  total: 0,
  loaded: false,
  error: null,
  seq: 0, // monotonic — stale responses are discarded
  ctrl: null, // AbortController for the in-flight request
  paging: false,
  debounce: null,
};

function newFilters() {
  return { q: '', project: '', outcomes: [], from: '', to: '', sort: DEFAULT_SORT, limit: DEFAULT_LIMIT, offset: 0 };
}

function hasActiveFilters(f) {
  return !!(f.q || f.project || f.outcomes.length || f.from || f.to);
}

// Local YYYY-MM-DD (the daemon interprets bare dates in its own local time).
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// ---- URL <-> filters (serialized names match the API params exactly) ----
function filtersToQuery(f) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.project) p.append('project', f.project);
  f.outcomes.forEach((o) => p.append('outcome', o));
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.sort && f.sort !== DEFAULT_SORT) p.set('sort', f.sort);
  if (f.limit !== DEFAULT_LIMIT) p.set('limit', String(f.limit));
  if (f.offset) p.set('offset', String(f.offset));
  return p;
}

function readFiltersFromParams(p) {
  const sort = p.get('sort');
  const limit = Number(p.get('limit'));
  hist.filters = {
    q: (p.get('q') || '').slice(0, 200),
    project: p.get('project') || '',
    outcomes: p.getAll('outcome'),
    from: p.get('from') || '',
    to: p.get('to') || '',
    sort: SORTS.includes(sort) ? sort : DEFAULT_SORT,
    limit: PAGE_SIZES.includes(limit) ? limit : DEFAULT_LIMIT,
    offset: Math.max(0, Number(p.get('offset')) || 0),
  };
}

// Filter edits replace (typing shouldn't spam the back stack); page changes push.
function writeHistoryUrl(push) {
  const qs = filtersToQuery(hist.filters).toString();
  const url = '#history' + (qs ? '?' + qs : '');
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

// ---- open / fetch ----
async function openHistory() {
  if (!hist.facets) await loadFacets();
  syncHistoryControls();
  writeHistoryUrl(false);
  fetchHistory('filter');
}

async function loadFacets() {
  try {
    hist.facets = await api('/api/history/facets');
  } catch (_e) {
    hist.facets = { projects: [], outcomes: [], earliest: null, latest: null };
  }
  buildProjectOptions();
  buildOutcomePanel();
}

async function fetchHistory(mode) {
  const seq = ++hist.seq;
  if (hist.ctrl) hist.ctrl.abort();
  const ctrl = new AbortController();
  hist.ctrl = ctrl;
  hist.error = null;
  if (mode === 'page') {
    hist.paging = true;
    setPagingBusy(true);
  } else {
    renderHistorySkeleton();
  }
  try {
    const qs = filtersToQuery(hist.filters).toString();
    const data = await api('/api/history' + (qs ? '?' + qs : ''), { signal: ctrl.signal });
    if (seq !== hist.seq) return; // superseded
    hist.runs = Array.isArray(data.runs) ? data.runs : [];
    hist.total = Number(data.total) || 0;
    hist.loaded = true;
  } catch (e) {
    if (seq !== hist.seq || (e && e.name === 'AbortError')) return;
    hist.error = (e && e.message) || String(e);
    hist.runs = [];
    hist.total = 0;
  } finally {
    if (seq === hist.seq) {
      hist.ctrl = null;
      hist.paging = false;
      setPagingBusy(false);
      renderHistory();
    }
  }
}

// Any filter change resets to page 1 and collapses open rows.
function applyFilterChange() {
  hist.filters.offset = 0;
  state.expanded.clear();
  renderHistoryChips();
  writeHistoryUrl(false);
  fetchHistory('filter');
}

function goToOffset(offset) {
  hist.filters.offset = Math.max(0, offset);
  state.expanded.clear();
  writeHistoryUrl(true);
  fetchHistory('page');
  const feed = $('#historyFeed');
  if (feed) feed.scrollIntoView({ block: 'start' });
}

function clearAllFilters() {
  const f = hist.filters;
  f.q = '';
  f.project = '';
  f.outcomes = [];
  f.from = '';
  f.to = '';
  syncHistoryControls();
  applyFilterChange();
}

// ---- controls ----
function buildProjectOptions() {
  const sel = $('#hProject');
  sel.replaceChildren();
  const all = el('option', null, 'All projects');
  all.value = '';
  sel.appendChild(all);
  ((hist.facets && hist.facets.projects) || []).forEach((p) => {
    const o = el('option', null, p);
    o.value = p;
    sel.appendChild(o);
  });
  // keep a URL-restored project selectable even if it has no runs left
  if (hist.filters.project && !sel.querySelector('option[value="' + cssEsc(hist.filters.project) + '"]')) {
    const o = el('option', null, hist.filters.project);
    o.value = hist.filters.project;
    sel.appendChild(o);
  }
  sel.value = hist.filters.project;
}

function buildOutcomePanel() {
  const panel = $('#hOutcomePanel');
  panel.replaceChildren();
  const outcomes = (hist.facets && hist.facets.outcomes) || [];

  const list = el('div', 'hf-pop-list');
  outcomes.forEach((o) => {
    const row = el('label', 'hf-pop-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = o;
    cb.checked = hist.filters.outcomes.includes(o);
    cb.addEventListener('change', () => {
      const set = new Set(hist.filters.outcomes);
      if (cb.checked) set.add(o);
      else set.delete(o);
      hist.filters.outcomes = outcomes.filter((x) => set.has(x));
      syncOutcomeButton();
      applyFilterChange();
    });
    row.appendChild(cb);
    row.appendChild(el('span', 'badge badge-' + o, o));
    list.appendChild(row);
  });
  panel.appendChild(list);

  const foot = el('div', 'hf-pop-foot');
  const selAll = el('button', 'btn btn-ghost btn-sm', 'Select all');
  selAll.type = 'button';
  selAll.addEventListener('click', () => {
    hist.filters.outcomes = outcomes.slice();
    buildOutcomePanel();
    syncOutcomeButton();
    applyFilterChange();
  });
  const clr = el('button', 'btn btn-ghost btn-sm', 'Clear');
  clr.type = 'button';
  clr.addEventListener('click', () => {
    hist.filters.outcomes = [];
    buildOutcomePanel();
    syncOutcomeButton();
    applyFilterChange();
  });
  foot.appendChild(selAll);
  foot.appendChild(clr);
  panel.appendChild(foot);
}

function syncOutcomeButton() {
  const n = hist.filters.outcomes.length;
  $('#hOutcomeBtn').textContent = n ? 'Outcome (' + n + ')' : 'All outcomes';
}

function setOutcomePanel(open) {
  $('#hOutcomePanel').hidden = !open;
  $('#hOutcomeBtn').setAttribute('aria-expanded', String(open));
}

// Push filter state into every control (used on load, popstate and Clear all).
function syncHistoryControls() {
  const f = hist.filters;
  $('#hQ').value = f.q;
  $('#hQClear').hidden = !f.q;
  buildProjectOptions();
  buildOutcomePanel();
  syncOutcomeButton();
  const from = $('#hFrom');
  const to = $('#hTo');
  from.value = f.from;
  to.value = f.to;
  const fac = hist.facets || {};
  if (fac.earliest) {
    const lo = ymd(new Date(fac.earliest));
    from.min = lo;
    to.min = lo;
  }
  if (fac.latest) {
    const hi = ymd(new Date(fac.latest));
    from.max = hi;
    to.max = hi;
  }
  $('#hSort').value = f.sort;
  $('#hLimit').value = String(f.limit);
  renderHistoryChips();
}

// ---- active-filter chips ----
function chipEl(label, onRemove) {
  const c = el('span', 'filter-chip');
  c.appendChild(el('span', null, label));
  const x = el('button', 'filter-chip-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Remove filter ' + label);
  x.addEventListener('click', onRemove);
  c.appendChild(x);
  return c;
}

function renderHistoryChips() {
  const box = $('#hChips');
  const f = hist.filters;
  box.replaceChildren();
  const chips = [];
  if (f.q) {
    chips.push(chipEl('search: ' + f.q, () => {
      f.q = '';
      $('#hQ').value = '';
      $('#hQClear').hidden = true;
      applyFilterChange();
    }));
  }
  if (f.project) {
    chips.push(chipEl('project: ' + f.project, () => {
      f.project = '';
      $('#hProject').value = '';
      applyFilterChange();
    }));
  }
  f.outcomes.forEach((o) => {
    chips.push(chipEl('outcome: ' + o, () => {
      f.outcomes = f.outcomes.filter((x) => x !== o);
      buildOutcomePanel();
      syncOutcomeButton();
      applyFilterChange();
    }));
  });
  if (f.from) {
    chips.push(chipEl('from: ' + f.from, () => {
      f.from = '';
      $('#hFrom').value = '';
      applyFilterChange();
    }));
  }
  if (f.to) {
    chips.push(chipEl('to: ' + f.to, () => {
      f.to = '';
      $('#hTo').value = '';
      applyFilterChange();
    }));
  }
  const n = chips.length;
  $('#hFilterToggle').textContent = n ? 'Filters (' + n + ')' : 'Filters';
  if (!n) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  chips.forEach((c) => box.appendChild(c));
  const clear = el('button', 'btn btn-ghost btn-sm', 'Clear all');
  clear.type = 'button';
  clear.addEventListener('click', clearAllFilters);
  box.appendChild(clear);
}

// ---- rendering ----
function setHistoryError(msg) {
  const box = $('#historyError');
  if (!msg) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  box.appendChild(el('h3', null, 'Error'));
  box.appendChild(el('div', null, 'Could not load history: ' + msg));
  const retry = el('button', 'btn btn-ghost btn-sm', 'Retry');
  retry.type = 'button';
  retry.style.marginTop = '8px';
  retry.addEventListener('click', () => fetchHistory('filter'));
  box.appendChild(retry);
}

function renderHistorySkeleton() {
  setHistoryError('');
  $('#historyEmpty').hidden = true;
  $('#historyPager').hidden = true;
  $('#historyCount').textContent = 'Searching…';
  const feed = $('#historyFeed');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 3; i++) {
    const li = el('li', 'run skel');
    const head = el('div', 'run-head');
    const main = el('div', 'run-main');
    main.appendChild(el('div', 'skel-bar skel-w60'));
    main.appendChild(el('div', 'skel-bar skel-w35'));
    main.appendChild(el('div', 'skel-bar skel-w80'));
    head.appendChild(main);
    const side = el('div', 'run-side');
    side.appendChild(el('div', 'skel-bar skel-pill'));
    head.appendChild(side);
    li.appendChild(head);
    frag.appendChild(li);
  }
  feed.replaceChildren(frag);
  feed.classList.remove('is-paging');
}

function renderHistoryFeed() {
  const feed = $('#historyFeed');
  const frag = document.createDocumentFragment();
  hist.runs.forEach((r) => frag.appendChild(renderRun(r)));
  feed.replaceChildren(frag);
}

function setPagingBusy(busy) {
  const feed = $('#historyFeed');
  if (feed) feed.classList.toggle('is-paging', !!busy);
  $('#hPrev').disabled = busy || hist.filters.offset <= 0;
  $('#hNext').disabled = busy || hist.filters.offset + hist.filters.limit >= hist.total;
}

function renderHistoryCount() {
  const f = hist.filters;
  const node = $('#historyCount');
  if (!hist.total) {
    node.textContent = hasActiveFilters(f) ? '0 runs match' : '';
    return;
  }
  const noun = hist.total === 1 ? ' run' : ' runs';
  const start = f.offset + 1;
  const end = Math.min(f.offset + f.limit, hist.total);
  node.textContent = hist.total.toLocaleString() + noun + (hasActiveFilters(f) ? ' match' : '') +
    ' · showing ' + start.toLocaleString() + '–' + end.toLocaleString();
}

function renderHistoryEmpty() {
  const box = $('#historyEmpty');
  box.replaceChildren();
  if (hasActiveFilters(hist.filters)) {
    box.appendChild(el('div', null, 'No runs match these filters.'));
    const fac = hist.facets || {};
    if (fac.earliest) {
      box.appendChild(el('div', 'muted', 'The oldest recorded run is from ' + fmtClock(fac.earliest) + '.'));
    }
    const btn = el('button', 'btn btn-ghost btn-sm', 'Clear all filters');
    btn.type = 'button';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', clearAllFilters);
    box.appendChild(btn);
  } else {
    box.appendChild(el('div', null, 'No runs recorded yet.'));
    box.appendChild(el('div', 'muted', 'Runs appear here after the loop processes a ticket — try Scan now on Activity.'));
  }
  box.hidden = false;
}

function renderHistoryPager() {
  const f = hist.filters;
  const pager = $('#historyPager');
  const pages = Math.max(1, Math.ceil(hist.total / f.limit));
  if (!hist.total || pages <= 1) {
    pager.hidden = true;
    return;
  }
  pager.hidden = false;
  const page = Math.floor(f.offset / f.limit) + 1;
  $('#hPageLabel').textContent = 'Page ' + page + ' of ' + pages;
  $('#hPrev').disabled = f.offset <= 0;
  $('#hNext').disabled = f.offset + f.limit >= hist.total;
}

function renderHistory() {
  setHistoryError(hist.error);
  const feed = $('#historyFeed');
  feed.classList.remove('is-paging');
  if (hist.error) {
    feed.replaceChildren();
    $('#historyEmpty').hidden = true;
    $('#historyPager').hidden = true;
    $('#historyCount').textContent = '';
    return;
  }
  renderHistoryCount();
  if (!hist.runs.length) {
    feed.replaceChildren();
    renderHistoryEmpty();
    renderHistoryPager();
    updateExpandAllBtn();
    return;
  }
  $('#historyEmpty').hidden = true;
  renderHistoryFeed();
  renderHistoryPager();
  updateExpandAllBtn();
}

function updateExpandAllBtn() {
  const btn = $('#hExpandAll');
  const ids = hist.runs.map((r) => r.id);
  btn.disabled = !ids.length;
  const allOpen = ids.length > 0 && ids.every((id) => state.expanded.has(id));
  btn.textContent = allOpen ? 'Collapse all' : 'Expand all';
}

async function toggleExpandAll() {
  const ids = hist.runs.map((r) => r.id);
  if (!ids.length) return;
  const allOpen = ids.every((id) => state.expanded.has(id));
  if (allOpen) {
    ids.forEach((id) => state.expanded.delete(id));
    renderHistoryFeed();
    updateExpandAllBtn();
    return;
  }
  ids.forEach((id) => state.expanded.add(id));
  renderHistoryFeed();
  updateExpandAllBtn();
  await Promise.all(ids.map((id) => ensureDetail(id)));
}

// ---- history event wiring ----
function bindHistory() {
  const qIn = $('#hQ');
  const applyQ = () => {
    clearTimeout(hist.debounce);
    hist.debounce = null;
    const v = qIn.value.trim().slice(0, 200);
    if (v === hist.filters.q) return;
    hist.filters.q = v;
    applyFilterChange();
  };
  qIn.addEventListener('input', () => {
    $('#hQClear').hidden = !qIn.value;
    clearTimeout(hist.debounce);
    hist.debounce = setTimeout(applyQ, DEBOUNCE_MS);
  });
  qIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyQ();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      qIn.value = '';
      $('#hQClear').hidden = true;
      applyQ();
    }
  });
  $('#hQClear').addEventListener('click', () => {
    qIn.value = '';
    $('#hQClear').hidden = true;
    applyQ();
    qIn.focus();
  });
  $('#historyFilters').addEventListener('submit', (e) => e.preventDefault());

  $('#hProject').addEventListener('change', (e) => {
    hist.filters.project = e.target.value;
    applyFilterChange();
  });
  $('#hSort').addEventListener('change', (e) => {
    hist.filters.sort = SORTS.includes(e.target.value) ? e.target.value : DEFAULT_SORT;
    applyFilterChange();
  });
  $('#hLimit').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    hist.filters.limit = PAGE_SIZES.includes(n) ? n : DEFAULT_LIMIT;
    applyFilterChange();
  });
  $('#hFrom').addEventListener('change', (e) => {
    hist.filters.from = e.target.value;
    applyFilterChange();
  });
  $('#hTo').addEventListener('change', (e) => {
    hist.filters.to = e.target.value;
    applyFilterChange();
  });

  $('#hQuick').addEventListener('click', (e) => {
    const btn = e.target.closest('.hf-quick-btn');
    if (!btn) return;
    const now = new Date();
    const today = ymd(now);
    const back = (days) => ymd(new Date(now.getTime() - days * 86400000));
    const r = btn.dataset.range;
    if (r === 'all') {
      hist.filters.from = '';
      hist.filters.to = '';
    } else if (r === 'today') {
      hist.filters.from = today;
      hist.filters.to = today;
    } else if (r === '7d') {
      hist.filters.from = back(6);
      hist.filters.to = today;
    } else if (r === '30d') {
      hist.filters.from = back(29);
      hist.filters.to = today;
    }
    $('#hFrom').value = hist.filters.from;
    $('#hTo').value = hist.filters.to;
    applyFilterChange();
  });

  const outBtn = $('#hOutcomeBtn');
  outBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOutcomePanel($('#hOutcomePanel').hidden);
  });
  $('#hOutcomePanel').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => setOutcomePanel(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#hOutcomePanel').hidden) setOutcomePanel(false);
  });

  $('#hFilterToggle').addEventListener('click', () => {
    const body = $('#hFilterBody');
    const open = body.classList.toggle('is-collapsed') === false;
    $('#hFilterToggle').setAttribute('aria-expanded', String(open));
  });

  $('#hRefresh').addEventListener('click', async () => {
    await loadFacets();
    syncHistoryControls();
    fetchHistory('filter');
  });
  $('#hExpandAll').addEventListener('click', toggleExpandAll);
  $('#hPrev').addEventListener('click', () => goToOffset(hist.filters.offset - hist.filters.limit));
  $('#hNext').addEventListener('click', () => goToOffset(hist.filters.offset + hist.filters.limit));

  // "/" focuses search while on History.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || activeView !== 'history') return;
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    qIn.focus();
    qIn.select();
  });
}

// ============================================================
// Setup view
// ============================================================

const setup = {
  config: null,
  editing: null, // name being edited, or null for "add"
  pendingDelete: null, // project name awaiting inline delete confirm
};

// ---- view switching ----
const VIEWS = ['activity', 'history', 'setup'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// `#view` fragment drives the tab so links are shareable; History appends its
// filters as a query string after the view name (see writeHistoryUrl).
function parseHash() {
  const h = String(location.hash || '').replace(/^#/, '');
  const qi = h.indexOf('?');
  const name = qi >= 0 ? h.slice(0, qi) : h;
  return {
    view: VIEWS.includes(name) ? name : 'activity',
    params: new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : ''),
  };
}

function setView(view, opts) {
  opts = opts || {};
  if (!VIEWS.includes(view)) view = 'activity';
  // Expansion is per-result-set; never carry it across views.
  if (view !== activeView) state.expanded.clear();
  activeView = view;
  VIEWS.forEach((v) => {
    const on = v === view;
    $('#view' + cap(v)).hidden = !on;
    const btn = $('#nav' + cap(v));
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  });
  // Scan is only meaningful on Activity.
  $('#scanBtn').hidden = view !== 'activity';
  if (view === 'activity') {
    if (!opts.silent) history.replaceState(null, '', '#activity');
    poll(); // resume immediately
  } else if (view === 'setup') {
    if (!opts.silent) history.replaceState(null, '', '#setup');
    loadConfig();
  } else {
    openHistory();
  }
}

// ---- toast ----
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    toastTimer = setTimeout(() => (t.hidden = true), 250);
  }, 2200);
}

function setSetupError(msg) {
  const box = $('#setupError');
  if (!msg) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  box.appendChild(el('h3', null, 'Error'));
  box.appendChild(el('div', null, msg));
}

// ---- load + render config ----
async function loadConfig() {
  try {
    setSetupError('');
    const cfg = await api('/api/config');
    setup.config = cfg;
    setup.pendingDelete = null;
    renderSetup();
  } catch (e) {
    setSetupError('Could not load configuration: ' + e.message);
  }
}

function renderSetup() {
  renderEnvStrip();
  renderProjects();
}

function renderEnvStrip() {
  const cfg = setup.config || {};
  const tooling = cfg.tooling || {};
  const g = cfg.globals || {};
  const chips = $('#envChips');
  chips.replaceChildren();
  [['claude', 'claude'], ['gh', 'gh'], ['git', 'git']].forEach(([key, label]) => {
    const ok = !!tooling[key];
    const chip = el('span', 'chip ' + (ok ? 'chip-ok' : 'chip-bad'));
    chip.appendChild(el('span', 'chip-mark', ok ? '✓' : '✕'));
    chip.appendChild(el('span', null, label));
    chips.appendChild(chip);
  });

  const auth = (g.auth && g.auth.mode) || '—';
  const plan = (g.quota && g.quota.plan) || '—';
  const pollSec = (g.trackerDefaults && g.trackerDefaults.pollIntervalSec) || '—';
  $('#envMeta').textContent = 'auth mode = ' + auth + ' · plan = ' + plan + ' · poll every ' + pollSec + 's';
}

function renderProjects() {
  const list = $('#projectList');
  const empty = $('#projectEmpty');
  const projects = (setup.config && setup.config.projects) || [];
  list.replaceChildren();
  if (!projects.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  projects.forEach((p) => list.appendChild(renderProjectCard(p)));
}

function autonomyClass(a) {
  if (a === 'propose') return 'auto-propose';
  if (a === 'gated-merge') return 'auto-gated';
  return 'auto-clarify';
}

function renderProjectCard(p) {
  const card = el('div', 'project-card');

  const head = el('div', 'project-head');
  head.appendChild(el('h3', 'project-name', p.name || '(unnamed)'));
  head.appendChild(el('span', 'badge auto-badge ' + autonomyClass(p.autonomy), p.autonomy || '—'));
  card.appendChild(head);

  // repo path
  const pathLine = el('div', 'project-path');
  pathLine.appendChild(el('span', 'mono', p.repoPath || '—'));
  if (p.repoExists === false) {
    pathLine.appendChild(el('span', 'path-warn', 'path not found'));
  }
  card.appendChild(pathLine);

  // tracker
  const rt = p.resolvedTracker || {};
  const team = rt.team || (p.tracker && p.tracker.team) || '—';
  const label = rt.simpleLabel || '—';
  card.appendChild(el('div', 'project-tracker muted', 'tracker: ' + team + ' · ' + label));

  // key status
  const keyRow = el('div', 'key-row');
  if (p.hasKey) {
    const src = p.keySource ? '(' + p.keySource + ')' : '';
    keyRow.appendChild(el('span', 'key-status key-set', 'key set ' + src));
  } else {
    keyRow.appendChild(el('span', 'key-status key-none', 'no key'));
  }
  card.appendChild(keyRow);

  // set key control
  const keyForm = el('form', 'key-form');
  const keyInput = el('input', 'input key-input');
  keyInput.type = 'password';
  keyInput.placeholder = 'Set API key';
  keyInput.autocomplete = 'off';
  keyInput.setAttribute('aria-label', 'API key for ' + (p.name || 'project'));
  const keyBtn = el('button', 'btn btn-sm', 'Save');
  keyBtn.type = 'submit';
  const keyMsg = el('span', 'key-msg');
  keyForm.appendChild(keyInput);
  keyForm.appendChild(keyBtn);
  keyForm.appendChild(keyMsg);
  keyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = keyInput.value.trim();
    if (!val) return;
    keyBtn.disabled = true;
    try {
      await mutate('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: p.name, key: val }),
      });
      keyInput.value = '';
      keyMsg.textContent = 'saved';
      keyMsg.className = 'key-msg ok';
      await loadConfig();
    } catch (err) {
      keyMsg.textContent = err.message || 'failed';
      keyMsg.className = 'key-msg bad';
    } finally {
      keyBtn.disabled = false;
    }
  });
  card.appendChild(keyForm);

  // actions
  const actions = el('div', 'project-actions');
  const editBtn = el('button', 'btn btn-ghost btn-sm', 'Edit');
  editBtn.addEventListener('click', () => openForm(p.name));
  actions.appendChild(editBtn);

  if (setup.pendingDelete === p.name) {
    const confirm = el('span', 'del-confirm');
    confirm.appendChild(el('span', null, 'Really delete?'));
    const yes = el('button', 'btn btn-danger btn-sm', 'yes');
    yes.addEventListener('click', () => doDelete(p.name));
    const no = el('button', 'btn btn-ghost btn-sm', 'no');
    no.addEventListener('click', () => {
      setup.pendingDelete = null;
      renderProjects();
    });
    confirm.appendChild(yes);
    confirm.appendChild(no);
    actions.appendChild(confirm);
  } else {
    const delBtn = el('button', 'btn btn-ghost btn-sm', 'Delete');
    delBtn.addEventListener('click', () => {
      setup.pendingDelete = p.name;
      renderProjects();
    });
    actions.appendChild(delBtn);
  }
  card.appendChild(actions);

  return card;
}

async function doDelete(name) {
  try {
    await mutate('/api/projects/' + encodeURIComponent(name), { method: 'DELETE' });
    toast('deleted');
    await loadConfig();
  } catch (e) {
    setSetupError('Delete failed: ' + e.message);
  }
}

// ---- project form ----
function findProject(name) {
  return ((setup.config && setup.config.projects) || []).find((p) => p.name === name) || null;
}

function inputRow(labelText, control, helpText) {
  const row = el('div', 'field');
  const lbl = el('label', 'field-label', labelText);
  if (control.id) lbl.htmlFor = control.id;
  row.appendChild(lbl);
  row.appendChild(control);
  if (helpText) row.appendChild(el('div', 'field-help muted', helpText));
  return row;
}

function mkInput(id, type, value, placeholder) {
  const i = el('input', 'input');
  i.id = id;
  i.type = type || 'text';
  if (value != null) i.value = value;
  if (placeholder) i.placeholder = placeholder;
  return i;
}

// One editable row in the multi-repo list (name / path / base / read-only).
function repoRowEl(r) {
  r = r || {};
  const row = el('div', 'repo-entry');
  const name = el('input', 'input repo-f-name');
  name.placeholder = 'name';
  name.value = r.name || '';
  const path = el('input', 'input repo-f-path mono');
  path.placeholder = 'path (relative to workspace root)';
  path.value = r.path || '';
  const base = el('input', 'input repo-f-base');
  base.placeholder = 'base (optional)';
  base.value = r.base || '';
  const roWrap = el('label', 'checkbox-row repo-f-rowrap');
  const ro = el('input');
  ro.type = 'checkbox';
  ro.className = 'repo-f-ro';
  ro.checked = !!r.shipDisabled;
  roWrap.appendChild(ro);
  roWrap.appendChild(el('span', null, 'read-only'));
  const del = el('button', 'icon-btn repo-f-del', '×');
  del.type = 'button';
  del.title = 'Remove repo';
  del.addEventListener('click', () => row.remove());
  row.appendChild(name);
  row.appendChild(path);
  row.appendChild(base);
  row.appendChild(roWrap);
  row.appendChild(del);
  return row;
}

function openForm(name) {
  setup.editing = name || null;
  const p = name ? findProject(name) : null;
  const cfg = setup.config || {};
  const g = cfg.globals || {};
  const td = g.trackerDefaults || {};
  const stageOrder = cfg.stageOrder || STAGE_ORDER;
  const defaults = cfg.defaultInstructions || {};

  $('#formTitle').textContent = name ? 'Edit project' : 'Add project';
  $('#formInlineError').hidden = true;

  const form = $('#projectForm');
  form.replaceChildren();

  // name
  const nameIn = mkInput('f_name', 'text', p ? p.name : '', 'my-project');
  if (name) nameIn.disabled = true;
  form.appendChild(inputRow('Name', nameIn, name ? 'Name is the key and cannot be changed.' : null));

  // repoPath (with folder picker)
  const repoIn = mkInput('f_repo', 'text', p ? p.repoPath : '', '/path/to/checkout');
  repoIn.classList.add('mono');
  const repoField = el('div', 'field');
  const repoLbl = el('label', 'field-label', 'Repo path');
  repoLbl.htmlFor = repoIn.id;
  repoField.appendChild(repoLbl);
  const repoRow = el('div', 'repo-row');
  repoRow.appendChild(repoIn);
  const browseBtn = el('button', 'btn btn-ghost btn-sm', 'Browse…');
  browseBtn.type = 'button';
  browseBtn.addEventListener('click', () => openFsPicker(repoIn));
  repoRow.appendChild(browseBtn);
  repoField.appendChild(repoRow);
  const repoHelp = el(
    'div',
    'field-help muted',
    'Your normal checkout (a git repo). Changes run in an isolated worktree, so your working tree is untouched.',
  );
  repoField.appendChild(repoHelp);
  form.appendChild(repoField);

  // ---- Multi-repo (sibling repos in one folder) ----
  const isMulti = !!(p && Array.isArray(p.repos) && p.repos.length);
  const multiWrap = el('label', 'checkbox-row');
  const multiIn = el('input');
  multiIn.type = 'checkbox';
  multiIn.id = 'f_multi';
  multiIn.checked = isMulti;
  multiWrap.appendChild(multiIn);
  multiWrap.appendChild(el('span', null, 'This project contains multiple repos'));
  const multiField = el('div', 'field');
  multiField.appendChild(multiWrap);
  multiField.appendChild(el(
    'div',
    'field-help muted',
    'For a folder holding several sibling git repos (e.g. frontend + backend). The repo path above becomes the workspace root, and a ticket can touch any of them — each changed repo gets its own PR. Leave off for a normal single repo or a monorepo.',
  ));
  form.appendChild(multiField);

  const reposBox = el('div', 'repos-box');
  reposBox.id = 'f_repos';
  const reposList = el('div', 'repos-list');
  reposList.id = 'f_repos_list';
  reposBox.appendChild(reposList);
  const addRepoBtn = el('button', 'btn btn-ghost btn-sm', '+ Add repo');
  addRepoBtn.type = 'button';
  addRepoBtn.addEventListener('click', () => reposList.appendChild(repoRowEl({})));
  reposBox.appendChild(addRepoBtn);
  form.appendChild(reposBox);

  if (isMulti) p.repos.forEach((r) => reposList.appendChild(repoRowEl(r)));
  else reposList.appendChild(repoRowEl({}));

  const syncMulti = () => {
    reposBox.hidden = !multiIn.checked;
    repoHelp.textContent = multiIn.checked
      ? 'The WORKSPACE ROOT — the parent folder containing the repos below. It need not be a git repo itself.'
      : 'Your normal checkout (a git repo). Changes run in an isolated worktree, so your working tree is untouched.';
  };
  multiIn.addEventListener('change', () => {
    if (multiIn.checked && !reposList.children.length) reposList.appendChild(repoRowEl({}));
    syncMulti();
  });
  syncMulti();

  // autonomy — default "propose" for new projects; keep existing when editing
  const autoSel = el('select', 'input');
  autoSel.id = 'f_autonomy';
  const autoVal = p ? p.autonomy : 'propose';
  ['clarify', 'propose', 'gated-merge'].forEach((v) => {
    const o = el('option', null, v);
    o.value = v;
    if (autoVal === v) o.selected = true;
    autoSel.appendChild(o);
  });
  const autoField = inputRow('Autonomy', autoSel);
  const autoHelp = el('div', 'field-help muted');
  [
    'clarify — Answer questions only: reads the code and posts a comment. Never changes code.',
    'propose — Answer questions, and for change requests open a pull request for you to review and merge. Never merges on its own. (Recommended)',
    'gated-merge — Like propose, but auto-merges trivial copy/CSS changes when the review is clean; everything else still becomes a PR.',
  ].forEach((line) => autoHelp.appendChild(el('div', 'autonomy-help-line', line)));
  autoField.appendChild(autoHelp);
  form.appendChild(autoField);

  // useWorktree
  const wtWrap = el('label', 'checkbox-row');
  const wtIn = el('input');
  wtIn.type = 'checkbox';
  wtIn.id = 'f_worktree';
  wtIn.checked = p ? p.useWorktree !== false : true;
  wtWrap.appendChild(wtIn);
  wtWrap.appendChild(el('span', null, 'Use git worktree'));
  const wtField = el('div', 'field');
  wtField.appendChild(wtWrap);
  form.appendChild(wtField);

  // devUrl
  const devIn = mkInput('f_devurl', 'text', p ? p.devUrl : '', 'http://localhost:3000');
  form.appendChild(inputRow('Dev URL (optional)', devIn));

  // tracker.team
  const teamIn = mkInput('f_team', 'text', p && p.tracker ? p.tracker.team : '', '');
  form.appendChild(inputRow(
    'Tracker team (optional)',
    teamIn,
    'The Linear team to pull tickets from — its key/prefix, e.g. MIL. Leave blank to include all teams in this workspace.',
  ));

  // tracker.simpleLabel
  const labelIn = mkInput('f_label', 'text', p && p.tracker ? p.tracker.simpleLabel : '', td.simpleLabel || '');
  form.appendChild(inputRow(
    'Tracker label (optional)',
    labelIn,
    'Only tickets with this label are handled — your on/off switch (e.g. ai-loop). Add the label in Linear to opt a ticket in.',
  ));

  // tracker.states
  const statesPlaceholder = Array.isArray(td.states) ? td.states.join(', ') : '';
  const statesVal = p && p.tracker && Array.isArray(p.tracker.states) ? p.tracker.states.join(', ') : '';
  const statesIn = mkInput('f_states', 'text', statesVal, statesPlaceholder);
  form.appendChild(inputRow(
    'Tracker states (comma-separated, optional)',
    statesIn,
    'Only tickets in these workflow states are eligible, comma-separated (e.g. Todo, Backlog).',
  ));

  // exclude
  const excl = el('textarea', 'input textarea');
  excl.id = 'f_exclude';
  excl.rows = 3;
  excl.placeholder = 'node_modules/**\ndist/**';
  if (p && Array.isArray(p.exclude)) excl.value = p.exclude.join('\n');
  form.appendChild(inputRow(
    'Exclude globs (one per line)',
    excl,
    'File-path patterns the agent must NEVER edit — a hard safety rail. If a change would touch any of these, the run is blocked before a PR is opened. One per line, e.g. **/migrations/**, **/*auth*.',
  ));

  // ---- Steps: per-step instructions (prominent, always visible) ----
  const stepsSection = el('div', 'steps-section');
  stepsSection.appendChild(el('h3', 'steps-title', 'Steps'));
  stepsSection.appendChild(el(
    'div',
    'field-help muted steps-intro',
    "Each step is run by the model using an instruction. Review the defaults and customize any that don't fit your project.",
  ));

  const pStages = (p && p.stages) || {};
  const gStages = g.stages || {};
  stageOrder.forEach((stage) => {
    const cur = pStages[stage] || {};
    const block = el('div', 'stage-config');

    // name + an Enabled toggle (reflects the effective state: project override,
    // else the global default — deploy-dev / verify-dev default OFF).
    const head = el('div', 'stage-config-head');
    head.appendChild(el('div', 'stage-config-name', stage));
    const globalEnabled = gStages[stage] ? gStages[stage].enabled !== false : true;
    const effEnabled = cur.enabled !== undefined ? cur.enabled : globalEnabled;
    const enWrap = el('label', 'stage-enable');
    const enCb = el('input');
    enCb.type = 'checkbox';
    enCb.id = 'f_stage_enabled_' + stage;
    enCb.dataset.stage = stage;
    enCb.checked = effEnabled;
    enWrap.appendChild(enCb);
    enWrap.appendChild(el('span', null, 'Enabled'));
    head.appendChild(enWrap);
    block.appendChild(head);

    // read-only default instruction
    const defWrap = el('div', 'stage-default');
    defWrap.appendChild(el('span', 'stage-default-label muted', 'Default:'));
    defWrap.appendChild(el('div', 'stage-default-text muted', defaults[stage] || '(none)'));
    block.appendChild(defWrap);

    // model + effort dropdowns on their own row (above the override textarea)
    const pickRow = el('div', 'stage-pick-row');

    const modelSel = el('select', 'input stage-model');
    modelSel.id = 'f_stage_model_' + stage;
    modelSel.dataset.stage = stage;
    const modelInherit = el('option', null, '(inherit default)');
    modelInherit.value = '';
    modelSel.appendChild(modelInherit);
    const models = Array.isArray(cfg.models) ? cfg.models : [];
    let modelMatched = false;
    models.forEach((m) => {
      const o = el('option', null, m.label);
      o.value = m.value;
      if (cur.model && cur.model === m.value) {
        o.selected = true;
        modelMatched = true;
      }
      modelSel.appendChild(o);
    });
    // preserve a stored custom/unknown model id not present in the list
    if (cur.model && !modelMatched) {
      const o = el('option', null, cur.model);
      o.value = cur.model;
      o.selected = true;
      modelSel.appendChild(o);
    }
    const modelLbl = el('label', 'stage-pick');
    modelLbl.appendChild(el('span', 'stage-pick-label muted', 'Model'));
    modelLbl.appendChild(modelSel);
    pickRow.appendChild(modelLbl);

    const effortSel = el('select', 'input stage-effort');
    effortSel.id = 'f_stage_effort_' + stage;
    effortSel.dataset.stage = stage;
    const effortInherit = el('option', null, '(inherit default)');
    effortInherit.value = '';
    effortSel.appendChild(effortInherit);
    const efforts = Array.isArray(cfg.efforts) ? cfg.efforts : [];
    efforts.forEach((ef) => {
      const o = el('option', null, ef);
      o.value = ef;
      if (cur.effort === ef) o.selected = true;
      effortSel.appendChild(o);
    });
    const effortLbl = el('label', 'stage-pick');
    effortLbl.appendChild(el('span', 'stage-pick-label muted', 'Thinking effort'));
    effortLbl.appendChild(effortSel);
    pickRow.appendChild(effortLbl);

    block.appendChild(pickRow);

    // optional override
    block.appendChild(el('div', 'stage-override-label muted', 'Your override'));
    const instr = el('textarea', 'input textarea stage-instr');
    instr.id = 'f_stage_instr_' + stage;
    instr.dataset.stage = stage;
    instr.rows = 2;
    instr.placeholder = 'Leave blank to use the default';
    if (cur.instruction) instr.value = cur.instruction;
    block.appendChild(instr);

    // instruction mode control
    const ctrlRow = el('div', 'stage-ctrl-row');

    const modeSel = el('select', 'input stage-mode');
    modeSel.id = 'f_stage_mode_' + stage;
    modeSel.dataset.stage = stage;
    ['replace', 'append'].forEach((m) => {
      const o = el('option', null, m);
      o.value = m;
      if (cur.instructionMode === m) o.selected = true;
      modeSel.appendChild(o);
    });
    const modeLbl = el('label', 'stage-ctrl');
    modeLbl.appendChild(el('span', 'muted', 'replace / append'));
    modeLbl.appendChild(modeSel);
    ctrlRow.appendChild(modeLbl);

    block.appendChild(ctrlRow);

    stepsSection.appendChild(block);
  });
  form.appendChild(stepsSection);

  form.onsubmit = onFormSubmit;
  $('#formOverlay').hidden = false;
  // focus first editable field
  (name ? repoIn : nameIn).focus();
}

function closeForm() {
  $('#formOverlay').hidden = true;
  setup.editing = null;
}

// ---- folder picker (GET /api/fs) ----
function openFsPicker(targetInput) {
  let cur = null;

  const overlay = el('div', 'overlay fs-overlay');
  const modal = el('div', 'modal fs-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Choose folder');

  const head = el('div', 'modal-head');
  head.appendChild(el('h2', null, 'Choose folder'));
  const closeBtn = el('button', 'icon-btn', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const body = el('div', 'modal-body fs-body');

  const pathRow = el('div', 'fs-path-row');
  const upBtn = el('button', 'btn btn-ghost btn-sm', '⬆ Up');
  upBtn.type = 'button';
  pathRow.appendChild(upBtn);
  const pathText = el('span', 'fs-path mono');
  pathRow.appendChild(pathText);
  const gitHint = el('span', 'fs-git-hint', '✓ git repo');
  gitHint.hidden = true;
  pathRow.appendChild(gitHint);
  body.appendChild(pathRow);

  const errBox = el('div', 'fs-error');
  errBox.hidden = true;
  body.appendChild(errBox);

  const listBox = el('div', 'fs-list');
  body.appendChild(listBox);
  modal.appendChild(body);

  const foot = el('div', 'modal-foot');
  const actions = el('div', 'modal-actions');
  const cancelBtn = el('button', 'btn btn-ghost', 'Cancel');
  cancelBtn.type = 'button';
  const selectBtn = el('button', 'btn', 'Select this folder');
  selectBtn.type = 'button';
  actions.appendChild(cancelBtn);
  actions.appendChild(selectBtn);
  foot.appendChild(actions);
  modal.appendChild(foot);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  async function load(dir) {
    errBox.hidden = true;
    listBox.replaceChildren();
    listBox.appendChild(el('div', 'fs-empty muted', 'Loading…'));
    try {
      const q = dir ? '?path=' + encodeURIComponent(dir) : '';
      const data = await api('/api/fs' + q);
      cur = data.path;
      pathText.textContent = data.path || '';
      gitHint.hidden = !data.isGitRepo;
      upBtn.disabled = data.parent == null;
      upBtn.onclick = () => {
        if (data.parent != null) load(data.parent);
      };
      selectBtn.disabled = !cur;
      listBox.replaceChildren();
      const dirs = Array.isArray(data.dirs) ? data.dirs : [];
      if (!dirs.length) {
        listBox.appendChild(el('div', 'fs-empty muted', 'No subfolders.'));
      } else {
        dirs.forEach((d) => {
          const item = el('button', 'fs-item');
          item.type = 'button';
          item.appendChild(el('span', 'fs-ico', '📁'));
          item.appendChild(el('span', 'fs-name', d.name));
          item.addEventListener('click', () => load(d.path));
          listBox.appendChild(item);
        });
      }
    } catch (e) {
      listBox.replaceChildren();
      errBox.hidden = false;
      errBox.textContent = 'Could not read folder: ' + (e.message || e);
    }
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  selectBtn.addEventListener('click', () => {
    if (cur) targetInput.value = cur;
    close();
  });
  document.addEventListener('keydown', onKey, true);

  load(targetInput.value.trim() || undefined);
}

function buildProjectFromForm() {
  const val = (id) => {
    const n = document.getElementById(id);
    return n ? n.value.trim() : '';
  };
  const proj = {
    name: val('f_name'),
    repoPath: val('f_repo'),
    autonomy: document.getElementById('f_autonomy').value,
    useWorktree: document.getElementById('f_worktree').checked,
  };
  const devUrl = val('f_devurl');
  if (devUrl) proj.devUrl = devUrl;

  const exclude = document.getElementById('f_exclude').value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  proj.exclude = exclude;

  // multi-repo rows → proj.repos (only when the toggle is on and rows are valid)
  const multiEl = document.getElementById('f_multi');
  if (multiEl && multiEl.checked) {
    const repos = [];
    document.querySelectorAll('#f_repos_list .repo-entry').forEach((row) => {
      const name = row.querySelector('.repo-f-name').value.trim();
      const path = row.querySelector('.repo-f-path').value.trim();
      if (!name || !path) return;
      const entry = { name, path };
      const base = row.querySelector('.repo-f-base').value.trim();
      if (base) entry.base = base;
      if (row.querySelector('.repo-f-ro').checked) entry.shipDisabled = true;
      repos.push(entry);
    });
    if (repos.length) proj.repos = repos;
  }

  const tracker = {};
  const team = val('f_team');
  if (team) tracker.team = team;
  const label = val('f_label');
  if (label) tracker.simpleLabel = label;
  const states = val('f_states')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (states.length) tracker.states = states;
  if (Object.keys(tracker).length) proj.tracker = tracker;

  // per-stage overrides — only non-empty
  const stageOrder = (setup.config && setup.config.stageOrder) || STAGE_ORDER;
  const gStages = (setup.config && setup.config.globals && setup.config.globals.stages) || {};
  const stages = {};
  stageOrder.forEach((stage) => {
    const model = val('f_stage_model_' + stage);
    const effort = val('f_stage_effort_' + stage);
    const instrEl = document.getElementById('f_stage_instr_' + stage);
    const instruction = instrEl ? instrEl.value.trim() : '';
    const ov = {};
    if (model) ov.model = model;
    if (effort) ov.effort = effort;
    if (instruction) {
      ov.instruction = instruction;
      const modeEl = document.getElementById('f_stage_mode_' + stage);
      ov.instructionMode = modeEl ? modeEl.value : 'replace';
    }
    // Emit `enabled` only when it differs from the global default, so we don't
    // bloat every stage — but a deliberate on/off (e.g. deploy-dev on) persists.
    const enEl = document.getElementById('f_stage_enabled_' + stage);
    if (enEl) {
      const globalEnabled = gStages[stage] ? gStages[stage].enabled !== false : true;
      if (enEl.checked !== globalEnabled) ov.enabled = enEl.checked;
    }
    if (Object.keys(ov).length) stages[stage] = ov;
  });
  if (Object.keys(stages).length) proj.stages = stages;

  return proj;
}

function setFormError(msg) {
  const box = $('#formInlineError');
  if (!msg) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.textContent = msg;
}

async function onFormSubmit(e) {
  e.preventDefault();
  setFormError('');
  const proj = buildProjectFromForm();
  if (!proj.name) return setFormError('Name is required.');
  if (!proj.repoPath) return setFormError('Repo path is required.');
  const multiEl = document.getElementById('f_multi');
  if (multiEl && multiEl.checked && !proj.repos)
    return setFormError('Add at least one repo (name + path), or turn off "multiple repos".');

  const saveBtn = $('#formSave');
  saveBtn.disabled = true;
  try {
    await mutate('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proj),
    });
    closeForm();
    await loadConfig();
    toast('saved');
  } catch (err) {
    setFormError(err.message || 'Save failed.');
  } finally {
    saveBtn.disabled = false;
  }
}

// ---- boot ----
$('#scanBtn').addEventListener('click', doScan);
$('#pauseBtn')?.addEventListener('click', doPauseToggle);
$('#navActivity').addEventListener('click', () => setView('activity'));
$('#navHistory').addEventListener('click', () => setView('history'));
$('#navSetup').addEventListener('click', () => setView('setup'));
$('#addProjectBtn').addEventListener('click', () => openForm(null));
$('#formClose').addEventListener('click', closeForm);
$('#formCancel').addEventListener('click', closeForm);
$('#formOverlay').addEventListener('click', (e) => {
  if (e.target === $('#formOverlay')) closeForm();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#formOverlay').hidden) closeForm();
});

bindHistory();

// Back/forward moves between views and between pages of history results.
globalThis.addEventListener('popstate', () => {
  const { view, params } = parseHash();
  if (view === 'history') readFiltersFromParams(params);
  setView(view, { silent: true });
});

// Boot into whatever the URL fragment asks for (default: Activity).
const boot = parseHash();
if (boot.view === 'history') {
  readFiltersFromParams(boot.params);
  setView('history', { silent: true });
} else if (boot.view === 'setup') {
  setView('setup', { silent: true });
} else {
  poll(); // self-schedules its next tick (fast while live, normal otherwise)
}
