// Workflows view — the step catalog browser and the workflow builder.
//
// Kept out of app.js: it is a self-contained view with its own state, and
// app.js is already the biggest file here. It talks to /api/catalog/* and
// re-compiles on EVERY edit, so what you see is always the plan that would
// actually run, not the draft you hope it is.

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch (_e) { /* no body */ }
  if (body && body.error) throw new Error(body.error);
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return body || {};
}
const post = (path, data) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

const state = {
  catalog: null,
  selected: null,      // { kind: 'workflow'|'step', ref }
  draft: null,         // an unsaved workflow being edited
  draftBase: null,     // the ref it was cloned from
  project: '',         // compile against this project's policy
  preview: null,
};

// ---- loading ---------------------------------------------------------------

async function load() {
  try {
    state.catalog = await api('/api/catalog');
    if (!state.selected) state.selected = { kind: 'workflow', ref: state.catalog.defaultWorkflow };
    if (!state.project && state.catalog.projects.length) state.project = state.catalog.projects[0].name;
    renderRail();
    renderProjectPicker();
    await renderMain();
    showError('');
  } catch (e) {
    showError(e.message);
  }
}

function showError(msg) {
  const box = $('#wfError');
  box.hidden = !msg;
  box.textContent = msg || '';
}

// ---- left rail -------------------------------------------------------------

function renderRail() {
  const wfList = $('#wfList');
  wfList.replaceChildren();
  for (const wf of state.catalog.workflows) {
    const li = el('li', 'wf-item');
    if (state.selected.kind === 'workflow' && state.selected.ref === wf.ref) li.classList.add('is-active');
    const main = el('div', 'wf-item-main');
    main.append(el('span', 'wf-item-name', wf.name));
    main.append(el('span', 'wf-item-ref', wf.ref));
    li.append(main);
    const tags = el('div', 'wf-item-tags');
    tags.append(el('span', 'tag tag-' + wf.scope, wf.scope));
    if (wf.usedBy.length) tags.append(el('span', 'tag tag-use', wf.usedBy.join(', ')));
    li.append(tags);
    li.addEventListener('click', () => select({ kind: 'workflow', ref: wf.ref }));
    wfList.append(li);
  }

  const stepList = $('#wfStepList');
  stepList.replaceChildren();
  for (const st of state.catalog.steps) {
    const li = el('li', 'wf-item');
    if (state.selected.kind === 'step' && state.selected.ref === st.ref) li.classList.add('is-active');
    const main = el('div', 'wf-item-main');
    main.append(el('span', 'wf-item-name', st.name));
    main.append(el('span', 'wf-item-ref', st.ref));
    li.append(main);
    const tags = el('div', 'wf-item-tags');
    tags.append(el('span', 'tag tag-' + st.scope, st.scope));
    tags.append(el('span', 'tag', st.contract));
    // Anything that reaches outside the worktree is called out in the list, not
    // buried in a detail pane.
    for (const fx of st.capabilities.externalEffects) tags.append(el('span', 'tag tag-effect', fx));
    if (st.capabilities.devOnly) tags.append(el('span', 'tag tag-dev', 'DEV only'));
    li.append(tags);
    li.addEventListener('click', () => select({ kind: 'step', ref: st.ref }));
    stepList.append(li);
  }
}

function renderProjectPicker() {
  const sel = $('#wfProject');
  sel.replaceChildren();
  sel.append(new Option('no project (defaults only)', ''));
  for (const p of state.catalog.projects) {
    const o = new Option(`${p.name} (${p.engine})`, p.name);
    o.selected = p.name === state.project;
    sel.append(o);
  }
}

function select(sel) {
  if (state.draft && !confirm('Discard the unsaved draft?')) return;
  state.draft = null;
  state.draftBase = null;
  state.selected = sel;
  renderRail();
  renderMain();
}

// ---- main pane -------------------------------------------------------------

async function renderMain() {
  const isWorkflow = state.selected.kind === 'workflow' || !!state.draft;
  $('#wfExportBtn').hidden = false;
  $('#wfSaveBtn').hidden = !state.draft;
  $('#wfAssignBtn').hidden = !!state.draft || state.selected.kind !== 'workflow';
  const banner = $('#wfDraftBanner');
  banner.hidden = !state.draft;
  if (state.draft) {
    banner.replaceChildren();
    banner.append(el('b', null, 'Unsaved draft'));
    banner.append(el('span', null,
      ` — cloned from ${state.draftBase}. Published versions are immutable, so saving creates a new version.`));
  }
  if (isWorkflow) return renderWorkflow();
  return renderStep();
}

function findStep(ref) {
  return state.catalog.steps.find((s) => s.ref === ref);
}

// ---- step detail -----------------------------------------------------------

function renderStep() {
  const st = findStep(state.selected.ref);
  if (!st) return;
  $('#wfTitle').textContent = st.name;
  $('#wfSubtitle').textContent = `${st.ref} · ${st.scope}${st.editable ? '' : ' · immutable'}`;
  $('#wfCloneBtn').textContent = 'Clone to edit';
  $('#wfDiagnostics').replaceChildren();

  const body = $('#wfBody');
  body.replaceChildren();
  body.append(el('p', 'wf-desc', st.description));

  const facts = el('div', 'wf-facts');
  const fact = (k, v) => {
    const d = el('div', 'wf-fact');
    d.append(el('span', 'wf-fact-k', k));
    d.append(el('span', 'wf-fact-v', v));
    facts.append(d);
  };
  fact('Contract', st.contract + (st.routeFields.length ? ` (${st.routeFields.join(', ')})` : ''));
  fact('Workspace', st.capabilities.workspace + (st.capabilities.mutatesRepo ? ' · may modify the repo' : ' · read only'));
  fact('Runs', st.capabilities.perRepo === 'once' ? 'once per ticket' : `once per ${st.capabilities.perRepo} repo`);
  fact('On resume', resumeExplain(st.resumePolicy));
  fact('Produces', `${st.produces.key} (${st.produces.type})`);
  if (st.requires.length) fact('Requires', st.requires.join(', '));
  if (st.consumes.length) fact('Uses if present', st.consumes.join(', '));
  if (st.capabilities.externalEffects.length) fact('External effects', st.capabilities.externalEffects.join(', '));
  if (st.capabilities.devOnly) fact('Environment', 'DEV only — hard-pinned, whatever the instruction says');
  if (st.requiresPermissions.length) fact('Needs permission', st.requiresPermissions.join(', '));
  fact('Defaults', [st.defaults.executionProfile, st.defaults.effort, st.defaults.skill ? '+skill:' + st.defaults.skill : '', st.defaults.allowedTools]
    .filter(Boolean).join(' · ') || '—');
  body.append(facts);

  // Permission reality check against the selected project.
  const project = state.catalog.projects.find((p) => p.name === state.project);
  if (project && st.requiresPermissions.length) {
    const missing = st.requiresPermissions.filter((p) => project.permissions[p] !== true);
    if (missing.length) {
      const warn = el('div', 'wf-warn');
      warn.textContent = `Project "${project.name}" has not granted ${missing.join(', ')}, so this step cannot run there. Grant it under Projects.`;
      body.append(warn);
    }
  }

  body.append(el('h3', 'wf-h3', 'Instruction'));
  const ta = el('textarea', 'wf-instruction');
  ta.value = state.draft?.instruction ?? '';
  ta.readOnly = true;
  // The list payload omits the (long) instruction; fetch it on demand.
  api('/api/catalog/step/' + encodeURIComponent(st.ref))
    .then((r) => { ta.value = r.step.instruction; })
    .catch((e) => { ta.value = '(could not load: ' + e.message + ')'; });
  body.append(ta);
}

function resumeExplain(policy) {
  return {
    replay: 'replay — reuse the cached output, no model call',
    rerun: 'rerun — a cached pass is not evidence it still holds',
    revalidate: 'revalidate — external state may have moved',
    idempotent: 'idempotent — will not repeat the same delivery',
  }[policy] || policy;
}

// ---- workflow detail + builder ---------------------------------------------

async function renderWorkflow() {
  const ref = state.draft ? null : state.selected.ref;
  const meta = state.draft || state.catalog.workflows.find((w) => w.ref === ref);
  $('#wfTitle').textContent = meta.name;
  $('#wfSubtitle').textContent = state.draft
    ? 'draft — not saved'
    : `${ref} · ${meta.scope}${meta.usedBy?.length ? ' · used by ' + meta.usedBy.join(', ') : ''}`;
  $('#wfCloneBtn').textContent = 'Clone to edit';

  const preview = await post('/api/catalog/preview', {
    workflow: state.draft || undefined,
    ref: ref || undefined,
    project: state.project || undefined,
  }).catch((e) => ({ error: e.message }));
  state.preview = preview;

  renderDiagnostics(preview);
  const body = $('#wfBody');
  body.replaceChildren();
  if (preview.error) {
    body.append(el('div', 'wf-warn', preview.error));
    return;
  }
  if (meta.description) body.append(el('p', 'wf-desc', meta.description));

  // --- the compiled trace: what would actually run ---
  const head = el('div', 'section-head');
  head.append(el('h3', 'wf-h3', 'Compiled plan'));
  head.append(el('span', 'muted', 'digest ' + preview.digest));
  body.append(head);

  const trace = el('ol', 'wf-trace');
  for (const row of preview.trace) {
    const li = el('li', 'wf-row wf-row-' + row.kind);
    li.style.paddingLeft = 8 + row.depth * 18 + 'px';
    if (!row.enabled) li.classList.add('is-off');
    const top = el('div', 'wf-row-top');
    top.append(el('span', 'wf-row-label', row.label));
    if (!row.enabled) top.append(el('span', 'tag', 'disabled'));
    for (const b of row.badges || []) top.append(el('span', 'tag tag-override', b));
    li.append(top);
    if (row.detail) li.append(el('div', 'wf-row-detail', row.detail));
    for (const p of row.problems) li.append(el('div', 'wf-row-problem', p));
    if (state.draft && (row.kind === 'step' || row.kind === 'loop')) {
      li.classList.add('is-editable');
      li.title = 'Click to edit this node';
      li.addEventListener('click', () => openNodeEditor(row.id, row.kind));
    }
    trace.append(li);
  }
  body.append(trace);

  // --- finally + outcomes: the parts people forget until a ticket goes silent ---
  if (preview.finallyNodes.length) {
    body.append(el('h3', 'wf-h3', 'Final report'));
    const ul = el('ul', 'wf-plain');
    for (const f of preview.finallyNodes)
      ul.append(el('li', null, `${f.id} (${f.ref}) — runs on: ${f.runOn.join(', ')}`));
    body.append(ul);
  }
  body.append(el('h3', 'wf-h3', 'Outcomes'));
  const ul = el('ul', 'wf-plain');
  for (const [cls, m] of Object.entries(preview.outcomes || {})) {
    const extra = m.whenArtifact
      ? ' (' + Object.entries(m.whenArtifact).map(([k, v]) => `${v} once ${k} succeeds`).join(', ') + ')'
      : '';
    ul.append(el('li', null, `${cls} → ${m.default}${extra}`));
  }
  body.append(ul);

  const granted = Object.entries(preview.permissions || {}).filter(([, v]) => v).map(([k]) => k);
  body.append(el('p', 'muted', 'Permissions granted here: ' + (granted.join(', ') || 'none')));
}

function renderDiagnostics(preview) {
  const box = $('#wfDiagnostics');
  box.replaceChildren();
  const diags = preview.diagnostics || [];
  if (preview.error) return;
  if (!diags.length) {
    box.append(el('div', 'wf-diag wf-diag-ok', '✓ valid — this plan can be assigned and run'));
    return;
  }
  for (const d of diags) {
    const row = el('div', 'wf-diag wf-diag-' + d.level);
    row.append(el('b', null, d.level === 'error' ? '✗ ' : '! '));
    row.append(el('span', null, `[${d.code}] ${d.message}`));
    box.append(row);
  }
}

// ---- builder: node editing --------------------------------------------------

/** Walk the draft's phase tree to find a node and its parent list. */
function findNode(id, phases, parent) {
  phases = phases || state.draft.phases;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (p.id === id && (p.step || p.stop || p.branch)) return { node: p, list: phases, index: i };
    if (p.loop) {
      if (p.loop.id === id) return { node: p, list: phases, index: i, isLoop: true };
      const inner = [p.loop.repair, ...(p.loop.gates || [])];
      for (let j = 0; j < inner.length; j++) {
        if (inner[j].id === id) {
          return { node: inner[j], list: j === 0 ? [p.loop.repair] : p.loop.gates, index: j === 0 ? 0 : j - 1, loop: p.loop };
        }
      }
    }
    if (p.branch) {
      for (const list of Object.values(p.branch.cases || {})) {
        const hit = findNode(id, list);
        if (hit) return hit;
      }
      if (Array.isArray(p.branch.default)) {
        const hit = findNode(id, p.branch.default);
        if (hit) return hit;
      }
    }
  }
  return null;
}

const RESULTS = ['pass', 'fail', 'wait', 'skip'];

function openNodeEditor(id, kind) {
  const found = findNode(id);
  if (!found) return;
  const form = $('#nodeForm');
  form.replaceChildren();
  $('#nodeTitle').textContent = 'Edit ' + id;
  $('#nodeInlineError').hidden = true;

  const field = (label, hint) => {
    const wrap = el('div', 'field');
    wrap.append(el('label', null, label));
    if (hint) wrap.append(el('p', 'field-hint', hint));
    form.append(wrap);
    return wrap;
  };

  if (found.isLoop || kind === 'loop') {
    const loop = found.node.loop;
    const it = field('Maximum repair attempts',
      'Each attempt is a full round of model calls. The loop stops here even if the gates never pass.');
    const num = el('input');
    num.type = 'number'; num.min = '1'; num.max = '10'; num.value = String(loop.maxIterations);
    num.name = 'maxIterations';
    it.append(num);

    const np = field('When two attempts produce identical findings',
      'The model is stuck; another identical pass is wasted quota.');
    const sel = el('select'); sel.name = 'noProgress';
    sel.append(new Option('stop the run', 'stop', false, loop.noProgress === 'stop'));
    sel.append(new Option('carry on with what we have', 'exit-loop', false, loop.noProgress === 'exit-loop'));
    np.append(sel);

    form.onsubmit = (e) => {
      e.preventDefault();
      loop.maxIterations = Number(num.value);
      loop.noProgress = sel.value;
      closeNodeEditor();
      renderWorkflow();
    };
  } else {
    const node = found.node;
    const step = findStep(node.step);

    const sw = field('Step', 'Which catalog step this node runs. Versions are pinned on purpose.');
    const stepSel = el('select'); stepSel.name = 'step';
    for (const s of state.catalog.steps)
      stepSel.append(new Option(`${s.name} — ${s.ref}`, s.ref, false, s.ref === node.step));
    sw.append(stepSel);

    const enabledWrap = field('Enabled', 'A disabled node is skipped, and its transitions for "skip" apply.');
    const enabled = el('input'); enabled.type = 'checkbox';
    enabled.checked = node.overrides?.enabled !== false && (step ? step.defaults.enabled !== false : true);
    enabledWrap.append(enabled);

    const transWrap = field('What each result means',
      'A gate that fails must say where the work goes. "wait" means something outside your control — it suspends instead of rewriting the code.');
    const targets = ['next', 'stop', 'suspend', 'continue', 'exit-loop', 'repair'];
    // Any named loop can be a repair target, which is how ship reaches back in.
    for (const row of state.preview?.trace || [])
      if (row.kind === 'loop') targets.push(row.id + '.repair');
    const selects = {};
    for (const r of RESULTS) {
      const line = el('div', 'trans-row');
      line.append(el('span', 'trans-k', r));
      const s = el('select');
      s.append(new Option('(default)', ''));
      for (const t of [...new Set(targets)]) s.append(new Option(t, t, false, node.on?.[r] === t));
      if (node.on?.[r]) s.value = node.on[r];
      selects[r] = s;
      line.append(s);
      transWrap.append(line);
    }

    const insWrap = field('Instruction override',
      'Leave empty to use the step’s own instruction. This is the main knob: tell the model how YOU want this step done.');
    const ta = el('textarea', 'wf-instruction');
    ta.value = node.overrides?.instruction || '';
    insWrap.append(ta);
    const modeSel = el('select');
    modeSel.append(new Option('replace the step instruction', 'replace', false, node.overrides?.instructionMode !== 'append'));
    modeSel.append(new Option('append to the step instruction', 'append', false, node.overrides?.instructionMode === 'append'));
    insWrap.append(modeSel);

    form.onsubmit = (e) => {
      e.preventDefault();
      node.step = stepSel.value;
      node.on = node.on || {};
      for (const r of RESULTS) {
        if (selects[r].value) node.on[r] = selects[r].value;
        else delete node.on[r];
      }
      node.overrides = node.overrides || {};
      if (ta.value.trim()) {
        node.overrides.instruction = ta.value;
        node.overrides.instructionMode = modeSel.value;
      } else {
        delete node.overrides.instruction;
        delete node.overrides.instructionMode;
      }
      const stepDefaultEnabled = findStep(stepSel.value)?.defaults.enabled !== false;
      if (enabled.checked === stepDefaultEnabled) delete node.overrides.enabled;
      else node.overrides.enabled = enabled.checked;
      if (!Object.keys(node.overrides).length) delete node.overrides;
      closeNodeEditor();
      renderWorkflow();
    };
  }
  $('#nodeOverlay').hidden = false;
}

function closeNodeEditor() {
  $('#nodeOverlay').hidden = true;
}

// ---- clone / save ----------------------------------------------------------

/** Point the selected project at the workflow currently shown. */
async function assignSelected() {
  if (state.draft) return showError('Save the draft before assigning it.');
  if (state.selected.kind !== 'workflow') return showError('Select a workflow to assign.');
  if (!state.project) return showError('Choose a project to assign it to.');
  const project = state.catalog.projects.find((p) => p.name === state.project);
  if (!confirm(`Run "${state.selected.ref}" on project "${state.project}"?`)) return;
  try {
    const r = await post('/api/catalog/assign', { project: state.project, ref: state.selected.ref });
    toast(`${state.project} now runs ${state.selected.ref}`);
    if (r.warning) showError(r.warning);
    else showError('');
    await load();
  } catch (e) {
    showError(e.message);
  }
}

async function cloneSelected() {
  try {
    const kind = state.selected.kind;
    const r = await post('/api/catalog/clone', { kind, ref: state.selected.ref });
    if (kind === 'workflow') {
      state.draft = r.draft;
      state.draftBase = state.selected.ref;
      await renderMain();
      toast('Draft created — edit nodes, then save a new version');
    } else {
      // A cloned step is saved straight away: there is nothing to preview, and
      // the instruction is edited in the file or via the API.
      const saved = await post('/api/catalog/save', { kind: 'step', draft: r.draft });
      toast('Saved ' + saved.ref);
      state.selected = { kind: 'step', ref: saved.ref };
      await load();
    }
  } catch (e) {
    showError(e.message);
  }
}

async function saveDraft() {
  try {
    const saved = await post('/api/catalog/save', { kind: 'workflow', draft: state.draft });
    state.draft = null;
    state.draftBase = null;
    state.selected = { kind: 'workflow', ref: saved.ref };
    toast('Saved ' + saved.ref);
    await load();
  } catch (e) {
    showError(e.message);
  }
}

// ---- sharing ---------------------------------------------------------------

function openBundle(title, build) {
  $('#bundleTitle').textContent = title;
  $('#bundleInlineError').hidden = true;
  const body = $('#bundleBody');
  body.replaceChildren();
  build(body);
  $('#bundleOverlay').hidden = false;
}

async function exportSelected() {
  const isWorkflow = state.selected.kind === 'workflow' && !state.draft;
  if (state.draft) return showError('Save the draft before exporting it.');
  try {
    const r = await post('/api/catalog/export', {
      id: state.selected.ref.split('@')[0],
      workflowRefs: isWorkflow ? [state.selected.ref] : [],
      stepRefs: isWorkflow ? [] : [state.selected.ref],
    });
    openBundle('Export bundle', (body) => {
      body.append(el('p', 'muted',
        `${r.manifest.steps.length} step(s), ${r.manifest.workflows.length} workflow(s). ` +
        `Checksum ${r.manifest.checksum.slice(0, 12)}… — the receiving side verifies it.`));
      const ta = el('textarea', 'wf-instruction wf-bundle');
      ta.value = r.yaml;
      ta.readOnly = true;
      body.append(ta);
      const copy = el('button', 'btn btn-ghost btn-sm', 'Copy to clipboard');
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(r.yaml).then(() => toast('Copied'));
      });
      body.append(copy);
    });
    $('#bundleConfirm').hidden = true;
  } catch (e) {
    showError(e.message);
  }
}

function openImport() {
  openBundle('Import a shared bundle', (body) => {
    body.append(el('p', 'muted', 'Paste a bundle. Nothing is written until you have seen what it can do.'));
    const ta = el('textarea', 'wf-instruction wf-bundle');
    ta.id = 'bundlePaste';
    body.append(ta);
    const review = el('button', 'btn btn-sm', 'Review');
    review.addEventListener('click', async () => {
      try {
        const r = await post('/api/catalog/inspect', { yaml: ta.value });
        renderTrust(body, r, ta.value);
      } catch (e) {
        showInlineError(e.message);
      }
    });
    body.append(review);
  });
  $('#bundleConfirm').hidden = true;
}

function renderTrust(body, r, yaml) {
  const old = body.querySelector('.trust');
  if (old) old.remove();
  const box = el('div', 'trust');
  box.append(el('h3', 'wf-h3', `${r.manifest.name} (${r.manifest.id})`));
  box.append(el('p', 'muted', `steps: ${r.manifest.steps.join(', ') || 'none'} · workflows: ${r.manifest.workflows.join(', ') || 'none'}`));
  box.append(el('p', r.trust.checksumOk ? 'trust-ok' : 'trust-bad',
    r.trust.checksumOk ? '✓ checksum verified' : '✗ checksum does not match — this bundle was modified after export'));

  box.append(el('h3', 'wf-h3', 'What it can do on your machine'));
  const ul = el('ul', 'wf-plain');
  if (r.trust.mutating.length) ul.append(el('li', null, 'Modifies repositories: ' + r.trust.mutating.join(', ')));
  for (const e of r.trust.externalEffects) ul.append(el('li', 'trust-effect', `${e.ref} reaches outside the worktree: ${e.effects.join(', ')}`));
  for (const s of r.trust.skills) ul.append(el('li', null, `${s.ref} invokes skill(s): ${s.skills.join(', ')}`));
  for (const t of r.trust.tools) ul.append(el('li', null, `${t.ref} requests tools: ${t.allowedTools}`));
  for (const p of r.trust.requestedPermissions)
    ul.append(el('li', null, `${p.ref} REQUESTS ${p.permissions.join(', ')} — importing does not grant this`));
  if (!ul.children.length) ul.append(el('li', null, 'Nothing beyond reading and reporting.'));
  box.append(ul);
  box.append(el('p', 'muted',
    'Step instructions are handed to a coding agent running with permissions skipped. Read them before accepting.'));
  // The checksum already has its own status line above; repeating it here just
  // makes the reader hunt for the errors that are actually different.
  for (const e of r.trust.errors) {
    if (e.startsWith('checksum')) continue;
    box.append(el('p', 'trust-bad', '✗ ' + e));
  }
  if (r.trust.conflicts.length)
    box.append(el('p', 'muted', 'Already installed, will be left alone: ' + r.trust.conflicts.join(', ')));
  body.append(box);

  const confirm = $('#bundleConfirm');
  confirm.hidden = !!r.trust.errors.length;
  confirm.onclick = async () => {
    try {
      const done = await post('/api/catalog/import', { yaml });
      toast('Imported ' + (done.written.join(', ') || 'nothing new'));
      $('#bundleOverlay').hidden = true;
      await load();
    } catch (e) {
      showInlineError(e.message);
    }
  };
}

function showInlineError(msg) {
  const box = $('#bundleInlineError');
  box.hidden = false;
  box.textContent = msg;
}

function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => (t.hidden = true), 250); }, 2200);
}

// ---- wiring ----------------------------------------------------------------

window.addEventListener('tl:workflows-open', load);
// app.js loads first and may have already switched to this view during boot
// (a #workflows deep link), firing the event before the listener above existed.
// Catch that case by loading now if the view is already showing.
if (!$('#viewWorkflows').hidden) load();
$('#wfProject').addEventListener('change', (e) => {
  state.project = e.target.value;
  renderMain();
});
$('#wfAssignBtn').addEventListener('click', assignSelected);
$('#wfCloneBtn').addEventListener('click', cloneSelected);
$('#wfSaveBtn').addEventListener('click', saveDraft);
$('#wfExportBtn').addEventListener('click', exportSelected);
$('#wfImportBtn').addEventListener('click', openImport);
$('#nodeClose').addEventListener('click', closeNodeEditor);
$('#nodeCancel').addEventListener('click', closeNodeEditor);
$('#bundleClose').addEventListener('click', () => ($('#bundleOverlay').hidden = true));
$('#bundleCancel').addEventListener('click', () => ($('#bundleOverlay').hidden = true));
