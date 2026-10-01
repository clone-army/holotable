'use strict';
// Holotable editor: a top-down map (drawn from the map's own .bsp) to place
// points, routes and areas on, and panels for the scenario's NPC types,
// groups and triggers. Everything edits S.scn, saved as the scenario JSON.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 7);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round1 = (v) => Math.round(v * 10) / 10;

const S = {
  scn: null, geo: null, dirty: false, tool: 'select', sel: null, drafting: null, drag: null,
  view: { cx: 0, cy: 0, zoom: 0.1 }, cut: 0, labels: true, hover: null, space: false,
  npcs: [], models: [], weapons: [], problems: [], crossings: {}, cache: null, teams: { team1: 'Team 1', team2: 'Team 2' },
};
const canvas = $('#map');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

// --- Map geometry --------------------------------------------------------------

const CELL = 256;
function prepGeometry(g) {
  const f = g.floors, n = f.length / 9;
  const tris = new Float32Array(f);
  const avg = new Float32Array(n);
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    avg[i] = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
    const x0 = Math.floor(Math.min(tris[o], tris[o + 3], tris[o + 6]) / CELL), x1 = Math.floor(Math.max(tris[o], tris[o + 3], tris[o + 6]) / CELL);
    const y0 = Math.floor(Math.min(tris[o + 1], tris[o + 4], tris[o + 7]) / CELL), y1 = Math.floor(Math.max(tris[o + 1], tris[o + 4], tris[o + 7]) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = x + ',' + y;
      let a = grid.get(k);
      if (!a) grid.set(k, a = []);
      a.push(i);
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => avg[a] - avg[b]);
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < n; i++) { zmin = Math.min(zmin, avg[i]); zmax = Math.max(zmax, avg[i]); }
  return { tris, avg, grid, order, n, walls: new Float32Array(g.walls), bounds: g.bounds, levels: g.levels || [], zmin, zmax,
    spawns: g.spawns || [], spawnZ: g.spawnZ };
}

// Every floor surface at (x, y): heights, highest first.
function surfacesAt(x, y) {
  const G = S.geo, out = [];
  const list = G.grid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL)) || [];
  for (const i of list) {
    const o = i * 9, t = G.tris;
    const ax = t[o], ay = t[o + 1], bx = t[o + 3], by = t[o + 4], cx = t[o + 6], cy = t[o + 7];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-6) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
    out.push(l1 * t[o + 2] + l2 * t[o + 5] + l3 * t[o + 8]);
  }
  out.sort((a, b) => b - a);
  const distinct = [];
  for (const z of out) if (!distinct.length || distinct[distinct.length - 1] - z > 12) distinct.push(z);
  return distinct;
}

// The floor a click lands on: the highest one under the cut height.
function pickZ(x, y) {
  const all = surfacesAt(x, y).filter((z) => z <= S.cut + 8);
  return all.length ? Math.round(all[0]) : null;
}

// Paths for what's drawn at the current cut, rebuilt when it changes.
const BAND = 450, BUCKETS = 12;
// Floors under the cut: the ones in the band just below it bright (blue to
// cyan, by height), and everything deeper in dimmer shades by height too -
// still clearly there (a tall room's floor can be well below the cut).
const DEEP = 6;
function buildCache() {
  const G = S.geo, cut = S.cut, lo = cut - BAND;
  const deepSpan = Math.max(1, lo - G.zmin);
  const ghost = Array.from({ length: DEEP }, () => new Path2D()), buckets = Array.from({ length: BUCKETS }, () => new Path2D());
  for (const i of G.order) {
    const z = G.avg[i];
    if (z > cut) break;
    const o = i * 9, t = G.tris;
    const p = z < lo ? ghost[clamp(Math.floor((z - G.zmin) / deepSpan * DEEP), 0, DEEP - 1)]
      : buckets[clamp(Math.floor((z - lo) / BAND * BUCKETS), 0, BUCKETS - 1)];
    p.moveTo(t[o], t[o + 1]); p.lineTo(t[o + 3], t[o + 4]); p.lineTo(t[o + 6], t[o + 7]); p.closePath();
  }
  const walls = new Path2D();
  const w = G.walls;
  for (let i = 0; i < w.length; i += 6) {
    if (w[i + 4] < cut - 8 && w[i + 5] > cut - 260) {
      walls.moveTo(w[i], w[i + 1]); walls.lineTo(w[i + 2], w[i + 3]);
    }
  }
  S.cache = { cut, ghost, buckets, walls };
}

function deepColour(k) {
  const t = k / (DEEP - 1);
  const a = [13, 32, 50], b = [20, 54, 82];
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')';
}

function bucketColour(k) {
  const t = k / (BUCKETS - 1);
  const a = [24, 66, 100], b = [70, 176, 228];
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')';
}

// --- View ------------------------------------------------------------------------

function w2s(x, y) { return [(x - S.view.cx) * S.view.zoom + W / 2, -(y - S.view.cy) * S.view.zoom + H / 2]; }
function s2w(sx, sy) { return [(sx - W / 2) / S.view.zoom + S.view.cx, -(sy - H / 2) / S.view.zoom + S.view.cy]; }

function fitTo(minx, miny, maxx, maxy) {
  S.view.cx = (minx + maxx) / 2;
  S.view.cy = (miny + maxy) / 2;
  S.view.zoom = Math.min(W / Math.max(200, maxx - minx), H / Math.max(200, maxy - miny)) * 0.9;
  draw();
}

function fit() {
  const pts = allPositions();
  if (pts.length >= 2) {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    fitTo(Math.min(...xs) - 400, Math.min(...ys) - 400, Math.max(...xs) + 400, Math.max(...ys) + 400);
  } else if (S.geo) {
    const b = S.geo.bounds;
    fitTo(b[0], b[1], b[2], b[3]);
  }
}

function allPositions() {
  const s = S.scn, out = [];
  if (!s) return out;
  s.points.forEach((p) => out.push(p));
  s.areas.forEach((a) => out.push(a));
  s.routes.forEach((r) => r.points.forEach((p) => out.push(p)));
  return out;
}

function resize() {
  const r = canvas.getBoundingClientRect();
  DPR = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  draw();
}

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawNow(); });
}

function drawNow() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#050b14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!S.geo) return;
  if (!S.cache || S.cache.cut !== S.cut) buildCache();
  const z = S.view.zoom;
  ctx.setTransform(DPR * z, 0, 0, -DPR * z, DPR * (W / 2 - S.view.cx * z), DPR * (H / 2 + S.view.cy * z));
  S.cache.ghost.forEach((p, k) => { ctx.fillStyle = deepColour(k); ctx.fill(p); });
  S.cache.buckets.forEach((p, k) => { ctx.fillStyle = bucketColour(k); ctx.fill(p); });
  ctx.strokeStyle = 'rgba(4,12,22,0.75)';
  ctx.lineWidth = 3 / z;
  ctx.stroke(S.cache.walls);
  ctx.strokeStyle = 'rgba(200,240,255,0.95)';
  ctx.lineWidth = 1.2 / z;
  ctx.stroke(S.cache.walls);

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawOverlay();
}

const COL = { point: '#ffd166', route: '#ff8a3d', area: '#7cff9b', bad: '#ff4d6d', sel: '#ffffff' };

// The map's own entities, by kind - drawn faintly when ticked in the
// cut panel (the choice is remembered in this browser).
const ENT_KINDS = [
  { k: 'spawn', t: 'Spawns', col: '#c8d7e6', on: true },
  { k: 'mover', t: 'Doors', col: '#c39bff' },
  { k: 'trigger', t: 'Triggers', col: '#3fd0c9' },
  { k: 'item', t: 'Items', col: '#ff9ff3' },
  { k: 'npc', t: 'NPCs', col: '#f2e27a' },
  { k: 'other', t: 'Other', col: '#d5dde6' },
];
const SPAWN_COL = { team1: '#5fb4ff', team2: '#ff6b6b' };
S.ents = null;
S.entHover = null;
S.entShow = (() => {
  try { const v = JSON.parse(localStorage.getItem('ht-ents')); if (v && typeof v === 'object') return v; } catch (e) { /* none yet */ }
  return Object.fromEntries(ENT_KINDS.map((e) => [e.k, !!e.on]));
})();

function entColour(e) {
  if (e.k === 'spawn') return /team1/i.test(e.c) ? SPAWN_COL.team1 : /team2/i.test(e.c) ? SPAWN_COL.team2 : ENT_KINDS[0].col;
  return (ENT_KINDS.find((x) => x.k === e.k) || ENT_KINDS[5]).col;
}

// Near enough the cut to show: a box that reaches into the band, or a point in it.
function entInBand(e) {
  return e.b ? (e.b[2] <= S.cut + 16 && e.b[5] >= S.cut - BAND) : (e.z <= S.cut + 16 && e.z >= S.cut - BAND);
}

function entsShown() {
  return (S.ents || []).filter((e) => S.entShow[e.k] && entInBand(e));
}

function setupEntKinds() {
  const box = $('#ent-kinds');
  box.innerHTML = '';
  const counts = {};
  (S.ents || []).forEach((e) => { counts[e.k] = (counts[e.k] || 0) + 1; });
  for (const kind of ENT_KINDS) {
    const n = S.ents ? (counts[kind.k] || 0) : (kind.k === 'spawn' ? 1 : 0);
    const input = h('input', { type: 'checkbox', checked: !!S.entShow[kind.k], disabled: !n, onchange: (ev) => {
      S.entShow[kind.k] = ev.target.checked;
      try { localStorage.setItem('ht-ents', JSON.stringify(S.entShow)); } catch (e) { /* private mode */ }
      draw();
    } });
    box.append(h('label', { class: 'check', title: S.ents ? n + ' on this map' : '' }, input,
      h('i', { style: 'background:' + (kind.k === 'spawn' ? 'linear-gradient(90deg,' + SPAWN_COL.team1 + ' 50%,' + SPAWN_COL.team2 + ' 50%)' : kind.col) }), kind.t));
  }
}

// The entity under the mouse, if any (within a few pixels, or inside its box).
function entAt(sx, sy) {
  const shown = entsShown();
  let best = null, bd = 100;
  for (const e of shown) {
    const [x, y] = w2s(e.x, e.y);
    const d = (x - sx) ** 2 + (y - sy) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  if (best) return best;
  for (const e of shown) {
    if (!e.b) continue;
    const [x1, y1] = w2s(e.b[0], e.b[4]), [x2, y2] = w2s(e.b[3], e.b[1]);
    if (sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) return e;
  }
  return null;
}

function drawEntities() {
  if (!S.ents) {
    // Not loaded (yet): the player spawns from the geometry, as before.
    if (!S.entShow.spawn) return;
    const sp = S.geo.spawns;
    ctx.fillStyle = 'rgba(200,215,230,0.45)';
    for (let i = 0; i < sp.length; i += 3) {
      if (sp[i + 2] > S.cut + 16 || sp[i + 2] < S.cut - BAND) continue;
      const [x, y] = w2s(sp[i], sp[i + 1]);
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 3.5, y + 3); ctx.lineTo(x - 3.5, y + 3); ctx.closePath(); ctx.fill();
    }
    return;
  }
  ctx.save();
  for (const e of entsShown()) {
    const col = entColour(e), hot = e === S.entHover;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    // A dark edge under each, so they read on the bright floors.
    const dark = 'rgba(5,11,20,0.85)';
    if (e.b) {
      const [x1, y1] = w2s(e.b[0], e.b[4]), [x2, y2] = w2s(e.b[3], e.b[1]);
      const bw = Math.max(3, x2 - x1), bh = Math.max(3, y2 - y1);
      ctx.globalAlpha = hot ? 0.35 : 0.2;
      ctx.fillRect(x1, y1, bw, bh);
      ctx.globalAlpha = 1;
      ctx.setLineDash(e.k === 'trigger' ? [5, 3] : []);
      ctx.lineWidth = hot ? 4.5 : 3.5; ctx.strokeStyle = dark; ctx.strokeRect(x1, y1, bw, bh);
      ctx.lineWidth = hot ? 2.5 : 1.5; ctx.strokeStyle = col; ctx.strokeRect(x1, y1, bw, bh);
      ctx.setLineDash([]);
    } else {
      const [x, y] = w2s(e.x, e.y), r = hot ? 7 : 5;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      if (e.k === 'spawn') { ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.87, y + r * 0.7); ctx.lineTo(x - r * 0.87, y + r * 0.7); }
      else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); }
      ctx.closePath();
      ctx.lineWidth = 2; ctx.strokeStyle = dark; ctx.stroke(); ctx.fill();
    }
  }
  ctx.restore();
}

function alphaFor(zv) { return zv > S.cut + 16 ? 0.3 : 1; }

function label(text, x, y, colour) {
  if (!S.labels || !text) return;
  ctx.font = '12px system-ui, sans-serif';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(5,11,20,0.9)';
  ctx.strokeText(text, x + 9, y - 8);
  ctx.fillStyle = colour;
  ctx.fillText(text, x + 9, y - 8);
}

function isSel(kind, id) { return S.sel && S.sel.kind === kind && S.sel.id === id; }

function drawOverlay() {
  const s = S.scn;
  if (!s) return;
  const zoom = S.view.zoom;
  // The map's own entities (spawns, doors, triggers...), faintly - for
  // finding your way about.
  drawEntities();
  // Areas
  for (const a of s.areas) {
    const [x, y] = w2s(a.x, a.y);
    ctx.globalAlpha = alphaFor(a.z);
    ctx.beginPath(); ctx.arc(x, y, Math.max(3, a.radius * zoom), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(124,255,155,0.09)'; ctx.fill();
    ctx.setLineDash([6, 4]); ctx.lineWidth = isSel('area', a.id) ? 2.5 : 1.5;
    ctx.strokeStyle = isSel('area', a.id) ? COL.sel : COL.area; ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = COL.area; ctx.fill();
    label(a.name, x, y, COL.area);
  }
  // Routes
  for (const r of s.routes) {
    if (!r.points.length) continue;
    const sel = isSel('route', r.id);
    const bad = S.crossings[r.id] || [];
    const pts = r.points.map((p) => w2s(p.x, p.y));
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      if (pts.length < 2 || (j === 0 && pts.length < 3)) break;
      const closing = j === 0;
      ctx.globalAlpha = Math.min(alphaFor(r.points[i].z), alphaFor(r.points[j].z));
      ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[j][0], pts[j][1]);
      ctx.setLineDash(closing ? [5, 5] : []);
      ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeStyle = bad.includes(i) ? COL.bad : (sel ? '#ffc38f' : COL.route);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    pts.forEach(([x, y], i) => {
      ctx.globalAlpha = alphaFor(r.points[i].z);
      const vsel = sel && S.sel.vi === i;
      ctx.beginPath(); ctx.arc(x, y, vsel ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = vsel ? COL.sel : COL.route; ctx.fill();
      if (sel && S.labels) { ctx.fillStyle = '#fff'; ctx.font = '10px system-ui'; ctx.fillText(String(i + 1), x + 6, y + 12); }
    });
    ctx.globalAlpha = alphaFor(r.points[0].z);
    label(r.name, pts[0][0], pts[0][1], COL.route);
  }
  // Points
  for (const p of s.points) {
    const [x, y] = w2s(p.x, p.y);
    ctx.globalAlpha = alphaFor(p.z);
    const yr = -p.yaw * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(yr) * 18, y + Math.sin(yr) * 18);
    ctx.strokeStyle = COL.point; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, isSel('point', p.id) ? 7 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = COL.point; ctx.fill();
    if (isSel('point', p.id)) { ctx.lineWidth = 2; ctx.strokeStyle = COL.sel; ctx.stroke(); }
    label(p.name, x, y, COL.point);
  }
  ctx.globalAlpha = 1;
  // Route being drawn: a line on to the cursor.
  if (S.drafting && S.hover) {
    const r = s.routes.find((q) => q.id === S.drafting);
    if (r && r.points.length) {
      const last = r.points[r.points.length - 1];
      const [x0, y0] = w2s(last.x, last.y);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(S.hover.sx, S.hover.sy);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = COL.route; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

// --- Hit testing and editing on the map ------------------------------------------

function hitTest(sx, sy) {
  const s = S.scn, d2 = (x, y) => (x - sx) ** 2 + (y - sy) ** 2;
  for (const p of s.points) { const [x, y] = w2s(p.x, p.y); if (d2(x, y) < 81) return { kind: 'point', id: p.id }; }
  for (const r of s.routes) for (let i = 0; i < r.points.length; i++) {
    const [x, y] = w2s(r.points[i].x, r.points[i].y);
    if (d2(x, y) < 64) return { kind: 'route', id: r.id, vi: i };
  }
  for (const a of s.areas) {
    const [x, y] = w2s(a.x, a.y);
    if (d2(x, y) < 81) return { kind: 'area', id: a.id, part: 'centre' };
    if (Math.abs(Math.sqrt(d2(x, y)) - a.radius * S.view.zoom) < 6) return { kind: 'area', id: a.id, part: 'edge' };
  }
  for (const r of s.routes) for (let i = 0; i + 1 < r.points.length; i++) {
    const [x1, y1] = w2s(r.points[i].x, r.points[i].y), [x2, y2] = w2s(r.points[i + 1].x, r.points[i + 1].y);
    if (segDist(sx, sy, x1, y1, x2, y2) < 6) return { kind: 'route', id: r.id };
  }
  for (const a of s.areas) { const [x, y] = w2s(a.x, a.y); if (d2(x, y) < (a.radius * S.view.zoom) ** 2) return { kind: 'area', id: a.id, part: 'inside' }; }
  return null;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
  const t = l ? clamp(((px - x1) * dx + (py - y1) * dy) / l, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function find(kind, id) {
  const list = { point: S.scn.points, route: S.scn.routes, area: S.scn.areas }[kind];
  return list ? list.find((x) => x.id === id) : null;
}

function placeZ(obj, x, y) {
  const z = pickZ(x, y);
  obj.x = round1(x); obj.y = round1(y);
  if (z !== null) { obj.z = z; return; }
  const above = surfacesAt(x, y).filter((q) => q > S.cut + 8);
  if (above.length) obj.z = Math.round(above[above.length - 1]);
  else if (obj.z === undefined) obj.z = Math.round(S.cut - 100);
  toast(above.length
    ? 'The floor there is above the cut height (at ' + Math.round(above[above.length - 1]) + ') - used that. Raise the cut to see that floor.'
    : 'No floor found under that spot - set its height by hand (Places tab).', !above.length);
}

function nextName(list, base) {
  let n = list.length + 1;
  while (list.some((x) => x.name === base + ' ' + n)) n++;
  return base + ' ' + n;
}

function onDown(e) {
  if (!S.scn || !S.geo) return;
  canvas.focus();
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  const [wx, wy] = s2w(sx, sy);
  if (e.button === 1 || e.button === 2 || S.space) { S.drag = { type: 'pan', sx, sy, cx: S.view.cx, cy: S.view.cy }; return; }
  if (e.button !== 0) return;
  const s = S.scn;
  if (S.tool === 'select') {
    const hit = hitTest(sx, sy);
    S.sel = hit;
    if (hit) {
      const obj = find(hit.kind, hit.id);
      S.drag = { type: 'move', hit, wx, wy, orig: JSON.parse(JSON.stringify(obj)), moved: false };
    } else {
      S.drag = { type: 'pan', sx, sy, cx: S.view.cx, cy: S.view.cy };
    }
    renderPanels('places');
  } else if (S.tool === 'point') {
    const p = { id: uid('p'), name: nextName(s.points, 'Point'), yaw: 0 };
    placeZ(p, wx, wy);
    s.points.push(p);
    S.sel = { kind: 'point', id: p.id };
    S.drag = { type: 'yaw', id: p.id, sx, sy };
    changed();
  } else if (S.tool === 'route') {
    let rt = S.drafting && s.routes.find((q) => q.id === S.drafting);
    if (!rt) {
      rt = { id: uid('r'), name: nextName(s.routes, 'Route'), points: [] };
      s.routes.push(rt);
      S.drafting = rt.id;
    }
    const q = {};
    placeZ(q, wx, wy);
    rt.points.push(q);
    S.sel = { kind: 'route', id: rt.id, vi: rt.points.length - 1 };
    changed();
  } else if (S.tool === 'area') {
    const a = { id: uid('a'), name: nextName(s.areas, 'Area'), radius: 32, height: 128 };
    placeZ(a, wx, wy);
    s.areas.push(a);
    S.sel = { kind: 'area', id: a.id };
    S.drag = { type: 'radius', id: a.id };
    changed();
  }
  draw();
}

function onMove(e) {
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  const [wx, wy] = s2w(sx, sy);
  S.hover = { sx, sy, wx, wy };
  const eh = S.ents ? entAt(sx, sy) : null;
  if (eh !== S.entHover) { S.entHover = eh; draw(); }
  updateHud();
  const d = S.drag;
  if (!d) { if (S.drafting) draw(); return; }
  if (d.type === 'pan') {
    S.view.cx = d.cx - (sx - d.sx) / S.view.zoom;
    S.view.cy = d.cy + (sy - d.sy) / S.view.zoom;
  } else if (d.type === 'yaw') {
    const p = find('point', d.id);
    const [px, py] = w2s(p.x, p.y);
    if (Math.hypot(sx - px, sy - py) > 6) p.yaw = Math.round(((Math.atan2(-(sy - py), sx - px) * 180 / Math.PI) + 360) % 360);
  } else if (d.type === 'radius') {
    const a = find('area', d.id);
    a.radius = Math.round(Math.max(16, Math.hypot(wx - a.x, wy - a.y)));
  } else if (d.type === 'move') {
    const obj = find(d.hit.kind, d.hit.id), dx = wx - d.wx, dy = wy - d.wy;
    d.moved = d.moved || Math.hypot(dx, dy) * S.view.zoom > 2;
    if (!d.moved) return;
    if (d.hit.kind === 'route' && d.hit.vi !== undefined) {
      obj.points[d.hit.vi].x = round1(d.orig.points[d.hit.vi].x + dx);
      obj.points[d.hit.vi].y = round1(d.orig.points[d.hit.vi].y + dy);
    } else if (d.hit.kind === 'route') {
      obj.points.forEach((p, i) => { p.x = round1(d.orig.points[i].x + dx); p.y = round1(d.orig.points[i].y + dy); });
    } else if (d.hit.kind === 'area' && d.hit.part === 'edge') {
      obj.radius = Math.round(Math.max(16, Math.hypot(wx - obj.x, wy - obj.y)));
    } else {
      obj.x = round1(d.orig.x + dx); obj.y = round1(d.orig.y + dy);
    }
  }
  draw();
}

function onUp() {
  const d = S.drag;
  S.drag = null;
  if (!d) return;
  if (d.type === 'move' && d.moved) {
    // Moved: onto the floor at its new spot.
    const obj = find(d.hit.kind, d.hit.id);
    if (d.hit.kind === 'route' && d.hit.vi !== undefined) placeZ(obj.points[d.hit.vi], obj.points[d.hit.vi].x, obj.points[d.hit.vi].y);
    else if (d.hit.kind === 'route') obj.points.forEach((p) => placeZ(p, p.x, p.y));
    else if (!(d.hit.kind === 'area' && d.hit.part === 'edge')) placeZ(obj, obj.x, obj.y);
    changed();
  } else if (d.type === 'yaw' || d.type === 'radius') {
    changed();
  }
  draw();
}

function onWheel(e) {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  const [wx, wy] = s2w(sx, sy);
  S.view.zoom = clamp(S.view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.005, 8);
  S.view.cx = wx - (sx - W / 2) / S.view.zoom;
  S.view.cy = wy + (sy - H / 2) / S.view.zoom;
  draw();
}

function finishRoute() {
  if (!S.drafting) return;
  const r = S.scn.routes.find((q) => q.id === S.drafting);
  S.drafting = null;
  if (r && r.points.length < 2) toast('A route needs at least 2 points.', true);
  changed();
}

function deleteSelection() {
  const sel = S.sel, s = S.scn;
  if (!sel) return;
  if (sel.kind === 'route' && sel.vi !== undefined) {
    const r = find('route', sel.id);
    r.points.splice(sel.vi, 1);
    S.sel = r.points.length ? { kind: 'route', id: r.id } : null;
    if (!r.points.length) s.routes = s.routes.filter((q) => q !== r);
  } else {
    const key = { point: 'points', route: 'routes', area: 'areas' }[sel.kind];
    s[key] = s[key].filter((x) => x.id !== sel.id);
    S.sel = null;
  }
  if (S.drafting && !s.routes.some((r) => r.id === S.drafting)) S.drafting = null;
  changed();
}

function setTool(t) {
  if (S.tool === 'route' && t !== 'route') finishRoute();
  S.tool = t;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
  updateHud();
}

const HINTS = {
  select: 'Drag things to move them (they drop onto the floor). Drag empty space to pan, scroll to zoom. Delete removes the selection.',
  point: 'Click to place a point; drag while placing to set the way it faces.',
  route: 'Click to add points. Enter, double-click or Esc finishes. Routes loop back to their first point.',
  area: 'Click the middle of the area and drag out its size. A trigger can fire when a player walks in.',
};

function updateHud() {
  const h = S.hover;
  let where = '';
  if (h && S.geo) {
    const all = surfacesAt(h.wx, h.wy);
    const below = all.filter((z) => z <= S.cut + 8);
    where = 'x ' + Math.round(h.wx) + '  y ' + Math.round(h.wy) + '  floor ' + (below.length ? Math.round(below[0]) : '-');
    if (below.length > 1) where += '  (also ' + below.slice(1, 4).map(Math.round).join(', ') + ')';
    const above = all.filter((z) => z > S.cut + 8);
    if (above.length) where += '  | above the cut: ' + above.slice(-3).reverse().map(Math.round).join(', ');
  }
  const e = S.entHover;
  if (e) {
    where += '  |  ' + e.c + (e.npc ? ' (' + e.npc + ')' : '') + (e.n ? '  "' + e.n + '"' : '') + (e.t ? '  -> ' + e.t : '') + '  z ' + e.z;
  }
  $('#hud').innerHTML = '<div>' + esc(where) + '</div><div class="muted">' + esc(HINTS[S.tool] || '') + '</div>';
}

// --- Cut height ---------------------------------------------------------------

function setCut(v, save = true) {
  S.cut = Math.round(v);
  $('#cut').value = S.cut;
  $('#cut-val').textContent = S.cut;
  document.querySelectorAll('#levels button').forEach((b) => b.classList.toggle('active', Math.abs(+b.dataset.cut - S.cut) < 4));
  if (save) try { localStorage.setItem('ht-cut-' + SCENARIO_ID, S.cut); } catch (e) { /* private mode */ }
  checkRoutes();
  draw();
  updateHud();
}

function setupCut() {
  const G = S.geo, el = $('#cut');
  el.min = Math.floor(G.zmin); el.max = Math.ceil(G.zmax + 200);
  el.addEventListener('input', () => setCut(+el.value));
  $('#levels').innerHTML = G.levels.map((z) => '<button type="button" data-cut="' + (z + 140) + '" title="Floors around ' + z + '">' + z + '</button>').join('');
  $('#levels').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setCut(+b.dataset.cut); });
  let start = null;
  try { start = localStorage.getItem('ht-cut-' + SCENARIO_ID); } catch (e) { /* private mode */ }
  if (start === null) {
    const zs = allPositions().map((p) => p.z);
    // Just above what's placed, else just above where players spawn.
    start = zs.length ? Math.max(...zs) + 140 : (G.spawnZ !== null && G.spawnZ !== undefined ? G.spawnZ + 100 :
      (G.levels.length ? G.levels[Math.floor(G.levels.length / 2)] + 140 : G.zmax));
  }
  setCut(+start, false);
}

// --- Checks ---------------------------------------------------------------------

function wallsCrossed(a, b) {
  const w = S.geo.walls, lo = Math.min(a.z, b.z) + 20, hi = Math.max(a.z, b.z) + 60;
  const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x), miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
  for (let i = 0; i < w.length; i += 6) {
    if (w[i + 4] > hi || w[i + 5] < lo) continue;
    if (Math.max(w[i], w[i + 2]) < minx || Math.min(w[i], w[i + 2]) > maxx || Math.max(w[i + 1], w[i + 3]) < miny || Math.min(w[i + 1], w[i + 3]) > maxy) continue;
    if (segsCross(a.x, a.y, b.x, b.y, w[i], w[i + 1], w[i + 2], w[i + 3])) return true;
  }
  return false;
}

function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay), d2 = o(cx, cy, dx, dy, bx, by), d3 = o(ax, ay, bx, by, cx, cy), d4 = o(ax, ay, bx, by, dx, dy);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 && d2 && d3 && d4;
}

function checkRoutes() {
  if (!S.geo || !S.scn) return;
  S.crossings = {};
  for (const r of S.scn.routes) {
    const bad = [];
    const n = r.points.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (n < 2 || (j === 0 && n < 3)) break;
      if (wallsCrossed(r.points[i], r.points[j])) bad.push(i);
    }
    if (bad.length) S.crossings[r.id] = bad;
  }
}

function knownNpc(name) {
  const l = String(name).toLowerCase();
  return S.npcs.some((n) => n.name.toLowerCase() === l) || S.scn.npcTypes.some((n) => n.name.toLowerCase() === l);
}

function validate() {
  const s = S.scn, out = [];
  const add = (level, text, focus) => out.push({ level, text, focus });
  const ids = (list) => new Set(list.map((x) => x.id));
  const pointIds = ids(s.points), routeIds = ids(s.routes), areaIds = ids(s.areas), groupIds = ids(s.groups), trigIds = ids(s.triggers);
  const startsSpawned = s.groups.some((g) => g.spawnAtStart);
  if (!s.triggers.length && !startsSpawned) add('error', 'Nothing happens yet: tick "Spawn when the scenario starts" on a group, or add a trigger.', { tab: 'triggers' });
  else if (s.triggers.length && !startsSpawned && !s.triggers.some((t) => ['start', 'timer', 'enter_area', 'all_in_area', 'players'].includes(t.when))) add('error', 'No trigger fires by itself - one needs When: start, a timer or a player entering an area (or a group that spawns at the start).', { tab: 'triggers' });
  if (s.limitClasses) {
    const c = ((LISTS.cls || {}).classes || {})[s.classMode === 'legends' ? 'legends' : 'map'];
    const sides = s.joinTeam && s.joinTeam !== 'any' ? [s.joinTeam] : ['team1', 'team2'];
    for (const tm of sides) {
      if (c && classIds(c, tm).length && !classIds(c, tm).some((id) => (s.classes || []).includes(id)))
        add('error', 'No ' + S.teams[tm] + ' class is ticked - nobody could play that side.', { tab: 'scenario' });
    }
    if (!(s.classes || []).length) add('error', 'Classes are limited but none is ticked.', { tab: 'scenario' });
  }
  const spawned = new Set();
  s.triggers.forEach((t) => t.actions.forEach((a) => { if (a.do === 'spawn') spawned.add(a.group); }));
  for (const g of s.groups) {
    const nm = g.name || 'a group';
    if (!g.npcs.length && !g.leader) add('error', 'Group "' + nm + '" has no NPC types.', { tab: 'groups' });
    if (g.spawnAtStart && !pointIds.has(g.spawn) && !routeIds.has(g.spawn)) add('error', 'Group "' + nm + '" spawns at the start - pick where (Spawns at).', { tab: 'groups' });
    if (g.behaviour === 'route' && !routeIds.has(g.route)) add('warn', 'Group "' + nm + '" walks a route but none is picked - it will just hunt.', { tab: 'groups' });
    if (!spawned.has(g.id) && !g.spawnAtStart) add('warn', 'Group "' + nm + '" is never spawned - tick "Spawn when the scenario starts", or spawn it from a trigger.', { tab: 'groups' });
    if (s.joinTeam && s.joinTeam !== 'any' && g.attacks && g.attacks !== 'all' && g.attacks !== s.joinTeam)
      add('warn', 'Group "' + nm + '" only attacks ' + S.teams[g.attacks] + ', but players can only join ' + S.teams[s.joinTeam] + ' - so they\'re allies, not enemies.', { tab: 'groups' });
    [...g.npcs, g.leader].filter(Boolean).forEach((n) => { if (!knownNpc(n)) add('warn', 'Group "' + nm + '": NPC type "' + n + '" isn\'t one the server has.', { tab: 'groups' }); });
  }
  for (const t of s.triggers) {
    const nm = t.name || 'a trigger';
    if (t.when === 'enter_area' && !areaIds.has(t.area)) add('error', 'Trigger "' + nm + '": pick the area.', { tab: 'triggers' });
    if (t.when === 'group_dead' && !groupIds.has(t.group)) add('error', 'Trigger "' + nm + '": pick the group.', { tab: 'triggers' });
    if (t.when === 'after' && !trigIds.has(t.trigger)) add('error', 'Trigger "' + nm + '": pick the trigger it follows.', { tab: 'triggers' });
    if (!t.actions.length) add('warn', 'Trigger "' + nm + '" does nothing - add an action.', { tab: 'triggers' });
    if (t.actions.length > 16) add('error', 'Trigger "' + nm + '" has ' + t.actions.length + ' actions - 16 at most (only the first 16 are kept). Split it, e.g. with "Some seconds after another trigger".', { tab: 'triggers' });
    if ((t.when === 'all_in_area') && !areaIds.has(t.area)) add('error', 'Trigger "' + nm + '": pick the area.', { tab: 'triggers' });
    if ((t.when === 'group_left') && !groupIds.has(t.group)) add('error', 'Trigger "' + nm + '": pick the group.', { tab: 'triggers' });
    if (t.when === 'counter' && !s.counters.some((c) => c.id === t.counter)) add('error', 'Trigger "' + nm + '": pick the counter.', { tab: 'triggers' });
    if (t.when === 'countdown_end' && !s.triggers.some((x) => x.actions.some((a) => a.do === 'countdown'))) add('warn', 'Trigger "' + nm + '" waits for a countdown, but nothing starts one.', { tab: 'triggers' });
    const placeIds = new Set([...pointIds, ...areaIds]);
    const hasPlayer = whenHasPlayer(t);
    t.actions.forEach((a) => {
      if (a.do === 'tell' && !hasPlayer) add('warn', 'Trigger "' + nm + '": "Tell the player" needs a trigger one player sets off (walks into an area, dies).', { tab: 'triggers' });
      if (['explode', 'effect'].includes(a.do) && !placeIds.has(a.at) && !(a.at === 'player' && hasPlayer)) add('error', 'Trigger "' + nm + '": pick where the ' + (a.do === 'explode' ? 'explosion' : 'effect') + ' happens.', { tab: 'triggers' });
      if (a.do === 'teleport' && !placeIds.has(a.at)) add('error', 'Trigger "' + nm + '": pick where to teleport them to.', { tab: 'triggers' });
      if (a.do === 'use' && !a.target) add('error', 'Trigger "' + nm + '": pick the map entity to use.', { tab: 'triggers' });
      if (a.do === 'despawn' && !groupIds.has(a.group)) add('error', 'Trigger "' + nm + '": a Remove action has no group.', { tab: 'triggers' });
      if (a.do === 'move' && !groupIds.has(a.group)) add('error', 'Trigger "' + nm + '": a New orders action has no group.', { tab: 'triggers' });
      if (a.do === 'move' && a.behaviour === 'route' && !routeIds.has(a.route)) add('error', 'Trigger "' + nm + '": pick the route for the group\'s new orders.', { tab: 'triggers' });
      if ((a.do === 'trigger_on' || a.do === 'trigger_off') && !trigIds.has(a.trigger)) add('error', 'Trigger "' + nm + '": pick the trigger to turn ' + (a.do === 'trigger_on' ? 'on.' : 'off.'), { tab: 'triggers' });
      if (a.do === 'counter' && !s.counters.some((c) => c.id === a.counter)) add('error', 'Trigger "' + nm + '": pick the counter to change.', { tab: 'triggers' });
      if ((a.do === 'vehicle' || a.do === 'pickup') && !placeIds.has(a.at) && !(a.at === 'player' && hasPlayer)) add('error', 'Trigger "' + nm + '": pick where the ' + a.do + ' goes.', { tab: 'triggers' });
      if (a.do === 'vehicle' && !a.vehicle) add('error', 'Trigger "' + nm + '": pick the vehicle.', { tab: 'triggers' });
      if (a.do === 'pickup' && !a.item) add('error', 'Trigger "' + nm + '": pick the pickup.', { tab: 'triggers' });
      if (a.do === 'give' && !a.item) add('error', 'Trigger "' + nm + '": pick what to give.', { tab: 'triggers' });
      if (a.do === 'texture' && (!a.from || !a.to)) add('error', 'Trigger "' + nm + '": pick both textures for the swap.', { tab: 'triggers' });
      if (a.who === 'player' && !hasPlayer && ['give', 'heal', 'kill', 'knockdown', 'freeze'].includes(a.do)) add('warn', 'Trigger "' + nm + '": "the player who set it off" - this trigger isn\'t set off by one player.', { tab: 'triggers' });
      if (a.do === 'spawn' && !groupIds.has(a.group)) add('error', 'Trigger "' + nm + '": a Spawn action has no group.', { tab: 'triggers' });
      if (a.do === 'spawn' && !pointIds.has(a.at) && !routeIds.has(a.at)) add('error', 'Trigger "' + nm + '": pick where the group spawns.', { tab: 'triggers' });
      if (a.do === 'say' && !a.text && !a.path) add('warn', 'Trigger "' + nm + '": a Say action is empty.', { tab: 'triggers' });
    });
  }
  if (s.triggers.length && !s.triggers.some((t) => t.actions.some((a) => a.do === 'end' || a.do === 'win')))
    add('info', 'Nothing ends it, so it runs until its time limit - e.g. add When: everyone\'s down - End (or Win the round).', { tab: 'triggers' });
  for (const r of s.routes) {
    if (r.points.length < 2) add('warn', 'Route "' + r.name + '" has fewer than 2 points.', { kind: 'route', id: r.id });
    if (S.crossings[r.id]) add('warn', 'Route "' + r.name + '" goes through a wall (red) - NPCs may get stuck. Add a point to go round it.', { kind: 'route', id: r.id });
  }
  if (s.npcTypes.length) add('info', 'NPC types made here can be spawned after the server\'s next map change.', { tab: 'npcs' });
  S.problems = out;
  const errors = out.filter((p) => p.level === 'error').length, warns = out.filter((p) => p.level === 'warn').length;
  const chip = $('#checks-chip');
  chip.textContent = errors ? errors + ' to fix' : warns ? warns + ' warning' + (warns > 1 ? 's' : '') : 'Ready';
  chip.className = 'chip ' + (errors ? 'bad' : warns ? 'warn' : 'good');
}

// --- Panels -------------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

function field(labelText, control, help) {
  return h('label', { class: 'field' }, h('span', {}, labelText), control, help ? h('small', { class: 'muted' }, help) : null);
}

function textIn(obj, key, attrs = {}, after) {
  return h('input', Object.assign({ value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; soft(); if (after) after(); } }, attrs));
}

function numIn(obj, key, attrs = {}, after) {
  return h('input', Object.assign({ type: 'number', value: obj[key] ?? 0, oninput: (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { obj[key] = v; soft(); draw(); if (after) after(); } } }, attrs));
}

function selectIn(obj, key, options, after) {
  const sel = h('select', { onchange: (e) => { obj[key] = e.target.value; changed(); if (after) after(); } });
  for (const o of options) sel.append(h('option', { value: o.v, selected: String(obj[key] ?? '') === String(o.v) }, o.t));
  return sel;
}

// --- Undo / redo ---------------------------------------------------------------
//
// The scenario as it was after each change, as JSON. An edit's changed()
// or soft() call comes after it's made, so the last snapshot is what it was
// before. Typing (soft) is gathered up into one step once it pauses.
const HIST = { undo: [], redo: [], last: null, timer: null, max: 150 };

function commitHistory() {
  clearTimeout(HIST.timer);
  HIST.timer = null;
  const now = JSON.stringify(S.scn);
  if (HIST.last !== null && now !== HIST.last) {
    HIST.undo.push(HIST.last);
    if (HIST.undo.length > HIST.max) HIST.undo.shift();
    HIST.redo = [];
  }
  HIST.last = now;
  updateUndoButtons();
}

function resetHistoryBase() { HIST.last = JSON.stringify(S.scn); updateUndoButtons(); }

function updateUndoButtons() {
  const u = $('#undo-btn'), r = $('#redo-btn');
  if (u) { u.disabled = !HIST.undo.length && !HIST.timer; u.title = 'Undo (Ctrl+Z)' + (HIST.undo.length ? ' - ' + HIST.undo.length + ' step' + (HIST.undo.length > 1 ? 's' : '') : ''); }
  if (r) r.disabled = !HIST.redo.length;
}

function restore(json) {
  S.scn = normalise(JSON.parse(json));
  HIST.last = json;
  S.drafting = null;
  S.drag = null;
  if (S.sel) {
    const o = find(S.sel.kind, S.sel.id);
    if (!o) S.sel = null;
    else if (S.sel.vi !== undefined && S.sel.vi >= o.points.length) delete S.sel.vi;
  }
  $('#scn-name').value = S.scn.name;
  markDirty();
  checkRoutes();
  validate();
  renderPanels();
  draw();
  updateUndoButtons();
}

function undo() {
  if (HIST.timer) commitHistory(); // typing still being gathered: that's the step to undo
  if (!HIST.undo.length) return;
  HIST.redo.push(HIST.last);
  restore(HIST.undo.pop());
}

function redo() {
  if (HIST.timer) commitHistory();
  if (!HIST.redo.length) return;
  HIST.undo.push(HIST.last);
  restore(HIST.redo.pop());
}

// A small edit that doesn't redraw the panels (so typing keeps focus).
function soft() {
  markDirty();
  validate();
  clearTimeout(HIST.timer);
  HIST.timer = setTimeout(commitHistory, 700);
  updateUndoButtons();
}

function changed() {
  commitHistory();
  markDirty();
  checkRoutes();
  validate();
  renderPanels();
  draw();
}

function markDirty() {
  S.dirty = true;
  $('#save-state').textContent = 'Unsaved changes';
}

let activeTab = 'scenario';
function showTab(t) {
  activeTab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.id !== 'tab-' + t; });
  renderPanels(t);
}

function renderPanels(only) {
  const which = only ? [only] : [activeTab];
  for (const t of which) {
    if (t !== activeTab) continue;
    const el = $('#tab-' + t);
    el.innerHTML = '';
    ({ scenario: renderScenario, places: renderPlaces, npcs: renderNpcs, groups: renderGroups, triggers: renderTriggers, checks: renderChecks })[t](el);
  }
}

function renderScenario(el) {
  const s = S.scn;
  el.append(
    field('Name', textIn(s, 'name', { maxlength: 60 }, () => { $('#scn-name').value = s.name; })),
    field('Description', textIn(s, 'description', { maxlength: 200, placeholder: 'Shown in the !ht list' })),
    field('Time limit (minutes)', h('input', { type: 'number', min: 1, max: 60, value: Math.round(s.timeLimit / 60), oninput: (e) => { s.timeLimit = clamp(Math.round(+e.target.value * 60) || 900, 30, 3600); soft(); } }), 'It ends by itself after this long. The round clock is held open for it.'),
    h('h3', {}, 'Players'),
    field('Players can join', selectIn(s, 'joinTeam', [
      { v: 'any', t: 'Either team (team balance as normal)' },
      { v: 'team1', t: 'Only ' + S.teams.team1 + ' - co-op, balance off' },
      { v: 'team2', t: 'Only ' + S.teams.team2 + ' - co-op, balance off' },
    ]), s.joinTeam && s.joinTeam !== 'any'
      ? 'Everyone plays on one side (so no friendly fire). Anyone who picks a ' + (s.joinTeam === 'team1' ? S.teams.team2 : S.teams.team1) + ' class is sent back to pick again.'
      : 'Side names are this map\'s own.'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!s.anytimeSpawn, onchange: (e) => { s.anytimeSpawn = e.target.checked; changed(); } }),
      h('span', {}, 'Anytime spawn - join any time, and respawn after dying')),
    ...(s.anytimeSpawn ? [field('Respawn after (seconds)', numIn(s, 'respawnSeconds', { min: 1, max: 60 }))] : []),
    h('h3', {}, 'Classes'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!s.limitClasses, onchange: (e) => {
      s.limitClasses = e.target.checked;
      if (s.limitClasses && !(s.classes || []).length) {
        // Start from every class, to untick the ones not wanted.
        loadList('cls', '/api/maps/' + encodeURIComponent(s.map) + '/classes', 'classes').then((c) => { s.classes = classIds(c[s.classMode || 'map']); changed(); });
      } else changed();
    } }), h('span', {}, 'Limit the classes players can pick')),
    ...(s.limitClasses ? [classPicker(s)] : []),
    h('div', { class: 'info' },
      h('b', {}, 'Playing it: '), 'on any server running the Holotable plugin, change to ', h('code', {}, s.map),
      ', log in (', h('code', {}, '!login'), ') and type ', h('code', {}, '!ht'), ' to list the map\'s scenarios. ',
      h('code', {}, '!ht <n> play'), ' runs one, ', h('code', {}, '!ht restart'), ' reloads it after you save a change here, and ',
      h('code', {}, '!ht stop'), ' ends it - for game admins and accounts ticked to run scenarios.'),
    h('div', { class: 'stats' },
      stat(s.points.length, 'points'), stat(s.routes.length, 'routes'), stat(s.areas.length, 'areas'),
      stat(s.npcTypes.length, 'NPC types'), stat(s.groups.length, 'groups'), stat(s.triggers.length, 'triggers')),
    h('p', {}, h('a', { href: '/api/scenarios/' + SCENARIO_ID, target: '_blank' }, 'View the saved JSON')),
  );
}

// Every class (and subclass) id in a map's /classes answer, by side.
function classIds(c, team) {
  c = c || {};
  return ['team1', 'team2'].filter((tm) => !team || tm === team)
    .flatMap((tm) => ((c[tm] || {}).classes || []).flatMap((k) => [k.id].concat(k.sub.map((x) => x.id))));
}

function classPicker(s) {
  const box = h('div', { class: 'class-list' }, h('small', { class: 'muted' }, 'Loading this map\'s classes...'));
  loadList('cls', '/api/maps/' + encodeURIComponent(s.map) + '/classes', 'classes').then((c) => {
    c = c || {};
    box.innerHTML = '';
    s.classes = s.classes || [];
    const mode = s.classMode === 'legends' ? 'legends' : 'map';
    box.append(field('Server mode', selectIn(s, 'classMode', [
      { v: 'map', t: 'Open / Semi-Authentic - this map\'s own classes' },
      { v: 'legends', t: 'Legends - the Legends roster' },
    ], () => { if (!s.classes.some((id) => classIds(c[s.classMode]).includes(id))) s.classes = classIds(c[s.classMode]); changed(); }),
      'Pick the mode the server runs - the classes differ.'));
    c = c[mode] || {};
    const tick = (id, name, sub) => h('label', { class: 'check-row' + (sub ? ' indent' : '') },
      h('input', { type: 'checkbox', checked: s.classes.includes(id), onchange: (e) => {
        s.classes = s.classes.filter((x) => x !== id).concat(e.target.checked ? [id] : []); changed();
      } }), h('span', {}, name, ' ', h('small', { class: 'muted' }, id)));
    for (const tm of ['team1', 'team2']) {
      if (s.joinTeam && s.joinTeam !== 'any' && s.joinTeam !== tm) continue;
      const side = c[tm] || { classes: [] };
      const all = classIds(c, tm);
      box.append(h('div', { class: 'row-end' }, h('b', { class: 'grow' }, S.teams[tm]),
        h('button', { class: 'btn small', onclick: () => { s.classes = s.classes.filter((x) => !all.includes(x)).concat(all); changed(); } }, 'All'),
        h('button', { class: 'btn small', onclick: () => { s.classes = s.classes.filter((x) => !all.includes(x)); changed(); } }, 'None')));
      if (!side.classes.length) box.append(h('small', { class: 'muted' }, 'No classes found for this side.'));
      for (const k of side.classes) {
        box.append(tick(k.id, k.name + (k.kind ? ' (' + k.kind + ')' : ''), false));
        k.sub.forEach((x) => box.append(tick(x.id, x.name, true)));
      }
    }
    box.append(h('small', { class: 'muted' }, 'Anyone on another class is told to pick again. ' + (mode === 'legends' ? 'Legends classes are the same on every map.' : 'From this map\'s own team setups.') + ' Not in Full Authentic mode, where players build their own classes.'));
  });
  return box;
}

function stat(n, t) { return h('div', { class: 'stat' }, h('b', {}, String(n)), h('span', {}, t)); }

function centreOn(x, y) { S.view.cx = x; S.view.cy = y; draw(); }

function renderPlaces(el) {
  const s = S.scn, sel = S.sel && find(S.sel.kind, S.sel.id);
  if (sel) {
    const box = h('div', { class: 'card selected' });
    const kind = S.sel.kind;
    box.append(h('div', { class: 'card-title' }, h('span', { class: 'tag ' + kind }, kind), textIn(sel, 'name', { maxlength: 40, class: 'grow' }, draw)));
    if (kind === 'point' || kind === 'area') {
      box.append(h('div', { class: 'grid3' }, field('x', numIn(sel, 'x')), field('y', numIn(sel, 'y')), field('z', numIn(sel, 'z'))));
      const floors = surfacesAt(sel.x, sel.y);
      if (floors.length > 1) box.append(h('div', { class: 'snap' }, h('span', { class: 'muted small' }, 'Floors here: '),
        floors.slice(0, 6).map((z) => h('button', { class: 'btn tiny' + (Math.abs(z - sel.z) < 2 ? ' on' : ''), onclick: () => { sel.z = Math.round(z); changed(); } }, String(Math.round(z))))));
    }
    if (kind === 'point') box.append(field('Facing (degrees)', numIn(sel, 'yaw', { min: 0, max: 359 })));
    if (kind === 'area') box.append(h('div', { class: 'grid2' }, field('Radius', numIn(sel, 'radius', { min: 16 })), field('Height', numIn(sel, 'height', { min: 32 }))));
    if (kind === 'route') {
      const tbl = h('table', { class: 'mini' }, h('tr', {}, h('th', {}, '#'), h('th', {}, 'x'), h('th', {}, 'y'), h('th', {}, 'z'), h('th', {})));
      sel.points.forEach((p, i) => tbl.append(h('tr', { class: S.sel.vi === i ? 'on' : '' },
        h('td', {}, String(i + 1)), h('td', {}, String(Math.round(p.x))), h('td', {}, String(Math.round(p.y))),
        h('td', {}, h('input', { type: 'number', value: p.z, class: 'tiny-in', oninput: (e) => { p.z = +e.target.value; soft(); } })),
        h('td', {}, h('button', { class: 'btn tiny danger', title: 'Remove this point', onclick: () => { sel.points.splice(i, 1); changed(); } }, 'x')))));
      box.append(tbl, h('button', { class: 'btn small', onclick: () => { S.drafting = sel.id; setTool('route'); S.tool = 'route'; } }, 'Add more points'));
      if (S.crossings[sel.id]) box.append(h('div', { class: 'warnline' }, 'Red legs go through a wall.'));
    }
    box.append(h('div', { class: 'row-end' }, h('button', { class: 'btn small', onclick: () => { const p = kind === 'route' ? sel.points[0] : sel; if (p) centreOn(p.x, p.y); } }, 'Centre'),
      h('button', { class: 'btn small danger', onclick: () => { S.sel = { kind, id: sel.id }; deleteSelection(); } }, 'Delete ' + kind)));
    el.append(box);
  } else {
    el.append(h('p', { class: 'muted' }, 'Pick a tool on the left and click the map. Heights come from the floor under the cut height.'));
  }
  const listFor = (title, kind, items, desc) => {
    el.append(h('h3', {}, title + ' ', h('span', { class: 'badge' }, String(items.length))));
    if (!items.length) { el.append(h('p', { class: 'muted small' }, 'None yet.')); return; }
    const ul = h('div', { class: 'list' });
    for (const it of items) ul.append(h('button', { class: 'list-item' + (isSel(kind, it.id) ? ' on' : ''), onclick: () => {
      S.sel = { kind, id: it.id };
      const p = kind === 'route' ? it.points[0] : it;
      if (p) centreOn(p.x, p.y);
      renderPanels('places');
    } }, h('span', { class: 'dot ' + kind }), it.name || '(unnamed)', h('span', { class: 'muted small' }, desc(it))));
    el.append(ul);
  };
  listFor('Points', 'point', s.points, (p) => ' z ' + Math.round(p.z) + ', facing ' + Math.round(p.yaw));
  listFor('Routes', 'route', s.routes, (r) => ' ' + r.points.length + ' points' + (S.crossings[r.id] ? ' - through a wall!' : ''));
  listFor('Areas', 'area', s.areas, (a) => ' radius ' + Math.round(a.radius));
}

// A searchable dropdown: type to filter, arrows and Enter (or a click) to
// pick. items: [{ value, label, sub, icon }]. freeText: what's typed counts
// as the value too (onType), for names the lists don't have.
const COMBO_SHOWN = 80;
function combo({ value = '', items, placeholder = '', onPick, onType, clearOnPick = false }) {
  const wrap = h('div', { class: 'combo' });
  const input = h('input', { value, placeholder, autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'combo-list', hidden: true });
  wrap.append(input, list);
  let shown = [], active = -1;

  const iconFor = (it) => {
    if (!it.icon) return null;
    const img = h('img', { src: it.icon, loading: 'lazy', alt: '' });
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    return img;
  };
  const fill = (showAll) => {
    const q = showAll ? '' : input.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const all = typeof items === 'function' ? items() : items;
    const hits = words.length ? all.filter((it) => {
      const hay = (it.value + ' ' + (it.label || '') + ' ' + (it.sub || '') + ' ' + (it.search || '')).toLowerCase();
      return words.every((w) => hay.includes(w));
    }) : all;
    // Names starting with what's typed first.
    if (q) hits.sort((a, b) => (b.value.toLowerCase().startsWith(q) - a.value.toLowerCase().startsWith(q)));
    shown = hits.slice(0, COMBO_SHOWN);
    active = shown.length ? 0 : -1;
    list.innerHTML = '';
    shown.forEach((it, i) => list.append(h('div', { class: 'combo-item' + (i === active ? ' on' : ''), 'data-i': i,
      onmousedown: (e) => { e.preventDefault(); pick(i); } },
      iconFor(it) || h('span', { class: 'combo-noicon' }),
      h('span', { class: 'combo-text' }, h('b', {}, it.label || it.value), it.sub ? h('small', {}, it.sub) : null))));
    if (!shown.length) list.append(h('div', { class: 'combo-empty' }, q ? 'Nothing matches "' + input.value.trim() + '"' : 'Nothing to pick'));
    else if (hits.length > shown.length) list.append(h('div', { class: 'combo-empty' }, (hits.length - shown.length) + ' more - keep typing to narrow it down'));
  };
  const highlight = (i) => {
    active = i;
    list.querySelectorAll('.combo-item').forEach((el, j) => el.classList.toggle('on', j === i));
    const el = list.querySelector('.combo-item.on');
    if (el) el.scrollIntoView({ block: 'nearest' });
  };
  // Opened by clicking in: everything (the current value highlighted, if
  // it's there), with the text selected so typing replaces it.
  const open = (all) => {
    fill(all);
    list.hidden = false;
    if (all && input.value) {
      const i = shown.findIndex((it) => it.value.toLowerCase() === input.value.trim().toLowerCase());
      if (i >= 0) highlight(i);
    }
  };
  const close = () => { list.hidden = true; };
  const pick = (i) => {
    const it = shown[i];
    if (!it) return;
    const query = input.value.trim().toLowerCase();
    input.value = clearOnPick ? '' : it.value;
    close();
    onPick(it.value, query);
  };
  input.addEventListener('focus', () => { open(true); input.select(); });
  input.addEventListener('click', () => { if (list.hidden) open(true); });
  input.addEventListener('input', () => { open(); if (onType) onType(input.value.trim()); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(true); else highlight(Math.min(shown.length - 1, active + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(0, active - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (!list.hidden && active >= 0) pick(active);
      else if (clearOnPick && input.value.trim()) { const v = input.value.trim(); input.value = ''; close(); onPick(v); }
    } else if (e.key === 'Escape') { close(); }
  });
  return wrap;
}

const iconUrl = (model, skin) => '/api/models/' + encodeURIComponent(model || 'x') + '/' + encodeURIComponent(skin || 'default') + '/icon';

function modelItems() {
  // Skins are searched too ("clone arc" finds clonetrooper_p2's arc skins).
  return S.models.map((m) => ({ value: m.model, sub: m.skins.length + ' skin' + (m.skins.length === 1 ? '' : 's') + ': ' + m.skins.slice(0, 8).join(', '),
    search: m.skins.join(' '), icon: iconUrl(m.model, 'default') }));
}

// Every NPC type a group can use: this scenario's own, then the server's.
function npcItems() {
  const own = S.scn.npcTypes.map((n) => ({ value: n.name, sub: 'this scenario - ' + (n.model || '?') + ' / ' + n.weapon.replace(/^WP_/, '').toLowerCase(), icon: iconUrl(n.model, n.skin) }));
  return own.concat(S.npcs.map((n) => ({ value: n.name, sub: n.model || '', icon: n.model ? iconUrl(n.model, 'default') : null })));
}

function modelSkins(model) {
  const m = S.models.find((x) => x.model.toLowerCase() === String(model || '').toLowerCase());
  return m ? m.skins : [];
}

// --- Folding cards (NPC types, groups, triggers) ------------------------------
//
// A folded card is just its title row and a one-line summary. They start
// folded; which have been opened is kept per scenario in this browser (new
// and cloned ones open, to be filled in).
let OPEN = new Set();
function loadFolded() {
  try { OPEN = new Set(JSON.parse(localStorage.getItem('ht-open-' + SCENARIO_ID) || '[]')); } catch (e) { OPEN = new Set(); }
}
function saveFolded() {
  try { localStorage.setItem('ht-open-' + SCENARIO_ID, JSON.stringify([...OPEN])); } catch (e) { /* private mode */ }
}
function openCard(id) { OPEN.add(id); saveFolded(); }

function foldable(card, id, summary) {
  const title = card.firstChild;
  const body = h('div', { class: 'fold-body' });
  while (card.childNodes.length > 1) body.append(card.childNodes[1]);
  const sum = h('div', { class: 'fold-summary' }, summary);
  card.append(sum, body);
  const btn = h('button', { class: 'fold-btn', type: 'button', title: 'Fold / unfold' });
  title.prepend(btn);
  const apply = () => {
    const folded = !OPEN.has(id);
    card.classList.toggle('folded', folded);
    body.hidden = folded;
    sum.hidden = !folded;
    btn.textContent = folded ? '\u25B8' : '\u25BE';
  };
  const toggle = () => { if (OPEN.has(id)) OPEN.delete(id); else OPEN.add(id); saveFolded(); apply(); };
  btn.addEventListener('click', toggle);
  sum.addEventListener('click', toggle);
  apply();
  return card;
}

function foldBar(ids, what) {
  const set = (fold) => { ids.forEach((id) => (fold ? OPEN.delete(id) : OPEN.add(id))); saveFolded(); renderPanels(); };
  return h('div', { class: 'fold-bar' },
    h('button', { class: 'btn tiny', type: 'button', onclick: () => set(true) }, 'Fold all ' + what),
    h('button', { class: 'btn tiny', type: 'button', onclick: () => set(false) }, 'Unfold all'));
}

const nameOf = (list, id) => ((list.find((x) => x.id === id) || {}).name || '?');
function npcSummary(n) {
  return [(n.model || '?') + ' / ' + (n.skin || 'default'), (n.weapon || '').replace(/^WP_/, '').replace(/_/g, ' ').toLowerCase(),
    n.health + ' health' + (n.armor ? ', ' + n.armor + ' armour' : ''), 'skill ' + n.skill].join(' \u00B7 ');
}
function groupSummary(g) {
  const who = g.npcs.length ? g.npcs.join(', ') : 'no NPC types';
  const many = g.count + (g.perPlayer ? ' +' + g.perPlayer + '/player' : '') + (g.leader ? ' + ' + g.leader : '');
  const attacks = !g.attacks || g.attacks === 'all' ? 'attacks everyone' : 'attacks ' + S.teams[g.attacks];
  return [who, many, g.behaviour, attacks].concat(g.spawnAtStart ? ['at start: ' + nameOf(S.scn.points.concat(S.scn.routes), g.spawn)] : []).join(' \u00B7 ');
}
const ACTION_SHORT = {
  spawn: 'spawn', despawn: 'remove group', say: 'NPC speech', tell: 'tell player', message: 'chat', center: 'centre message',
  explode: 'explosion', effect: 'effect', shake: 'shake', sound: 'sound', music: 'music', teleport: 'teleport', use: 'use entity',
  give: 'give', heal: 'heal', kill: 'kill', knockdown: 'knock down', freeze: 'freeze', vehicle: 'vehicle', pickup: 'pickup',
  move: 'new orders', trigger_on: 'trigger on', trigger_off: 'trigger off', counter: 'counter', countdown: 'countdown',
  objective: 'objective', texture: 'texture swap', gravity: 'gravity', speed: 'speed', addtime: 'round time', win: 'win round', end: 'end',
};
function triggerSummary(t) {
  const when = (WHENS.find((w) => w.v === t.when) || {}).t || t.when;
  const acts = t.actions.map((a) => ACTION_SHORT[a.do] || a.do);
  return [when, t.actions.length + ' action' + (t.actions.length === 1 ? '' : 's') + (acts.length ? ': ' + acts.slice(0, 4).join(', ') + (acts.length > 4 ? '...' : '') : '')]
    .concat(t.repeat ? ['every time'] : [], t.startOff ? ['starts off'] : []).join(' \u00B7 ');
}

function renderNpcs(el) {
  const s = S.scn;
  el.append(h('p', { class: 'muted' }, 'Your own NPC types for this scenario. They\'re hostile to everyone, like bar fight NPCs. Saving writes them into the server\'s NPC folder; ',
    h('b', {}, 'new or changed types work after the server\'s next map change.'), ' Groups can also use any of the ' + S.npcs.length + ' types the server already has.'));
  if (s.npcTypes.length) el.append(foldBar(s.npcTypes.map((n) => 'npc:' + n.name), 'npcs'));
  s.npcTypes.forEach((n, i) => {
    const card = h('div', { class: 'card' });
    const skinSel = h('select', { onchange: (e) => { n.skin = e.target.value; soft(); updIcon(); } });
    const icon = h('img', { class: 'npc-icon', alt: '' });
    icon.addEventListener('error', () => { icon.style.visibility = 'hidden'; });
    icon.addEventListener('load', () => { icon.style.visibility = 'visible'; });
    const updIcon = () => { icon.src = '/api/models/' + encodeURIComponent(n.model || 'x') + '/' + encodeURIComponent(n.skin || 'default') + '/icon'; };
    const fillSkins = () => {
      const skins = modelSkins(n.model);
      skinSel.innerHTML = '';
      (skins.length ? skins : ['default']).forEach((k) => skinSel.append(h('option', { value: k, selected: k === n.skin }, k)));
      if (skins.length && !skins.includes(n.skin)) { n.skin = skins.includes('default') ? 'default' : skins[0]; skinSel.value = n.skin; }
      updIcon();
    };
    const modelIn = combo({ value: n.model, items: modelItems, placeholder: 'Search ' + S.models.length + ' models',
      onPick: (v, query) => {
        n.model = v;
        // Found by a skin's name: that skin.
        const words = (query || '').split(/\s+/).filter((w) => w && !v.toLowerCase().includes(w));
        const skin = words.length && modelSkins(v).find((k) => words.every((w) => k.toLowerCase().includes(w)));
        if (skin) n.skin = skin;
        soft();
        fillSkins();
      }, onType: (v) => { n.model = v; soft(); } });
    const nameIn = h('input', { value: n.name, maxlength: 43, oninput: (e) => {
      const old = n.name;
      let v = e.target.value.replace(/[^A-Za-z0-9_]/g, '');
      n.name = v;
      if (OPEN.has('npc:' + old)) { OPEN.delete('npc:' + old); openCard('npc:' + v); }
      s.groups.forEach((g) => { g.npcs = g.npcs.map((x) => x === old ? v : x); if (g.leader === old) g.leader = v; });
      soft();
    }, onchange: (e) => { if (!/^HT_/i.test(n.name)) { const was = n.name; n.name = 'HT_' + n.name; e.target.value = n.name; if (OPEN.has('npc:' + was)) { OPEN.delete('npc:' + was); openCard('npc:' + n.name); } soft(); } } });
    card.append(
      h('div', { class: 'card-title' }, h('span', { class: 'tag' }, 'npc'), h('b', { class: 'grow' }, n.name || 'unnamed')),
      h('div', { class: 'npc-head' }, icon, h('div', { class: 'grow' }, field('Type name', nameIn, 'Starts with HT_. Used in groups.'))),
      h('div', { class: 'grid2' }, field('Model', modelIn), field('Skin', skinSel)),
      h('div', { class: 'grid2' }, field('Weapon', selectIn(n, 'weapon', S.weapons.map((w) => ({ v: w, t: w.replace(/^WP_/, '').replace(/_/g, ' ').toLowerCase() }))), n.weapon === 'WP_SABER' ? 'Saber NPCs are experimental.' : null),
        field('Fires', h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!n.altFire, onchange: (e) => { n.altFire = e.target.checked; soft(); } }), ' alt fire'))),
      n.weapon === 'WP_SABER' ? field('Saber colour', selectIn(n, 'saberColor', SABER_COLORS.map((c) => ({ v: c, t: c })))) : null,
      h('div', { class: 'grid3' }, field('Health', numIn(n, 'health', { min: 1, max: 5000 })), field('Armour', numIn(n, 'armor', { min: 0, max: 1000 })), field('Size %', numIn(n, 'scale', { min: 40, max: 250 }))),
      h('div', { class: 'grid2' }, field('Skill', selectIn(n, 'skill', [1, 2, 3, 4, 5].map((k) => ({ v: k, t: ['', '1 - raw recruit', '2 - poor', '3 - average', '4 - veteran', '5 - elite'][k] })))),
        field('Run speed', numIn(n, 'runSpeed', { min: 50, max: 400 }))),
      h('div', { class: 'row-end' }, h('button', { class: 'btn small danger', onclick: () => { s.npcTypes.splice(i, 1); changed(); } }, 'Delete type')),
    );
    el.append(foldable(card, 'npc:' + n.name, npcSummary(n)));
    fillSkins();
  });
  el.append(h('button', { class: 'btn primary', onclick: () => {
    const npcName = 'HT_' + (S.scn.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'Npc') + (s.npcTypes.length + 1);
    openCard('npc:' + npcName);
    s.npcTypes.push({ name: npcName, model: 'stormtrooper', skin: 'default', weapon: 'WP_BLASTER', altFire: false, health: 100, armor: 0, scale: 100, skill: 3, runSpeed: 210, saberColor: 'blue' });
    changed();
  } }, '+ New NPC type'));
}

function npcChips(g) {
  const wrap = h('div', { class: 'chips' });
  g.npcs.forEach((n, i) => wrap.append(h('span', { class: 'chipx' + (knownNpc(n) ? '' : ' bad'), title: knownNpc(n) ? '' : 'Not a type the server has' }, n,
    h('button', { type: 'button', onclick: () => { g.npcs.splice(i, 1); changed(); } }, 'x'))));
  if (g.npcs.length < 8) {
    wrap.append(combo({ items: npcItems, clearOnPick: true, placeholder: g.npcs.length ? 'add another' : 'Search ' + (S.npcs.length + S.scn.npcTypes.length) + ' NPC types',
      onPick: (v) => { g.npcs.push(v); changed(); } }));
  }
  return wrap;
}

const BEHAVIOURS = [
  { v: 'hunt', t: 'Hunt - go straight for the nearest player' },
  { v: 'route', t: 'Route - walk a route, fight players who come close' },
  { v: 'guard', t: 'Guard - hold where they spawned, fight anyone close' },
  { v: 'idle', t: 'Idle - stand about (fight only if attacked)' },
];
const SABER_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const PACES = [{ v: 'walk', t: 'Walking' }, { v: 'run', t: 'Running' }];

function renderGroups(el) {
  const s = S.scn;
  el.append(h('p', { class: 'muted' }, 'Groups of NPCs, spawned by a trigger\'s Spawn action. They and the players can hurt each other.'));
  if (s.groups.length) el.append(foldBar(s.groups.map((g) => g.id), 'groups'));
  s.groups.forEach((g, i) => {
    const spawnOpts = [{ v: '', t: '- pick -' }].concat(s.points.map((p) => ({ v: p.id, t: 'Point: ' + p.name })), s.routes.map((r) => ({ v: r.id, t: 'Route: ' + r.name + ' (along it)' })));
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-title' }, h('span', { class: 'tag group' }, 'group'), textIn(g, 'name', { maxlength: 47, class: 'grow' })),
      field('NPC types', npcChips(g), 'Spawned in turn. Up to 8.'),
      field('Leader (optional)', combo({ value: g.leader, items: npcItems, placeholder: 'spawns first, once - search NPC types',
        onPick: (v) => { g.leader = v; changed(); }, onType: (v) => { g.leader = v; soft(); } })),
      h('div', { class: 'grid3' }, field('How many', numIn(g, 'count', { min: 0, max: 32 })), field('+ per player', numIn(g, 'perPlayer', { min: 0, max: 8 })), field('At most', numIn(g, 'max', { min: 1, max: 32 }))),
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!g.spawnAtStart, onchange: (e) => { g.spawnAtStart = e.target.checked; changed(); } }),
        h('span', {}, 'Spawn when the scenario starts (no trigger needed)')),
      g.spawnAtStart ? field('Spawns at', selectIn(g, 'spawn', spawnOpts), 'Where it appears as the scenario starts.')
        : h('small', { class: 'muted', style: 'display:block;margin:-6px 0 10px' }, 'Otherwise a trigger spawns it, and its Spawn action says where.'),
      field('Behaviour', selectIn(g, 'behaviour', BEHAVIOURS)),
      field('Attacks', selectIn(g, 'attacks', [
        { v: 'all', t: 'Everyone (hostile to all)' },
        { v: 'team1', t: 'Only ' + S.teams.team1 + ' - they fight for ' + S.teams.team2 },
        { v: 'team2', t: 'Only ' + S.teams.team2 + ' - they fight for ' + S.teams.team1 },
      ]), g.attacks && g.attacks !== 'all'
        ? 'Players on the other side (and NPCs fighting for it) are left alone - groups on opposite sides fight each other.'
        : 'Pick a side to make them allies of the other one.'),
      g.behaviour === 'route' ? field('Route to walk', selectIn(g, 'route', [{ v: '', t: '- pick -' }].concat(s.routes.map((r) => ({ v: r.id, t: r.name }))))) : null,
      g.behaviour === 'route' ? field('Pace', selectIn(g, 'routePace', PACES), 'Walking or running round the route. Once they go after a player they run either way.') : null,
      (g.behaviour === 'route' || g.behaviour === 'guard') ? field('Engage range', numIn(g, 'engage', { min: 0, max: 4096, placeholder: g.behaviour === 'guard' ? '600' : '350' }), 'How close a player comes before they go for them (0 = default).') : null,
      h('div', { class: 'row-end' },
        h('button', { class: 'btn small', title: 'A copy of this group, right below it - change what you need', onclick: () => {
          // Everything copied but its id; a name that says it's a copy.
          const copy = JSON.parse(JSON.stringify(g));
          copy.id = uid('g');
          let name = (g.name || 'Group') + ' copy', n = 2;
          while (s.groups.some((x) => x.name === name)) name = (g.name || 'Group') + ' copy ' + n++;
          copy.name = name;
          s.groups.splice(i + 1, 0, copy);
          openCard(copy.id);
          changed();
          toast('Cloned - "' + name + '" is below. Triggers still spawn the original; add a Spawn action for the copy.');
        } }, 'Clone group'),
        h('button', { class: 'btn small danger', onclick: () => { s.groups.splice(i, 1); changed(); } }, 'Delete group')),
    );
    el.append(foldable(card, g.id, groupSummary(g)));
  });
  el.append(h('button', { class: 'btn primary', onclick: () => {
    const gid = uid('g');
    openCard(gid);
    s.groups.push({ id: gid, name: nextName(s.groups, 'Group'), npcs: [], leader: '', count: 3, perPlayer: 1, max: 12, spawn: '', spawnAtStart: false, behaviour: 'hunt', route: '', routePace: 'walk', engage: 0, attacks: 'all' });
    changed();
  } }, '+ New group'));
}

// "When" choices. player: the trigger knows who set it off (for "tell",
// "teleport them" and "at the player").
const WHENS = [
  { v: 'start', t: 'The scenario starts' },
  { v: 'timer', t: 'Some seconds after the start (or every N seconds)' },
  { v: 'enter_area', t: 'A player walks into an area', player: true },
  { v: 'all_in_area', t: 'Every player is inside an area' },
  { v: 'group_dead', t: 'A group is all down' },
  { v: 'group_left', t: 'A group is down to N or fewer' },
  { v: 'all_dead', t: 'Every NPC so far is down' },
  { v: 'npc_killed', t: 'Any scenario NPC is killed' },
  { v: 'player_died', t: 'A player dies', player: true },
  { v: 'players', t: 'N or more players are in the game' },
  { v: 'after', t: 'Some seconds after another trigger' },
  { v: 'counter', t: 'A counter reaches a value' },
  { v: 'countdown_end', t: 'The countdown reaches zero' },
];
const ACTION_TYPES = [
  { v: 'spawn', t: 'Spawn a group' },
  { v: 'despawn', t: 'Remove a group' },
  { v: 'say', t: 'An NPC says something (everyone)' },
  { v: 'tell', t: 'Tell the player who set it off (only them)' },
  { v: 'message', t: 'Chat message (everyone)' },
  { v: 'center', t: 'Big centre message (everyone)' },
  { v: 'explode', t: 'Explosion (hurts players and NPCs)' },
  { v: 'effect', t: 'Visual effect' },
  { v: 'shake', t: 'Shake the screen' },
  { v: 'sound', t: 'Play a sound' },
  { v: 'music', t: 'Change the music' },
  { v: 'teleport', t: 'Teleport players' },
  { v: 'use', t: 'Use a map entity (door, lift, button...)' },
  { v: 'give', t: 'Give players a weapon, health, armour, ammo or item' },
  { v: 'heal', t: 'Heal players to full' },
  { v: 'kill', t: 'Kill players' },
  { v: 'knockdown', t: 'Knock players down' },
  { v: 'freeze', t: 'Freeze players (can look, not move or shoot)' },
  { v: 'vehicle', t: 'Spawn a vehicle' },
  { v: 'pickup', t: 'Drop a pickup (medpack, weapon, ammo...)' },
  { v: 'move', t: 'Give a group new orders (hunt, route, guard, idle)' },
  { v: 'trigger_on', t: 'Turn a trigger on (and re-arm it)' },
  { v: 'trigger_off', t: 'Turn a trigger off' },
  { v: 'counter', t: 'Change a counter' },
  { v: 'countdown', t: 'Start a countdown (on everyone\'s screen)' },
  { v: 'objective', t: 'Complete a map objective' },
  { v: 'texture', t: 'Swap a texture' },
  { v: 'gravity', t: 'Change gravity' },
  { v: 'speed', t: 'Change player speed' },
  { v: 'addtime', t: 'Add time to the round clock' },
  { v: 'win', t: 'Win the round for a side (ends the scenario)' },
  { v: 'end', t: 'End the scenario' },
];

// Whom a player action is for.
function whoSelect(a, t) {
  const opts = [];
  if (whenHasPlayer(t) || a.who === 'player') opts.push({ v: 'player', t: 'The player who set it off' });
  opts.push({ v: 'all', t: 'Every player' }, { v: 'team1', t: 'Everyone on ' + S.teams.team1 }, { v: 'team2', t: 'Everyone on ' + S.teams.team2 });
  S.scn.areas.forEach((ar) => opts.push({ v: ar.id, t: 'Everyone in area: ' + ar.name }));
  if (!opts.some((o) => o.v === a.who)) a.who = opts[0].v;
  return selectIn(a, 'who', opts);
}

// Lists loaded once, when first needed.
const LISTS = {};
async function loadList(key, url, field) {
  if (!LISTS[key]) {
    try { LISTS[key] = await api(url); } catch (e) { LISTS[key] = {}; }
  }
  return LISTS[key][field] || [];
}
function lateCombo(box, key, url, field, a, prop, placeholder, sub) {
  loadList(key, url, field).then((list) => {
    box.prepend(combo({ value: a[prop] || '', items: () => list.map((v) => (typeof v === 'string' ? { value: v, sub: sub ? sub(v) : '' } : v)),
      placeholder: placeholder.replace('N', list.length), onPick: (v) => { a[prop] = v; soft(); }, onType: (v) => { a[prop] = v; soft(); } }));
  });
}
const GIVE_EXTRAS = [
  { value: 'health', sub: 'full health' }, { value: 'armor', sub: 'full armour' }, { value: 'ammo', sub: 'full ammo for what they carry' },
  { value: 'item_jetpack', sub: 'jetpack (with fuel)' }, { value: 'item_shockfield', sub: 'shock field' },
  { value: 'item_seeker', sub: 'seeker drone' }, { value: 'item_sentry_gun', sub: 'sentry gun' },
  { value: 'item_shield', sub: 'portable shield' }, { value: 'item_medpac', sub: 'medpac' }, { value: 'item_stimpack', sub: 'stimpack' },
  { value: 'item_cloak', sub: 'cloak' }, { value: 'item_eweb_holdable', sub: 'E-Web' },
];
const whenHasPlayer = (t) => !!(WHENS.find((w) => w.v === t.when) || {}).player;

// Where an action happens: a point, an area's middle, or the player who set
// it off (only offered on triggers that have one).
function placeSelect(obj, t, noneLabel) {
  const s = S.scn;
  const opts = [{ v: '', t: noneLabel || '- pick a place -' }]
    .concat(s.points.map((p) => ({ v: p.id, t: 'Point: ' + p.name })), s.areas.map((a) => ({ v: a.id, t: 'Area: ' + a.name + ' (middle)' })));
  if (whenHasPlayer(t) || obj.at === 'player') opts.push({ v: 'player', t: 'Where the player who set it off is' });
  return selectIn(obj, 'at', opts);
}

function soundPicker(obj, key, placeholder) {
  const inp = h('input', { value: obj[key] || '', placeholder: placeholder || 'sound/...', oninput: (e) => { obj[key] = e.target.value.trim(); soft(); } });
  const play = h('button', { type: 'button', class: 'btn tiny', title: 'Listen', onclick: () => playSound(obj[key]) }, '▶');
  const find = h('button', { type: 'button', class: 'btn tiny', onclick: () => openSearch({
    title: 'Find a sound', url: '/api/sounds', key: 'sounds', play: true,
    hint: 'Search the game\'s sounds, e.g. "rex taunt", "battledroid", "explosion".',
    onPick: (p) => { obj[key] = p; inp.value = p; soft(); } }) }, 'Find');
  return h('div', { class: 'input-row' }, inp, play, find);
}

function effectPicker(obj, key) {
  const inp = h('input', { value: obj[key] || '', placeholder: 'e.g. Grenades/EXP_BaseThermal', oninput: (e) => { obj[key] = e.target.value.trim(); soft(); } });
  const find = h('button', { type: 'button', class: 'btn tiny', onclick: () => openSearch({
    title: 'Find an effect', url: '/api/effects', key: 'effects',
    hint: 'Search the game\'s effects, e.g. "explosion", "smoke", "fire", "sparks". Effects from optional map packs only show for players who have them - the MBII ones (Grenades/, env/, explosions/...) are safest.',
    onPick: (p) => { obj[key] = p; inp.value = p; soft(); } }) }, 'Find');
  return h('div', { class: 'input-row' }, inp, find);
}

function playSound(path) {
  if (!path) return;
  const a = $('#preview');
  a.src = '/api/sound?path=' + encodeURIComponent(path);
  a.play().catch(() => toast('Can\'t play that one here (not found, or not a sound file).', true));
}

function openSearch({ title, url, key, hint, play, onPick }) {
  const dlg = h('dialog', { class: 'sound-dlg' });
  const results = h('div', { class: 'sound-results' }, h('p', { class: 'muted small' }, hint || ''));
  let timer = null;
  const q = h('input', { type: 'search', placeholder: 'Search', autofocus: true, oninput: () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (q.value.trim().length < 2) return;
      try {
        const r = await api(url + '?q=' + encodeURIComponent(q.value));
        results.innerHTML = '';
        if (!r[key].length) results.append(h('p', { class: 'muted small' }, 'Nothing found.'));
        r[key].forEach((p) => results.append(h('div', { class: 'sound-row' },
          play ? h('button', { class: 'btn tiny', type: 'button', onclick: () => playSound(p) }, '▶') : null,
          h('code', { class: 'grow' }, p),
          h('button', { class: 'btn tiny primary', type: 'button', onclick: () => { onPick(p); dlg.close(); } }, 'Use'))));
      } catch (err) { toast(err.message, true); }
    }, 250);
  } });
  dlg.append(h('div', { class: 'dlg-head' }, h('b', {}, title), h('button', { class: 'btn tiny', type: 'button', onclick: () => dlg.close() }, 'Close')), q, results);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// The map's own doors, lifts, buttons... (by targetname), loaded once.
let mapTargets = null;
async function loadTargets() {
  if (mapTargets) return mapTargets;
  try { mapTargets = (await api('/api/maps/' + encodeURIComponent(S.scn.map) + '/targets')).targets; }
  catch (e) { mapTargets = []; }
  return mapTargets;
}
function targetItems() {
  return (mapTargets || []).map((t) => ({ value: t.target, sub: t.classes.join(', ') + (t.count > 1 ? ' (' + t.count + ')' : '') + (t.at ? ' - at ' + t.at.join(' ') : '') }));
}

function actionRow(t, a, i) {
  const s = S.scn;
  const row = h('div', { class: 'action' });
  // A new kind: its own fields, with sensible defaults - one undo step.
  const kind = h('select', { onchange: (e) => {
    for (const k of Object.keys(a)) delete a[k];
    a.do = e.target.value;
    if (a.do === 'explode') Object.assign(a, { damage: 60, radius: 250, effect: 'Grenades/EXP_BaseThermal', path: 'sound/weapons/thermal/explode.mp3', at: '' });
    if (a.do === 'shake') Object.assign(a, { intensity: 4, seconds: 1, at: '' });
    if (a.do === 'tell') a.style = 'center';
    if (a.do === 'teleport') a.who = whenHasPlayer(t) ? 'player' : 'all';
    if (a.do === 'win') a.team = (S.scn.joinTeam && S.scn.joinTeam !== 'any') ? S.scn.joinTeam : 'team1';
    if (['give', 'heal', 'kill', 'knockdown', 'freeze'].includes(a.do)) a.who = whenHasPlayer(t) ? 'player' : 'all';
    if (a.do === 'knockdown') a.seconds = 3;
    if (a.do === 'freeze') a.seconds = 5;
    if (a.do === 'addtime') a.seconds = 120;
    if (a.do === 'move') a.behaviour = 'hunt';
    if (a.do === 'counter') { a.op = 'add'; a.value = 1; a.counter = (S.scn.counters[0] || {}).id || ''; }
    if (a.do === 'countdown') { a.seconds = 30; a.text = ''; }
    if (a.do === 'objective') { a.team = 'team1'; a.objective = 1; }
    if (a.do === 'gravity') { a.value = 200; a.seconds = 30; }
    if (a.do === 'speed') { a.value = 200; a.seconds = 30; }
    changed();
  } }, ACTION_TYPES.map((o) => h('option', { value: o.v, selected: o.v === a.do }, o.t)));
  row.append(h('div', { class: 'input-row' }, kind,
    h('button', { class: 'btn tiny', type: 'button', title: 'Move up', disabled: i === 0, onclick: () => { t.actions.splice(i - 1, 0, t.actions.splice(i, 1)[0]); changed(); } }, '↑'),
    h('button', { class: 'btn tiny danger', type: 'button', title: 'Remove', onclick: () => { t.actions.splice(i, 1); changed(); } }, 'x')));
  const groupSel = () => selectIn(a, 'group', [{ v: '', t: '- pick a group -' }].concat(s.groups.map((g) => ({ v: g.id, t: g.name }))));
  switch (a.do) {
    case 'spawn':
      row.append(groupSel(), selectIn(a, 'at', [{ v: '', t: '- pick where they spawn -' }]
        .concat(S.scn.points.map((p) => ({ v: p.id, t: 'At point: ' + p.name })), S.scn.routes.map((r) => ({ v: r.id, t: 'Along route: ' + r.name })))));
      break;
    case 'despawn':
      row.append(groupSel());
      break;
    case 'say':
      row.append(h('div', { class: 'grid-say' }, textIn(a, 'speaker', { placeholder: 'Who (e.g. Captain Rex)', maxlength: 40 }), textIn(a, 'text', { placeholder: 'What they say', maxlength: 190 })));
      row.append(soundPicker(a, 'path', 'voice sound (optional)'));
      break;
    case 'tell':
      row.append(textIn(a, 'text', { maxlength: 190, placeholder: 'What they see - ^1 ^2 ^3... colour codes work' }),
        selectIn(a, 'style', [{ v: 'center', t: 'Big, centre of their screen' }, { v: 'chat', t: 'In their chat' }]));
      if (!whenHasPlayer(t)) row.append(h('div', { class: 'warnline' }, 'This trigger isn\'t set off by one player, so nobody will see it. Use it with "A player walks into an area" or "A player dies".'));
      break;
    case 'message': case 'center': case 'end':
      row.append(textIn(a, 'text', { maxlength: 190, placeholder: a.do === 'end' ? 'Big message as it ends (optional)' : 'Text - ^1 ^2 ^3... colour codes work' }));
      break;
    case 'sound':
      row.append(soundPicker(a, 'path'), placeSelect(a, t, 'Everyone hears it (not at a place)'));
      break;
    case 'music': {
      // Every track in the game, filtered as you type; any other path can be typed too.
      const box = h('div', { class: 'input-row' },
        h('button', { type: 'button', class: 'btn tiny', title: 'Listen', onclick: () => playSound(a.path) }, '\u25B6'));
      lateCombo(box, 'music', '/api/music', 'music', a, 'path', 'Search N music tracks (or type a path)',
        (v) => v.replace(/^music\//i, '').replace(/\//g, ' / '));
      row.append(box, h('small', { class: 'muted' }, 'Plays for everyone instead of the map\'s music; the map\'s comes back when the scenario ends.'));
      break;
    }
    case 'explode':
      row.append(placeSelect(a, t),
        h('div', { class: 'grid2' }, field('Damage (at the middle)', numIn(a, 'damage', { min: 0, max: 1000 })), field('Radius', numIn(a, 'radius', { min: 16, max: 2048 }))),
        field('Effect', effectPicker(a, 'effect')), field('Sound', soundPicker(a, 'path')));
      break;
    case 'effect':
      row.append(placeSelect(a, t), field('Effect', effectPicker(a, 'effect')), field('Sound (optional)', soundPicker(a, 'path')));
      break;
    case 'shake':
      row.append(placeSelect(a, t, 'Everyone, wherever they are'),
        h('div', { class: 'grid2' }, field('Strength', numIn(a, 'intensity', { min: 0.5, max: 20, step: 0.5 })), field('Seconds', numIn(a, 'seconds', { min: 0.1, max: 10, step: 0.1 }))));
      break;
    case 'teleport':
      row.append(selectIn(a, 'who', whenHasPlayer(t)
        ? [{ v: 'player', t: 'The player who set it off' }, { v: 'all', t: 'Every player' }]
        : [{ v: 'all', t: 'Every player' }]));
      if (!whenHasPlayer(t) && a.who !== 'all') { a.who = 'all'; }
      row.append(selectIn(a, 'at', [{ v: '', t: '- to where -' }].concat(s.points.map((p) => ({ v: p.id, t: 'Point: ' + p.name + ' (facing its way)' })), s.areas.map((q) => ({ v: q.id, t: 'Area: ' + q.name + ' (middle)' })))));
      break;
    case 'win':
      row.append(selectIn(a, 'team', [
        { v: 'team1', t: S.teams.team1 + ' win' },
        { v: 'team2', t: S.teams.team2 + ' win' },
        { v: 'draw', t: 'A draw' },
      ]), textIn(a, 'text', { maxlength: 190, placeholder: 'Big message as it ends (optional)' }),
      h('small', { class: 'muted' }, 'Ends the scenario, then the round - scores, round-over message and the next round, as if they\'d won it themselves.'));
      break;
    case 'give': {
      row.append(whoSelect(a, t));
      const box = h('div', {}, h('small', { class: 'muted' }, 'A weapon (with ammo), health, armour, ammo, or an item by name.'));
      const weapons = S.weapons.map((w) => ({ value: w, sub: 'weapon' }));
      box.prepend(combo({ value: a.item || '', items: () => GIVE_EXTRAS.concat(weapons), placeholder: 'What to give - search', onPick: (v) => { a.item = v; soft(); }, onType: (v) => { a.item = v; soft(); } }));
      row.append(box);
      break;
    }
    case 'heal': case 'kill':
      row.append(whoSelect(a, t));
      break;
    case 'knockdown': case 'freeze':
      row.append(whoSelect(a, t), field(a.do === 'freeze' ? 'For (seconds)' : 'Down for (seconds)', numIn(a, 'seconds', { min: 0.5, max: 60, step: 0.5 })));
      break;
    case 'vehicle': {
      const box = h('div', {});
      lateCombo(box, 'veh', '/api/vehicles', 'vehicles', a, 'vehicle', 'Search N vehicles');
      row.append(placeSelect(a, t), box);
      break;
    }
    case 'pickup': {
      const box = h('div', {}, h('small', { class: 'muted' }, 'Dropped on the floor there, as if someone dropped it.'));
      lateCombo(box, 'veh', '/api/vehicles', 'items', a, 'item', 'Search N pickups (item_, weapon_, ammo_...)');
      row.append(placeSelect(a, t), box);
      break;
    }
    case 'addtime':
      row.append(field('Seconds (negative takes time off)', numIn(a, 'seconds', { min: -3600, max: 3600 })));
      break;
    case 'move': {
      const s2 = S.scn;
      row.append(selectIn(a, 'group', [{ v: '', t: '- pick a group -' }].concat(s2.groups.map((g) => ({ v: g.id, t: g.name })))),
        selectIn(a, 'behaviour', BEHAVIOURS));
      if (a.behaviour === 'route') row.append(selectIn(a, 'route', [{ v: '', t: '- pick a route -' }].concat(s2.routes.map((r) => ({ v: r.id, t: r.name })))), selectIn(a, 'pace', PACES));
      if (a.behaviour === 'guard') row.append(placeSelect(a, t, 'Where each of them spawned'));
      break;
    }
    case 'trigger_on': case 'trigger_off':
      row.append(selectIn(a, 'trigger', [{ v: '', t: '- pick a trigger -' }].concat(S.scn.triggers.filter((x) => x !== t).map((x) => ({ v: x.id, t: x.name })))));
      break;
    case 'counter':
      row.append(h('div', { class: 'grid3' },
        field('Counter', selectIn(a, 'counter', [{ v: '', t: '- pick -' }].concat(S.scn.counters.map((c) => ({ v: c.id, t: c.name }))))),
        field('', selectIn(a, 'op', [{ v: 'add', t: 'add' }, { v: 'set', t: 'set to' }])),
        field('', numIn(a, 'value', { min: -9999, max: 9999 }))));
      if (!S.scn.counters.length) row.append(h('div', { class: 'warnline' }, 'Make a counter first (Counters, top of this tab).'));
      break;
    case 'countdown':
      row.append(h('div', { class: 'grid-say' }, field('Seconds', numIn(a, 'seconds', { min: 1, max: 3600 })), field('Label', textIn(a, 'text', { maxlength: 90, placeholder: 'e.g. Reactor overload in' }))),
        h('small', { class: 'muted' }, 'Ticks down on everyone\'s screen; "The countdown reaches zero" triggers fire at the end.'));
      break;
    case 'objective': {
      const box = h('div', {});
      loadList('obj', '/api/maps/' + encodeURIComponent(S.scn.map) + '/objectives', 'objectives').then((objs) => {
        const opts = [];
        ['team1', 'team2'].forEach((tm) => (objs[tm] || []).forEach((o) => opts.push({ v: tm + ':' + o.n, t: S.teams[tm] + ' - ' + o.name + (o.final ? ' (final)' : '') })));
        const holder = { pick: a.team + ':' + a.objective };
        if (!opts.length) opts.push({ v: holder.pick, t: 'This map lists no objectives' });
        box.append(selectIn(holder, 'pick', opts, () => { const [tm, n] = holder.pick.split(':'); a.team = tm; a.objective = +n; changed(); }),
          h('small', { class: 'muted' }, 'As if that side had done it - a final objective wins them the round.'));
      });
      row.append(box);
      break;
    }
    case 'texture': {
      const from = h('div', {}), to = h('div', {}, h('small', { class: 'muted' }, 'Any texture or shader path, e.g. one from another surface. Put back when the scenario ends.'));
      lateCombo(from, 'shd', '/api/maps/' + encodeURIComponent(S.scn.map) + '/shaders', 'shaders', a, 'from', 'Texture on this map to swap (N)');
      lateCombo(to, 'shd', '/api/maps/' + encodeURIComponent(S.scn.map) + '/shaders', 'shaders', a, 'to', 'Swap it for (search or type a path)');
      row.append(from, to);
      break;
    }
    case 'gravity': case 'speed':
      row.append(h('div', { class: 'grid2' },
        a.do === 'gravity' ? field('Gravity (normal 800, lower = floatier)', numIn(a, 'value', { min: 0, max: 5000 }))
          : field('Speed, % of normal (50 = half, 200 = double)', numIn(a, 'value', { min: 10, max: 400 })),
        field('For (seconds, 0 = till it ends)', numIn(a, 'seconds', { min: 0, max: 3600 }))));
      break;
    case 'use': {
      const box = h('div', {});
      loadTargets().then((list) => {
        box.append(combo({ value: a.target || '', items: targetItems, placeholder: list.length ? 'Search ' + list.length + ' map entities' : 'This map has no named entities',
          onPick: (v) => { a.target = v; soft(); }, onType: (v) => { a.target = v; soft(); } }),
        h('small', { class: 'muted' }, 'Sets off everything with that targetname, as a button would - doors open, lifts move, relays fire.'));
      });
      row.append(box);
      break;
    }
  }
  return row;
}

function renderCounters(el) {
  const s = S.scn;
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, h('span', { class: 'tag' }, 'counters'),
    h('span', { class: 'muted small' }, 'Numbers your triggers change and react to - keys found, waves cleared...')));
  s.counters.forEach((c, i) => card.append(h('div', { class: 'input-row', style: 'margin-bottom:6px' },
    textIn(c, 'name', { maxlength: 40, placeholder: 'name' }),
    h('span', { class: 'muted small' }, 'starts at'), numIn(c, 'start', { min: -9999, max: 9999, style: 'max-width:90px' }),
    h('button', { class: 'btn tiny danger', type: 'button', onclick: () => { s.counters.splice(i, 1); changed(); } }, 'x'))));
  card.append(h('button', { class: 'btn small', onclick: () => { s.counters.push({ id: uid('c'), name: nextName(s.counters, 'Counter'), start: 0 }); changed(); } }, '+ Counter'));
  el.append(card);
}

function renderTriggers(el) {
  const s = S.scn;
  el.append(h('p', { class: 'muted' }, 'When something happens, do things - in order, top to bottom.'));
  if (s.triggers.length) el.append(foldBar(s.triggers.map((t) => t.id), 'triggers'));
  renderCounters(el);
  s.triggers.forEach((t, i) => {
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-title' }, h('span', { class: 'tag trigger' }, 'trigger'), textIn(t, 'name', { maxlength: 47, class: 'grow' })),
      field('When', selectIn(t, 'when', WHENS)));
    const areaSel = () => field('Area', selectIn(t, 'area', [{ v: '', t: '- pick -' }].concat(s.areas.map((a) => ({ v: a.id, t: a.name })))));
    const groupSel = () => field('Group', selectIn(t, 'group', [{ v: '', t: '- pick -' }].concat(s.groups.map((g) => ({ v: g.id, t: g.name })))));
    if (t.when === 'timer') card.append(field(t.repeat ? 'Every (seconds)' : 'Seconds after the start', numIn(t, 'seconds', { min: 0, max: 3600 })));
    if (t.when === 'enter_area' || t.when === 'all_in_area') card.append(areaSel());
    if (t.when === 'group_dead') card.append(groupSel());
    if (t.when === 'group_left') card.append(h('div', { class: 'grid2' }, groupSel(), field('N or fewer left', numIn(t, 'count', { min: 0, max: 32 }))));
    if (t.when === 'players') card.append(field('Players in the game', numIn(t, 'count', { min: 1, max: 64 })));
    if (t.when === 'counter') card.append(h('div', { class: 'grid3' },
      field('Counter', selectIn(t, 'counter', [{ v: '', t: '- pick -' }].concat(s.counters.map((c) => ({ v: c.id, t: c.name }))))),
      field('is', selectIn(t, 'compare', [{ v: '>=', t: 'at least' }, { v: '==', t: 'exactly' }, { v: '<=', t: 'at most' }])),
      field('', numIn(t, 'count', { min: -9999, max: 9999 }))));
    if (t.when === 'after') {
      const others = [{ v: '', t: '- pick -' }].concat(s.triggers.filter((x) => x !== t).map((x) => ({ v: x.id, t: x.name })));
      card.append(h('div', { class: 'grid2' },
        field('Trigger', selectIn(t, 'trigger', others)),
        field('Seconds later', numIn(t, 'seconds', { min: 0, max: 3600 }))));
    }
    if (t.when !== 'start') {
      card.append(h('div', { class: 'grid2' },
        field('Fires', h('select', { onchange: (e) => { t.repeat = e.target.value === 'every'; changed(); } },
          h('option', { value: 'once', selected: !t.repeat }, 'Once'), h('option', { value: 'every', selected: !!t.repeat }, 'Every time'))),
        t.repeat ? field('No more often than (seconds)', numIn(t, 'cooldown', { min: 1, max: 3600 })) : h('span')));
    }
    card.append(h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!t.startOff, onchange: (e) => { t.startOff = e.target.checked; changed(); } }),
      h('span', { class: 'small' }, 'Starts turned off - another trigger turns it on')));
    const acts = h('div', { class: 'actions-list' });
    t.actions.forEach((a, j) => acts.append(actionRow(t, a, j)));
    card.append(h('div', { class: 'sub' }, 'Then'), acts,
      h('div', { class: 'row-end' },
        h('button', { class: 'btn small', onclick: () => { t.actions.push({ do: whenHasPlayer(t) ? 'tell' : 'center', text: '', style: 'center' }); changed(); } }, '+ Action'),
        h('button', { class: 'btn small danger', onclick: () => { s.triggers.splice(i, 1); changed(); } }, 'Delete trigger')));
    el.append(foldable(card, t.id, triggerSummary(t)));
  });
  el.append(h('button', { class: 'btn primary', onclick: () => {
    const tid = uid('t');
    openCard(tid);
    s.triggers.push({ id: tid, name: nextName(s.triggers, 'Trigger'), when: s.triggers.length ? 'all_dead' : 'start', area: '', group: '', trigger: '', seconds: 0,
      count: 0, repeat: false, cooldown: 5,
      actions: [s.groups[0] ? { do: 'spawn', group: s.groups[0].id, at: s.points[0] ? s.points[0].id : '' } : { do: 'center', text: '' }] });
    changed();
  } }, '+ New trigger'));
}

function renderChecks(el) {
  if (!S.problems.length) { el.append(h('p', { class: 'good-line' }, 'Nothing to fix - ready to play.')); return; }
  for (const p of S.problems) {
    el.append(h('button', { class: 'problem ' + p.level, onclick: () => {
      if (p.focus.tab) showTab(p.focus.tab);
      else if (p.focus.kind) { S.sel = { kind: p.focus.kind, id: p.focus.id }; const o = find(p.focus.kind, p.focus.id); const q = o && (o.points ? o.points[0] : o); if (q) centreOn(q.x, q.y); showTab('places'); }
    } }, h('span', { class: 'lvl' }, p.level === 'error' ? 'Fix' : p.level === 'warn' ? 'Check' : 'Note'), p.text));
  }
}

// --- Load and save -----------------------------------------------------------

function normalise(s) {
  for (const k of ['points', 'routes', 'areas', 'groups', 'triggers', 'npcTypes', 'counters']) if (!Array.isArray(s[k])) s[k] = [];
  if (!s.joinTeam) s.joinTeam = 'any';
  if (!s.respawnSeconds) s.respawnSeconds = 5;
  s.routes.forEach((r) => { if (!Array.isArray(r.points)) r.points = []; });
  s.groups.forEach((g) => { if (!Array.isArray(g.npcs)) g.npcs = []; if (!g.attacks) g.attacks = 'all'; });
  s.triggers.forEach((t) => { if (!Array.isArray(t.actions)) t.actions = []; });
  s.triggers.forEach((t) => t.actions.forEach((a) => {
    if (a.do === 'spawn' && !a.at) {
      const g = s.groups.find((x) => x.id === a.group);
      if (g && g.spawn) a.at = g.spawn;
    }
  }));
  return s;
}

async function save() {
  if (S.drafting) finishRoute();
  $('#save-state').textContent = 'Saving...';
  try {
    const r = await api('/api/scenarios/' + SCENARIO_ID, S.scn);
    if (HIST.timer) commitHistory();
    S.scn = normalise(r.scenario);
    resetHistoryBase();
    S.dirty = false;
    $('#save-state').textContent = 'Saved ' + new Date().toLocaleTimeString();
    toast('Saved.');
    validate();
    renderPanels();
    draw();
  } catch (err) {
    $('#save-state').textContent = 'Not saved';
    toast(err.message, true);
  }
}

async function load() {
  resize();
  new ResizeObserver(resize).observe(canvas);
  const [scn, npcs, models] = await Promise.all([
    api('/api/scenarios/' + SCENARIO_ID),
    api('/api/npcs').catch(() => ({ npcs: [] })),
    api('/api/models').catch(() => ({ models: [], weapons: [] })),
  ]);
  try { S.teams = (await api('/api/maps/' + encodeURIComponent(scn.scenario.map) + '/teams')).teams; } catch (e) { /* Team 1 / 2 */ }
  S.scn = normalise(scn.scenario);
  loadFolded();
  resetHistoryBase();
  S.npcs = npcs.npcs;
  S.models = models.models;
  S.weapons = models.weapons;
  $('#npc-list').innerHTML = S.npcs.map((n) => '<option value="' + esc(n.name) + '">' + esc(n.model) + '</option>').join('');
  $('#model-list').innerHTML = S.models.map((m) => '<option value="' + esc(m.model) + '">').join('');
  $('#scn-name').value = S.scn.name;
  $('#scn-map').textContent = S.scn.map;
  document.title = S.scn.name + ' - Holotable';
  validate();
  showTab('scenario');
  try {
    const res = await fetch('/api/maps/' + encodeURIComponent(S.scn.map) + '/geometry', { headers: { 'X-Holotable': '1' } });
    const g = await res.json();
    if (!res.ok || g.ok === false) throw new Error(g.error || 'Could not load the map.');
    S.geo = prepGeometry(g);
    $('#loading').hidden = true;
    setupEntKinds();
    api('/api/maps/' + encodeURIComponent(scn.scenario.map) + '/entities')
      .then((r) => { S.ents = r.entities || []; setupEntKinds(); draw(); })
      .catch(() => { /* just the spawns, from the geometry */ });
    setupCut();
    checkRoutes();
    validate();
    fit();
  } catch (err) {
    $('#loading').textContent = err.message;
  }
}

// --- Wiring ------------------------------------------------------------------------

canvas.addEventListener('mousedown', onDown);
window.addEventListener('mousemove', onMove);
window.addEventListener('mouseup', onUp);
canvas.addEventListener('wheel', onWheel, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('dblclick', () => {
  if (S.tool !== 'route' || !S.drafting) return;
  // The double-click's second click added a point on top of the first.
  const r = S.scn.routes.find((q) => q.id === S.drafting);
  if (r && r.points.length >= 2) {
    const a = r.points[r.points.length - 1], b = r.points[r.points.length - 2];
    if (Math.hypot(a.x - b.x, a.y - b.y) * S.view.zoom < 6) r.points.pop();
  }
  finishRoute();
});
document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#fit-btn').addEventListener('click', fit);
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#save-btn').addEventListener('click', save);
$('#undo-btn').addEventListener('click', undo);
$('#redo-btn').addEventListener('click', redo);
$('#checks-chip').addEventListener('click', () => showTab('checks'));
$('#scn-name').addEventListener('input', (e) => { S.scn.name = e.target.value; soft(); });
$('#show-labels').addEventListener('change', (e) => { S.labels = e.target.checked; draw(); });

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  // Ctrl+Z / Ctrl+Y - in a text box, the box's own undo instead.
  if ((e.ctrlKey || e.metaKey) && !typing) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
  }
  if (typing) return;
  if (e.key === ' ') { S.space = true; e.preventDefault(); return; }
  if (e.key === 'Enter' || e.key === 'Escape') { finishRoute(); draw(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
  const tools = { v: 'select', p: 'point', r: 'route', a: 'area' };
  if (tools[e.key.toLowerCase()]) setTool(tools[e.key.toLowerCase()]);
  if (e.key.toLowerCase() === 'f') fit();
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') S.space = false; });
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

setTool('select');
load().catch((err) => { $('#loading').textContent = err.message; toast(err.message, true); });
