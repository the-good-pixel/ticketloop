// Workflow diagram — lays out a compiled plan tree and draws it as SVG.
//
// The plan is a structured tree (sequence / branch / bounded loop / terminal),
// never an arbitrary graph, so a deterministic top-down layout works and there
// is no need for a graph library. Two passes: measure every block bottom-up,
// then place it top-down. Nothing here mutates the workflow — it only draws.

const NS = 'http://www.w3.org/2000/svg';

// Geometry. Tuned so a full standard workflow is readable at 100% on a laptop.
const NW = 208;        // step box width
const NH = 58;         // step box height
const STOP_H = 38;     // terminal pill height
const VG = 34;         // vertical gap (leaves room for an arrow + its label)
const HG = 30;         // gap between branch case columns
const PAD = 18;        // loop container padding
const LOOP_HEAD = 30;  // loop container title bar
const BACK_LANE = 34;  // right-hand lane inside a loop for its repair arrow
const CASE_HEAD = 26;  // case label strip above each branch column
const CHIP_W = 150;    // width of a collapsed case column
const MARGIN = 28;

const svg = (tag, attrs, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  return n;
};

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
      h: NH + VG + Math.max(...cases.map((c) => c.h), CASE_HEAD),
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
  g.append(svg('rect', { x, y, width: NW, height: NH, rx: 10, class: 'wd-box' + (hasError ? ' has-error' : '') }));
  // Contract stripe: a gate must be distinguishable at a glance from a step
  // that merely does work, because only a gate can send the run backwards.
  g.append(svg('rect', { x, y, width: 4, height: NH, rx: 2, class: 'wd-stripe' }));
  g.append(svg('text', { x: x + 14, y: y + 22, class: 'wd-title' }, n.id));
  g.append(svg('text', { x: x + 14, y: y + 38, class: 'wd-sub' }, n.ref + (n.enabled ? '' : ' · disabled')));
  g.append(svg('text', { x: x + 14, y: y + 51, class: 'wd-sub wd-sub-dim' }, n.detail.slice(0, 34)));

  // Badges down the right edge: anything that reaches outside the worktree, a
  // DEV pin, or a local override.
  let by = y + 14;
  const chip = (text, cls) => {
    const w = 8 + text.length * 5.6;
    g.append(svg('rect', { x: x + NW - w - 8, y: by - 9, width: w, height: 14, rx: 7, class: 'wd-chip ' + cls }));
    g.append(svg('text', { x: x + NW - w / 2 - 8, y: by + 1, class: 'wd-chip-t', 'text-anchor': 'middle' }, text));
    by += 17;
  };
  for (const e of n.effects) chip(e, 'wd-chip-effect');
  if (n.devOnly) chip('DEV only', 'wd-chip-dev');
  if (n.badges.length) chip(n.badges.length === 1 ? n.badges[0].slice(0, 18) : n.badges.length + ' overrides', 'wd-chip-override');

  if (ctx.editable) g.classList.add('is-editable');
  c.shapes.push(g);
  c.boxes.set(n.id, { x, y, w: NW, h: NH });
  note(c, x, y, NW, NH);
}

function drawStop(c, n, x, y) {
  const g = svg('g', { class: 'wd-node wd-stop wd-term-' + n.terminal, 'data-node': n.id });
  g.append(svg('rect', { x, y, width: NW, height: STOP_H, rx: 19, class: 'wd-box' }));
  g.append(svg('text', { x: x + NW / 2, y: y + 17, class: 'wd-title', 'text-anchor': 'middle' }, n.outcome || n.terminal));
  g.append(svg('text', { x: x + NW / 2, y: y + 30, class: 'wd-sub', 'text-anchor': 'middle' },
    n.reported ? 'ends here · already replied' : 'ends here · reported by finally'));
  c.shapes.push(g);
  c.boxes.set(n.id, { x, y, w: NW, h: STOP_H });
  note(c, x, y, NW, STOP_H);
}

function placePhase(c, lay, cx, y, ctx) {
  const p = lay.p;
  if (p.kind === 'step') return drawStep(c, p, cx - NW / 2, y, ctx);
  if (p.kind === 'stop') return drawStop(c, p, cx - NW / 2, y);

  if (p.kind === 'branch') {
    drawBranchHead(c, p, cx - NW / 2, y, ctx);
    const top = y + NH;
    let x = cx - lay.innerW / 2;
    for (const col of lay.cases) {
      const colCx = x + col.w / 2;
      // Case label strip, clickable to collapse/expand this branch.
      const g = svg('g', { class: 'wd-case' + (col.collapsed ? ' is-collapsed' : ''), 'data-case': p.id + ':' + col.c.name });
      const chipW = Math.min(col.w, 172);
      g.append(svg('rect', { x: colCx - chipW / 2, y: top + VG - CASE_HEAD, width: chipW, height: 20, rx: 10, class: 'wd-case-box' }));
      g.append(svg('text', { x: colCx, y: top + VG - CASE_HEAD + 14, class: 'wd-case-t', 'text-anchor': 'middle' },
        (col.collapsed ? '▸ ' : '▾ ') + col.c.name + (col.collapsed ? ` (${countPhases(col.c.phases)})` : '')));
      c.shapes.push(g);
      arrow(c, cx, y + NH, colCx, top + VG - CASE_HEAD, null, 'wd-edge-branch');
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
    `↻ ${p.id} — up to ${p.maxIterations} attempt${p.maxIterations === 1 ? '' : 's'}, then ${p.noProgress === 'stop' ? 'stop' : 'carry on'}`));
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
  const g = svg('g', { class: 'wd-node wd-branch', 'data-node': p.id });
  g.append(svg('rect', { x, y, width: NW, height: NH, rx: 10, class: 'wd-box' }));
  g.append(svg('text', { x: x + NW / 2, y: y + 24, class: 'wd-title', 'text-anchor': 'middle' }, '⑂ ' + p.id));
  g.append(svg('text', { x: x + NW / 2, y: y + 42, class: 'wd-sub', 'text-anchor': 'middle' },
    'on ' + p.on.nodeId + '.' + p.on.field));
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
    }
    cursor += lay.h + VG;
  });
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
  // The trunk is centred on a canvas that is usually wider than its pane, so
  // without this the view opens on empty space beside the first step.
  const trunkCx = (MARGIN + seq.w / 2 - minX) * zoom;
  host.scrollLeft = Math.max(0, trunkCx - host.clientWidth / 2);

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
