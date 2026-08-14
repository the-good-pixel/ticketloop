// Workflow diagram — lays out a compiled plan tree and draws it as SVG.
//
// The plan is a structured tree (sequence / branch / bounded loop / terminal),
// never an arbitrary graph, so a deterministic top-down layout works and there
// is no need for a graph library. Two passes: measure every block bottom-up,
// then place it top-down. Nothing here mutates the workflow — it only draws.

const NS = 'http://www.w3.org/2000/svg';

// Geometry. Cards are deliberately comfortable to scan in the full-screen
// editor; the canvas can scroll when a workflow is wider than the viewport.
const NW = 244;        // step box width
const NH = 70;         // step box height
const STOP_H = 44;     // terminal pill height
const VG = 40;         // vertical gap (leaves room for an arrow + its label)
// Expanded paths need room for loop borders, card shadows and cross-loop
// failure lines. A narrow gutter makes neighbouring paths look connected.
const HG = 78;         // gap between branch case columns
const PAD = 18;        // loop container padding
const LOOP_HEAD = 34;  // loop container title bar
const BACK_LANE = 34;  // right-hand lane inside a loop for its repair arrow
const CASE_HEAD = 38;  // case label strip above each branch column
const CHIP_W = 152;    // width of a collapsed case column
const MARGIN = 32;

const svg = (tag, attrs, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  return n;
};

function displayRef(ref) {
  const [id, version] = String(ref || '').split('@');
  return version ? `${id} · version ${version}` : id;
}

function friendlyRoute(name) {
  return ({ question: 'Question', data: 'Data request', bug: 'Bug', change: 'Change', default: 'Other' })[name] ||
    name.replace(/[-_]/g, ' ').replace(/^./, (char) => char.toUpperCase());
}

function routeTone(name, index) {
  const known = {
    ineligible: 'rose', question: 'violet', data: 'teal', bug: 'orange', change: 'blue',
  };
  if (known[name]) return known[name];
  const tones = ['blue', 'violet', 'teal', 'orange', 'rose', 'green'];
  return tones[index % tones.length];
}

function contractLabel(contract, effects) {
  if (effects?.length) return 'External action';
  return ({ route: 'Routes the ticket', verdict: 'Quality check', post: 'Updates the ticket', text: 'Work step', artifact: 'Creates an output' })[contract] || 'Workflow step';
}

function branchDescription(branch) {
  if (branch.on.field === 'KIND') return 'Routes by ticket type';
  if (branch.on.field === 'DECISION') return 'Checks whether work is needed';
  return 'Uses an earlier answer';
}

// ---- pass 1: measure --------------------------------------------------------

function layPhase(p, collapsed) {
  if (p.kind === 'step') return { p, w: NW, h: NH };
  if (p.kind === 'stop') return { p, w: NW, h: STOP_H };
  if (p.kind === 'branch') {
    const cases = p.cases.map((c) => {
      const isCollapsed = collapsed.has(p.id + ':' + c.name);
      const seq = isCollapsed ? { items: [], w: NW, h: 0 } : laySeq(c.phases, collapsed);
      return {
        c,
        seq,
        collapsed: isCollapsed,
        // A folded case shrinks to its chip. Five folded cases each holding a
        // full node's width would still be too wide to read.
        w: isCollapsed ? CHIP_W : Math.max(NW, seq.w),
        h: CASE_HEAD + (isCollapsed ? 0 : VG / 2 + seq.h),
      };
    });
    const inner = cases.reduce((a, c) => a + c.w, 0) + HG * Math.max(0, cases.length - 1);
    return {
      p,
      cases,
      w: Math.max(NW, inner),
      innerW: inner,
      h: (p.compact ? 0 : NH) + VG + Math.max(...cases.map((c) => c.h), CASE_HEAD),
    };
  }
  // loop
  const seq = laySeq([p.repair, ...p.gates], collapsed);
  return {
    p,
    seq,
    w: seq.w + PAD * 2 + BACK_LANE,
    h: seq.h + PAD * 2 + LOOP_HEAD,
  };
}

function laySeq(phases, collapsed) {
  const items = phases.map((p) => layPhase(p, collapsed));
  return {
    items,
    w: Math.max(NW, ...items.map((i) => i.w)),
    h: items.reduce((a, i) => a + i.h, 0) + VG * Math.max(0, items.length - 1),
  };
}

// ---- pass 2: place + draw ---------------------------------------------------

/** Shared drawing state for one render. */
function makeCanvas() {
  return { shapes: [], boxes: new Map(), loops: new Map(), maxX: 0, maxY: 0 };
}

function note(c, x, y, w, h) {
  c.maxX = Math.max(c.maxX, x + w);
  c.maxY = Math.max(c.maxY, y + h);
}

function arrow(c, x1, y1, x2, y2, label, cls) {
  const d = x1 === x2
    ? `M ${x1} ${y1} L ${x2} ${y2}`
    : `M ${x1} ${y1} C ${x1} ${y1 + 18}, ${x2} ${y2 - 18}, ${x2} ${y2}`;
  c.shapes.push(svg('path', { d, class: 'wd-edge ' + (cls || ''), 'marker-end': 'url(#wd-arrow)' }));
  if (label) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const t = svg('text', { x: mx, y: my + 4, class: 'wd-edge-label', 'text-anchor': 'middle' }, label);
    c.shapes.push(t);
  }
}

function drawStep(c, n, x, y, ctx) {
  const g = svg('g', { class: 'wd-node wd-' + n.contract + (n.enabled ? '' : ' is-off'), 'data-node': n.id, tabindex: '0' });
  const hasError = n.problems.some((p) => p.startsWith('error'));
  g.append(svg('rect', { x, y, width: NW, height: NH, rx: 12, class: 'wd-box' + (hasError ? ' has-error' : '') }));
  g.append(svg('text', { x: x + 18, y: y + 29, class: 'wd-title' }, n.name || n.id));
  g.append(svg('text', { x: x + 18, y: y + 51, class: 'wd-sub' }, (n.enabled ? contractLabel(n.contract, n.effects) : 'Turned off')));

  // Badges down the right edge: anything that reaches outside the worktree, a
  // DEV pin, or a local override.
  let by = y + 14;
  const chip = (text, cls) => {
    const w = 8 + text.length * 5.6;
    g.append(svg('rect', { x: x + NW - w - 8, y: by - 9, width: w, height: 14, rx: 7, class: 'wd-chip ' + cls }));
    g.append(svg('text', { x: x + NW - w / 2 - 8, y: by + 1, class: 'wd-chip-t', 'text-anchor': 'middle' }, text));
    by += 17;
  };
  // Browse mode exposes execution metadata. Edit mode stays focused on the
  // flow; detailed settings remain available in the node drawer.
  if (!ctx.editable) {
    for (const e of n.effects) chip(e, 'wd-chip-effect');
    if (n.devOnly) chip('DEV only', 'wd-chip-dev');
    if (n.badges.length) chip(n.badges.length === 1 ? n.badges[0].slice(0, 18) : n.badges.length + ' overrides', 'wd-chip-override');
  }

  if (ctx.editable) g.classList.add('is-editable');
  if (ctx.editable) drawNodeActions(g, x, y, n.id, true, !ctx.canRemove || ctx.canRemove(n.id));
  c.shapes.push(g);
  c.boxes.set(n.id, { x, y, w: NW, h: NH });
  note(c, x, y, NW, NH);
}

function drawStop(c, n, x, y, ctx) {
  const g = svg('g', { class: 'wd-node wd-stop wd-term-' + n.terminal + (ctx.editable ? ' is-editable' : ''), 'data-node': n.id, tabindex: '0' });
  g.append(svg('rect', { x, y, width: NW, height: STOP_H, rx: 19, class: 'wd-box' }));
  g.append(svg('text', { x: x + NW / 2, y: y + 17, class: 'wd-title', 'text-anchor': 'middle' }, n.outcome || n.terminal));
  g.append(svg('text', { x: x + NW / 2, y: y + 30, class: 'wd-sub', 'text-anchor': 'middle' },
    n.reported ? 'ends here · already replied' : 'ends here · reported by finally'));
  if (ctx.editable) drawNodeActions(g, x, y - 10, n.id, false, !ctx.canRemove || ctx.canRemove(n.id));
  c.shapes.push(g);
  c.boxes.set(n.id, { x, y, w: NW, h: STOP_H });
  note(c, x, y, NW, STOP_H);
}

function placePhase(c, lay, cx, y, ctx) {
  const p = lay.p;
  if (p.kind === 'step') return drawStep(c, p, cx - NW / 2, y, ctx);
  if (p.kind === 'stop') return drawStop(c, p, cx - NW / 2, y, ctx);

  if (p.kind === 'branch') {
    const headH = p.compact ? 0 : NH;
    if (!p.compact) drawBranchHead(c, p, cx - NW / 2, y, ctx);
    const top = y + headH;
    let x = cx - lay.innerW / 2;
    for (const [caseIndex, col] of lay.cases.entries()) {
      const colCx = x + col.w / 2;
      // Case label strip, clickable to collapse/expand this branch.
      const tone = routeTone(col.c.name, caseIndex);
      const g = svg('g', { class: `wd-case wd-route-${tone}` + (col.collapsed ? ' is-collapsed' : ''), 'data-case': p.id + ':' + col.c.name });
      const chipW = Math.min(col.w, 196);
      g.append(svg('rect', { x: colCx - chipW / 2, y: top + VG - CASE_HEAD, width: chipW, height: 30, rx: 15, class: 'wd-case-box' }));
      g.append(svg('text', { x: colCx, y: top + VG - CASE_HEAD + 20, class: 'wd-case-t', 'text-anchor': 'middle' },
        (col.collapsed ? '' : '✓ ') + friendlyRoute(col.c.name)));
      c.shapes.push(g);
      arrow(c, cx, y + headH, colCx, top + VG - CASE_HEAD, null, `wd-edge-branch wd-route-${tone}`);
      if (!col.collapsed) placeSeq(c, col.seq, colCx, top + VG + VG / 2 - CASE_HEAD + CASE_HEAD, ctx);
      note(c, colCx - col.w / 2, top, col.w, col.h);
      x += col.w + HG;
    }
    return;
  }

  // loop container
  const x0 = cx - lay.w / 2;
  const g = svg('g', { class: 'wd-loop', 'data-loop': p.id });
  g.append(svg('rect', { x: x0, y, width: lay.w, height: lay.h, rx: 14, class: 'wd-loop-box' }));
  g.append(svg('text', { x: x0 + 14, y: y + 20, class: 'wd-loop-t' },
    `↻ Improve until ready · up to ${p.maxIterations} attempt${p.maxIterations === 1 ? '' : 's'}`));
  if (ctx.editable) drawLoopRemove(g, x0 + lay.w - 18, y + 15, p.id, !ctx.canRemove || ctx.canRemove(p.id));
  c.shapes.push(g);
  const innerCx = x0 + PAD + lay.seq.w / 2;
  placeSeq(c, lay.seq, innerCx, y + LOOP_HEAD + PAD, ctx);
  // The repair arrow: from the last gate back up to the repair step, drawn in
  // the reserved right-hand lane so it never crosses a node.
  const laneX = x0 + lay.w - BACK_LANE / 2;
  const first = c.boxes.get(p.repair.id);
  const last = c.boxes.get(p.gates[p.gates.length - 1]?.id) || first;
  if (first && last) {
    const d = `M ${last.x + last.w} ${last.y + last.h / 2} H ${laneX} V ${first.y + first.h / 2} H ${first.x + first.w}`;
    c.shapes.push(svg('path', { d, class: 'wd-edge wd-edge-repair', 'marker-end': 'url(#wd-arrow-repair)' }));
    c.shapes.push(svg('text', { x: laneX + 6, y: (first.y + last.y) / 2, class: 'wd-edge-label wd-repair-label' }, 'fail'));
  }
  c.loops.set(p.id, { x: x0, y, w: lay.w, h: lay.h });
  note(c, x0, y, lay.w, lay.h);
}

function countPhases(phases) {
  let n = 0;
  for (const p of phases) {
    if (p.kind === 'loop') n += 1 + p.gates.length;
    else if (p.kind === 'branch') n += p.cases.reduce((a, c) => a + countPhases(c.phases), 0);
    else n += 1;
  }
  return n;
}

function drawBranchHead(c, p, x, y, ctx) {
  const g = svg('g', { class: 'wd-node wd-branch' + (ctx.editable ? ' is-editable' : ''), 'data-node': p.id, tabindex: '0' });
  g.append(svg('rect', { x, y, width: NW, height: NH, rx: 12, class: 'wd-box' }));
  g.append(svg('text', { x: x + NW / 2, y: y + 29, class: 'wd-title', 'text-anchor': 'middle' }, 'Choose a path'));
  g.append(svg('text', { x: x + NW / 2, y: y + 51, class: 'wd-sub', 'text-anchor': 'middle' },
    ctx.editable ? branchDescription(p) : 'on ' + p.on.nodeId + '.' + p.on.field));
  if (ctx.editable) drawNodeActions(g, x, y, p.id, false, !ctx.canRemove || ctx.canRemove(p.id));
  c.shapes.push(g);
  c.boxes.set(p.id, { x, y, w: NW, h: NH });
  note(c, x, y, NW, NH);
}

function placeSeq(c, seq, cx, y, ctx) {
  let cursor = y;
  seq.items.forEach((lay, i) => {
    placePhase(c, lay, cx, cursor, ctx);
    if (i < seq.items.length - 1) {
      const from = cursor + lay.h;
      const to = from + VG;
      // Label the edge with what carries execution forward, when it is not the
      // plain "pass" case — the interesting transitions should be visible.
      const label = lay.p.kind === 'step' ? edgeLabel(lay.p) : null;
      arrow(c, cx, from, cx, to, label);
      if (ctx.editable && lay.p.kind !== 'stop' && (!ctx.canInsert || ctx.canInsert(lay.p.id))) {
        insertButton(c, lay.p.id, cx, from + VG / 2);
      }
    }
    cursor += lay.h + VG;
  });
}

function drawNodeActions(group, x, y, id, replace, remove) {
  if (!replace && !remove) return;
  const actions = svg('g', { class: 'wd-node-actions' });
  let ax = x + NW - 13;
  if (remove) {
    actions.append(actionButton(ax, y + 13, '×', 'wd-remove', id, 'Remove from path'));
    ax -= 25;
  }
  if (replace) actions.append(actionButton(ax, y + 13, '↻', 'wd-replace', id, 'Replace step'));
  group.append(actions);
}

function drawLoopRemove(group, x, y, id, allowed) {
  if (!allowed) return;
  const actions = svg('g', { class: 'wd-node-actions wd-loop-actions' });
  actions.append(actionButton(x, y, '×', 'wd-remove', id, 'Remove loop'));
  group.append(actions);
}

function actionButton(x, y, text, cls, id, label) {
  const g = svg('g', { class: `wd-node-action ${cls}`, [`data-${cls.replace('wd-', '')}`]: id, tabindex: '0', 'aria-label': label });
  g.append(svg('circle', { cx: x, cy: y, r: 9, class: 'wd-action-circle' }));
  g.append(svg('text', { x, y: y + 3.5, class: 'wd-action-text', 'text-anchor': 'middle' }, text));
  return g;
}

function insertButton(c, id, x, y) {
  const g = svg('g', { class: 'wd-insert', 'data-insert': id, tabindex: '0', 'aria-label': 'Add a step here' });
  g.append(svg('circle', { cx: x, cy: y, r: 10, class: 'wd-insert-circle' }));
  g.append(svg('text', { x, y: y + 4, class: 'wd-insert-plus', 'text-anchor': 'middle' }, '+'));
  c.shapes.push(g);
}

function edgeLabel(n) {
  const t = n.transitions || {};
  if (t.pass === 'next' || !t.pass) return null;
  return t.pass;
}

// ---- entry point ------------------------------------------------------------

/**
 * Render `tree` into `host`. `ctx.editable` turns on click-to-edit affordances;
 * `ctx.onNode` / `ctx.onLoop` / `ctx.onCase` are the click handlers.
 */
export function renderDiagram(host, tree, ctx) {
  ctx = ctx || {};
  const collapsed = ctx.collapsed || new Set();
  const seq = laySeq(tree, collapsed);
  const c = makeCanvas();
  placeSeq(c, seq, MARGIN + seq.w / 2, MARGIN, ctx);

  // Cross-block repair edges — a failed ship reaching back into an earlier
  // loop. Drawn last, in the left margin, so they read as exceptional.
  for (const [id, box] of c.boxes) {
    const node = findNode(tree, id);
    const target = node && node.transitions && Object.values(node.transitions).find((t) => /\.repair$/.test(t || ''));
    if (!target) continue;
    const loop = c.loops.get(target.replace(/\.repair$/, ''));
    if (!loop) continue;
    const laneX = Math.min(box.x, loop.x) - 22;
    const d = `M ${box.x} ${box.y + box.h / 2} H ${laneX} V ${loop.y + LOOP_HEAD / 2} H ${loop.x}`;
    c.shapes.push(svg('path', { d, class: 'wd-edge wd-edge-repair wd-edge-far', 'marker-end': 'url(#wd-arrow-repair)' }));
    c.shapes.push(svg('text', { x: laneX + 4, y: box.y + box.h / 2 - 8, class: 'wd-edge-label wd-repair-label' }, 'fail → repair'));
  }

  const minX = -60; // room for the left-margin repair lane
  const width = c.maxX + MARGIN;
  const height = c.maxY + MARGIN;
  const contentW = width - minX;

  // Fit-to-width on first render: a branch row that is 30% wider than the pane
  // reads as "broken", not as "scroll me". Never scale below 55% — past that
  // the labels stop being readable and a scrollbar is the better answer.
  let zoom = ctx.zoom;
  if (zoom == null) {
    zoom = Math.min(1, Math.max(0.55, (host.clientWidth - 12) / contentW));
    zoom = Math.round(zoom * 20) / 20;
    if (ctx.onFit) ctx.onFit(zoom);
  }

  const root = svg('svg', {
    class: 'wd',
    viewBox: `${minX} 0 ${contentW} ${height}`,
    width: contentW * zoom,
    height: height * zoom,
  });
  root.append(defs());
  for (const s of c.shapes) root.append(s);

  host.replaceChildren(root);
  let canvasOffset = 0;
  if (ctx.panReserve) {
    // A scroll container can only pan across content that exists. Reserve one
    // drawer width after the SVG so even its rightmost card can move fully into
    // the visible workspace when the inspector overlays the canvas.
    const stage = document.createElement('div');
    stage.className = 'wf-pan-stage';
    const rootWidth = contentW * zoom;
    canvasOffset = Math.max(0, (host.clientWidth - rootWidth) / 2);
    stage.style.width = `${canvasOffset + rootWidth + ctx.panReserve}px`;
    stage.style.height = `${height * zoom}px`;
    root.style.marginLeft = `${canvasOffset}px`;
    root.style.marginRight = '0';
    root.replaceWith(stage);
    stage.append(root);
  }
  // The trunk is centred on a canvas that is usually wider than its pane, so
  // without this the view opens on empty space beside the first step.
  const trunkCx = canvasOffset + (MARGIN + seq.w / 2 - minX) * zoom;
  host.scrollLeft = Math.max(0, trunkCx - host.clientWidth / 2);
  if (ctx.focusCase) {
    const target = [...root.querySelectorAll('[data-case]')]
      .find((node) => node.getAttribute('data-case') === ctx.focusCase);
    if (target) {
      const targetBox = target.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      host.scrollLeft += targetBox.left + targetBox.width / 2 - hostBox.left - hostBox.width / 2;
    }
  }

  if (ctx.onNode) {
    root.querySelectorAll('[data-node]').forEach((n) => {
      n.addEventListener('click', () => ctx.onNode(n.getAttribute('data-node')));
    });
  }
  if (ctx.onLoop) {
    root.querySelectorAll('[data-loop]').forEach((n) => {
      n.addEventListener('click', (e) => {
        if (e.target.closest('[data-node]')) return; // inner node wins
        ctx.onLoop(n.getAttribute('data-loop'));
      });
    });
  }
  if (ctx.onCase) {
    root.querySelectorAll('[data-case]').forEach((n) => {
      n.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.onCase(n.getAttribute('data-case'));
      });
    });
  }
  if (ctx.onInsert) {
    root.querySelectorAll('[data-insert]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        ctx.onInsert(node.getAttribute('data-insert'));
      });
    });
  }
  if (ctx.onReplace) {
    root.querySelectorAll('[data-replace]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        ctx.onReplace(node.getAttribute('data-replace'));
      });
    });
  }
  if (ctx.onRemove) {
    root.querySelectorAll('[data-remove]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        ctx.onRemove(node.getAttribute('data-remove'));
      });
    });
  }
  return root;
}

export function findNode(tree, id) {
  for (const p of tree) {
    if (p.id === id) return p;
    if (p.kind === 'branch') {
      for (const c of p.cases) {
        const hit = findNode(c.phases, id);
        if (hit) return hit;
      }
    }
    if (p.kind === 'loop') {
      const hit = findNode([p.repair, ...p.gates], id);
      if (hit) return hit;
    }
  }
  return null;
}

function defs() {
  const d = svg('defs');
  const mk = (id, cls) => {
    const m = svg('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
    m.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: cls }));
    return m;
  };
  d.append(mk('wd-arrow', 'wd-arrowhead'));
  d.append(mk('wd-arrow-repair', 'wd-arrowhead-repair'));
  return d;
}
