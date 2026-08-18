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

function fmtHistoryDate(ms) {
  if (!ms) return 'Unknown date';
  return new Date(ms).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
  expanded: new Set(), // run ids currently expanded (stage detail)
  expandedTickets: new Set(), // ticket keys currently expanded (their run list)
  detailCache: new Map(), // id -> RunRecord (full)
  runsById: new Map(),
  resumable: new Map(), // ticket key -> daemon resume state
  systemPaused: false,
};
const retryPending = new Set();

let lastStatus = null;
let lastActivity = [];
let systemPausePending = null;
const ticketPausePending = new Map();

const OUTCOME_LABELS = {
  answered: 'Answer posted',
  exported: 'Export posted',
  'pr-opened': 'PR ready',
  'pr-opened-with-findings': 'PR needs review',
  deployed: 'Ready on dev',
  partial: 'Partly completed',
  merged: 'Merged',
  skipped: 'No action needed',
  blocked: 'Safety block',
  waiting: 'Waiting',
  paused: 'Paused',
  cancelled: 'Stopped by you',
  failed: 'Needs attention',
  running: 'Running',
};

function outcomeLabel(outcome, blocker) {
  if (outcome === 'waiting') {
    if (blocker?.kind === 'provider') return 'Waiting for model quota';
    if (blocker?.kind === 'approval') return 'Waiting for approval';
    if (blocker?.kind === 'deployment') return 'Waiting for deployment';
    if (blocker?.kind === 'external') return 'Waiting on another system';
  }
  return OUTCOME_LABELS[outcome] || outcome || 'Unknown';
}

function isWaiting(run) {
  return run?.outcome === 'waiting';
}

function waitTitle(blocker) {
  if (blocker?.kind === 'provider') return 'Waiting for model quota';
  if (blocker?.kind === 'deployment') return 'Deployment has not started';
  if (blocker?.kind === 'approval') return 'A person needs to approve the next step';
  return 'An external service is blocking progress';
}

function renderWaitNotice(run, ticketKey) {
  const notice = el('section', 'wait-notice');
  notice.appendChild(el('span', 'wait-notice-mark', '!'));
  const copy = el('div', 'wait-notice-copy');
  const blocker = run.blocker || { kind: 'external', resume: 'manual' };
  copy.appendChild(el('strong', null, waitTitle(blocker)));
  copy.appendChild(el('p', null, blocker.reason || run.summary || run.error || 'The run is waiting for an external condition.'));

  const resumeState = state.resumable.get(ticketKey);
  const actions = el('div', 'wait-notice-actions');
  if (blocker.resume === 'automatic' && resumeState?.canResume) {
    actions.appendChild(el('span', 'wait-notice-legacy', 'Automatic resume'));
    const when = blocker.resumeAt ? ' after ' + fmtClock(blocker.resumeAt) : ' when capacity is available';
    actions.appendChild(el('span', 'wait-notice-help', 'Ticketloop will continue' + when + '.'));
  } else if (resumeState?.canResume) {
    const pending = retryPending.has(ticketKey);
    const resume = el('button', 'btn btn-wait btn-sm', pending ? 'Starting…' : state.systemPaused ? 'Resume all first' : 'Continue run');
    resume.type = 'button';
    resume.disabled = pending || state.systemPaused;
    resume.title = state.systemPaused
      ? 'Ticket processing is paused at the system level'
      : 'Recheck the external step from the saved checkpoint';
    resume.addEventListener('click', (event) => {
      event.stopPropagation();
      doRetry(ticketKey, false);
    });
    actions.appendChild(resume);
    actions.appendChild(el('span', 'wait-notice-help', 'Completed code steps stay saved. The blocking step is checked again.'));
  } else {
    actions.appendChild(el('span', 'wait-notice-legacy', 'No safe checkpoint'));
    actions.appendChild(el(
      'span',
      'wait-notice-help',
      'This older wait lost its checkpoint. Complete the external step manually; do not restart the whole ticket.',
    ));
  }
  copy.appendChild(actions);
  notice.appendChild(copy);
  return notice;
}

let connOk = true;
function setConn(ok) {
  connOk = ok;
  $('#connState').hidden = ok;
}

// ---- rendering: header/status ----
function renderStatus(s) {
  lastStatus = s;
  const paused = systemPausePending == null ? !!s.paused : systemPausePending;
  state.systemPaused = paused;
  state.resumable = new Map((s.resumableTickets || []).map((item) => [item.key, item]));
  $('#statusDot').classList.toggle('running', !!s.running);
  $('#statusDot').classList.toggle('paused', paused);
  $('#statusDot').title = paused ? 'ticket processing paused' : s.running ? 'ticket processing running' : 'ticket processing idle';
  const pauseBtn = $('#pauseBtn');
  if (pauseBtn) {
    const pending = systemPausePending != null;
    pauseBtn.textContent = pending
      ? paused ? 'Pausing…' : 'Resuming…'
      : paused ? '▶ Resume all' : '⏸ Pause all';
    pauseBtn.classList.toggle('is-paused', paused);
    pauseBtn.classList.toggle('is-pending', pending);
    pauseBtn.dataset.paused = paused ? '1' : '';
    pauseBtn.disabled = pending;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.setAttribute('aria-busy', String(pending));
    pauseBtn.title = pending
      ? paused ? 'Sending pause request…' : 'Resuming ticket processing…'
      : paused
        ? 'Resume ticket processing'
        : 'Pause new work now; active steps finish at their next safe boundary';
  }
  renderGlobalPauseState(s, paused);
  const mode = s.authMode === 'api' ? 'API' : 'subscription';
  $('#planBadge').textContent = (s.provider || 'claude') + ' · ' + mode;

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

function renderGlobalPauseState(status, paused) {
  const box = $('#pauseState');
  if (!box) return;
  if (!paused) {
    box.hidden = true;
    return;
  }

  const activeCount = Array.isArray(status.activeRuns) ? status.activeRuns.length : 0;
  const pending = systemPausePending === true;
  const finishing = activeCount > 0;
  $('#pauseStateTitle').textContent = pending || finishing
    ? 'Pause requested'
    : 'Ticket processing is paused';
  $('#pauseStateDetail').textContent = finishing
    ? activeCount + ' active ' + (activeCount === 1 ? 'run is' : 'runs are') + ' finishing the current step. No new tickets will start.'
    : 'No new tickets will start until you resume processing.';
  box.classList.toggle('is-finishing', finishing);
  box.hidden = false;
}

// ---- rendering: quota meter card ----
function renderProviderQuota(snapshot) {
  const node = el('div', 'meter-card');
  node.replaceChildren();
  const head = el('div', 'meter-head');
  const tw = el('span', 'meter-title');
  tw.appendChild(document.createTextNode((snapshot.provider || 'provider').toUpperCase()));
  tw.appendChild(el('span', 'meter-src src-real', snapshot.plan || snapshot.authMode || 'provider'));
  head.appendChild(tw);
  head.appendChild(el('span', 'meter-pct mono', snapshot.limitReached ? 'LIMIT' : ''));
  node.appendChild(head);
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (!windows.length) node.appendChild(el('div', 'meter-resets', 'Usage unknown — no percentage reported'));
  windows.forEach((window) => {
    const pct = Math.max(0, Math.min(100, Math.round(window.usedPercent || 0)));
    const row = el('div', 'meter-window');
    const labels = el('div', 'meter-stats');
    labels.appendChild(el('span', 'label', window.name));
    labels.appendChild(el('span', 'mono', pct + '%'));
    row.appendChild(labels);
    const bar = el('div', 'meter-bar');
    const fill = el('div', 'meter-fill ' + fillClass(pct));
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    const reset = el('div', 'meter-resets', window.resetsAt ? fmtResetsLine(window.resetsAt) : 'Reset time not reported');
    if (window.resetsAt) reset.title = fmtClock(window.resetsAt);
    row.appendChild(reset);
    node.appendChild(row);
  });
  if (snapshot.fetchedAt) {
    const cached = snapshot.source === 'local-cache';
    const origin = cached ? 'Cached from Claude Code' : 'Polled from provider';
    node.appendChild(el('div', 'meter-resets' + (cached ? ' is-stale' : ''), origin + ' · as of ' + fmtRelative(snapshot.fetchedAt)));
  } else {
    node.appendChild(el('div', 'meter-resets is-stale', 'Not polled yet'));
  }
  return node;
}

function renderUsage(u) {
  const grid = $('#quotaGrid');
  grid.replaceChildren();
  (u.providers || []).forEach((snapshot) => grid.appendChild(renderProviderQuota(snapshot)));
}

function appendWhy(main, run) {
  if (run.error) {
    main.appendChild(el('div', 'run-error', run.error));
  } else if (run.summary) {
    main.appendChild(el('div', 'run-why', run.summary));
  }
}

// ---- rendering: stage tracker (compact pills) ----
function renderStageTracker(stages) {
  const wrap = el('div', 'stages');
  // Show only work that actually happened. The old fixed fourteen-step strip
  // made short branches look unfinished and listed nodes a custom workflow did
  // not even contain. Repeated loop nodes keep their latest status.
  const ordered = [];
  const byName = new Map();
  (Array.isArray(stages) ? stages : []).forEach((stage) => {
    if (!stage?.stage) return;
    const name = stage.stage;
    if (!byName.has(name)) ordered.push(name);
    byName.set(name, stage.status);
  });
  ordered.forEach((name) => {
    const status = byName.get(name);
    let cls = 'stage-none';
    if (status === 'ok') cls = 'stage-ok';
    else if (status === 'failed') cls = 'stage-failed';
    else if (status === 'running') cls = 'stage-running';
    else if (status === 'skipped') cls = 'stage-skipped';
    wrap.appendChild(el('span', 'stage-pill ' + cls, name));
  });
  return wrap;
}

// ---- rendering: a TICKET card (the feed's unit) ----
// Runs are grouped under the ticket they serviced, so you track tickets — not a
// scatter of attempt cards — and see how many runs each one took.
function renderTicketGroup(g) {
  const latest = g.runs[0];
  const li = el('li', 'ticket');
  li.dataset.key = g.key;

  const head = el('div', 'run-head');

  const main = el('div', 'run-main');
  const titleLine = el('div', 'run-titleline');
  const ticket = el('a', 'run-ticket', g.ticket || '');
  if (g.ticketUrl) {
    ticket.href = g.ticketUrl;
    ticket.target = '_blank';
    ticket.rel = 'noopener';
    ticket.addEventListener('click', (e) => e.stopPropagation());
  }
  titleLine.appendChild(ticket);
  titleLine.appendChild(el('span', 'run-title', g.ticketTitle || '(untitled)'));
  main.appendChild(titleLine);

  const sub = el('div', 'run-sub');
  if (g.project) sub.appendChild(el('span', null, g.project));
  if (g.autonomy) sub.appendChild(el('span', null, autonomyLabel(g.autonomy)));
  sub.appendChild(el('span', 'run-count', g.runs.length + (g.runs.length === 1 ? ' run' : ' runs')));
  if (latest.resumes) sub.appendChild(el('span', null, '↻ resumed ' + latest.resumes + '×'));
  main.appendChild(sub);

  // At-a-glance: the latest run's progress.
  main.appendChild(renderStageTracker(latest.stages));
  if (isWaiting(latest)) main.appendChild(renderWaitNotice(latest, g.key));
  else appendWhy(main, latest);

  // Resume / Restart act on the TICKET (they continue its latest work).
  if (!isWaiting(latest) && (latest.outcome === 'failed' || latest.outcome === 'paused' || latest.outcome === 'blocked')) {
    const actions = el('div', 'run-actions');
    const resume = el('button', 'btn btn-ghost btn-sm', '▶ Continue run');
    resume.title = 'Continue this run from its checkpoint (already-done steps are reused)';
    resume.addEventListener('click', (e) => { e.stopPropagation(); doRetry(g.key, false); });
    const fresh = el('button', 'btn btn-ghost btn-sm', '↻ Start over');
    fresh.title = 'Discard the checkpoint and start a NEW run under the current workflow';
    fresh.addEventListener('click', (e) => { e.stopPropagation(); doRetry(g.key, true); });
    actions.appendChild(resume);
    actions.appendChild(fresh);
    main.appendChild(actions);
    main.appendChild(el(
      'div',
      'run-action-help muted',
      'Continue run reuses completed steps. Start over discards saved progress and runs the current workflow from the beginning.',
    ));
  }
  head.appendChild(main);

  const side = el('div', 'run-side');
  side.appendChild(el('span', 'badge badge-' + (latest.outcome || 'skipped'), outcomeLabel(latest.outcome, latest.blocker)));
  const metrics = el('div', 'run-metrics');
  metrics.appendChild(el('span', null, fmtTokens(g.totalTokens) + ' tok'));
  metrics.appendChild(el('span', null, fmtMoney(g.costUsd)));
  side.appendChild(metrics);
  const running = latest.outcome === 'running' || !latest.endedAt;
  const timeStr = running ? fmtDuration(latest.startedAt, latest.endedAt) : fmtRelative(latest.endedAt || latest.startedAt);
  const time = el('span', 'run-time', timeStr);
  time.title = 'started ' + fmtClock(latest.startedAt) + (latest.endedAt ? '\nended ' + fmtClock(latest.endedAt) : '');
  side.appendChild(time);
  head.appendChild(side);

  head.addEventListener('click', () => toggleTicket(g.key));
  li.appendChild(head);

  // Expanded: every run for this ticket, newest first.
  if (state.expandedTickets.has(g.key)) {
    const runs = el('ul', 'ticket-runs');
    g.runs.forEach((r) => runs.appendChild(renderRun(r)));
    li.appendChild(runs);
  }
  return li;
}

// ---- rendering: one run row (inside a ticket card) ----
function renderRun(r) {
  const li = el('li', 'run');
  li.dataset.id = r.id;

  const head = el('div', 'run-head');

  // main column
  const main = el('div', 'run-main');
  const sub = el('div', 'run-sub');
  sub.appendChild(el('span', null, fmtClock(r.startedAt)));
  if (r.resumes) sub.appendChild(el('span', null, '↻ resumed ' + r.resumes + '×'));
  main.appendChild(sub);
  main.appendChild(renderStageTracker(r.stages));
  appendWhy(main, r);
  head.appendChild(main);

  // side column
  const side = el('div', 'run-side');
  side.appendChild(el('span', 'badge badge-' + (r.outcome || 'skipped'), outcomeLabel(r.outcome, r.blocker)));
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

  head.addEventListener('click', (e) => { e.stopPropagation(); toggleExpand(r.id); });
  li.appendChild(head);

  if (state.expanded.has(r.id)) {
    li.appendChild(renderDetail(r.id));
  }
  return li;
}

// History needs a complete identity and outcome at a glance. The Activity
// renderer omits those fields because each run sits inside a ticket card.
function renderHistoryRun(r) {
  const li = el('li', 'run history-run');
  li.dataset.id = r.id;
  li.dataset.outcome = r.outcome || 'skipped';

  const head = el('div', 'history-run-head');
  const main = el('div', 'history-run-main');

  const identity = el('div', 'history-run-identity');
  if (r.project) identity.appendChild(el('span', 'history-project', r.project));
  const ticket = el(r.ticketUrl ? 'a' : 'span', 'history-ticket-key', r.ticket || 'Unknown ticket');
  if (r.ticketUrl) {
    ticket.href = r.ticketUrl;
    ticket.target = '_blank';
    ticket.rel = 'noopener';
    ticket.title = 'Open ' + (r.ticket || 'ticket');
  }
  identity.appendChild(ticket);
  main.appendChild(identity);

  main.appendChild(el('h2', 'history-run-title', r.ticketTitle || '(untitled ticket)'));

  const timing = el('div', 'history-run-timing');
  const started = el('time', null, fmtHistoryDate(r.startedAt));
  started.dateTime = new Date(r.startedAt).toISOString();
  timing.appendChild(started);
  timing.appendChild(el('span', null, fmtDuration(r.startedAt, r.endedAt) + ' elapsed'));
  if (r.resumes) timing.appendChild(el('span', null, 'Resumed ' + r.resumes + '×'));
  main.appendChild(timing);

  const summary = r.summary || r.error;
  if (!isWaiting(r) && summary)
    main.appendChild(el('p', 'history-run-summary' + (r.error ? ' is-error' : ''), summary));
  if (isWaiting(r))
    main.appendChild(renderWaitNotice(r, (r.project || '') + ':' + (r.ticket || '')));

  const flow = el('div', 'history-run-flow');
  flow.appendChild(el('span', 'history-flow-label', 'Work'));
  flow.appendChild(renderStageTracker(r.stages));
  main.appendChild(flow);
  head.appendChild(main);

  const side = el('div', 'history-run-side');
  side.appendChild(el('span', 'badge badge-' + (r.outcome || 'skipped'), outcomeLabel(r.outcome, r.blocker)));

  const metrics = el('div', 'history-run-metrics');
  const tokenMetric = el('span');
  tokenMetric.appendChild(el('small', null, 'Tokens'));
  tokenMetric.appendChild(el('strong', null, fmtTokens(r.totalTokens)));
  metrics.appendChild(tokenMetric);
  const costMetric = el('span');
  costMetric.appendChild(el('small', null, 'Cost'));
  costMetric.appendChild(el('strong', null, fmtMoney(r.costUsd)));
  metrics.appendChild(costMetric);
  side.appendChild(metrics);

  const open = state.expanded.has(r.id);
  const expand = el('button', 'history-expand', open ? 'Hide details' : 'View details');
  expand.type = 'button';
  expand.setAttribute('aria-expanded', String(open));
  expand.setAttribute('aria-label', (open ? 'Hide details for ' : 'View details for ') + (r.ticket || 'this run'));
  expand.appendChild(el('span', 'history-expand-arrow', '↓'));
  expand.addEventListener('click', () => toggleExpand(r.id));
  side.appendChild(expand);
  head.appendChild(side);
  li.appendChild(head);

  if (open) li.appendChild(renderDetail(r.id));
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
  if (s.provider || s.model) meta.push([s.provider, s.model].filter(Boolean).join('/'));
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

// Group runs (newest-first) under their ticket, preserving that order both for
// the groups and for the runs inside each group.
function groupByTicket(runs) {
  const groups = new Map();
  for (const r of runs) {
    const key = (r.project || '') + ':' + (r.ticket || '');
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        project: r.project,
        ticket: r.ticket,
        ticketTitle: r.ticketTitle,
        ticketUrl: r.ticketUrl,
        autonomy: r.autonomy,
        totalTokens: 0,
        costUsd: 0,
        runs: [],
      };
      groups.set(key, g);
    }
    g.runs.push(r);
    g.totalTokens += r.totalTokens || 0;
    g.costUsd += r.costUsd || 0;
  }
  return [...groups.values()];
}

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
  groupByTicket(lastRuns).forEach((g) => frag.appendChild(renderTicketGroup(g)));
  feed.replaceChildren(frag);
  window.scrollTo({ top: y });
}

function toggleTicket(key) {
  if (state.expandedTickets.has(key)) state.expandedTickets.delete(key);
  else state.expandedTickets.add(key);
  state.feedSig = '';
  renderFeedFromState();
}

// A cheap signature of what the feed actually displays; if unchanged between
// polls we skip re-rendering entirely (no DOM churn, no scroll disturbance).
function feedSignature(runs, expanded) {
  return (
    [...state.expandedTickets].sort().join(',') +
    '#' +
    runs
      .map(
        (r) =>
          r.id +
          ':' +
          r.outcome +
          ':' +
          (r.totalTokens || 0) +
          ':' +
          (r.resumes || 0) +
          ':' +
          (expanded.has(r.id) ? 'x' : '') +
          ':' +
          (r.stages || []).map((s) => s.stage + s.status).join(','),
      )
      .join('|')
  );
}

function renderActivity(runs) {
  lastRuns = Array.isArray(runs) ? runs : [];
  state.runsById.clear();
  lastRuns.forEach((r) => state.runsById.set(r.id, r));
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

const stopping = new Set();

function renderLiveMonitor(status, activity) {
  const box = $('#liveMonitor');
  status = status || {};
  lastActivity = Array.isArray(activity) ? activity : [];
  const live = isLive(status, activity);
  if (!live && !pauseNote) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  // Parallel runs: one row per active run (one per project). Fall back to the
  // running runs in the activity feed if the daemon didn't report activeRuns.
  const runs = Array.isArray(status.activeRuns) && status.activeRuns.length
    ? status.activeRuns.map((a) => ({ project: a.project, ticket: a.ticket, run: findRunByTicket(activity, a.ticket, a.project) }))
    : (Array.isArray(activity) ? activity : [])
        .filter((r) => r && r.outcome === 'running')
        .map((r) => ({ project: r.project, ticket: r.ticket, run: r }));

  box.replaceChildren();
  if (pauseNote) box.appendChild(el('div', 'live-note', pauseNote));
  if (runs.length > 1) box.appendChild(el('div', 'live-head mono', runs.length + ' running in parallel'));

  const pausedTickets = new Set(Array.isArray(status.pausedTickets) ? status.pausedTickets : []);
  runs.forEach(({ project, ticket, run }) => {
    const step = runningStageName(run) || '…';
    const ticketKey = project + ':' + ticket;
    const pending = ticketPausePending.get(ticketKey);
    const globallyPaused = !!status.paused || systemPausePending === true;
    const pauseRequested = globallyPaused || pausedTickets.has(ticketKey) || pending === true;
    const row = el('div', 'live-row');
    row.classList.toggle('is-pause-requested', pauseRequested);
    const dot = el('span', 'live-dot');
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);
    row.appendChild(el('span', 'live-label', pending === true
      ? 'Pausing…'
      : pending === false
        ? 'Resuming…'
        : pauseRequested ? 'Pause requested' : 'Processing'));
    const who = project && ticket ? project + ' · ' + ticket : project || ticket;
    if (who) row.appendChild(el('span', 'live-ticket', who));
    row.appendChild(el('span', 'live-step-chip', pauseRequested ? 'Finishing ' + step : step));
    const btn = el('button', 'btn btn-ghost btn-sm live-pause', pauseRequested ? 'Cancel pause' : '⏸ Pause');
    btn.disabled = pending != null || globallyPaused;
    btn.title = globallyPaused
      ? 'All ticket processing is paused; use Resume all in the header'
      : pauseRequested
        ? 'Let this ticket continue after its current step'
        : 'Pause this ticket after its current step finishes';
    btn.addEventListener('click', () => doTicketPause(ticketKey, !pauseRequested));
    row.appendChild(btn);

    const stop = el('button', 'btn btn-ghost btn-sm live-stop', stopping.has(ticketKey) ? 'Stopping…' : '✋ Stop');
    stop.disabled = stopping.has(ticketKey);
    stop.title = 'Stop this run immediately, discarding the step in progress';
    stop.addEventListener('click', () => openStopDialog(ticketKey));
    row.appendChild(stop);
    box.appendChild(row);
  });

  box.hidden = false;
}

function openStopDialog(ticketKey) {
  const wrap = el('div', 'overlay');
  const card = el('div', 'modal');

  const head = el('div', 'modal-head');
  head.appendChild(el('h2', null, 'Stop ' + ticketKey + '?'));
  const close = el('button', 'icon-btn', '\u00d7');
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => wrap.remove());
  head.appendChild(close);
  card.appendChild(head);

  const body = el('div', 'modal-body');
  body.appendChild(el('p', 'stop-note',
    'The step running right now is killed and its work is discarded. Any branch or worktree already created is left in place for you to inspect.'));
  const label = el('label', 'stop-check');
  const cb = el('input');
  cb.type = 'checkbox';
  label.appendChild(cb);
  label.appendChild(el('span', null, 'Also never process this ticket again'));
  body.appendChild(label);
  body.appendChild(el('p', 'stop-note',
    'New comments will not wake it. Clear the mark from the "Never processed" list to undo.'));
  card.appendChild(body);

  const foot = el('div', 'modal-foot');
  const actions = el('div', 'modal-actions');
  const cancel = el('button', 'btn btn-ghost', 'Keep running');
  cancel.addEventListener('click', () => wrap.remove());
  const confirm = el('button', 'btn btn-danger', 'Stop now');
  confirm.addEventListener('click', () => {
    wrap.remove();
    doStop(ticketKey, cb.checked);
  });
  actions.appendChild(cancel);
  actions.appendChild(confirm);
  foot.appendChild(actions);
  card.appendChild(foot);

  wrap.appendChild(card);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', esc);
    wrap.remove();
  });
  document.body.appendChild(wrap);
  confirm.focus();
}

async function doStop(ticketKey, ignore) {
  stopping.add(ticketKey);
  renderLiveMonitor(lastStatus || {}, lastActivity);
  try {
    const r = await mutate('/api/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketKey, ignore }),
    });
    toast(r && r.stopped
      ? (ignore ? 'Stopped · will not be processed again' : 'Stopped')
      : (ignore ? 'Marked never-process' : 'Nothing was running for that ticket'));
    await poll();
  } catch (e) {
    toast('Could not stop that ticket');
    setConn(false);
  } finally {
    stopping.delete(ticketKey);
    renderLiveMonitor(lastStatus || {}, lastActivity);
  }
}

async function doUnignore(ticketKey) {
  try {
    await mutate('/api/unignore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketKey }),
    });
    toast(ticketKey + ' will be processed again');
    await poll();
  } catch (e) {
    toast('Could not clear that mark');
    setConn(false);
  }
}

function renderIgnored(status) {
  const box = $('#ignoredBox');
  if (!box) return;
  const marks = Array.isArray(status && status.ignoredTickets) ? status.ignoredTickets : [];
  box.replaceChildren();
  if (!marks.length) {
    box.hidden = true;
    return;
  }
  box.appendChild(el('div', 'ignored-head', 'Never processed (' + marks.length + ')'));
  marks.forEach((m) => {
    const row = el('div', 'ignored-row');
    row.appendChild(el('span', 'ignored-key mono', m.ticketKey));
    if (m.at) row.appendChild(el('span', 'ignored-when', 'since ' + fmtRelative(m.at)));
    if (m.reason) row.appendChild(el('span', 'ignored-reason', m.reason));
    const undo = el('button', 'btn btn-ghost btn-sm', 'Process again');
    undo.addEventListener('click', () => doUnignore(m.ticketKey));
    row.appendChild(undo);
    box.appendChild(row);
  });
  box.hidden = false;
}

// Pause/resume a single ticket; surface the one-per-project warning inline.
async function doTicketPause(ticketKey, paused) {
  if (ticketPausePending.has(ticketKey)) return;
  ticketPausePending.set(ticketKey, paused);
  renderLiveMonitor(lastStatus || {}, lastActivity);
  try {
    const r = await mutate('/api/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused, ticketKey }),
    });
    pauseNote = r && r.warning ? r.warning : '';
    if (lastStatus) {
      const keys = new Set(Array.isArray(lastStatus.pausedTickets) ? lastStatus.pausedTickets : []);
      if (paused) keys.add(ticketKey);
      else keys.delete(ticketKey);
      lastStatus = { ...lastStatus, pausedTickets: [...keys] };
    }
    ticketPausePending.delete(ticketKey);
    renderLiveMonitor(lastStatus || {}, lastActivity);
    toast(paused
      ? 'Pause requested · the current step will finish first'
      : 'Ticket will keep running');
    await poll();
  } catch (e) {
    ticketPausePending.delete(ticketKey);
    renderLiveMonitor(lastStatus || {}, lastActivity);
    toast('Could not change ticket pause state');
    setConn(false);
  }
}

// Resume (fresh=false) or restart-fresh (fresh=true) a resumable ticket now.
async function doRetry(ticketKey, fresh) {
  if (retryPending.has(ticketKey)) return;
  retryPending.add(ticketKey);
  if (activeView === 'history') renderHistoryFeed();
  try {
    await mutate('/api/retry', { method: 'POST', body: JSON.stringify({ ticketKey, fresh }) });
    pauseNote = '';
    toast(fresh ? 'Starting a new run' : 'Continuing from the saved checkpoint');
  } catch (e) {
    pauseNote = e.message || String(e);
    toast(pauseNote);
  } finally {
    retryPending.delete(ticketKey);
    if (activeView === 'history') fetchHistory('filter');
    else await poll();
  }
}

// The running run for a given ticket in the activity feed (for its live stage).
function findRunByTicket(activity, ticket, project) {
  return (Array.isArray(activity) ? activity : []).find((r) =>
    r && r.ticket === ticket && (!project || r.project === project) && r.outcome === 'running',
  ) || null;
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
    renderIgnored(status);
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
  if (!btn || systemPausePending != null) return;
  const paused = btn.dataset.paused === '1';
  const nextPaused = !paused;
  systemPausePending = nextPaused;
  renderStatus(lastStatus || { paused, activeRuns: [] });
  renderLiveMonitor(lastStatus || {}, lastActivity);
  try {
    const result = await mutate('/api/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: nextPaused }),
    });
    systemPausePending = null;
    lastStatus = { ...(lastStatus || {}), paused: !!result.paused };
    renderStatus(lastStatus);
    renderLiveMonitor(lastStatus, lastActivity);
    const activeCount = Array.isArray(lastStatus.activeRuns) ? lastStatus.activeRuns.length : 0;
    toast(nextPaused
      ? activeCount
        ? 'Pause requested · active steps will finish first'
        : 'Ticket processing paused'
      : 'Ticket processing resumed');
    if (activeView === 'history') await fetchHistory('filter');
    else await poll();
  } catch (e) {
    systemPausePending = null;
    renderStatus(lastStatus || { paused, activeRuns: [] });
    renderLiveMonitor(lastStatus || {}, lastActivity);
    toast('Could not change processing state');
    setConn(false);
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
  status: null,
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
    const [data, status] = await Promise.all([
      api('/api/history' + (qs ? '?' + qs : ''), { signal: ctrl.signal }),
      api('/api/status', { signal: ctrl.signal }),
    ]);
    if (seq !== hist.seq) return; // superseded
    hist.runs = Array.isArray(data.runs) ? data.runs : [];
    hist.total = Number(data.total) || 0;
    hist.status = status;
    renderStatus(status);
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
  const filterOpen = !$('#hFilterBody').classList.contains('is-collapsed');
  $('#hFilterToggle').textContent = (filterOpen ? 'Hide filters' : 'Show filters') + (n ? ' (' + n + ')' : '');
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
    const li = el('li', 'run history-run skel');
    const head = el('div', 'history-run-head');
    const main = el('div', 'history-run-main');
    main.appendChild(el('div', 'skel-bar skel-w35'));
    main.appendChild(el('div', 'skel-bar skel-w60'));
    main.appendChild(el('div', 'skel-bar skel-w80'));
    head.appendChild(main);
    const side = el('div', 'history-run-side');
    side.appendChild(el('div', 'skel-bar skel-pill'));
    side.appendChild(el('div', 'skel-bar skel-w80'));
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
  hist.runs.forEach((r) => frag.appendChild(renderHistoryRun(r)));
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
  node.textContent = start.toLocaleString() + '–' + end.toLocaleString() + ' of ' +
    hist.total.toLocaleString() + noun + (hasActiveFilters(f) ? ' found' : '');
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
    const n = document.querySelectorAll('#hChips .filter-chip').length;
    $('#hFilterToggle').textContent = (open ? 'Hide filters' : 'Show filters') + (n ? ' (' + n + ')' : '');
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
const VIEWS = ['activity', 'history', 'setup', 'workflows', 'settings'];
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
  } else if (view === 'workflows') {
    if (!opts.silent) history.replaceState(null, '', '#workflows');
    // The Workflows view owns its own data loading (catalog.js).
    window.dispatchEvent(new CustomEvent('tl:workflows-open'));
  } else if (view === 'setup' || view === 'settings') {
    // Both read the same config payload; each renders only its own section.
    if (!opts.silent) history.replaceState(null, '', '#' + view);
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
  showError($('#setupError'), msg);
}

function setSettingsError(msg) {
  showError($('#settingsError'), msg);
}

function showError(box, msg) {
  if (!box) return;
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
    const [cfg, status] = await Promise.all([api('/api/config'), api('/api/status')]);
    setup.config = cfg;
    setup.status = status;
    setup.pendingDelete = null;
    renderSetup();
  } catch (e) {
    setSetupError('Could not load configuration: ' + e.message);
  }
}

function renderSetup() {
  if (setup.status) renderStatus(setup.status);
  renderSetupRunState();
  renderEnvStrip();
  renderSettings();
  renderProjects();
}

function renderSetupRunState() {
  const box = $('#setupRunState');
  if (!box) return;
  const paused = !!setup.status?.paused;
  box.className = 'setup-run-state ' + (paused ? 'is-paused' : 'is-running');
  box.replaceChildren();
  const copy = el('div');
  copy.appendChild(el('strong', null, paused ? 'Ticket processing is paused' : 'Ticket processing is on'));
  copy.appendChild(el(
    'span',
    'muted',
    paused
      ? 'Projects and workflows can be edited safely. Resume from Activity when you are ready.'
      : 'Eligible tickets may be picked up on the next scan. Pause from Activity before making large setup changes.',
  ));
  box.appendChild(el('span', 'setup-state-dot'));
  box.appendChild(copy);
  const activity = el('button', 'btn btn-ghost btn-sm', paused ? 'Review and resume' : 'Open Activity');
  activity.type = 'button';
  activity.addEventListener('click', () => setView('activity'));
  box.appendChild(activity);
}

// ---- global settings (everything not tied to one project) ----
// auth mode and the server port stay out on purpose: one changes billing, the
// other needs a restart to take effect.
function renderSettings() {
  const box = $('#settingsForm');
  if (!box) return;
  const cfg = setup.config || {};
  const g = cfg.globals || {};
  const loop = g.loop || {};
  const runner = g.runner || {};
  const defaultProvider = runner.defaultProvider || 'claude';
  const providerCfg = (runner.providers && runner.providers[defaultProvider]) || {};
  const td = g.trackerDefaults || {};
  box.replaceChildren();

  // Each group is a card: title + one-line purpose, then an even field grid.
  const group = (title, desc, fields) => {
    const card = el('section', 'settings-card');
    const head = el('div', 'settings-card-head');
    head.appendChild(el('h3', 'settings-card-title', title));
    if (desc) head.appendChild(el('p', 'settings-card-desc muted', desc));
    card.appendChild(head);
    const grid = el('div', 'settings-grid');
    fields.forEach((f) => grid.appendChild(f));
    card.appendChild(grid);
    box.appendChild(card);
  };
  const field = (label, node, help) => {
    const wrap = el('label', 'settings-field');
    wrap.appendChild(el('span', 'settings-label', label));
    wrap.appendChild(node);
    if (help) wrap.appendChild(el('span', 'settings-help muted', help));
    return wrap;
  };
  // A switch reads better than a lone checkbox floating under a label.
  const toggleField = (label, id, checked, help) => {
    const wrap = el('label', 'settings-field');
    wrap.appendChild(el('span', 'settings-label', label));
    // Same label → control → help rhythm as the other fields, so a toggle lines
    // up with its neighbours in the grid instead of floating.
    const row = el('span', 'settings-toggle-row');
    const i = el('input', 'switch');
    i.type = 'checkbox';
    i.id = id;
    i.checked = !!checked;
    const stateText = el('span', 'settings-toggle-state muted', i.checked ? 'On' : 'Off');
    i.addEventListener('change', () => { stateText.textContent = i.checked ? 'On' : 'Off'; });
    row.appendChild(i);
    row.appendChild(stateText);
    wrap.appendChild(row);
    if (help) wrap.appendChild(el('span', 'settings-help muted', help));
    return wrap;
  };
  const numIn = (id, value, min, max, step) => {
    const i = el('input', 'input');
    i.type = 'number';
    i.id = id;
    i.value = value == null ? '' : String(value);
    if (min != null) i.min = String(min);
    if (max != null) i.max = String(max);
    if (step != null) i.step = String(step);
    return i;
  };
  const textIn = (id, value, placeholder) => {
    const i = el('input', 'input');
    i.type = 'text';
    i.id = id;
    i.value = value == null ? '' : String(value);
    if (placeholder) i.placeholder = placeholder;
    return i;
  };
  const selectIn = (id, value, options) => {
    const s = el('select', 'input');
    s.id = id;
    options.forEach((o) => {
      const label = typeof o === 'string' ? o : o.label;
      const v = typeof o === 'string' ? o : o.value;
      const opt = el('option', null, label);
      opt.value = v;
      if (String(value) === String(v)) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  };
  group('Loop', 'How persistently a run retries when a gate fails.', [
    toggleField('Fix-loop enabled', 's_loop_enabled', loop.enabled !== false, 'Off = a single fix pass, no repair loop.'),
    field('Max fix iterations', numIn('s_loop_iters', loop.maxFixIterations, 1, 20), 'How many times a failed gate may send work back to fix.'),
  ]);

  const providerInput = selectIn('s_run_provider', defaultProvider, ['claude', 'codex']);
  const modelChoices = (cfg.models && cfg.models[defaultProvider]) || [];
  const modelInput = selectIn('s_run_model', providerCfg.defaultModel, modelChoices);
  if (providerCfg.defaultModel && ![...modelInput.options].some((o) => o.value === providerCfg.defaultModel)) {
    const custom = el('option', null, providerCfg.defaultModel);
    custom.value = providerCfg.defaultModel;
    custom.selected = true;
    modelInput.appendChild(custom);
  }
  const effortInput = selectIn('s_run_effort', providerCfg.defaultEffort, cfg.efforts || ['low', 'medium', 'high']);
  providerInput.addEventListener('change', () => {
    const choices = (cfg.models && cfg.models[providerInput.value]) || [];
    modelInput.replaceChildren();
    choices.forEach((m) => {
      const o = el('option', null, m.label);
      o.value = m.value;
      modelInput.appendChild(o);
    });
    const nextCfg = runner.providers && runner.providers[providerInput.value];
    if (nextCfg) {
      if (![...modelInput.options].some((o) => o.value === nextCfg.defaultModel)) {
        const custom = el('option', null, nextCfg.defaultModel);
        custom.value = nextCfg.defaultModel;
        modelInput.appendChild(custom);
      }
      modelInput.value = nextCfg.defaultModel;
      effortInput.value = nextCfg.defaultEffort;
    }
  });
  group('Runner', 'Defaults for the coding agent behind every step. Any step can override them.', [
    field('Default provider', providerInput, 'Choose Claude Code or Codex CLI.'),
    field('Default model', modelInput, 'Used by any step that does not set its own.'),
    field('Default effort', effortInput, 'Higher effort = more thinking, more tokens.'),
    field('Permission mode', selectIn('s_run_perm', runner.permissionMode, ['bypass', 'acceptEdits', 'default']), 'bypass lets steps use any tool — safety comes from worktrees + guardrails.'),
    field('Max turns per step', numIn('s_run_turns', runner.maxTurns, 1, 1000), 'Claude-only ceiling; Codex CLI does not expose the same limit.'),
    field('Step timeout (seconds)', numIn('s_run_timeout', runner.stageTimeoutSec, 0, 86400), '0 = no timeout (long coding steps run as long as they need).'),
    field('Idle timeout (seconds)', numIn('s_run_idle_timeout', runner.stageIdleTimeoutSec, 0, 86400), 'Stops a hung stage after no output. The default is 1800 seconds; 0 disables this safeguard.'),
  ]);

  group('Tracker defaults', 'Which tickets the loop picks up. Each project can override these.', [
    field('Poll interval (seconds)', numIn('s_trk_poll', td.pollIntervalSec, 10, 86400), 'Applies after a restart.'),
    field('Opt-in label', textIn('s_trk_label', td.simpleLabel, '(none — all tickets in the states)'), 'Only tickets with this label are considered.'),
    field('States', textIn('s_trk_states', (td.states || []).join(', '), 'Todo, In Review'), 'Comma-separated.'),
  ]);

}

async function saveSettings() {
  const btn = $('#settingsSave');
  const num = (id) => {
    const n = document.getElementById(id);
    if (!n || n.value === '') return undefined;
    const v = Number(n.value);
    return Number.isFinite(v) ? v : undefined;
  };
  const str = (id) => {
    const n = document.getElementById(id);
    return n ? n.value.trim() : undefined;
  };
  const patch = {
    loop: { enabled: document.getElementById('s_loop_enabled').checked, maxFixIterations: num('s_loop_iters') },
    runner: {
      defaultProvider: str('s_run_provider'),
      defaultModel: str('s_run_model'),
      defaultEffort: str('s_run_effort'),
      permissionMode: str('s_run_perm'),
      maxTurns: num('s_run_turns'),
      stageTimeoutSec: num('s_run_timeout'),
      stageIdleTimeoutSec: num('s_run_idle_timeout'),
    },
    tracker: {
      simpleLabel: str('s_trk_label'),
      states: (str('s_trk_states') || '').split(',').map((s) => s.trim()).filter(Boolean),
      pollIntervalSec: num('s_trk_poll'),
    },
  };
  btn.disabled = true;
  try {
    await mutate('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    setSettingsError('');
    await loadConfig();
    toast('settings saved');
  } catch (e) {
    setSettingsError(e.message || 'Could not save settings.');
  } finally {
    btn.disabled = false;
  }
}

function renderEnvStrip() {
  const cfg = setup.config || {};
  const tooling = cfg.tooling || {};
  const g = cfg.globals || {};
  const chips = $('#envChips');
  chips.replaceChildren();
  [['claude', 'claude'], ['codex', 'codex'], ['gh', 'gh'], ['git', 'git']].forEach(([key, label]) => {
    const ok = !!tooling[key];
    const chip = el('span', 'chip ' + (ok ? 'chip-ok' : 'chip-bad'));
    chip.appendChild(el('span', 'chip-mark', ok ? '✓' : '✕'));
    chip.appendChild(el('span', null, label));
    chips.appendChild(chip);
  });

  const provider = (g.runner && g.runner.defaultProvider) || 'claude';
  const auth = (g.runner && g.runner.providers && g.runner.providers[provider] && g.runner.providers[provider].authMode) || '—';
  const pollSec = (g.trackerDefaults && g.trackerDefaults.pollIntervalSec) || '—';
  $('#envMeta').textContent = 'provider = ' + provider + ' · auth = ' + auth + ' · poll every ' + pollSec + 's';
}

function renderProjects() {
  const list = $('#projectList');
  const empty = $('#projectEmpty');
  const projects = (setup.config && setup.config.projects) || [];
  list.replaceChildren();
  if (!projects.length) {
    empty.hidden = false;
    empty.replaceChildren();
    const welcome = el('div', 'onboarding-empty');
    welcome.appendChild(el('span', 'onboarding-kicker', 'Start safely'));
    welcome.appendChild(el('h3', null, 'Connect your first project'));
    welcome.appendChild(el(
      'p',
      'muted',
      'Choose a repository, a workflow, and the Linear tickets Ticketloop may see. The daemon stays paused after setup so you can review everything before the first scan.',
    ));
    const steps = el('div', 'onboarding-promises');
    [
      ['1', 'Your checkout stays clean', 'Code changes run in an isolated git worktree.'],
      ['2', 'Tickets must opt in', 'Only the Linear label and states you choose are scanned.'],
      ['3', 'You stay in control', 'Ticketloop opens a PR; it never merges the first project automatically.'],
    ].forEach(([number, title, copy]) => {
      const item = el('div', 'onboarding-promise');
      item.appendChild(el('span', 'onboarding-number', number));
      const text = el('div');
      text.appendChild(el('strong', null, title));
      text.appendChild(el('span', 'muted', copy));
      item.appendChild(text);
      steps.appendChild(item);
    });
    welcome.appendChild(steps);
    const start = el('button', 'btn onboarding-start', 'Set up first project');
    start.type = 'button';
    start.addEventListener('click', () => openForm(null));
    welcome.appendChild(start);
    empty.appendChild(welcome);
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

function autonomyLabel(a) {
  if (a === 'propose') return 'PR for review';
  if (a === 'gated-merge') return 'May merge low-risk changes';
  return 'Answers only';
}

function workflowSummary(p) {
  if (p.engine !== 'workflow' || !p.workflow) return null;
  const workflow = (setup.config?.workflows || []).find((item) => item.ref === p.workflow);
  const version = String(p.workflow).includes('@') ? 'v' + String(p.workflow).split('@').pop() : '';
  return {
    name: workflow?.id === 'standard' ? 'Standard template' : (workflow?.name || 'Custom workflow'),
    version,
  };
}

function renderProjectCard(p) {
  const card = el('div', 'project-card');

  const head = el('div', 'project-head');
  head.appendChild(el('h3', 'project-name', p.name || '(unnamed)'));
  head.appendChild(el('span', 'badge auto-badge ' + autonomyClass(p.autonomy), autonomyLabel(p.autonomy)));
  const trackerReady = p.resolvedTracker?.type === 'mock' || p.hasKey;
  const workflow = workflowSummary(p);
  const ready = p.repoExists !== false && trackerReady && !!workflow;
  head.appendChild(el('span', 'project-ready ' + (ready ? 'is-ready' : 'needs-setup'), ready ? 'Ready' : 'Needs setup'));
  card.appendChild(head);

  // repo path
  const pathLine = el('div', 'project-path');
  pathLine.appendChild(el('span', 'mono', p.repoPath || '—'));
  if (p.repoExists === false) {
    pathLine.appendChild(el('span', 'path-warn', 'path not found'));
  }
  card.appendChild(pathLine);

  const workflowRow = el('div', 'project-workflow-row');
  const workflowCopy = el('div');
  workflowCopy.appendChild(el('span', 'project-row-label', 'Workflow'));
  if (workflow) {
    workflowCopy.appendChild(el('strong', null, workflow.name));
    if (workflow.version) workflowCopy.appendChild(el('span', 'project-workflow-version', workflow.version));
  } else {
    workflowCopy.appendChild(el('strong', 'project-missing', 'Choose a workflow before running'));
  }
  workflowRow.appendChild(workflowCopy);
  const manageWorkflow = el('button', 'btn btn-ghost btn-sm', workflow ? 'Edit workflow' : 'Choose workflow');
  manageWorkflow.type = 'button';
  manageWorkflow.addEventListener('click', () => {
    setView(workflow ? 'workflows' : 'setup');
    if (workflow) window.dispatchEvent(new CustomEvent('tl:edit-project-workflow', { detail: { project: p.name } }));
    else openForm(p.name);
  });
  workflowRow.appendChild(manageWorkflow);
  card.appendChild(workflowRow);

  // tracker
  const rt = p.resolvedTracker || {};
  const team = rt.team || (p.tracker && p.tracker.team) || '—';
  const label = rt.simpleLabel || '—';
  card.appendChild(el('div', 'project-tracker muted', 'Linear scope · team ' + team + ' · opt-in label ' + label));

  // key status
  const keyRow = el('div', 'key-row');
  const mockTracker = p.resolvedTracker?.type === 'mock';
  if (mockTracker) {
    keyRow.appendChild(el('span', 'key-status key-set', 'No API key needed for mock tickets'));
  } else if (p.hasKey) {
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
  if (!mockTracker) card.appendChild(keyForm);

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
  const isFirstProject = !name && !((setup.config && setup.config.projects) || []).length;
  const p = name ? findProject(name) : (isFirstProject ? setup.firstProjectDraft || null : null);
  setup.firstProject = isFirstProject;
  setup.reviewingFirstProject = false;
  const cfg = setup.config || {};
  const g = cfg.globals || {};
  const td = g.trackerDefaults || {};

  $('#formTitle').textContent = name ? 'Edit project' : (isFirstProject ? 'Set up your first project' : 'Add project');
  $('#formOverlay').classList.toggle('onboarding-overlay', isFirstProject);
  $('#formInlineError').hidden = true;

  const form = $('#projectForm');
  form.replaceChildren();

  if (isFirstProject) {
    const intro = el('div', 'onboarding-intro');
    intro.appendChild(el('span', 'onboarding-step', 'Project setup · 1 of 2'));
    intro.appendChild(el('p', null, 'Connect one repository to one workflow. You can add more projects and tune advanced settings later.'));
    form.appendChild(intro);
  }

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

  // maxParallel — opt this project into working several tickets at once
  const mpIn = mkInput('f_maxparallel', 'number', p && p.maxParallel ? String(p.maxParallel) : '1', '1');
  mpIn.min = '1';
  form.appendChild(inputRow(
    'Max parallel tickets',
    mpIn,
    'How many of THIS project\'s tickets may run at once (default 1). Different projects always run in parallel; raise this to also work several tickets of this project concurrently. Each ticket gets its own worktree, but they share one repo — keep it at 1 if your steps contend (e.g. a verify step that binds a fixed dev-server port).',
  ));

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

  // Workflow assignment is a project-level choice. Step models and
  // instructions live in the visual workflow editor itself.
  const workflowSelect = el('select', 'input');
  workflowSelect.id = 'f_workflow';
  workflowSelect.appendChild(new Option('Choose a workflow…', ''));
  for (const workflow of cfg.workflows || []) {
    const label = workflow.id === 'standard'
      ? 'Standard template'
      : workflow.name;
    workflowSelect.appendChild(new Option(label, workflow.ref));
  }
  // Legacy projects have not actively chosen a visual workflow yet, even if a
  // compatibility pin exists in their config.
  workflowSelect.value = p?.engine === 'workflow' ? p.workflow || '' : '';
  const workflowField = inputRow(
    'Workflow',
    workflowSelect,
    'Choose the visual workflow this project will run. Set up or customize workflows before starting the loop.',
  );
  form.appendChild(workflowField);

  if (isFirstProject) {
    // A real first project uses Linear. The key is stored separately from the
    // YAML config and is never returned to the browser.
    const keyIn = mkInput('f_key', 'password', setup.firstProjectKey || '', 'lin_api_…');
    keyIn.autocomplete = 'off';
    const keyField = inputRow(
      'Linear API key',
      keyIn,
      'Stored only in Ticketloop’s local credential file. The key is not written to ticketloop.config.yml.',
    );

    const safety = el('div', 'onboarding-safety');
    safety.appendChild(el('strong', null, 'The first run will not start yet'));
    safety.appendChild(el('span', 'muted', 'Setup pauses the daemon before saving. Review the project, then resume from Activity when you are ready.'));

    // Keep the first screen focused. Less common controls remain available
    // without forcing every new user to understand them up front.
    const coreIds = new Set(['f_name', 'f_repo', 'f_team', 'f_label', 'f_workflow']);
    const fields = [...form.querySelectorAll(':scope > .field')];
    const advanced = el('details', 'onboarding-advanced');
    advanced.appendChild(el('summary', null, 'Advanced project settings'));
    const advancedBody = el('div', 'onboarding-advanced-body');
    fields.forEach((field) => {
      const control = field.querySelector('input[id], select[id], textarea[id]');
      if (!control || !coreIds.has(control.id)) advancedBody.appendChild(field);
    });
    advanced.appendChild(advancedBody);

    // Put the workflow directly after the repository, followed by the Linear
    // scope and key. This matches the mental setup sequence.
    const repoFieldEl = repoIn.closest('.field');
    if (repoFieldEl) repoFieldEl.after(workflowField);
    form.appendChild(keyField);
    form.appendChild(safety);
    form.appendChild(advanced);
    $('#formSave').textContent = 'Review setup';
  } else {
    $('#formSave').textContent = 'Save';
  }

  if (name && p) {
    const workflowSection = el('div', 'project-workflow-link');
    const copy = el('div');
    copy.appendChild(el('h3', null, 'Workflow'));
    copy.appendChild(el('p', 'field-help muted', 'Create workflows and configure each step’s model and instruction in the visual editor.'));
    const editWorkflow = el('button', 'btn btn-ghost', 'Manage workflows');
    editWorkflow.type = 'button';
    editWorkflow.addEventListener('click', () => {
      closeForm();
      setView('workflows');
      window.dispatchEvent(new CustomEvent('tl:edit-project-workflow', { detail: { project: p.name } }));
    });
    workflowSection.append(copy, editWorkflow);
    form.appendChild(workflowSection);
  }

  form.onsubmit = onFormSubmit;
  $('#formOverlay').hidden = false;
  // focus first editable field
  (name ? repoIn : nameIn).focus();
}

function closeForm() {
  $('#formOverlay').hidden = true;
  $('#formOverlay').classList.remove('onboarding-overlay');
  $('#formSave').textContent = 'Save';
  setup.editing = null;
  setup.reviewingFirstProject = false;
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

  // Only persist maxParallel when it opts into more than the default of 1.
  const mp = parseInt(val('f_maxparallel'), 10);
  if (Number.isFinite(mp) && mp > 1) proj.maxParallel = mp;

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
  if (setup.firstProject) {
    proj.tracker = { ...(proj.tracker || {}), type: 'linear' };
    // The first project is deliberately review-only until the user resumes.
    proj.autonomy = 'propose';
    proj.useWorktree = true;
  }

  // Step settings are edited in Workflows. Preserve existing settings when
  // this form saves unrelated project setup fields.
  const existing = setup.editing ? findProject(setup.editing) : null;
  if (existing?.stages) proj.stages = structuredClone(existing.stages);
  const workflow = val('f_workflow');
  if (workflow) {
    proj.workflow = workflow;
    proj.engine = 'workflow';
  } else if (existing?.engine === 'workflow') {
    // Do not silently turn off an active workflow just because an older client
    // omitted the field. The current form always includes it.
    proj.workflow = existing.workflow;
    proj.engine = existing.engine;
  }

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
  if (setup.reviewingFirstProject) return finishFirstProject();

  const proj = buildProjectFromForm();
  if (!proj.name) return setFormError('Name is required.');
  if (!proj.repoPath) return setFormError('Repo path is required.');
  const multiEl = document.getElementById('f_multi');
  if (multiEl && multiEl.checked && !proj.repos)
    return setFormError('Add at least one repo (name + path), or turn off "multiple repos".');

  if (setup.firstProject) {
    const workflow = document.getElementById('f_workflow')?.value || '';
    const label = document.getElementById('f_label')?.value.trim() || '';
    const key = document.getElementById('f_key')?.value.trim() || '';
    if (!workflow) return setFormError('Choose the workflow this project will run.');
    if (!label) return setFormError('Add an opt-in label so Ticketloop cannot scan every ticket.');
    if (!key) return setFormError('Add the Linear API key for this project.');
    if (!proj.repos) {
      try {
        const folder = await api('/api/fs?path=' + encodeURIComponent(proj.repoPath));
        if (!folder.isGitRepo) return setFormError('Choose a Git repository. The selected folder does not contain .git.');
      } catch (err) {
        return setFormError('Could not check the repository: ' + (err.message || err));
      }
    }
    setup.firstProjectDraft = proj;
    setup.firstProjectKey = key;
    return renderFirstProjectReview(proj);
  }

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

function renderFirstProjectReview(proj) {
  setup.reviewingFirstProject = true;
  $('#formTitle').textContent = 'Review your first project';
  const form = $('#projectForm');
  form.replaceChildren();
  const intro = el('div', 'onboarding-intro');
  intro.appendChild(el('span', 'onboarding-step', 'Project setup · 2 of 2'));
  intro.appendChild(el('h3', null, 'Nothing runs when you save'));
  intro.appendChild(el('p', 'muted', 'Ticketloop will pause first, save this project, and store the Linear key locally. Resume only after checking the project and workflow.'));
  form.appendChild(intro);

  const review = el('dl', 'onboarding-review');
  const row = (term, value) => {
    review.appendChild(el('dt', null, term));
    review.appendChild(el('dd', value && value.startsWith('/') ? 'mono' : null, value || '—'));
  };
  row('Project', proj.name);
  row('Repository', proj.repoPath);
  row('Workflow', proj.workflow);
  row('Linear team', proj.tracker?.team || 'All teams in this workspace');
  row('Opt-in label', proj.tracker?.simpleLabel);
  row('Eligible states', (proj.tracker?.states || setup.config?.globals?.trackerDefaults?.states || []).join(', '));
  row('Change policy', 'Open a PR for review; never auto-merge');
  row('Starts', 'Paused');
  form.appendChild(review);

  const back = el('button', 'btn btn-ghost onboarding-back', '← Back and edit');
  back.type = 'button';
  back.addEventListener('click', () => openForm(null));
  form.appendChild(back);
  $('#formSave').textContent = 'Save paused';
}

async function finishFirstProject() {
  const proj = setup.firstProjectDraft;
  const key = setup.firstProjectKey;
  if (!proj || !key) return setFormError('Setup details were lost. Go back and try again.');
  const saveBtn = $('#formSave');
  saveBtn.disabled = true;
  try {
    // Pause BEFORE adding the live project so the scheduler cannot pick up a
    // ticket between config save and the user’s final review.
    await mutate('/api/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    await mutate('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proj),
    });
    await mutate('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: proj.name, key }),
    });
    setup.firstProjectDraft = null;
    setup.firstProjectKey = '';
    closeForm();
    await loadConfig();
    toast('project saved · daemon paused');
  } catch (err) {
    setFormError((err.message || 'Setup failed.') + ' The daemon remains paused.');
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
$('#navWorkflows').addEventListener('click', () => setView('workflows'));
$('#navSettings').addEventListener('click', () => setView('settings'));
$('#addProjectBtn').addEventListener('click', () => openForm(null));
$('#settingsSave')?.addEventListener('click', saveSettings);
$('#formClose').addEventListener('click', closeForm);
$('#formCancel').addEventListener('click', closeForm);
$('#formOverlay').addEventListener('click', (e) => {
  if (e.target === $('#formOverlay')) closeForm();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#formOverlay').hidden) return closeForm();
  // The Workflows view owns the node drawer, but Escape is a page-level habit.
  for (const id of ['#nodeOverlay']) {
    const o = $(id);
    if (o && !o.hidden) { o.hidden = true; return; }
  }
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
} else if (boot.view === 'setup' || boot.view === 'settings' || boot.view === 'workflows') {
  setView(boot.view, { silent: true });
} else {
  poll(); // self-schedules its next tick (fast while live, normal otherwise)
}
