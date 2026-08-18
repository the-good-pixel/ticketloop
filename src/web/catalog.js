// Workflows view — the step catalog browser and the workflow builder.
//
// Kept out of app.js: it is a self-contained view with its own state, and
// app.js is already the biggest file here. It talks to /api/catalog/* and
// re-compiles on EVERY edit, so what you see is always the plan that would
// actually run, not the draft you hope it is.

import { renderDiagram, findNode as findTreeNode } from './wfdiagram.js';

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
  selectionSource: 'project', // project | template | catalog
  draft: null,         // an unsaved workflow being edited
  draftBase: null,     // the ref it was cloned from
  draftTarget: null,   // template | project — controls naming, save, and assignment
  stepDraft: null,     // an unsaved new version of a catalog step
  stepDraftBase: null, // the published step version it started from
  project: '',         // compile against this project's policy
  preview: null,
  collapsed: new Set(), // branch cases folded away, keyed "<branchId>:<case>"
  zoom: null,           // null = fit to the pane on the next render
  focusCase: null,      // route tab to centre after the diagram is redrawn
};

// ---- loading ---------------------------------------------------------------

async function load() {
  try {
    state.catalog = await api('/api/catalog');
    if (!state.project && state.catalog.projects.length) state.project = state.catalog.projects[0].name;
    const project = currentProject();
    if (!state.selected) {
      state.selected = { kind: 'workflow', ref: project?.workflow || state.catalog.defaultWorkflow };
    }
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

  // Projects are the primary objects people edit. The catalog version is an
  // implementation detail, so show one entry per project rather than every
  // historical version of the standard workflow.
  for (const project of state.catalog.projects) {
    const wf = state.catalog.workflows.find((item) => item.ref === project.workflow);
    const li = el('li', 'wf-item');
    if (state.selectionSource === 'project' && project.name === state.project && state.selected.kind === 'workflow')
      li.classList.add('is-active');
    const main = el('div', 'wf-item-main');
    main.append(el('span', 'wf-item-name', projectName(project.name)));
    main.append(el('span', 'wf-item-ref', wf?.name || 'Standard template'));
    li.append(main);
    const tags = el('div', 'wf-item-tags');
    tags.append(el('span', 'tag tag-use', project.engine === 'workflow' ? 'Custom workflow' : 'Custom instructions'));
    li.append(tags);
    li.addEventListener('click', () => selectProject(project.name));
    wfList.append(li);
  }

  const latestTemplate = latestStandardTemplate();
  if (latestTemplate) {
    const heading = el('li', 'wf-list-label', 'Template');
    wfList.append(heading);
    const li = el('li', 'wf-item wf-template-item');
    if (state.selectionSource === 'template' && state.selected.kind === 'workflow')
      li.classList.add('is-active');
    const main = el('div', 'wf-item-main');
    main.append(el('span', 'wf-item-name', 'Standard template'));
    main.append(el('span', 'wf-item-ref', 'Starting point for a project workflow'));
    li.append(main);
    li.addEventListener('click', () => select({ kind: 'workflow', ref: latestTemplate.ref }, 'template'));
    wfList.append(li);
  }

  const stepList = $('#wfStepList');
  stepList.replaceChildren();
  const availableSteps = latestCatalogSteps();
  $('#wfStepCount').textContent = `${availableSteps.length} available`;
  for (const st of availableSteps) {
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

function projectName(name) {
  if (name.toLowerCase() === 'hkbu') return 'HKBU';
  return name.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function latestStandardTemplate() {
  return state.catalog.workflows
    // A user-edited template is an immutable `standard@N` catalog version too.
    // Keep showing the newest version after it is published; project pins do
    // not move until the user explicitly switches them.
    .filter((workflow) => workflow.id === 'standard')
    .sort((a, b) => b.version - a.version)[0];
}

/** The catalog keeps every immutable version, but normal picking should show
 * the newest version of each reusable step rather than a wall of history. */
function latestCatalogSteps() {
  const latest = new Map();
  for (const step of state.catalog?.steps || []) {
    const prior = latest.get(step.id);
    if (!prior || step.version > prior.version) latest.set(step.id, step);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function selectProject(name) {
  if (hasUnsavedDraft() && !confirm('Discard the unsaved changes and switch project?')) return;
  state.draft = null;
  state.draftBase = null;
  state.draftTarget = null;
  state.stepDraft = null;
  state.stepDraftBase = null;
  state.project = name;
  state.selectionSource = 'project';
  const project = currentProject();
  state.selected = { kind: 'workflow', ref: project?.workflow || state.catalog.defaultWorkflow };
  state.preview = null;
  state.collapsed.clear();
  state.zoom = null;
  renderProjectPicker();
  renderRail();
  renderMain();
}

function renderProjectPicker() {
  const sel = $('#wfProject');
  sel.replaceChildren();
  for (const p of state.catalog.projects) {
    const o = new Option(p.name, p.name);
    o.selected = p.name === state.project;
    sel.append(o);
  }
}

function currentProject() {
  return state.catalog?.projects.find((p) => p.name === state.project);
}

function select(sel, source = 'catalog') {
  if (hasUnsavedDraft() && !confirm('Discard the unsaved changes?')) return;
  state.draft = null;
  state.draftBase = null;
  state.draftTarget = null;
  state.stepDraft = null;
  state.stepDraftBase = null;
  state.selected = sel;
  state.selectionSource = source;
  state.preview = null; // a different workflow folds fresh
  state.collapsed.clear();
  state.zoom = null;
  renderRail();
  renderMain();
}

// ---- main pane -------------------------------------------------------------

async function renderMain() {
  const isWorkflow = state.selected.kind === 'workflow' || !!state.draft;
  const isEditing = !!state.draft || !!state.stepDraft;
  $('#viewWorkflows').classList.toggle('is-editing', !!state.draft);
  document.body.classList.toggle('workflow-editing', !!state.draft);
  $('#wfSaveBtn').hidden = !isEditing;
  $('#wfDiscardBtn').hidden = !isEditing;
  $('#wfCloneBtn').hidden = isEditing;
  $('#wfAssignBtn').hidden = isEditing || state.selected.kind !== 'workflow' || currentProject()?.workflow === state.selected.ref;
  $('#wfAssignBtn').textContent = `Switch ${state.project} to this workflow`;
  $('#wfSaveBtn').textContent = state.stepDraft
    ? 'Save new default'
    : state.draftTarget === 'template'
      ? 'Publish new version'
      : `Save for ${state.project}`;
  $('#wfDiscardBtn').textContent = state.stepDraft ? 'Cancel editing' : 'Discard changes';
  const banner = $('#wfDraftBanner');
  banner.hidden = !isEditing;
  if (state.draft) {
    banner.replaceChildren();
    if (state.draftTarget === 'template') {
      banner.append(el('b', null, 'Editing the standard template'));
      banner.append(el('span', null,
        ` — based on ${friendlyRef(state.draftBase)}. Publishing creates a new template version; projects stay pinned until explicitly switched.`));
    } else {
      banner.append(el('b', null, `Editing for ${state.project || 'project defaults'}`));
      banner.append(el('span', null,
        ` — based on ${friendlyRef(state.draftBase)}. Saving creates a new version and uses it only for ${state.project}.`));
    }
  } else if (state.stepDraft) {
    banner.replaceChildren();
    banner.append(el('b', null, `Editing the default for ${state.stepDraft.name}`));
    banner.append(el('span', null,
      ` — based on ${friendlyRef(state.stepDraftBase)}. Saving publishes a new step version; existing workflows stay pinned until you choose the new version.`));
  }
  if (isWorkflow) return renderWorkflow();
  return renderStep();
}

function friendlyRef(ref) {
  if (!ref) return '';
  const [id, version] = ref.split('@');
  return version ? `${id}, version ${version}` : ref;
}

function findStep(ref) {
  return state.catalog.steps.find((s) => s.ref === ref);
}

function hasUnsavedDraft() {
  return !!state.draft || !!state.stepDraft;
}

// ---- step detail -----------------------------------------------------------

function renderStep() {
  const st = findStep(state.selected.ref);
  if (!st) return;
  const draft = state.stepDraft;
  $('#wfTitle').textContent = draft?.name || st.name;
  $('#wfSubtitle').textContent = draft
    ? `New default based on ${friendlyRef(state.stepDraftBase)} · not saved`
    : `${friendlyRef(st.ref)} · ${st.scope} · published`;
  $('#wfCloneBtn').textContent = 'Edit default instruction';
  $('#wfDiagnostics').replaceChildren();

  const body = $('#wfBody');
  body.replaceChildren();
  body.append(el('p', 'wf-desc', draft?.description || st.description));

  if (draft) {
    const intro = el('div', 'wf-step-edit-intro');
    const marker = el('span', 'wf-step-edit-icon', '✎');
    const words = el('div');
    words.append(el('b', null, 'Set the reusable default instruction'));
    words.append(el('p', null,
      'Workflow steps without a custom instruction use this text. Saving creates a new catalog version so running and published workflows do not change unexpectedly.'));
    intro.append(marker, words);
    body.append(intro);
  }

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

  body.append(el('h3', 'wf-h3', draft ? 'Default instruction' : 'Default instruction'));
  if (draft) {
    const help = el('p', 'wf-field-help',
      'Describe what the agent should do, the important limits, and what a good result looks like. Project workflows can still replace this instruction for one specific node.');
    body.append(help);
  }
  const ta = el('textarea', 'wf-instruction');
  ta.value = draft?.instruction || '';
  ta.readOnly = !draft;
  ta.placeholder = draft ? 'Write the default instruction for this step…' : '';
  if (draft) {
    ta.classList.add('is-editing');
    ta.addEventListener('input', () => { state.stepDraft.instruction = ta.value; });
  } else {
    // The list payload omits the (long) instruction; fetch it on demand.
    api('/api/catalog/step/' + encodeURIComponent(st.ref))
      .then((r) => { ta.value = r.step.instruction; })
      .catch((e) => { ta.value = '(could not load: ' + e.message + ')'; });
  }
  body.append(ta);

  if (draft) {
    const note = el('div', 'wf-version-note');
    note.append(el('b', null, `What happens after saving ${draft.id}@${draft.version}`));
    note.append(el('span', null,
      'The new version becomes the version offered when adding or replacing this step. Existing workflow versions keep their current instruction until edited and saved.'));
    body.append(note);
  }
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
  const firstRender = !state.preview;
  const meta = state.draft || state.catalog.workflows.find((w) => w.ref === ref);
  $('#wfTitle').textContent = state.draft
    ? state.draftTarget === 'template' ? 'Standard template' : meta.name
    : state.selectionSource === 'template'
      ? 'Standard template'
      : `${projectName(state.project)} workflow`;
  $('#wfViewIntro').textContent = state.draftTarget === 'template' || (!state.draft && state.selectionSource === 'template')
    ? 'Edit the shared template to publish a new version. Projects stay on their assigned version until you switch them.'
    : 'Choose a project to view its workflow. Saving an edit creates a new version for that project only.';
  $('#wfSubtitle').textContent = state.draft
    ? state.draftTarget === 'template'
      ? 'Template draft · publishing creates a new immutable version'
      : `Draft for ${state.project} · changes not saved`
    : state.selectionSource === 'project'
      ? `${projectName(state.project)} workflow · includes this project's custom instructions`
      : 'Shared standard template · projects stay pinned to their assigned version';
  $('#wfCloneBtn').textContent = state.selectionSource === 'template'
    ? 'Edit template'
    : `Edit for ${state.project}`;
  $('#wfCloneBtn').title = state.selectionSource === 'template'
    ? 'Create and edit the next immutable standard-template version'
    : `Create and edit a workflow version for ${state.project}`;

  const preview = await post('/api/catalog/preview', {
    workflow: state.draft || undefined,
    ref: ref || undefined,
    project: (state.draft || state.selectionSource === 'project') ? state.project || undefined : undefined,
  }).catch((e) => ({ error: e.message }));
  state.preview = preview;
  const displayTree = preview.tree ? simplifyTriageTree(preview.tree) : [];
  const diagramTree = state.focusCase ? focusCaseTree(displayTree, state.focusCase) : displayTree;

  // Open folded. A workflow with five branch cases side by side is wider than
  // any screen; the shape is what matters first, the detail on demand.
  if (firstRender && !state.collapsed.size) collapseEveryCase(displayTree);

  renderDiagnostics(preview);
  const body = $('#wfBody');
  body.replaceChildren();
  if (preview.error) {
    body.append(el('div', 'wf-warn', preview.error));
    return;
  }
  if (meta.description) body.append(el('p', 'wf-desc', meta.description));

  // --- the diagram: what would actually run ---
  const head = el('div', 'section-head');
  const title = el('div');
  title.append(el('h3', 'wf-h3', state.draft ? 'Editing flow' : 'Workflow map'));
  title.append(el('p', 'wf-canvas-help', state.draft
    ? 'Select any card, route, loop, or ending to edit it.'
    : `Select a route to open it. Choose ${state.selectionSource === 'template' ? 'Edit template' : 'Edit workflow'} to make changes.`));
  head.append(title);
  const tools = el('div', 'wf-diagram-tools');
  const zoomBtn = (label, delta) => {
    const b = el('button', 'btn btn-ghost btn-sm', label);
    b.addEventListener('click', () => {
      state.zoom = Math.min(1.6, Math.max(0.45, Math.round(((state.zoom || 1) + delta) * 20) / 20));
      renderWorkflow();
    });
    return b;
  };
  tools.append(zoomBtn('−', -0.15));
  const pct = el('span', 'muted', state.zoom ? Math.round(state.zoom * 100) + '%' : 'fit');
  tools.append(pct);
  tools.append(zoomBtn('+', 0.15));
  const fitBtn = el('button', 'btn btn-ghost btn-sm', 'Fit');
  fitBtn.addEventListener('click', () => {
    state.zoom = null;
    renderWorkflow();
  });
  tools.append(fitBtn);
  const foldAll = el('button', 'btn btn-ghost btn-sm', state.collapsed.size ? 'Expand all' : 'Collapse branches');
  foldAll.addEventListener('click', () => {
    if (state.collapsed.size) state.collapsed.clear();
    else collapseEveryCase(preview.tree);
    state.zoom = null; // the natural width just changed — refit
    renderWorkflow();
  });
  tools.append(foldAll);
  head.append(tools);
  body.append(head);

  if (state.draft) body.append(routeTabs(displayTree));

  const canvas = el('div', 'wf-canvas');
  body.append(canvas);
  renderDiagram(canvas, diagramTree, {
    editable: !!state.draft,
    panReserve: state.draft ? 460 : 0,
    collapsed: state.collapsed,
    zoom: state.zoom,
    focusCase: state.focusCase,
    onFit: (z) => { pct.textContent = Math.round(z * 100) + '%'; },
    onNode: (id) => (state.draft ? openNodeEditor(id, 'step') : showNodeInfo(id)),
    onLoop: (id) => (state.draft ? openNodeEditor(id, 'loop') : showNodeInfo(id)),
    onInsert: (id) => openInsertEditor(id),
    canInsert: (id) => !!findNode(id)?.list,
    onReplace: (id) => openReplaceEditor(id),
    onRemove: (id) => removeNodeFromCanvas(id),
    canRemove: (id) => canRemoveNode(id),
    onCase: (key) => {
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      state.zoom = null;
      renderWorkflow();
    },
  });
  if (state.draft) enableCanvasPan(canvas);
  body.append(legend());

  renderSystemSteps(body, preview.systemSteps || []);

  if (state.draft) return;

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

/** Locked harness actions are shown with every workflow but never placed in the
 * editable tree: users should understand the real run without being able to
 * remove a safety invariant by accident. */
function renderSystemSteps(body, steps) {
  if (!steps.length) return;
  const section = el('section', 'wf-system-steps');
  const heading = el('div', 'wf-system-head');
  const copy = el('div');
  copy.append(el('span', 'wf-system-eyebrow', 'Always enforced by Ticketloop'));
  copy.append(el('h3', 'wf-h3', 'Worktree lifecycle'));
  heading.append(copy);
  heading.append(el('span', 'tag tag-builtin', `${steps.length} locked system steps`));
  section.append(heading);
  for (const step of steps) {
    const card = el('div', 'wf-system-card');
    const icon = el('span', 'wf-system-icon', step.id === 'create-worktree' ? '+' : '−');
    icon.setAttribute('aria-hidden', 'true');
    const detail = el('div');
    detail.append(el('strong', null, step.name));
    detail.append(el('span', 'wf-system-timing', step.timing));
    detail.append(el('p', null, step.description));
    const outcomeNames = {
      exported: 'export delivered',
      'pr-opened': 'PR opened',
      'pr-opened-with-findings': 'PR opened with findings',
      deployed: 'deployed',
      merged: 'merged',
    };
    const outcomes = step.runOn
      ? el('span', 'wf-system-runs',
          `Runs after: ${step.runOn.map((outcome) => outcomeNames[outcome] || outcome).join(' · ')}`)
      : el('span', 'wf-system-runs', 'Runs once when needed');
    card.append(icon, detail, outcomes);
    section.append(card);
  }
  body.append(section);
}

/** Drag empty canvas space like a design tool. Nodes and controls keep their
 * normal click behavior; the canvas itself becomes the pan surface. */
function enableCanvasPan(canvas) {
  let active = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  const interactive = '[data-node], [data-loop], [data-case], [data-insert], [data-replace], [data-remove]';

  canvas.classList.add('is-pannable');
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest(interactive)) return;
    active = true;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = canvas.scrollLeft;
    startTop = canvas.scrollTop;
    canvas.classList.add('is-panning');
    try { canvas.setPointerCapture(event.pointerId); } catch (_error) { /* synthetic pointer in tests */ }
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!active) return;
    canvas.scrollLeft = startLeft - (event.clientX - startX);
    canvas.scrollTop = startTop - (event.clientY - startY);
    event.preventDefault();
  });
  const stop = (event) => {
    if (!active) return;
    active = false;
    canvas.classList.remove('is-panning');
    try { canvas.releasePointerCapture(event.pointerId); } catch (_error) { /* pointer already released */ }
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
}

function showNodeDrawer(nodeId) {
  $('#nodeOverlay').hidden = false;
  document.body.classList.add('workflow-node-open');
  requestAnimationFrame(() => keepNodeClearOfDrawer(nodeId));
}

/** If a card sits under the drawer, pan just enough to keep the whole card
 * visible. The user can continue dragging from there. */
function keepNodeClearOfDrawer(nodeId) {
  if (!nodeId) return;
  const canvas = $('.wf-canvas');
  const drawer = $('.wf-node-drawer');
  const escaped = CSS.escape(nodeId);
  const target = canvas?.querySelector(`[data-node="${escaped}"], [data-loop="${escaped}"]`);
  if (!canvas || !drawer || !target) return;
  const targetBox = target.getBoundingClientRect();
  const drawerBox = drawer.getBoundingClientRect();
  const safeRight = drawerBox.left - 28;
  if (targetBox.right > safeRight) canvas.scrollLeft += targetBox.right - safeRight;
}

/**
 * Route tabs act like focused views. Once a route is chosen, its sibling
 * columns stay available in the tabs but leave the canvas, giving the active
 * path the centre instead of squeezing it against an edge.
 */
function focusCaseTree(tree, key) {
  const splitAt = key.indexOf(':');
  const branchId = key.slice(0, splitAt);
  const caseName = key.slice(splitAt + 1);
  return tree.map((phase) => {
    if (phase.kind === 'branch') {
      const cases = phase.id === branchId
        ? phase.cases.filter((route) => route.name === caseName)
        : phase.cases.map((route) => ({ ...route, phases: focusCaseTree(route.phases, key) }));
      return { ...phase, cases };
    }
    if (phase.kind === 'loop') {
      return { ...phase, repair: focusCaseTree([phase.repair], key)[0], gates: focusCaseTree(phase.gates, key) };
    }
    return phase;
  });
}

/**
 * Triage emits two internal fields: DECISION handles early exits and KIND
 * chooses the work path. People experience both as one decision, so the
 * editor combines them into one fan-out and omits the invisible no-op exit.
 * Execution still uses the untouched compiled tree in `state.preview`.
 */
function simplifyTriageTree(tree) {
  const decisionIndex = tree.findIndex((phase) => phase.kind === 'branch' && phase.on?.field === 'DECISION');
  const kindIndex = tree.findIndex((phase) => phase.kind === 'branch' && phase.on?.field === 'KIND');
  if (decisionIndex < 0 || kindIndex < 0 || decisionIndex >= kindIndex) return tree;
  const decision = tree[decisionIndex];
  const kind = tree[kindIndex];
  const ineligible = decision.cases.find((route) => route.name === 'ineligible');
  // The compiler exposes the branch's default fallback as a case named
  // "default". Triage can only emit question/data/bug/change, and malformed
  // output already falls back to the Change path. It is execution safety, not
  // a ticket type users can choose, so keep it out of the visual editor.
  const ticketTypes = kind.cases.filter((route) => route.name !== 'default');
  const combined = {
    ...kind,
    compact: true,
    cases: [...(ineligible ? [ineligible] : []), ...ticketTypes],
  };
  const result = tree.filter((_, index) => index !== decisionIndex && index !== kindIndex);
  result.splice(decisionIndex, 0, combined);
  return result;
}

function routeTabs(tree) {
  const box = el('div', 'wf-route-tabs');
  const label = el('span', 'wf-route-label', 'Triage result');
  box.append(label);
  const branches = [];
  const collect = (phases) => {
    for (const phase of phases || []) {
      if (phase.kind === 'branch') {
        branches.push(phase);
        for (const route of phase.cases) collect(route.phases);
      }
      if (phase.kind === 'loop') collect([phase.repair, ...phase.gates]);
    }
  };
  collect(tree);
  const branch = branches.sort((a, b) => b.cases.length - a.cases.length)[0];
  if (!branch) return box;

  const all = el('button', 'wf-route-tab' + (branch.cases.every((route) => !state.collapsed.has(`${branch.id}:${route.name}`)) ? ' is-active' : ''), 'All routes');
  all.type = 'button';
  all.addEventListener('click', () => {
    for (const route of branch.cases) state.collapsed.delete(`${branch.id}:${route.name}`);
    state.focusCase = null;
    renderWorkflow();
  });
  box.append(all);
  for (const [index, route] of branch.cases.entries()) {
    const key = `${branch.id}:${route.name}`;
    const active = !state.collapsed.has(key) && branch.cases.filter((item) => !state.collapsed.has(`${branch.id}:${item.name}`)).length === 1;
    const button = el('button', `wf-route-tab wd-route-${routeTone(route.name, index)}` + (active ? ' is-active' : ''), friendlyRoute(route.name));
    button.type = 'button';
    button.addEventListener('click', () => {
      for (const item of branch.cases) state.collapsed.add(`${branch.id}:${item.name}`);
      state.collapsed.delete(key);
      state.focusCase = key;
      renderWorkflow();
    });
    box.append(button);
  }
  const add = el('button', 'wf-route-add', '+ Add path');
  add.type = 'button';
  add.title = 'Add another triage result';
  add.addEventListener('click', () => openNodeEditor(branch.id, 'branch'));
  box.append(add);
  return box;
}

function routeTone(name, index) {
  const known = {
    ineligible: 'rose', question: 'violet', data: 'teal', bug: 'orange', change: 'blue',
  };
  if (known[name]) return known[name];
  const tones = ['blue', 'violet', 'teal', 'orange', 'rose', 'green'];
  return tones[index % tones.length];
}

function friendlyRoute(name) {
  return ({ question: 'Question', data: 'Data request', bug: 'Bug', change: 'Change', default: 'Other' })[name] ||
    name.replace(/[-_]/g, ' ').replace(/^./, (char) => char.toUpperCase());
}

function collapseEveryCase(tree) {
  for (const p of tree) {
    if (p.kind === 'branch') {
      for (const c of p.cases) {
        state.collapsed.add(p.id + ':' + c.name);
        collapseEveryCase(c.phases);
      }
    }
    if (p.kind === 'loop') collapseEveryCase([p.repair, ...p.gates]);
  }
}

function legend() {
  const box = el('div', 'wf-legend');
  const item = (cls, text) => {
    const s = el('span', 'wf-legend-item');
    s.append(el('span', 'wf-swatch ' + cls));
    s.append(el('span', null, text));
    box.append(s);
  };
  item('wd-sw-loop', 'loop — repeats work until a check passes');
  item('wd-sw-effect', 'reaches outside the worktree');
  return box;
}

/** Read-only inspector for a node in a workflow you are not editing. */
function showNodeInfo(id) {
  const n = findTreeNode(state.preview.tree, id);
  if (!n) return;
  const lines = [];
  if (n.kind === 'step') {
    lines.push(`${n.name} — ${n.ref}`, n.detail);
    lines.push('results: ' + Object.entries(n.transitions).map(([r, t]) => `${r} → ${t}`).join(', '));
    if (n.effects.length) lines.push('external effects: ' + n.effects.join(', '));
    if (n.devOnly) lines.push('DEV only — hard-pinned');
    if (n.perRepo !== 'once') lines.push(`runs once per ${n.perRepo} repo`);
    for (const b of n.badges) lines.push(b);
  } else if (n.kind === 'loop') {
    lines.push(`repair loop — up to ${n.maxIterations} attempts, then ${n.noProgress === 'stop' ? 'stop' : 'carry on'}`);
  } else if (n.kind === 'stop') {
    lines.push(`ends the run as ${n.outcome || n.terminal}`, n.reported ? 'the ticket was already replied to here' : 'the final report still runs');
  }
  for (const p of n.problems || []) lines.push(p);
  toast(lines.filter(Boolean).join(' · '));
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

/**
 * Walk the draft's phase tree for a node. Returns the REAL array it lives in
 * and its index, so structural edits mutate the draft rather than a copy.
 * `slot` says what the node is: a phase in a sequence, a loop's gate, or the
 * loop's repair step (which cannot be moved or removed — it is the loop's
 * entry point).
 */
function findNode(id, phases) {
  phases = phases || state.draft.phases;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (p.id === id && (p.step || p.stop || p.branch)) return { node: p, list: phases, index: i, slot: 'phase' };
    if (p.loop) {
      if (p.loop.id === id) return { node: p, list: phases, index: i, slot: 'phase', isLoop: true };
      if (p.loop.repair && p.loop.repair.id === id)
        return { node: p.loop.repair, list: null, index: 0, slot: 'repair', loop: p.loop };
      const gi = (p.loop.gates || []).findIndex((g) => g.id === id);
      if (gi >= 0) return { node: p.loop.gates[gi], list: p.loop.gates, index: gi, slot: 'gate', loop: p.loop };
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

/** A node id that is not already taken anywhere in the draft. */
function freeNodeId(base) {
  let n = base;
  let i = 2;
  while (findNode(n)) n = `${base}-${i++}`;
  return n;
}

function openNodeEditor(id, kind) {
  const found = findNode(id);
  if (!found) {
    showError(`"${id}" is part of the compiled plan but not editable here.`);
    return;
  }
  const form = $('#nodeForm');
  form.replaceChildren();
  $('#nodeTitle').textContent = found.isLoop
    ? 'Loop settings'
    : found.node.branch
      ? 'Triage paths'
      : friendlyNodeName(found.node);
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
  } else if (found.node.branch) {
    const branch = found.node.branch;
    const routesWrap = field('Triage paths',
      'The Triage step must return the exact path name. Open Triage separately if its instruction needs to recognize a new type.');
    const caseRows = el('div', 'wf-case-editor');
    const cases = Object.entries(branch.cases || {}).map(([name, phases]) => ({ name, phases }));
    const drawCases = () => {
      caseRows.replaceChildren();
      cases.forEach((route, index) => {
        const row = el('div', 'wf-case-row');
        const input = el('input');
        input.value = route.name;
        input.setAttribute('aria-label', `Route ${index + 1} name`);
        input.addEventListener('input', () => { route.name = input.value; });
        const count = el('span', 'tag', `${route.phases.length} item${route.phases.length === 1 ? '' : 's'}`);
        const remove = el('button', 'icon-btn', '×');
        remove.type = 'button';
        remove.title = 'Remove route';
        remove.addEventListener('click', () => {
          if (!confirm(`Remove route "${route.name}" and every step inside it?`)) return;
          cases.splice(index, 1);
          drawCases();
        });
        row.append(input, count, remove);
        caseRows.append(row);
      });
    };
    drawCases();
    routesWrap.append(caseRows);
    const addRoute = el('button', 'btn wf-add-route', '+ Add another path');
    addRoute.type = 'button';
    addRoute.addEventListener('click', () => {
      cases.push({
        name: `new-path-${cases.length + 1}`,
        phases: [{
          id: freeNodeId('new-route-end'),
          stop: 'failed',
          note: 'No steps are configured for this triage path yet.',
        }],
      });
      drawCases();
      const inputs = caseRows.querySelectorAll('input');
      const last = inputs[inputs.length - 1];
      last?.focus();
      last?.select();
    });
    routesWrap.append(addRoute);

    form.onsubmit = (e) => {
      e.preventDefault();
      const names = cases.map((route) => route.name.trim());
      if (names.some((name) => !name)) return nodeError('Every route needs a name.');
      if (new Set(names).size !== names.length) return nodeError('Route names must be unique.');
      branch.cases = Object.fromEntries(cases.map((route, index) => [names[index], route.phases]));
      closeNodeEditor();
      state.collapsed.clear();
      state.focusCase = null;
      state.preview = null;
      renderWorkflow();
    };
  } else if (found.node.stop) {
    const node = found.node;
    const endWrap = field('End the run as', 'The final report still runs unless this ending already replied to the ticket.');
    const terminal = el('select');
    for (const value of ['success', 'partial', 'waiting', 'failed', 'skipped', 'blocked']) {
      terminal.append(new Option(value, value, false, node.stop === value));
    }
    endWrap.append(terminal);
    const outcomeWrap = field('Outcome label', 'Optional short label shown in run history.');
    const outcome = el('input'); outcome.value = node.outcome || ''; outcome.placeholder = 'for example: answered';
    outcomeWrap.append(outcome);
    const reportedWrap = field('Ticket already updated', 'Turn on only when an earlier step has already posted the result.');
    const reported = el('input'); reported.type = 'checkbox'; reported.checked = !!node.reported;
    reportedWrap.append(reported);
    const noteWrap = field('Note');
    const note = el('textarea', 'wf-instruction'); note.value = node.note || ''; noteWrap.append(note);
    form.onsubmit = (e) => {
      e.preventDefault();
      node.stop = terminal.value;
      if (outcome.value.trim()) node.outcome = outcome.value.trim(); else delete node.outcome;
      if (note.value.trim()) node.note = note.value.trim(); else delete node.note;
      if (reported.checked) node.reported = true; else delete node.reported;
      closeNodeEditor();
      renderWorkflow();
    };
  } else {
    const node = found.node;
    const step = findStep(node.step);

    const modelWrap = field('Model',
      `Choose the model for this step in the ${projectName(state.project)} workflow.`);
    const modelSel = el('select');
    modelSel.append(new Option('Use the project default', ''));
    const models = state.catalog.models || {};
    for (const [provider, choices] of Object.entries(models)) {
      const group = document.createElement('optgroup');
      group.label = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider;
      for (const choice of choices) {
        const option = new Option(choice.label, `${provider}:${choice.value}`);
        group.append(option);
      }
      modelSel.append(group);
    }
    const currentProvider = node.overrides?.provider || '';
    const currentModel = node.overrides?.model || '';
    const currentValue = currentModel ? `${currentProvider || state.catalog.defaultProvider}:${currentModel}` : '';
    if (currentValue && ![...modelSel.options].some((option) => option.value === currentValue)) {
      modelSel.append(new Option(currentModel, currentValue));
    }
    modelSel.value = currentValue;
    modelWrap.append(modelSel);

    const effortWrap = field('Thinking effort',
      'Higher effort gives the model more room to reason, but usually takes longer.');
    const effortSel = el('select');
    effortSel.append(new Option('Use the project default', ''));
    for (const effort of state.catalog.efforts || []) {
      const label = effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1);
      effortSel.append(new Option(label, effort));
    }
    effortSel.value = node.overrides?.effort || '';
    effortWrap.append(effortSel);

    let passSelect = null;
    let failSelect = null;
    if (step?.contract === 'verdict') {
      const outcomes = field('When the check finishes',
        'Waiting always pauses the workflow. A skipped check always moves on.');
      passSelect = simpleOutcomeSelect(outcomes, 'On success', [
        ['Continue to the next step', 'next'],
        ...(found.loop ? [['Finish this loop', 'exit-loop']] : []),
        ['Stop this path', 'stop'],
      ], node.on?.pass || 'next');
      const failOptions = found.loop
        ? [['Try this loop again', 'repair'], ['Stop this path', 'stop']]
        : [['Stop this path', 'stop'], ...availableLoopTargets()];
      failSelect = simpleOutcomeSelect(outcomes, 'On failure', failOptions, node.on?.fail || 'stop');
    }

    const defaultWrap = field('Default instruction',
      `Read-only instruction from “${step?.name || 'this step'}” in the step library.`);
    const defaultText = el('div', 'wf-default-instruction', 'Loading default instruction…');
    defaultWrap.append(defaultText);
    if (step?.ref) {
      api('/api/catalog/step/' + encodeURIComponent(step.ref))
        .then((result) => {
          if (defaultText.isConnected) defaultText.textContent = result.step.instruction || 'No default instruction.';
        })
        .catch((error) => {
          if (defaultText.isConnected) defaultText.textContent = `Could not load the default instruction: ${error.message}`;
        });
    }

    const insWrap = field('Project customization',
      `Leave empty to use the default. If you add text, the ${projectName(state.project)} workflow uses your version instead; the step-library default stays unchanged.`);
    const ta = el('textarea', 'wf-instruction');
    ta.value = node.overrides?.instruction || '';
    ta.placeholder = 'Add a project-specific instruction…';
    insWrap.append(ta);

    form.onsubmit = (e) => {
      e.preventDefault();
      node.on = node.on || {};
      if (passSelect && failSelect) {
        node.on.pass = passSelect.value;
        node.on.fail = failSelect.value;
        node.on.wait = 'suspend';
        node.on.skip = found.loop && passSelect.value === 'exit-loop' ? 'exit-loop' : 'next';
      }
      node.overrides = node.overrides || {};
      node.overrides.enabled = true;
      if (modelSel.value) {
        const splitAt = modelSel.value.indexOf(':');
        node.overrides.provider = modelSel.value.slice(0, splitAt);
        node.overrides.model = modelSel.value.slice(splitAt + 1);
      } else {
        delete node.overrides.provider;
        delete node.overrides.model;
      }
      if (effortSel.value) node.overrides.effort = effortSel.value;
      else delete node.overrides.effort;
      if (ta.value.trim()) {
        node.overrides.instruction = ta.value;
        node.overrides.instructionMode = 'replace';
      } else {
        delete node.overrides.instruction;
        delete node.overrides.instructionMode;
      }
      if (!Object.keys(node.overrides).length) delete node.overrides;
      closeNodeEditor();
      renderWorkflow();
    };
  }
  showNodeDrawer(id);
}

function simpleOutcomeSelect(host, label, options, value) {
  const row = el('label', 'wf-outcome-row');
  row.append(el('span', null, label));
  const select = el('select');
  for (const [text, target] of options) select.append(new Option(text, target, false, target === value));
  if (![...select.options].some((option) => option.value === value)) select.value = options[0]?.[1] || '';
  row.append(select);
  host.append(row);
  return select;
}

function availableLoopTargets() {
  const loops = (state.preview?.trace || []).filter((row) => row.kind === 'loop');
  return loops.map((loop) => [`Send back to “${friendlyLoopName(loop.id)}”`, `${loop.id}.repair`]);
}

function friendlyLoopName(id) {
  return id.replace(/[-_]/g, ' ').replace(/^./, (char) => char.toUpperCase());
}

function openInsertEditor(id) {
  const found = findNode(id);
  if (!found?.list) return;
  openStepPicker(`Add after ${friendlyNodeName(found.node)}`, found, false);
}

function openReplaceEditor(id) {
  const found = findNode(id);
  if (!found?.node?.step) return;
  openStepPicker(`Replace ${friendlyNodeName(found.node)}`, found, true);
}

function openStepPicker(title, found, replacing) {
  const form = $('#nodeForm');
  form.replaceChildren();
  $('#nodeTitle').textContent = title;
  $('#nodeInlineError').hidden = true;
  const wrap = el('div', 'field wf-step-picker-field');
  wrap.append(el('p', 'field-hint', replacing
    ? 'Choose a replacement. Instructions from the old step will be cleared.'
    : 'Choose a flow control or a catalog step.'));

  const inLoop = !!found.loop;
  // Catalog contracts describe how the engine parses a result, not how the
  // builder should explain the step. Locate emits a route-shaped REUSE value,
  // but every result continues to the next card, so it is work from the user's
  // point of view. Only steps that actually shape the visible graph belong in
  // Flow controls.
  const currentSteps = latestCatalogSteps();
  const routeSteps = currentSteps.filter((step) => step.id === 'triage');
  const workSteps = currentSteps.filter((step) => step.id !== 'triage');
  if (!replacing && !inLoop) {
    const flow = pickerSection(wrap, 'Flow controls', 'Shape how the path runs.');
    pickerChoice(flow, { name: 'Loop', description: 'Repeat work until its checks pass', icon: '↻', contract: 'flow' }, () => {
      found.list.splice(found.index + 1, 0, createLoopNode());
      closeNodeEditor();
      renderWorkflow();
    });
    for (const step of routeSteps) pickerCatalogStep(flow, found, step, replacing);
  } else if (replacing && !inLoop && routeSteps.length) {
    const flow = pickerSection(wrap, 'Flow steps', 'Steps that inspect a ticket and choose what happens next.');
    for (const step of routeSteps) pickerCatalogStep(flow, found, step, true);
  }

  const availableWork = inLoop
    ? workSteps.filter((step) => step.contract === 'verdict' && !step.capabilities.externalEffects.length && !(step.requires || []).length)
    : workSteps;
  if (availableWork.length) {
    const work = pickerSection(wrap, inLoop ? 'Quality checks' : 'Work steps', inLoop
      ? 'A loop repeats when one of these checks fails.'
      : 'Reusable steps from your step catalog.');
    for (const step of availableWork) pickerCatalogStep(work, found, step, replacing);
  }

  form.append(wrap);
  form.onsubmit = (event) => event.preventDefault();
  $('#nodeSave').hidden = true;
  $('#nodeCancel').textContent = 'Close';
  showNodeDrawer(found.node?.id || found.node?.loop?.id);
}

function pickerSection(host, title, hint) {
  const section = el('section', 'wf-picker-section');
  section.append(el('h3', null, title));
  section.append(el('p', null, hint));
  const grid = el('div', 'wf-step-grid');
  section.append(grid);
  host.append(section);
  return grid;
}

function pickerCatalogStep(grid, found, step, replacing) {
  pickerChoice(grid, {
    name: step.name,
    description: stepChoiceDescription(step),
    icon: stepIcon(step),
    contract: step.contract,
  }, () => {
    if (replacing) replaceNodeStep(found, step);
    else found.list.splice(found.index + 1, 0, createStepNode(step, found));
    closeNodeEditor();
    renderWorkflow();
  });
}

function pickerChoice(grid, choice, onChoose) {
    const button = el('button', `wf-step-choice wd-choice-${choice.contract}`);
    button.type = 'button';
    button.className = `wf-step-choice wd-choice-${choice.contract}`;
    button.append(el('span', 'wf-step-choice-icon', choice.icon));
    const words = el('span');
    words.append(el('b', null, choice.name));
    words.append(el('small', null, choice.description));
    button.append(words);
    button.addEventListener('click', onChoose);
    grid.append(button);
}

function createStepNode(step, found) {
  return {
    id: freeNodeId(step.id),
    step: step.ref,
    on: step.contract === 'verdict'
      ? { pass: found.loop ? 'exit-loop' : 'next', fail: found.loop ? 'repair' : 'stop', wait: 'suspend', skip: found.loop ? 'exit-loop' : 'next' }
      : { pass: 'next' },
    overrides: { enabled: true },
  };
}

function replaceNodeStep(found, step) {
  found.node.step = step.ref;
  found.node.on = createStepNode(step, found).on;
  found.node.overrides = { enabled: true };
}

function createLoopNode() {
  const currentSteps = latestCatalogSteps();
  const repairStep = currentSteps.find((step) => step.id === 'fix') ||
    currentSteps.find((step) => step.contract === 'text');
  const gateStep = currentSteps.find((step) => step.id === 'verify') ||
    currentSteps.find((step) => step.contract === 'verdict');
  if (!repairStep || !gateStep) throw new Error('A loop needs at least one work step and one quality check in the catalog.');
  return {
    loop: {
      id: freeNodeId('work-loop'),
      repair: {
        id: freeNodeId('loop-work'),
        step: repairStep.ref,
        on: { pass: 'next' },
        overrides: { enabled: true },
      },
      gates: [{
        id: freeNodeId('loop-check'),
        step: gateStep.ref,
        on: { pass: 'exit-loop', fail: 'repair', wait: 'suspend', skip: 'exit-loop' },
        overrides: { enabled: true },
      }],
      maxIterations: 3,
      noProgress: 'stop',
    },
  };
}

function removeNodeFromCanvas(id) {
  const found = findNode(id);
  if (!found?.list) return;
  if (found.slot === 'gate' && found.loop?.gates.length <= 1) {
    return toast('A loop needs at least one quality check');
  }
  if (!confirm(`Remove “${friendlyNodeName(found.node)}” from this path?`)) return;
  found.list.splice(found.index, 1);
  closeNodeEditor();
  state.zoom = null;
  renderWorkflow();
}

function canRemoveNode(id) {
  const found = findNode(id);
  if (!found?.list) return false;
  return !(found.slot === 'gate' && found.loop?.gates.length <= 1);
}

function friendlyNodeName(node) {
  if (node.step) return findStep(node.step)?.name || node.id;
  if (node.stop) return 'ending';
  if (node.loop) return 'loop';
  if (node.branch) return 'route';
  return node.id || 'item';
}

function stepIcon(step) {
  if (step.capabilities.externalEffects.length) return '↗';
  return ({ route: '⑂', verdict: '✓', post: '↥', text: '•', artifact: '◆' })[step.contract] || '•';
}

function stepChoiceDescription(step) {
  if (step.capabilities.externalEffects.length) return 'Connects to an outside service';
  if (step.id === 'locate') return 'Checks whether this ticket already has a PR';
  return ({ route: 'Chooses what happens next', verdict: 'Checks the work before continuing', post: 'Updates the ticket', text: 'Does a piece of work', artifact: 'Creates an output' })[step.contract] || 'Workflow step';
}

function nodeError(message) {
  const box = $('#nodeInlineError');
  box.hidden = false;
  box.textContent = message;
}

function closeNodeEditor() {
  $('#nodeOverlay').hidden = true;
  document.body.classList.remove('workflow-node-open');
  $('#nodeSave').hidden = false;
  $('#nodeCancel').textContent = 'Cancel';
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
    const r = await post('/api/catalog/assign', { project: state.project, ref: state.selected.ref, engine: 'workflow' });
    state.selectionSource = 'project';
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
    const editingTemplate = kind === 'workflow' && state.selectionSource === 'template';
    const currentRef = currentProject()?.workflow || '';
    const currentId = currentRef.split('@')[0];
    const newId = kind === 'workflow'
      ? editingTemplate
        ? state.selected.ref.split('@')[0]
        : (currentId && currentId !== 'standard' && state.selected.ref === currentRef ? currentId : state.project)
      : undefined;
    const r = await post('/api/catalog/clone', {
      kind,
      ref: state.selected.ref,
      newId,
      project: editingTemplate ? undefined : state.project,
    });
    if (kind === 'workflow') {
      state.draft = r.draft;
      state.draftTarget = editingTemplate ? 'template' : 'project';
      state.draft.name = editingTemplate ? 'Standard dev cycle' : `${projectName(state.project)} workflow`;
      if (!editingTemplate) enableWiredSteps(state.draft);
      state.draftBase = state.selected.ref;
      // The full-screen editor should open at a comfortable reading size.
      // Wide workflows remain reachable by scrolling the canvas.
      state.zoom = 1.1;
      await renderMain();
      toast(editingTemplate
        ? `Editing ${friendlyRef(state.selected.ref)} as a new template version`
        : `Editing a private draft for ${state.project}`);
    } else {
      state.stepDraft = r.draft;
      state.stepDraftBase = state.selected.ref;
      await renderMain();
      requestAnimationFrame(() => document.querySelector('.wf-instruction.is-editing')?.focus());
      toast(`Editing the default for ${r.draft.name}`);
    }
  } catch (e) {
    showError(e.message);
  }
}

function enableWiredSteps(workflow) {
  const visitStep = (node) => {
    node.overrides = { ...(node.overrides || {}), enabled: true };
  };
  const visit = (phases) => {
    for (const phase of phases || []) {
      if (phase.step) visitStep(phase);
      if (phase.loop) {
        visitStep(phase.loop.repair);
        for (const gate of phase.loop.gates || []) visitStep(gate);
      }
      if (phase.branch) {
        for (const route of Object.values(phase.branch.cases || {})) visit(route);
        if (Array.isArray(phase.branch.default)) visit(phase.branch.default);
      }
    }
  };
  visit(workflow.phases);
  for (const node of workflow.finally || []) visitStep(node);
}

async function saveDraft() {
  if (state.stepDraft) return saveStepDraft();
  let saved = null;
  const editingTemplate = state.draftTarget === 'template';
  try {
    saved = await post('/api/catalog/save', {
      kind: 'workflow',
      draft: state.draft,
      project: editingTemplate ? undefined : state.project,
    });
    if (!editingTemplate && state.project) {
      // Saving from the visual editor is the explicit point where a project
      // opts into the workflow interpreter. Existing stage settings continue
      // to supply the project's provider, model and instruction overrides.
      await post('/api/catalog/assign', { project: state.project, ref: saved.ref, engine: 'workflow' });
    }
    state.draft = null;
    state.draftBase = null;
    state.draftTarget = null;
    state.selected = { kind: 'workflow', ref: saved.ref };
    state.selectionSource = editingTemplate ? 'template' : 'project';
    closeNodeEditor();
    toast(editingTemplate
      ? `Published ${saved.ref}; project assignments were not changed`
      : `Saved and applied to ${state.project}`);
    await load();
  } catch (e) {
    // Saving and assigning are separate server operations. If project policy
    // refuses the assignment, do not leave a stale draft that would create yet
    // another version on retry.
    if (saved) {
      state.draft = null;
      state.draftBase = null;
      state.draftTarget = null;
      state.selected = { kind: 'workflow', ref: saved.ref };
      state.selectionSource = editingTemplate ? 'template' : 'project';
      closeNodeEditor();
      await load();
      return showError(editingTemplate
        ? `Published ${friendlyRef(saved.ref)}, but could not refresh the catalog: ${e.message}`
        : `Saved ${friendlyRef(saved.ref)}, but could not apply it to ${state.project}: ${e.message}`);
    }
    showError(e.message);
  }
}

async function saveStepDraft() {
  const instruction = String(state.stepDraft?.instruction || '').trim();
  if (!instruction) return showError('The default instruction cannot be empty.');
  try {
    state.stepDraft.instruction = instruction;
    const saved = await post('/api/catalog/save', { kind: 'step', draft: state.stepDraft });
    state.stepDraft = null;
    state.stepDraftBase = null;
    state.selected = { kind: 'step', ref: saved.ref };
    state.selectionSource = 'catalog';
    toast(`Saved ${saved.ref} as the new default`);
    showError('');
    await load();
  } catch (e) {
    showError(e.message);
  }
}

function discardDraft() {
  if (state.stepDraft) {
    if (!confirm('Discard this unsaved default instruction?')) return;
    state.stepDraft = null;
    state.stepDraftBase = null;
    showError('');
    return renderMain();
  }
  if (!state.draft || !confirm('Discard all unsaved workflow changes?')) return;
  state.draft = null;
  state.draftBase = null;
  state.draftTarget = null;
  state.preview = null;
  state.collapsed.clear();
  state.zoom = null;
  closeNodeEditor();
  renderMain();
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
window.addEventListener('tl:edit-project-workflow', async (event) => {
  if (!state.catalog) await load();
  const project = event.detail?.project;
  if (!project || !state.catalog.projects.some((item) => item.name === project)) return;
  selectProject(project);
});
// app.js loads first and may have already switched to this view during boot
// (a #workflows deep link), firing the event before the listener above existed.
// Catch that case by loading now if the view is already showing.
if (!$('#viewWorkflows').hidden) load();
$('#wfProject').addEventListener('change', (e) => {
  if (hasUnsavedDraft() && !confirm('Discard the unsaved changes and switch project?')) {
    e.target.value = state.project;
    return;
  }
  state.draft = null;
  state.draftBase = null;
  state.draftTarget = null;
  state.stepDraft = null;
  state.stepDraftBase = null;
  state.project = e.target.value;
  state.selectionSource = 'project';
  const project = currentProject();
  state.selected = { kind: 'workflow', ref: project?.workflow || state.catalog.defaultWorkflow };
  state.preview = null;
  state.collapsed.clear();
  state.zoom = null;
  renderRail();
  renderMain();
});
$('#wfAssignBtn').addEventListener('click', assignSelected);
$('#wfCloneBtn').addEventListener('click', cloneSelected);
$('#wfSaveBtn').addEventListener('click', saveDraft);
$('#wfDiscardBtn').addEventListener('click', discardDraft);
$('#nodeClose').addEventListener('click', closeNodeEditor);
$('#nodeCancel').addEventListener('click', closeNodeEditor);
