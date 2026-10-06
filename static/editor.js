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
  (s.props || []).forEach((p) => out.push(p));
  (s.items || []).forEach((p) => out.push(p));
  ['vehicles', 'effects', 'sounds'].forEach((k) => (s[k] || []).forEach((p) => out.push(p)));
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

const COL = { point: '#ffd166', route: '#ff8a3d', area: '#7cff9b', bad: '#ff4d6d', sel: '#ffffff', prop: '#e0a96d', item: '#5ee6ff', vehicle: '#b0f070', effect: '#ff7a59', sound: '#c79bff' };
// Our own Holo Entities, by kind - each can be hidden on
// the map (the cut panel; remembered in this browser). Hidden ones aren't
// drawn and can't be clicked.
const H_KINDS = [
  { k: 'point', t: 'Points' }, { k: 'route', t: 'Routes' }, { k: 'area', t: 'Areas' }, { k: 'prop', t: 'Props' },
  { k: 'item', t: 'Items' }, { k: 'vehicle', t: 'Vehicles' }, { k: 'effect', t: 'Effects' }, { k: 'sound', t: 'Sounds' },
];
S.hShow = (() => {
  const all = Object.fromEntries(H_KINDS.map((x) => [x.k, true]));
  try { const v = JSON.parse(localStorage.getItem('ht-hents')); if (v && typeof v === 'object') return Object.assign(all, v); } catch (e) { /* none yet */ }
  return all;
})();
const hOn = (k) => S.hShow[k] !== false;

function setupHKinds() {
  const box = $('#h-kinds');
  if (!box) return;
  box.innerHTML = '';
  for (const kind of H_KINDS) {
    box.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: hOn(kind.k), onchange: (ev) => {
      S.hShow[kind.k] = ev.target.checked;
      try { localStorage.setItem('ht-hents', JSON.stringify(S.hShow)); } catch (e) { /* private mode */ }
      if (!ev.target.checked && S.sel && S.sel.kind === kind.k) S.sel = null;
      draw();
    } }), h('i', { style: 'background:' + COL[kind.k] }), kind.t));
  }
}

// What the prop and item tools put down (the last one picked).
S.propModel = 'models/map_objects/imperial/crate.md3';
S.itemName = 'item_medpak_instant';
S.vehicleName = '';
// Placed kinds: their list in the scenario and what names them.
const PLACED = { prop: ['props', 'model'], item: ['items', 'item'], vehicle: ['vehicles', 'vehicle'], effect: ['effects', 'effect'], sound: ['sounds', 'sound'] };
// A prop's size from the props list (loaded once): [mins, maxs], or a guess.
function propBox(model) {
  const p = ((LISTS.props || {}).props || []).find((x) => x.model.toLowerCase() === String(model || '').toLowerCase());
  return p ? [p.mins, p.maxs] : [[-16, -16, 0], [16, 16, 32]];
}
function itemKind(name) { return /^weapon_/.test(name) ? 'weapon' : /^ammo_/.test(name) ? 'ammo' : /^holdable_/.test(name) ? 'holdable' : 'item'; }
function shortModel(m) { return String(m || '').replace(/^models\/map_objects\//i, '').replace(/\.md3$/i, ''); }

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
  for (const a of hOn('area') ? s.areas : []) {
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
  for (const r of hOn('route') ? s.routes : []) {
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
  // Props: their box, turned; items: a ringed cross.
  for (const p of hOn('prop') ? s.props || [] : []) {
    const [mn, mx] = propBox(p.model), yr = (p.yaw || 0) * Math.PI / 180, c = Math.cos(yr), sn = Math.sin(yr);
    const corners = [[mn[0], mn[1]], [mx[0], mn[1]], [mx[0], mx[1]], [mn[0], mx[1]]]
      .map(([x, y]) => w2s(p.x + x * c - y * sn, p.y + x * sn + y * c));
    ctx.globalAlpha = alphaFor(p.z);
    ctx.beginPath(); corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    ctx.fillStyle = 'rgba(224,169,109,0.35)'; ctx.fill();
    ctx.lineWidth = isSel('prop', p.id) ? 2.5 : 1.5; ctx.strokeStyle = isSel('prop', p.id) ? COL.sel : COL.prop; ctx.stroke();
    const [x, y] = w2s(p.x, p.y);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(-yr) * 14, y + Math.sin(-yr) * 14); ctx.strokeStyle = COL.prop; ctx.lineWidth = 2; ctx.stroke();
    label(p.name, x, y, COL.prop);
  }
  for (const it of hOn('item') ? s.items || [] : []) {
    const [x, y] = w2s(it.x, it.y), sel = isSel('item', it.id);
    ctx.globalAlpha = alphaFor(it.z);
    ctx.beginPath(); ctx.arc(x, y, sel ? 7 : 5.5, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = sel ? COL.sel : COL.item; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); ctx.strokeStyle = COL.item; ctx.stroke();
    label(it.name, x, y, COL.item);
  }
  for (const [kind, list] of [['vehicle', s.vehicles], ['effect', s.effects], ['sound', s.sounds]]) {
    for (const o of hOn(kind) ? list || [] : []) {
      const [x, y] = w2s(o.x, o.y), sel = isSel(kind, o.id), r = sel ? 7 : 5.5;
      ctx.globalAlpha = alphaFor(o.z);
      ctx.beginPath();
      if (kind === 'vehicle') { ctx.rect(x - r, y - r * 0.7, r * 2, r * 1.4); }
      else if (kind === 'effect') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * 0.8); ctx.lineTo(x - r, y + r * 0.8); ctx.closePath(); }
      else { ctx.arc(x, y, r, 0, Math.PI * 2); }
      ctx.fillStyle = COL[kind]; ctx.globalAlpha *= 0.85; ctx.fill(); ctx.globalAlpha = alphaFor(o.z);
      ctx.lineWidth = sel ? 2 : 1; ctx.strokeStyle = sel ? COL.sel : 'rgba(5,11,20,0.9)'; ctx.stroke();
      if (kind === 'sound') { ctx.beginPath(); ctx.arc(x, y, r + 5, -0.6, 0.6); ctx.strokeStyle = COL.sound; ctx.lineWidth = 1.5; ctx.stroke(); }
      if (kind === 'vehicle') {
        const yr = -(o.yaw || 0) * Math.PI / 180;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(yr) * 16, y + Math.sin(yr) * 16); ctx.strokeStyle = COL.vehicle; ctx.lineWidth = 2; ctx.stroke();
      }
      label(o.name, x, y, COL[kind]);
    }
  }
  // Points
  for (const p of hOn('point') ? s.points : []) {
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

// What's under the mouse - hidden kinds (cut panel) don't count.
function hitTest(sx, sy) {
  const s = Object.assign({}, S.scn), d2 = (x, y) => (x - sx) ** 2 + (y - sy) ** 2;
  for (const [kind, key] of [['point', 'points'], ['route', 'routes'], ['area', 'areas'], ['prop', 'props'], ['item', 'items'], ['vehicle', 'vehicles'], ['effect', 'effects'], ['sound', 'sounds']]) {
    if (!hOn(kind)) s[key] = [];
  }
  for (const p of s.points) { const [x, y] = w2s(p.x, p.y); if (d2(x, y) < 81) return { kind: 'point', id: p.id }; }
  for (const it of s.items || []) { const [x, y] = w2s(it.x, it.y); if (d2(x, y) < 81) return { kind: 'item', id: it.id }; }
  for (const [kind, list] of [['vehicle', s.vehicles], ['effect', s.effects], ['sound', s.sounds]]) {
    for (const o of list || []) { const [x, y] = w2s(o.x, o.y); if (d2(x, y) < 81) return { kind, id: o.id }; }
  }
  for (const p of s.props || []) {
    const [mn, mx] = propBox(p.model), r = Math.max(9, Math.max(mx[0] - mn[0], mx[1] - mn[1]) / 2 * S.view.zoom);
    const [x, y] = w2s(p.x, p.y); if (d2(x, y) < r * r) return { kind: 'prop', id: p.id };
  }
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
  const list = { point: S.scn.points, route: S.scn.routes, area: S.scn.areas, prop: S.scn.props, item: S.scn.items,
    vehicle: S.scn.vehicles, effect: S.scn.effects, sound: S.scn.sounds }[kind];
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
    : 'No floor found under that spot - set its height by hand (Holo Entities tab).', !above.length);
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
      if (activeTab !== 'places') showTab('places'); else renderPanels('places');
    } else {
      S.drag = { type: 'pan', sx, sy, cx: S.view.cx, cy: S.view.cy };
      renderPanels('places');
    }
  } else if (S.tool === 'point') {
    const p = { id: uid('p'), name: nextName(s.points, 'Point'), yaw: 0 };
    placeZ(p, wx, wy);
    s.points.push(p);
    S.sel = { kind: 'point', id: p.id };
    S.drag = { type: 'yaw', kind: 'point', id: p.id, sx, sy };
    changed();
    showTab('places');
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
    showTab('places');
  } else if (S.tool === 'prop') {
    const p = { id: uid('o'), name: nextName(s.props, shortModel(S.propModel).split('/').pop()), model: S.propModel, yaw: 0 };
    placeZ(p, wx, wy);
    s.props.push(p);
    S.sel = { kind: 'prop', id: p.id };
    S.drag = { type: 'yaw', kind: 'prop', id: p.id, sx, sy };
    changed();
    showTab('places');
  } else if (S.tool === 'item') {
    const it = { id: uid('i'), name: nextName(s.items, S.itemName.replace(/^(item|weapon|ammo|holdable)_/, '')), item: S.itemName };
    placeZ(it, wx, wy);
    s.items.push(it);
    S.sel = { kind: 'item', id: it.id };
    changed();
    showTab('places');
  } else if (S.tool === 'vehicle' || S.tool === 'effect' || S.tool === 'sound') {
    const kind = S.tool, [listKey, nameKey] = PLACED[kind];
    // The last one picked: for effects and sounds, the newest placed that has one.
    const last = kind === 'vehicle' ? S.vehicleName : ((s[listKey].filter((x) => x[nameKey]).slice(-1)[0]) || {})[nameKey] || '';
    const base = last ? last.split('/').pop().replace(/\.(mp3|wav)$/i, '') : kind[0].toUpperCase() + kind.slice(1);
    const o = { id: uid(kind[0]), name: nextName(s[listKey], base), [nameKey]: last };
    if (kind === 'vehicle') o.yaw = 0;
    if (kind === 'effect') o.every = 1;
    placeZ(o, wx, wy);
    s[listKey].push(o);
    S.sel = { kind, id: o.id };
    if (kind === 'vehicle') S.drag = { type: 'yaw', kind: 'vehicle', id: o.id, sx, sy };
    changed();
    showTab('places');
    if (!last) toast('Pick which ' + kind + ' it is in the Holo Entities tab - new ones use the last picked.');
  } else if (S.tool === 'area') {
    const a = { id: uid('a'), name: nextName(s.areas, 'Area'), radius: 32, height: 128 };
    placeZ(a, wx, wy);
    s.areas.push(a);
    S.sel = { kind: 'area', id: a.id };
    S.drag = { type: 'radius', id: a.id };
    changed();
    showTab('places');
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
    const p = find(d.kind || 'point', d.id);
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
    const key = { point: 'points', route: 'routes', area: 'areas', prop: 'props', item: 'items', vehicle: 'vehicles', effect: 'effects', sound: 'sounds' }[sel.kind];
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
  prop: 'Click to place a prop, drag to turn it. Pick its model in the Holo Entities tab - new ones use the last picked.',
  item: 'Click to place an item (a pickup). Pick which in the Holo Entities tab - new ones use the last picked.',
  vehicle: 'Click to park a vehicle, drag to face it. Pick which in the Holo Entities tab - new ones use the last picked.',
  effect: 'Click to place a looping effect. Pick it, and how often it plays, in the Holo Entities tab.',
  sound: 'Click to place a looping sound. Pick it in the Holo Entities tab.',
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

// NPC types the server refuses to spawn (they take it down - Holo_TypeRefused
// in the engine): MBII's boba_fett, its one Boba Fett AI (jetpack) NPC.
const CRASHY_NPCS = new Set(['boba_fett']);

function validate() {
  const s = S.scn, out = [];
  const add = (level, text, focus) => out.push({ level, text, focus });
  const ids = (list) => new Set(list.map((x) => x.id));
  const pointIds = ids(s.points), routeIds = ids(s.routes), areaIds = ids(s.areas), groupIds = ids(s.groups), trigIds = ids(s.triggers);
  const startsSpawned = s.groups.some((g) => g.spawnAtStart);
  if (!s.triggers.length && !startsSpawned && !['props', 'items', 'vehicles', 'effects', 'sounds'].some((k) => (s[k] || []).length)) add('error', 'Nothing happens yet: tick "Spawn when the scenario starts" on a group, add a trigger, or place props or items.', { tab: 'triggers' });
  else if (s.triggers.length && !startsSpawned && !s.triggers.some((t) => ['start', 'timer', 'enter_area', 'all_in_area', 'players', 'use'].includes(t.when))) add('error', 'No trigger fires by itself - one needs When: start, a timer, a player entering an area or using something (or a group that spawns at the start).', { tab: 'triggers' });
  if (s.limitClasses) {
    const c = ((LISTS[clsKey(s)] || {}).classes || {})[s.classMode === 'legends' ? 'legends' : 'map'];
    const sides = s.joinTeam && s.joinTeam !== 'any' ? [s.joinTeam] : ['team1', 'team2'];
    for (const tm of sides) {
      if (c && classIds(c, tm).length && !classIds(c, tm).some((id) => (s.classes || []).includes(id)))
        add('error', 'No ' + S.teams[tm] + ' class is ticked - nobody could play that side.', { tab: 'scenario' });
    }
    if (!(s.classes || []).length) add('error', 'Classes are limited but none is ticked.', { tab: 'scenario' });
  }
  for (const [kind, [listKey, nameKey]] of Object.entries(PLACED)) {
    (s[listKey] || []).forEach((o) => { if (!o[nameKey]) add('error', 'The ' + kind + ' "' + o.name + '" needs picking - which ' + kind + ' it is (Holo Entities tab).', { kind, id: o.id }); });
  }
  const spawned = new Set();
  s.triggers.forEach((t) => t.actions.forEach((a) => { if (a.do === 'spawn') spawned.add(a.group); }));
  for (const g of s.groups) {
    const nm = g.name || 'a group';
    if (!g.npcs.length && !g.leader) add('error', 'Group "' + nm + '" has no NPC types.', { tab: 'groups' });
    if (g.spawnAtStart && !pointIds.has(g.spawn) && !routeIds.has(g.spawn)) add('error', 'Group "' + nm + '" spawns at the start - pick where (Spawns at).', { tab: 'groups' });
    if (g.behaviour === 'route' && !routeIds.has(g.route)) add('warn', 'Group "' + nm + '" walks a route but none is picked - it will just hunt.', { tab: 'groups' });
    if (!spawned.has(g.id) && !g.spawnAtStart) add('warn', 'Group "' + nm + '" is never spawned - tick "Spawn when the scenario starts", or spawn it from a trigger.', { tab: 'groups' });
    if (g.attacks === 'none' && g.behaviour === 'hunt') add('warn', 'Group "' + nm + '" is peaceful but set to Hunt - it will just stand there. Use Idle or Route.', { tab: 'groups' });
    if (s.joinTeam && s.joinTeam !== 'any' && g.attacks && g.attacks !== 'all' && g.attacks !== 'none' && g.attacks !== s.joinTeam)
      add('warn', 'Group "' + nm + '" only attacks ' + S.teams[g.attacks] + ', but players can only join ' + S.teams[s.joinTeam] + ' - so they\'re allies, not enemies.', { tab: 'groups' });
    [...g.npcs, g.leader].filter(Boolean).forEach((n) => { if (CRASHY_NPCS.has(n.toLowerCase())) add('error', 'Group "' + nm + '": NPC type "' + n + '" crashes the server, so it\'s never spawned - pick another.', { tab: 'groups' }); });
    [...g.npcs, g.leader].filter(Boolean).forEach((n) => { if (!knownNpc(n)) add('warn', 'Group "' + nm + '": NPC type "' + n + '" isn\'t one the server has.', { tab: 'groups' }); });
  }
  for (const t of s.triggers) {
    const nm = t.name || 'a trigger';
    for (const c of condsOf(t)) {
    if (c.when === 'enter_area' && !areaIds.has(c.area)) add('error', 'Trigger "' + nm + '": pick the area.', { tab: 'triggers' });
    if (c.when === 'use' && !pointIds.has(c.at) && !areaIds.has(c.at)) add('error', 'Trigger "' + nm + '": pick where it\'s used - a point or an area.', { tab: 'triggers' });
    if (['group_dead', 'group_health', 'leader_health'].includes(c.when) && !groupIds.has(c.group)) add('error', 'Trigger "' + nm + '": pick the group.', { tab: 'triggers' });
    if (c.when === 'leader_health' && groupIds.has(c.group) && !(s.groups.find((g) => g.id === c.group) || {}).leader) add('warn', 'Trigger "' + nm + '": that group has no leader to watch.', { tab: 'triggers' });
    if (c.when === 'prop_destroyed' && c.prop && !s.props.some((p) => p.id === c.prop && p.health > 0)) add('error', 'Trigger "' + nm + '": that prop isn\'t breakable (or is gone) - give it health, or pick another.', { tab: 'triggers' });
    if (c.when === 'prop_destroyed' && !c.prop && !s.props.some((p) => p.health > 0) && !s.triggers.some((x) => x.actions.some((a) => a.do === 'prop' && a.health > 0))) add('warn', 'Trigger "' + nm + '" waits for a prop to break, but no prop can be broken.', { tab: 'triggers' });
    if (c.when === 'after' && !trigIds.has(c.trigger)) add('error', 'Trigger "' + nm + '": pick the trigger it follows.', { tab: 'triggers' });
    if (!t.actions.length) add('warn', 'Trigger "' + nm + '" does nothing - add an action.', { tab: 'triggers' });
    if (t.actions.length > 16) add('error', 'Trigger "' + nm + '" has ' + t.actions.length + ' actions - 16 at most (only the first 16 are kept). Split it, e.g. with "Some seconds after another trigger".', { tab: 'triggers' });
    if ((c.when === 'all_in_area') && !areaIds.has(c.area)) add('error', 'Trigger "' + nm + '": pick the area.', { tab: 'triggers' });
    if (c.when === 'group_in_area' && !groupIds.has(c.group)) add('error', 'Trigger "' + nm + '": pick the group.', { tab: 'triggers' });
    if (c.when === 'group_in_area' && !areaIds.has(c.area)) add('error', 'Trigger "' + nm + '": pick the area.', { tab: 'triggers' });
    if ((c.when === 'group_left') && !groupIds.has(c.group)) add('error', 'Trigger "' + nm + '": pick the group.', { tab: 'triggers' });
    if (c.when === 'counter' && !s.counters.some((k) => k.id === c.counter)) add('error', 'Trigger "' + nm + '": pick the counter.', { tab: 'triggers' });
    if (c.when === 'countdown_end' && !s.triggers.some((x) => x.actions.some((a) => a.do === 'countdown'))) add('warn', 'Trigger "' + nm + '" waits for a countdown, but nothing starts one.', { tab: 'triggers' });
    }
    if (condsOf(t).filter((c) => c.when === 'use').length > 1) add('error', 'Trigger "' + nm + '": only one of its whens can be "a player uses something".', { tab: 'triggers' });
    const placeIds = new Set([...pointIds, ...areaIds]);
    const hasPlayer = whenHasPlayer(t);
    t.actions.forEach((a) => {
      if (a.do === 'tell' && !hasPlayer) add('warn', 'Trigger "' + nm + '": "Tell the player" needs a trigger one player sets off (walks into an area, dies).', { tab: 'triggers' });
      if (['explode', 'effect'].includes(a.do) && !placeIds.has(a.at) && !(a.at === 'player' && hasPlayer)) add('error', 'Trigger "' + nm + '": pick where the ' + (a.do === 'explode' ? 'explosion' : 'effect') + ' happens.', { tab: 'triggers' });
      if (a.do === 'teleport' && !placeIds.has(a.at)) add('error', 'Trigger "' + nm + '": pick where to teleport them to.', { tab: 'triggers' });
      if (a.do === 'use' && !a.target) add('error', 'Trigger "' + nm + '": pick the map entity to use.', { tab: 'triggers' });
      if (a.do === 'break' && !a.model) add('error', 'Trigger "' + nm + '": pick what to break.', { tab: 'triggers' });
      if (a.do === 'prop' && !a.model) add('error', 'Trigger "' + nm + '": pick the prop\'s model.', { tab: 'triggers' });
      if (a.do === 'prop' && !placeIds.has(a.at) && !(a.at === 'player' && hasPlayer)) add('error', 'Trigger "' + nm + '": pick where the prop goes.', { tab: 'triggers' });
      if (a.do === 'respawn' && a.where && !pointIds.has(a.where) && !routeIds.has(a.where)) add('error', 'Trigger "' + nm + '": the respawn point is gone - pick another.', { tab: 'triggers' });
      if (a.do === 'despawn' && !groupIds.has(a.group)) add('error', 'Trigger "' + nm + '": a Remove action has no group.', { tab: 'triggers' });
      if (a.do === 'arm' && !groupIds.has(a.group)) add('error', 'Trigger "' + nm + '": a Give weapon action has no group.', { tab: 'triggers' });
      if (a.do === 'side' && !groupIds.has(a.group)) add('error', 'Trigger "' + nm + '": a Change side action has no group.', { tab: 'triggers' });
      if (a.do === 'move' && !groupIds.has(a.group)) add('error', 'Trigger "' + nm + '": a New orders action has no group.', { tab: 'triggers' });
      if (a.do === 'move' && a.behaviour === 'follow_class' && !a.class) add('error', 'Trigger "' + nm + '": pick the class the group follows.', { tab: 'triggers' });
      if (a.do === 'move' && a.behaviour === 'follow' && !hasPlayer) add('info', 'Trigger "' + nm + '": no one player sets it off, so the group follows whoever\'s nearest.', { tab: 'triggers' });
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
      if ((a.do === 'loop_on' || a.do === 'loop_off') && !s.effects.concat(s.sounds).some((x) => x.id === a.target)) add('error', 'Trigger "' + nm + '": pick the placed effect or sound to turn ' + (a.do === 'loop_on' ? 'on.' : 'off.'), { tab: 'triggers' });
      if (a.do === 'log' && !a.text) add('error', 'Trigger "' + nm + '": a Log action has nothing to write.', { tab: 'triggers' });
      if (a.do === 'http' && !/^https?:\/\/\S+$/.test(a.url || '')) add('error', 'Trigger "' + nm + '": a web request needs a full http:// or https:// address.', { tab: 'triggers' });
      if (a.do === 'counter' && a.op === 'random' && (a.min ?? 1) > (a.max ?? 6)) add('warn', 'Trigger "' + nm + '": a random counter\'s lowest is above its highest (they\'ll be swapped).', { tab: 'triggers' });
    });
  }
  if (s.triggers.length && !s.triggers.some((t) => t.actions.some((a) => a.do === 'end' || a.do === 'win')))
    add('info', 'Nothing ends it, so it runs until its time limit - e.g. add When: everyone\'s down - End (or Win the round).', { tab: 'triggers' });
  for (const r of s.routes) {
    if (r.points.length < 2) add('warn', 'Route "' + r.name + '" has fewer than 2 points.', { kind: 'route', id: r.id });
    if (S.crossings[r.id]) add('warn', 'Route "' + r.name + '" goes through a wall (red) - NPCs may get stuck. Add a point to go round it.', { kind: 'route', id: r.id });
  }
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
    field('Server mode', selectIn(s, 'mode', MODES, () => {
      const was = s.classMode;
      s.classMode = s.mode === 'legends' ? 'legends' : 'map';
      // A class list from the other roster means nothing now.
      if (was !== s.classMode && s.limitClasses) { s.limitClasses = false; s.classes = []; }
      renderPanels();
    }), s.mode === 'keep' ? 'Plays in whatever mode the server is in.'
      : 'If the server is in another mode, !ht play reloads the map in this one first (everyone picks a class again), then starts it. The server goes back to its own mode on the next map.'),
    ...(s.mode === 'legends' ? [
      field(S.teams.team1 + ' team', teamPicker(s, 'team1')),
      field(S.teams.team2 + ' team', teamPicker(s, 'team2'),
        'Legends only (MBII goes by these in no other mode): any of the game\'s team setups instead of the Legends sides - ' +
        'every player already has them, nothing to download (g_siegeTeam1/2). Whole teams only - the classes in a team are its own; ' +
        'Limit classes (below) picks which of them can be played. Other teams make !ht play reload the map with them; the usual ' +
        'Legends sides come back on the next map. Played by itself (a timer, every round, a background), a scenario keeps the server\'s teams.')] : []),
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
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!s.everyRound, onchange: (e) => { s.everyRound = e.target.checked; changed(); } }),
      h('span', {}, 'Run every round - once it\'s played, it starts again with each new round (till !ht stop or a new map)')),
    h('h3', {}, 'Classes'),
    ...(s.mode === 'open' || s.mode === 'keep' ? [h('small', { class: 'muted' }, s.mode === 'open'
      ? 'In Open mode players build their own classes - there\'s no class list to limit.'
      : 'Pick a server mode to limit classes - the lists differ by mode.')] : [
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!s.limitClasses, onchange: (e) => {
      s.limitClasses = e.target.checked;
      if (s.limitClasses && !(s.classes || []).length) {
        // Start from every class, to untick the ones not wanted.
        loadClasses(s).then((c) => { s.classes = classIds(c[s.classMode || 'map']); changed(); });
      } else changed();
    } }), h('span', {}, 'Limit the classes players can pick')),
    ...(s.limitClasses ? [classPicker(s)] : [])]),
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

// The class lists: the map's, or - Legends with its own teams - those.
const scnTeams = (s) => (s.mode === 'legends' ? [s.team1 || '', s.team2 || ''] : ['', '']);
const clsKey = (s) => 'cls:' + (s.map || '') + ':' + scnTeams(s).join(':');
function loadClasses(s) {
  const [t1, t2] = scnTeams(s);
  const q = t1 || t2 ? '?team1=' + encodeURIComponent(t1) + '&team2=' + encodeURIComponent(t2) : '';
  return loadList(clsKey(s), '/api/maps/' + encodeURIComponent(s.map) + '/classes' + q, 'classes');
}

// A team picker: any of the game's team configs, or the map's own.
function teamPicker(s, side) {
  const box = h('div', { class: 'team-pick' });
  const reset = () => { s.limitClasses = false; s.classes = []; changed(); renderPanels(); };
  loadList('teams', '/api/teams', 'teams').then((teams) => {
    loadClasses(Object.assign({}, s, { team1: '', team2: '' })).then((c) => {
      const own = ((c.legends || {})[side] || {}).config || 'Legends';
      box.append(combo({ value: s[side] || '', placeholder: 'Default (' + own + ') - search ' + teams.length + ' teams',
        items: () => teams.map((t) => ({ value: t.id, sub: t.classes })),
        onPick: (v) => { s[side] = v; reset(); },
        onType: (v) => { s[side] = v.replace(/[^\w\-]/g, ''); soft(); } }));
      if (s[side]) box.append(h('button', { class: 'btn tiny', type: 'button', onclick: () => { s[side] = ''; reset(); } }, 'Default'));
    });
  });
  return box;
}

// Every class (and subclass) id in a map's /classes answer, by side.
function classIds(c, team) {
  c = c || {};
  return ['team1', 'team2'].filter((tm) => !team || tm === team)
    .flatMap((tm) => ((c[tm] || {}).classes || []).flatMap((k) => [k.id].concat(k.sub.map((x) => x.id))));
}

function classPicker(s) {
  const box = h('div', { class: 'class-list' }, h('small', { class: 'muted' }, 'Loading this map\'s classes...'));
  loadClasses(s).then((c) => {
    c = c || {};
    box.innerHTML = '';
    s.classes = s.classes || [];
    const mode = s.classMode === 'legends' ? 'legends' : 'map';
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
    box.append(h('small', { class: 'muted' }, 'Anyone on another class is told to pick again. ' + (mode === 'legends' ? 'Legends classes are the same on every map.' : 'From this map\'s own team setups.') + ' Not in Open mode, where players build their own classes.'));
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
    if (kind === 'prop') {
      const pick = h('div', {});
      loadList('props', '/api/props', 'props').then((list) => {
        const size = (p) => (p.maxs[0] - p.mins[0]) + ' x ' + (p.maxs[1] - p.mins[1]) + ', ' + (p.maxs[2] - p.mins[2]) + ' tall';
        pick.append(combo({ value: sel.model || '', items: () => list.map((p) => ({ value: p.model, sub: size(p) })), placeholder: 'Search ' + list.length + ' props',
          onPick: (v) => { sel.model = v; S.propModel = v; changed(); } }));
      });
      box.append(field('Model', pick, 'Solid - players, NPCs and shots stop at it. There from the start; gone when the scenario ends. The Prop tool puts down the last one picked.'),
        breakableFields(sel));
    }
    if (kind === 'item') {
      const pick = h('div', {});
      loadList('veh', '/api/vehicles', 'items').then((list) => {
        pick.append(combo({ value: sel.item || '', items: () => list.map((v) => ({ value: v, sub: itemKind(v) })), placeholder: 'Search ' + list.length + ' items',
          onPick: (v) => { sel.item = v; S.itemName = v; changed(); } }));
      });
      box.append(field('Item', pick, 'A pickup, as the map\'s own are - picked up, it comes back as they do. There from the start; gone when the scenario ends.'));
    }
    if (kind === 'vehicle') {
      const pick = h('div', {});
      loadList('veh', '/api/vehicles', 'vehicles').then((list) => {
        pick.append(combo({ value: sel.vehicle || '', items: () => list.map((v) => ({ value: v })), placeholder: 'Search ' + list.length + ' vehicles',
          onPick: (v) => { sel.vehicle = v; S.vehicleName = v; changed(); } }));
      });
      box.append(field('Vehicle', pick, 'Parked there from the start, ready to ride. Taken away when the scenario ends - unless someone\'s riding it.'));
    }
    if (kind === 'effect') {
      box.append(field('Effect', effectPicker(sel, 'effect'), 'Played there over and over while the scenario runs - fire, smoke, sparks, steam...'),
        field('Every (seconds)', numIn(sel, 'every', { min: 0.2, max: 60, step: 0.1 }), 'How often it plays again. Match it to the effect\'s length for a steady loop.'));
    }
    if (kind === 'sound') {
      box.append(field('Sound', soundPicker(sel, 'sound', 'sound/... - a looping one works best'), 'Plays on a loop there for the whole scenario, heard by anyone nearby - alarms, machinery, a crowd...'));
    }
    if (kind === 'effect' || kind === 'sound') {
      box.append(h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!sel.startOff, onchange: (e) => { sel.startOff = e.target.checked; changed(); } }),
        h('span', { class: 'small' }, 'Starts off - a trigger turns it on (Turn on a placed looping effect or sound)')));
    }
    if (['point', 'area', 'prop', 'item', 'vehicle', 'effect', 'sound'].includes(kind)) {
      box.append(h('div', { class: 'grid3' }, field('x', numIn(sel, 'x')), field('y', numIn(sel, 'y')), field('z', numIn(sel, 'z'))));
      const floors = surfacesAt(sel.x, sel.y);
      if (floors.length > 1) box.append(h('div', { class: 'snap' }, h('span', { class: 'muted small' }, 'Floors here: '),
        floors.slice(0, 6).map((z) => h('button', { class: 'btn tiny' + (Math.abs(z - sel.z) < 2 ? ' on' : ''), onclick: () => { sel.z = Math.round(z); changed(); } }, String(Math.round(z))))));
    }
    if (kind === 'point' || kind === 'prop' || kind === 'vehicle') box.append(field('Facing (degrees)', numIn(sel, 'yaw', { min: 0, max: 359 })));
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
  listFor('Props', 'prop', s.props || [], (p) => ' ' + shortModel(p.model));
  listFor('Items', 'item', s.items || [], (i) => ' ' + i.item);
  listFor('Vehicles', 'vehicle', s.vehicles || [], (v) => ' ' + (v.vehicle || 'pick one'));
  listFor('Effects', 'effect', s.effects || [], (f) => ' ' + (f.effect || 'pick one') + ', every ' + f.every + 's');
  listFor('Sounds', 'sound', s.sounds || [], (o) => ' ' + (o.sound || 'pick one'));
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
    n.health + ' health' + (n.armor ? ', ' + n.armor + ' armour' : ''), 'skill ' + n.skill]
    .concat(n.weapon === 'WP_SABER' && (n.saber || n.saber2) ? [[n.saber, n.saber2].filter(Boolean).join(' + ')] : [], n.peaceful ? ['peaceful'] : []).join(' \u00B7 ');
}
function groupSummary(g) {
  const who = g.npcs.length ? g.npcs.join(', ') : 'no NPC types';
  const many = g.count + (g.perPlayer ? ' +' + g.perPlayer + '/player' : '') + (g.leader ? ' + ' + g.leader : '');
  const attacks = !g.attacks || g.attacks === 'all' ? 'attacks everyone' : g.attacks === 'none' ? 'peaceful' : 'attacks ' + S.teams[g.attacks];
  return [who, many, g.behaviour, attacks].concat(g.spawnAtStart ? ['at start: ' + nameOf(S.scn.points.concat(S.scn.routes), g.spawn)] : []).join(' \u00B7 ');
}
const ACTION_SHORT = {
  spawn: 'spawn', despawn: 'remove group', say: 'NPC speech', tell: 'tell player', message: 'chat', center: 'centre message',
  explode: 'explosion', effect: 'effect', shake: 'shake', sound: 'sound', music: 'music', teleport: 'teleport', use: 'use entity', break: 'break', respawn: 'move respawn', prop: 'prop',
  give: 'give', heal: 'heal', kill: 'kill', knockdown: 'knock down', freeze: 'freeze', vehicle: 'vehicle', pickup: 'pickup',
  move: 'new orders', side: 'change side', arm: 'give weapon', trigger_on: 'trigger on', trigger_off: 'trigger off', counter: 'counter', countdown: 'countdown',
  objective: 'objective', texture: 'texture swap', gravity: 'gravity', speed: 'speed', addtime: 'round time', win: 'win round', end: 'end',
  loop_on: 'loop on', loop_off: 'loop off', log: 'log', http: 'web request',
};
function triggerSummary(t) {
  const when = condsOf(t).map((c) => (WHENS.find((w) => w.v === c.when) || {}).t || c.when).join(t.match === 'any' ? ' OR ' : ' AND ');
  const acts = t.actions.map((a) => ACTION_SHORT[a.do] || a.do);
  return [when, t.actions.length + ' action' + (t.actions.length === 1 ? '' : 's') + (acts.length ? ': ' + acts.slice(0, 4).join(', ') + (acts.length > 4 ? '...' : '') : '')]
    .concat(t.repeat ? ['every time'] : [], t.startOff ? ['starts off'] : []).join(' \u00B7 ');
}

function renderNpcs(el) {
  const s = S.scn;
  el.append(h('p', { class: 'muted' }, 'Your own NPC types for this scenario. They\'re hostile to everyone - unless Peaceful. Saving writes them into the server\'s NPC folder, ',
    'and the server picks up new or changed ones the next time a scenario starts. Groups can also use any of the ' + S.npcs.length + ' types the server already has.'));
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
      n.weapon === 'WP_SABER' ? saberFields(n) : null,
      h('div', { class: 'grid3' }, field('Health', numIn(n, 'health', { min: 1, max: 5000 })), field('Armour', numIn(n, 'armor', { min: 0, max: 1000 })), field('Size %', numIn(n, 'scale', { min: 40, max: 250 }))),
      h('div', { class: 'grid2' }, field('Skill', selectIn(n, 'skill', [1, 2, 3, 4, 5].map((k) => ({ v: k, t: ['', '1 - raw recruit', '2 - poor', '3 - average', '4 - veteran', '5 - elite'][k] })))),
        field('Run speed', numIn(n, 'runSpeed', { min: 50, max: 400 }))),
      abilityFields(n),
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!n.peaceful, onchange: (e) => { n.peaceful = e.target.checked; changed(); } }),
        h('span', {}, 'Peaceful - attacks nobody, like the bartender (for a background\'s customers)')),
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

// A saber NPC type's hilt(s) - any of the game's saber definitions: the
// MagnaGuard's electrostaff, Grievous' two-bladed pair, staffs... - colours
// and style.
const SABER_STYLES = [
  { v: 0, t: 'From the saber(s)' }, { v: 1, t: 'Fast (blue)' }, { v: 2, t: 'Medium (yellow)' },
  { v: 3, t: 'Strong (red)' }, { v: 4, t: 'Desann' }, { v: 5, t: 'Tavion' },
];
function saberFields(n) {
  const box = h('div', {});
  const colours = SABER_COLORS.map((c) => ({ v: c, t: c }));
  loadList('sabers', '/api/sabers', 'sabers').then((sabers) => {
    const items = () => sabers.map((s) => ({ value: s.id, sub: s.name + ' \u00B7 ' + s.kind + (s.blades > 1 ? ', ' + s.blades + ' blades' : '') }));
    const known = (id) => sabers.find((s) => s.id.toLowerCase() === String(id || '').toLowerCase());
    const hint = (id) => { const s = known(id); return s ? s.name + ' - ' + s.kind + (s.blades > 1 ? ', ' + s.blades + ' blades' : '') : (id ? 'Not a saber the game has' : ''); };
    const staff = (known(n.saber) || {}).kind === 'staff';
    box.append(
      h('div', { class: 'grid2' },
        field('Saber', combo({ value: n.saber || '', items, placeholder: 'Plain single saber - search ' + sabers.length,
          onPick: (v) => { n.saber = v; changed(); }, onType: (v) => { n.saber = v.replace(/[^\w\-]/g, ''); soft(); } }), hint(n.saber)),
        field('Colour', selectIn(n, 'saberColor', colours))),
      h('div', { class: 'grid2' },
        field('Second saber (optional)', combo({ value: n.saber2 || '', items, placeholder: 'None - search ' + sabers.length,
          onPick: (v) => { n.saber2 = v; changed(); }, onType: (v) => { n.saber2 = v.replace(/[^\w\-]/g, ''); soft(); } }),
          n.saber2 ? hint(n.saber2) : 'One in each hand - they fight dual.'),
        n.saber2 ? field('Its colour', selectIn(n, 'saber2Color', colours)) : h('div', {})),
      n.saber2 ? h('div', { class: 'row-end' }, h('button', { class: 'btn tiny', type: 'button', onclick: () => { n.saber2 = ''; changed(); } }, 'No second saber')) : null,
      n.saber2 || staff ? h('small', { class: 'muted', style: 'display:block;margin-bottom:10px' }, n.saber2 ? 'Two sabers: they fight dual.' : 'A staff: they fight staff.')
        : field('Style', selectIn(n, 'saberStyle', SABER_STYLES)),
      h('small', { class: 'muted', style: 'display:block;margin-bottom:10px' },
        'E.g. a MagnaGuard: model magnaguard, saber electrostaff. Grievous: model grievous4, sabers grievb4 and grievg4.'));
  });
  return box;
}

// MBII attributes for an NPC type. Passive ones (defences, armour, plating,
// strength...) work on NPCs - MBII's own NPC files use them; ones a player
// has to use (jetpack, cloak, sentry...) the NPC AI never does.
const ATT_NAMES = {
  MB_ATT_FP_SABER_DEFENSE: 'Saber defence', MB_ATT_GUN_DEFENSE: 'Blaster defence', MB_ATT_DEFLECT: 'Blaster deflect',
  MB_ATT_FORCEBLOCK: 'Force block', MB_ATT_FORCEFOCUS: 'Force focus', MB_ATT_HEALING: 'Healing / auto repair',
  MB_ATT_BLAST_ARMOUR: 'Blast armour', MB_ATT_MAGNETIC_PLATING: 'Magnetic plating', MB_ATT_CORTOSIS: 'Cortosis (saber resistant)',
  MB_ATT_BESKAR: 'Beskar armour', MB_ATT_ENV_PROT: 'Environment protection', MB_ATT_WOOKIE_STRENGTH: 'Strength',
  MB_ATT_WOOKIEE_FURY: 'Wookiee fury', MB_ATT_DEXTERITY: 'Dexterity', MB_ATT_GETUPS: 'Quick get-ups', MB_ATT_FLIPKICK: 'Flip kick',
  MB_ATT_SPEEDLUNGE: 'Speed lunge', MB_ATT_SABER_COMBO: 'Saber combos', MB_ATT_FP_REPULSE: 'Force repulse',
  MB_ATT_BUNNY_HOP: 'Bunny hop', MB_ATT_FLOAT_HOP: 'Float hop', MB_ATT_DASH: 'Dash', MB_ATT_STAMINA: 'Stamina',
  MB_ATT_KNOCKDOWN_ROLL: 'Knockdown roll', MB_ATT_SHIELD_RECHARGE: 'Shield recharge', MB_ATT_RECHARGE: 'Battery recharge',
  MB_ATT_CCTRAINING: 'Close combat training', MB_ATT_DODGE: 'Dodge', MB_ATT_ARMOUR: 'Armour', MB_ATT_FP_LIGHTNING: 'Force lightning',
  MB_ATT_FP_PULL: 'Force pull', MB_ATT_FP_RAGE: 'Force rage', MB_ATT_FIREPOWER: 'Firepower',
};
const attLabel = (id) => ATT_NAMES[id] || id.replace(/^MB_ATT_(FP_)?/, '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

function abilityFields(n) {
  n.attributes = n.attributes || [];
  const box = h('div', { class: 'abilities' }, h('b', {}, 'Abilities'),
    h('small', { class: 'muted', style: 'display:block;margin-bottom:6px' },
      'MBII class attributes. Passive ones - defences, armour, plating, strength - work on NPCs (MBII\'s own use them); ' +
      'ones a player has to use (jetpack, cloak, sentry...) the NPC never will. E.g. a MagnaGuard: saber defence 1, blaster defence 1, ' +
      'force block 3, magnetic plating 1, blast armour 1. Grievous: saber defence 3, blaster defence 2, deflect 1, force block 3.'));
  loadList('atts', '/api/attributes', 'attributes').then((atts) => {
    const byId = {};
    atts.forEach((a) => { byId[a.id] = a; });
    const items = () => atts.map((a) => ({ value: a.id, sub: attLabel(a.id) + (a.npcs ? ' \u00B7 used by MBII NPCs' : '') + ' \u00B7 up to ' + a.max }));
    n.attributes.forEach((a, i) => {
      const max = (byId[a.id] || {}).max || 100;
      box.append(h('div', { class: 'grid-att', style: 'display:flex;gap:6px;align-items:center;margin-bottom:4px' },
        h('span', { class: 'grow', title: a.id }, attLabel(a.id)),
        h('input', { type: 'number', min: 1, max: max, value: a.level, style: 'width:70px', title: '1 to ' + max,
          oninput: (e) => { a.level = clamp(Math.round(+e.target.value) || 1, 1, max); soft(); } }),
        h('button', { class: 'btn tiny', type: 'button', title: 'Remove', onclick: () => { n.attributes.splice(i, 1); changed(); } }, 'x')));
    });
    if (n.attributes.length < 24) {
      box.append(combo({ items, clearOnPick: true, placeholder: '+ add an ability - search ' + atts.length,
        onPick: (v) => { if (!n.attributes.some((a) => a.id === v)) n.attributes.push({ id: v, level: 1 }); changed(); } }));
    }
    box.append(h('div', { class: 'grid3', style: 'margin-top:8px' },
      field('PB chance', numIn(n, 'pbChance', { min: 0, max: 100, placeholder: 'game' }), 'MBII NPCs: ~40'),
      field('MB chance', numIn(n, 'mbChance', { min: 0, max: 100, placeholder: 'game' }), 'MBII NPCs: ~4'),
      field('SB chance', numIn(n, 'sbChance', { min: 0, max: 100, placeholder: 'game' }), 'MBII NPCs: 50-90')),
      field('Force pool', numIn(n, 'forcePool', { min: 0, max: 1000, placeholder: 'game' }), 'For force-based abilities (MBII NPCs: 100-200). 0 = the game\'s own.'));
  });
  return box;
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
// Who a group attacks (its side) - on the group, and the Change side action.
const ATTACKS = () => [
  { v: 'all', t: 'Everyone (hostile to all)' },
  { v: 'team1', t: 'Only ' + S.teams.team1 + ' - they fight for ' + S.teams.team2 },
  { v: 'team2', t: 'Only ' + S.teams.team2 + ' - they fight for ' + S.teams.team1 },
  { v: 'none', t: 'Nobody - peaceful (and they can\'t be hurt)' },
];

// New orders can also be Follow: after the player who set the trigger off.
const ORDERS = BEHAVIOURS.concat([
  { v: 'follow', t: 'Follow - the player who set it off' },
  { v: 'follow_class', t: 'Follow a class - the nearest player playing it' },
]);
const MODES = [
  { v: 'fa', t: 'Full Authentic - the map\'s own classes' },
  { v: 'semi', t: 'Semi-Authentic' },
  { v: 'legends', t: 'Legends - the Legends roster' },
  { v: 'open', t: 'Open - players build their own classes' },
  { v: 'keep', t: 'Don\'t change - the server\'s mode' },
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
      field('Attacks', selectIn(g, 'attacks', ATTACKS()), g.attacks === 'none'
        ? 'They never fight and can\'t be hurt - for a background\'s customers. Idle stands them on the spot; Route walks it round and round.'
        : g.attacks && g.attacks !== 'all'
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
  { v: 'use', t: 'A player uses something (holds the use key there)', player: true },
  { v: 'all_in_area', t: 'Every player is inside an area' },
  { v: 'group_dead', t: 'A group is all down' },
  { v: 'group_left', t: 'A group is down to N or fewer' },
  { v: 'group_in_area', t: 'NPCs of a group walk into an area' },
  { v: 'all_dead', t: 'Every NPC so far is down' },
  { v: 'npc_killed', t: 'Any scenario NPC is killed' },
  { v: 'player_died', t: 'A player dies', player: true },
  { v: 'players', t: 'N or more players are in the game' },
  { v: 'after', t: 'Some seconds after another trigger' },
  { v: 'counter', t: 'A counter reaches a value' },
  { v: 'countdown_end', t: 'The countdown reaches zero' },
  { v: 'group_health', t: 'A group\'s health falls to N% or below' },
  { v: 'leader_health', t: 'A group\'s leader falls to N% health or below (bosses)' },
  { v: 'prop_destroyed', t: 'A breakable prop is broken', player: true },
];
const ACTION_TYPES = [
  { v: 'spawn', t: 'Spawn a group', c: 'NPCs', k: 'enemies wave reinforcements' },
  { v: 'despawn', t: 'Remove a group', c: 'NPCs', k: 'delete clear' },
  { v: 'say', t: 'An NPC says something (everyone)', c: 'Messages', k: 'talk speak chat voice dialogue' },
  { v: 'tell', t: 'Tell the player who set it off (only them)', c: 'Messages', k: 'whisper private' },
  { v: 'message', t: 'Chat message (everyone)', c: 'Messages', k: 'chat text' },
  { v: 'center', t: 'Big centre message (everyone)', c: 'Messages', k: 'screen title text' },
  { v: 'explode', t: 'Explosion (hurts players and NPCs)', c: 'World', k: 'bomb grenade blast damage' },
  { v: 'effect', t: 'Visual effect', c: 'World', k: 'fx particles fire smoke sparks' },
  { v: 'shake', t: 'Shake the screen', c: 'World', k: 'earthquake camera' },
  { v: 'sound', t: 'Play a sound', c: 'Sound', k: 'audio noise' },
  { v: 'music', t: 'Change the music', c: 'Sound', k: 'song track audio' },
  { v: 'teleport', t: 'Teleport players', c: 'Players', k: 'move warp' },
  { v: 'use', t: 'Use a map entity (door, lift, button...)', c: 'Map', k: 'door lift button open activate' },
  { v: 'break', t: 'Break something on the map (window, wall...)', c: 'Map', k: 'destroy smash glass' },
  { v: 'respawn', t: 'Move where a side respawns', c: 'Players', k: 'spawn point side' },
  { v: 'prop', t: 'Place a prop (crate, barrel, barrier...) - solid', c: 'World', k: 'model object crate barrel barrier' },
  { v: 'give', t: 'Give players a weapon, health, armour, ammo or item', c: 'Players', k: 'weapon health armour ammo item' },
  { v: 'heal', t: 'Heal players to full', c: 'Players', k: 'health' },
  { v: 'kill', t: 'Kill players', c: 'Players', k: 'death' },
  { v: 'knockdown', t: 'Knock players down', c: 'Players', k: 'stun' },
  { v: 'freeze', t: 'Freeze players (can look, not move or shoot)', c: 'Players', k: 'stop hold stun' },
  { v: 'vehicle', t: 'Spawn a vehicle', c: 'World', k: 'swoop speeder ride' },
  { v: 'pickup', t: 'Drop a pickup (medpack, weapon, ammo...)', c: 'World', k: 'item medpack weapon ammo drop' },
  { v: 'move', t: 'Give a group new orders (hunt, route, guard, idle, follow)', c: 'NPCs', k: 'orders behaviour hunt route guard idle follow' },
  { v: 'side', t: 'Change a group\'s side (who it attacks)', c: 'NPCs', k: 'team attack ally enemy' },
  { v: 'arm', t: 'Give a group a weapon', c: 'NPCs', k: 'weapon' },
  { v: 'trigger_on', t: 'Turn a trigger on (and re-arm it)', c: 'Logic', k: 'enable arm' },
  { v: 'trigger_off', t: 'Turn a trigger off', c: 'Logic', k: 'disable' },
  { v: 'counter', t: 'Change a counter (add, set, or a random number)', c: 'Logic', k: 'variable number add set random dice chance' },
  { v: 'countdown', t: 'Start a countdown (on everyone\'s screen)', c: 'Logic', k: 'timer clock' },
  { v: 'objective', t: 'Complete a map objective', c: 'Round', k: 'siege complete' },
  { v: 'texture', t: 'Swap a texture', c: 'Map', k: 'shader remap swap' },
  { v: 'gravity', t: 'Change gravity', c: 'World', k: 'physics jump' },
  { v: 'speed', t: 'Change player speed', c: 'Players', k: 'run slow fast' },
  { v: 'addtime', t: 'Add time to the round clock', c: 'Round', k: 'clock time limit' },
  { v: 'loop_on', t: 'Turn on a placed looping effect or sound', c: 'World', k: 'start alarm fire smoke loop enable' },
  { v: 'loop_off', t: 'Turn off a placed looping effect or sound', c: 'World', k: 'stop alarm fire smoke loop disable' },
  { v: 'log', t: 'Write a line to the server\'s games log', c: 'Logic', k: 'log file record games.log' },
  { v: 'http', t: 'Send a web request (GET / POST to an API)', c: 'Logic', k: 'http api webhook url post get discord' },
  { v: 'win', t: 'Win the round for a side (ends the round)', c: 'Round', k: 'victory end' },
  { v: 'end', t: 'End the scenario', c: 'Round', k: 'finish stop' },
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
// A trigger's whens: its own, and any more it has ("also").
const condsOf = (t) => [t].concat(t.also || []);
const whenHasPlayer = (t) => condsOf(t).some((c) => !!(WHENS.find((w) => w.v === c.when) || {}).player);

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
  const pickKind = (v) => {
    if (v === a.do) return;
    for (const k of Object.keys(a)) delete a[k];
    a.do = v;
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
    if (a.do === 'side') a.attacks = 'all';
    if (a.do === 'arm') a.weapon = 'WP_BLASTER';
    if (a.do === 'respawn') Object.assign(a, { team: (S.scn.joinTeam && S.scn.joinTeam !== 'any') ? S.scn.joinTeam : 'both', where: '' });
    if (a.do === 'counter') { a.op = 'add'; a.value = 1; a.min = 1; a.max = 6; a.counter = (S.scn.counters[0] || {}).id || ''; }
    if (a.do === 'loop_on' || a.do === 'loop_off') a.target = ((S.scn.effects[0] || S.scn.sounds[0]) || {}).id || '';
    if (a.do === 'log') a.text = '';
    if (a.do === 'http') Object.assign(a, { method: 'POST', url: '', body: '{"scenario": "{scenario}", "player": "{player}"}', contentType: 'application/json' });
    if (a.do === 'countdown') { a.seconds = 30; a.text = ''; }
    if (a.do === 'objective') { a.team = 'team1'; a.objective = 1; }
    if (a.do === 'gravity') { a.value = 200; a.seconds = 30; }
    if (a.do === 'speed') { a.value = 200; a.seconds = 30; }
    changed();
  };
  // Searchable: by its name, its kind (NPCs, Players...) or a word for it.
  const kindLabel = () => (ACTION_TYPES.find((o) => o.v === a.do) || {}).t || a.do;
  const kind = combo({ value: kindLabel(), placeholder: 'Search actions', items: ACTION_TYPES.map((o) => ({ value: o.t, sub: o.c, search: o.v + ' ' + o.k })),
    onPick: (label) => { const o = ACTION_TYPES.find((x) => x.t === label); if (o) pickKind(o.v); } });
  kind.classList.add('combo-plain');
  // Left without picking: back to what it is.
  kind.querySelector('input').addEventListener('blur', () => setTimeout(() => { kind.querySelector('input').value = kindLabel(); }, 150));
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
        selectIn(a, 'behaviour', ORDERS));
      if (a.behaviour === 'follow_class') {
        // The map's (or Legends') classes, by side - the same ids class limits use.
        const sel = h('select', { onchange: (e) => { a.class = e.target.value; changed(); } }, h('option', { value: '' }, 'Loading classes...'));
        loadClasses(s2).then((c) => {
          c = (c || {})[s2.classMode === 'legends' ? 'legends' : 'map'] || {};
          sel.innerHTML = '';
          sel.append(h('option', { value: '' }, '- pick a class -'));
          for (const tm of ['team1', 'team2']) {
            const og = h('optgroup', { label: S.teams[tm] });
            ((c[tm] || {}).classes || []).forEach((k) => {
              og.append(h('option', { value: k.id, selected: a.class === k.id }, k.name));
              (k.sub || []).forEach((x) => og.append(h('option', { value: x.id, selected: a.class === x.id }, '\u00A0\u00A0' + x.name)));
            });
            if (og.children.length) sel.append(og);
          }
          if (a.class && ![...sel.options].some((o) => o.value === a.class)) sel.append(h('option', { value: a.class, selected: true }, a.class));
        });
        row.append(sel);
      }
      if (a.behaviour === 'follow' || a.behaviour === 'follow_class') {
        const g = s2.groups.find((x) => x.id === a.group);
        const what = !g ? '' : g.attacks === 'none' ? ' They\'re peaceful, so they just tag along.'
          : g.attacks === 'all' || !g.attacks ? ' This group attacks everyone, so they go after that player - give it a side, or make it peaceful, for an escort.'
          : ' They fight enemies who come close, then carry on following.';
        row.append(h('small', { class: 'muted', style: 'display:block' },
          (a.behaviour === 'follow_class'
            ? 'They walk after whoever\'s nearest playing that class, a few steps behind - and move on to the next one if that player dies, leaves or changes class. Nobody on it: they wait. Not in Open mode, where players build their own classes.'
            : (whenHasPlayer(t) ? 'They walk after the player who set it off, a few steps behind, running to catch up.' :
              'This trigger isn\'t set off by one player, so they follow whoever\'s nearest them.') + ' If that player dies or leaves, they wait where they are.') + what));
      }
      if (a.behaviour === 'route') row.append(selectIn(a, 'route', [{ v: '', t: '- pick a route -' }].concat(s2.routes.map((r) => ({ v: r.id, t: r.name })))), selectIn(a, 'pace', PACES));
      if (a.behaviour === 'guard') row.append(placeSelect(a, t, 'Where each of them spawned'));
      break;
    }
    case 'arm':
      row.append(selectIn(a, 'group', [{ v: '', t: '- pick a group -' }].concat(S.scn.groups.map((x) => ({ v: x.id, t: x.name })))),
        selectIn(a, 'weapon', S.weapons.filter((w) => w !== 'WP_SABER').map((w) => ({ v: w, t: w.replace(/^WP_/, '').replace(/_/g, ' ').toLowerCase() }))),
        h('small', { class: 'muted', style: 'display:block' },
          'They switch to it within a second, and any of the group spawned later carry it too. Not lightsabers - make a saber NPC type for those.'));
      break;
    case 'side': {
      const g = S.scn.groups.find((x) => x.id === a.group);
      row.append(selectIn(a, 'group', [{ v: '', t: '- pick a group -' }].concat(S.scn.groups.map((x) => ({ v: x.id, t: x.name })))),
        selectIn(a, 'attacks', ATTACKS()),
        h('small', { class: 'muted', style: 'display:block' },
          'Its NPCs already up switch at once and drop who they were after; any of it spawned later come in on the new side.' +
          (g ? ' (It starts as: ' + ((ATTACKS().find((o) => o.v === (g.attacks || 'all')) || {}).t || g.attacks) + '.)' : '')));
      break;
    }
    case 'trigger_on': case 'trigger_off':
      row.append(selectIn(a, 'trigger', [{ v: '', t: '- pick a trigger -' }].concat(S.scn.triggers.filter((x) => x !== t).map((x) => ({ v: x.id, t: x.name })))));
      break;
    case 'counter':
      row.append(h('div', { class: 'grid3' },
        field('Counter', selectIn(a, 'counter', [{ v: '', t: '- pick -' }].concat(S.scn.counters.map((c) => ({ v: c.id, t: c.name }))))),
        field('', selectIn(a, 'op', [{ v: 'add', t: 'add' }, { v: 'set', t: 'set to' }, { v: 'random', t: 'set to a random number' }])),
        a.op === 'random' ? h('div', { class: 'input-row' }, h('span', { class: 'muted small' }, 'from'), numIn(a, 'min', { min: -9999, max: 9999 }),
          h('span', { class: 'muted small' }, 'to'), numIn(a, 'max', { min: -9999, max: 9999 }))
          : field('', numIn(a, 'value', { min: -9999, max: 9999 }))));
      if (a.op === 'random') row.append(h('small', { class: 'muted' }, 'A whole number, both ends included - from 1 to 3 is 1, 2 or 3. Then a "A counter reaches a value" trigger for each (counter exactly 1, exactly 2...) picks what happens.'));
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
    case 'prop': {
      const box = h('div', {});
      loadList('props', '/api/props', 'props').then((list) => {
        const size = (p) => (p.maxs[0] - p.mins[0]) + ' x ' + (p.maxs[1] - p.mins[1]) + ', ' + (p.maxs[2] - p.mins[2]) + ' tall';
        box.prepend(combo({ value: a.model || '', items: () => list.map((p) => ({ value: p.model, sub: size(p) })),
          placeholder: 'Search ' + list.length + ' props - crate, barrel, cargo...',
          onPick: (v) => { a.model = v; changed(); }, onType: (v) => { a.model = v; soft(); } }));
      });
      const yaw = h('input', { type: 'number', min: 0, max: 359, value: a.yaw ?? '', placeholder: 'the point\'s own', style: 'max-width:120px',
        oninput: (e) => { if (e.target.value === '') delete a.yaw; else a.yaw = +e.target.value; soft(); } });
      row.append(box, h('div', { class: 'input-row' }, placeSelect(a, t), h('span', { class: 'muted small' }, 'facing'), yaw),
        h('small', { class: 'muted' }, 'Stands on the floor there, solid - players, NPCs and shots stop at it. Gone when the scenario ends. Its box is square to the map, so a turned prop blocks a little more than it shows.'),
        breakableFields(a));
      break;
    }
    case 'loop_on': case 'loop_off': {
      const opts = [{ v: '', t: '- pick one -' }].concat(S.scn.effects.map((e) => ({ v: e.id, t: 'Effect: ' + e.name })), S.scn.sounds.map((x) => ({ v: x.id, t: 'Sound: ' + x.name })));
      row.append(selectIn(a, 'target', opts), h('small', { class: 'muted' }, S.scn.effects.length || S.scn.sounds.length
        ? 'A looping effect or sound placed on the map (the Effect and Sound tools). Tick "Starts off" on it for one that a trigger turns on later.'
        : 'Place a looping effect or sound on the map first (the Effect and Sound tools).'));
      break;
    }
    case 'log':
      row.append(textIn(a, 'text', { maxlength: 190, placeholder: 'e.g. {player} hacked the console' }),
        h('small', { class: 'muted' }, 'Written to the server\'s games log as "Holotable: <scenario>: <text>" - for the server\'s own tools (stats, bots) to pick up. {player} is the player who set it off.'));
      break;
    case 'http':
      row.append(h('div', { class: 'input-row' },
        selectIn(a, 'method', [{ v: 'GET', t: 'GET' }, { v: 'POST', t: 'POST' }]),
        textIn(a, 'url', { maxlength: 250, placeholder: 'https://example.com/api/hook?player={player}', class: 'grow' })));
      if (a.method === 'POST') row.append(field('Body', h('textarea', { rows: 3, maxlength: 500, oninput: (e) => { a.body = e.target.value; soft(); } }, a.body || '')),
        field('Content type', textIn(a, 'contentType', { maxlength: 80, placeholder: 'application/json' })));
      row.append(h('small', { class: 'muted' }, 'Sent by the game server as it happens, without waiting for an answer (10 seconds at most). {player}, {scenario} and {map} are filled in. Only admins can add or change these.'));
      break;
    case 'respawn':
      row.append(selectIn(a, 'team', [
        { v: 'both', t: 'Both sides' },
        { v: 'team1', t: S.teams.team1 },
        { v: 'team2', t: S.teams.team2 },
      ]), selectIn(a, 'where', [{ v: '', t: 'The map\'s own spawns (put back)' }]
        .concat(S.scn.points.map((p) => ({ v: p.id, t: 'Point: ' + p.name })), S.scn.routes.map((r) => ({ v: r.id, t: 'Along route: ' + r.name })))),
      h('small', { class: 'muted' }, 'From now on, players on that side who spawn are moved there straight away - spread round a point, or a route\'s points in turn. Lasts till another of these or the scenario ends.'));
      break;
    case 'break': {
      // The map's breakables (loaded with the map's entities).
      const list = (S.ents || []).filter((e) => e.m && /breakable|glass/i.test(e.c));
      const label = (e) => (e.n ? '"' + e.n + '" ' : '') + e.c.replace(/^func_/, '') + ' ' + e.m + ' (' + e.x + ', ' + e.y + ', floor ' + (e.b ? e.b[2] : e.z) + ')';
      const holder = { pick: a.model || '' };
      const sel = selectIn(holder, 'pick', [{ v: '', t: list.length ? '- pick one of ' + list.length + ' -' : (S.ents ? 'This map has no breakables' : 'Loading the map\'s entities...') }]
        .concat(list.map((e) => ({ v: e.m, t: label(e) }))), () => {
        const e = list.find((x) => x.m === holder.pick);
        a.model = holder.pick; a.target = (e && e.n) || '';
        changed();
      });
      const show = h('button', { type: 'button', class: 'btn tiny', title: 'Show it on the map', onclick: () => {
        const e = list.find((x) => x.m === a.model);
        if (e) { S.entShow[e.k] = true; S.entHover = e; setCut(Math.max(S.cut, (e.b ? e.b[2] : e.z) + 60)); centreOn(e.x, e.y); setupEntKinds(); }
      } }, 'Show');
      row.append(h('div', { class: 'input-row' }, sel, show),
        h('small', { class: 'muted' }, 'Smashed as if shot to pieces. It stays broken till the round restarts.'));
      break;
    }
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

// A prop's breakable settings: placed ones and "place a prop" alike.
function breakableFields(o) {
  const box = h('div', { class: 'sub-box' });
  box.append(field('Health (0 = can\'t be broken)', numIn(o, 'health', { min: 0, max: 100000, onchange: () => changed() }),
    o.health > 0 ? 'Shots, sabers and explosions wear it down; at 0 it breaks and is gone.' : 'Give it health to make it breakable - crates, barrels, a door to blast through.'));
  if (o.health > 0) {
    if (o.blastRadius === undefined) o.blastRadius = 250;
    box.append(
      h('div', { class: 'grid2' }, field('Hit effect', effectPicker(o, 'hitEffect'), 'Where each hit lands - sparks, chips...'),
        field('Badly hurt effect', effectPicker(o, 'damagedEffect'), 'Every second once half its health is gone - smoke, fire...')),
      h('div', { class: 'grid2' }, field('Break effect', effectPicker(o, 'breakEffect'), 'As it breaks - an explosion, debris...'),
        field('Break sound', soundPicker(o, 'breakSound', 'sound/... (optional)'))),
      h('div', { class: 'grid2' }, field('Blast damage (0 = none)', numIn(o, 'blastDamage', { min: 0, max: 1000 }), 'Hurts everyone (and other breakable props) round it as it breaks - explosive barrels.'),
        field('Blast radius', numIn(o, 'blastRadius', { min: 16, max: 2048 }))));
  }
  return box;
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

// The fields one "when" needs (c: the trigger itself, or one of its "also").
function condFields(c, t) {
  const s = S.scn, out = [];
  const areaSel = () => field('Area', selectIn(c, 'area', [{ v: '', t: '- pick -' }].concat(s.areas.map((a) => ({ v: a.id, t: a.name })))));
  const groupSel = () => field('Group', selectIn(c, 'group', [{ v: '', t: '- pick -' }].concat(s.groups.map((g) => ({ v: g.id, t: g.name })))));
  if (c.when === 'timer') out.push(field(t.repeat ? 'Every (seconds)' : 'Seconds after the start', numIn(c, 'seconds', { min: 0, max: 3600 })));
  if (c.when === 'enter_area' || c.when === 'all_in_area') out.push(areaSel());
  if (c.when === 'use') {
    if (c.hold === undefined) Object.assign(c, { hold: 3, bar: true, radius: 64, soundEvery: 1, team: 'any', label: '', sound: '' });
    const places = [{ v: '', t: '- pick -' }].concat(s.points.map((p) => ({ v: p.id, t: 'Point: ' + p.name })), s.areas.map((a) => ({ v: a.id, t: 'Area: ' + a.name + ' (anywhere in it)' })));
    const atPoint = s.points.some((p) => p.id === c.at);
    out.push(
      h('div', { class: 'grid2' }, field('Where', selectIn(c, 'at', places)),
        atPoint ? field('Within (units)', numIn(c, 'radius', { min: 16, max: 1024 })) : field('', h('span', {}))),
      h('div', { class: 'grid2' }, field('Hold use for (seconds)', numIn(c, 'hold', { min: 0, max: 120, step: 0.5 }), '0 = just press it.'),
        field('Who can', selectIn(c, 'team', [{ v: 'any', t: 'Anyone' }, { v: 'team1', t: S.teams.team1 + ' only' }, { v: 'team2', t: S.teams.team2 + ' only' }]))),
      ...(c.hold > 0 ? [
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: c.bar !== false, onchange: (e) => { c.bar = e.target.checked; changed(); } }),
          h('span', {}, 'Show a progress bar on their screen')),
        ...(c.bar !== false ? [field('Bar label', textIn(c, 'label', { maxlength: 60, placeholder: 'e.g. Hacking the console...' }))] : []),
        h('div', { class: 'grid2' }, field('Sound while holding (optional)', soundPicker(c, 'sound', 'sound/... e.g. a beep or a hacking loop')),
          field('Every (seconds)', numIn(c, 'soundEvery', { min: 0.2, max: 30, step: 0.1 }))),
      ] : []),
      h('small', { class: 'muted', style: 'display:block;margin:-6px 0 10px' },
        'Letting go of use, or moving away, starts it over. Whoever finishes is "the player who set it off" for the actions.'));
  }
  if (c.when === 'group_dead') out.push(groupSel());
  if (c.when === 'group_left') out.push(h('div', { class: 'grid2' }, groupSel(), field('N or fewer left', numIn(c, 'count', { min: 0, max: 32 }))));
  if (c.when === 'players') out.push(field('Players in the game', numIn(c, 'count', { min: 1, max: 64 })));
  if (c.when === 'group_in_area') {
    out.push(h('div', { class: 'grid3' }, groupSel(), areaSel(), field('How many of them', numIn(c, 'count', { min: 1, max: 32, placeholder: '1' }))),
      h('small', { class: 'muted', style: 'display:block;margin:-6px 0 10px' },
        'Fires as that many of the group are inside it at once - e.g. the droids reach the reactor. With "every time", again each time they come back in.'));
  }
  if (c.when === 'counter') out.push(h('div', { class: 'grid3' },
    field('Counter', selectIn(c, 'counter', [{ v: '', t: '- pick -' }].concat(s.counters.map((c) => ({ v: c.id, t: c.name }))))),
    field('is', selectIn(c, 'compare', [{ v: '>=', t: 'at least' }, { v: '==', t: 'exactly' }, { v: '<=', t: 'at most' }])),
    field('', numIn(c, 'count', { min: -9999, max: 9999 }))));
  if (c.when === 'after') {
    const others = [{ v: '', t: '- pick -' }].concat(s.triggers.filter((x) => x !== t).map((x) => ({ v: x.id, t: x.name })));
    out.push(h('div', { class: 'grid2' },
      field('Trigger', selectIn(c, 'trigger', others)),
      field('Seconds later', numIn(c, 'seconds', { min: 0, max: 3600 }))));
  }
  if (c.when === 'group_health' || c.when === 'leader_health') {
  if (c.percent === undefined) c.percent = 50;
  out.push(h('div', { class: 'grid2' }, groupSel(), field(c.when === 'leader_health' ? 'Leader\'s health at or below (%)' : 'Health at or below (%)', numIn(c, 'percent', { min: 1, max: 99 }))),
    h('small', { class: 'muted', style: 'display:block;margin:-6px 0 10px' }, c.when === 'leader_health'
      ? 'The group\'s leader (set on the group) - a boss: at 50% call in help, at 20% run for it...'
      : 'All of the group together, out of its full health - the fallen count as nothing. Once all of it has spawned.'));
  }
  if (c.when === 'prop_destroyed') {
  out.push(field('Prop', selectIn(c, 'prop', [{ v: '', t: 'Any breakable prop' }].concat(s.props.filter((p) => p.health > 0).map((p) => ({ v: p.id, t: p.name })))),
    'Placed props with health (Prop tool). "Any" also counts ones put down by a Place a prop action. Whoever broke it is "the player who set it off".'));
  }
  return out;
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
    card.append(...condFields(t, t));
    // More whens, all of them or any one.
    (t.also || []).forEach((c, j) => {
      const sub = h('div', { class: 'cond-box' },
        h('div', { class: 'input-row' }, h('b', { class: 'small' }, t.match === 'any' ? 'OR' : 'AND'),
          selectIn(c, 'when', WHENS.filter((w) => w.v !== 'use' || c.when === 'use' || !condsOf(t).some((x) => x.when === 'use'))),
          h('button', { class: 'btn tiny danger', type: 'button', title: 'Remove this when', onclick: () => { t.also.splice(j, 1); if (!t.also.length) delete t.also; changed(); } }, 'x')));
      condFields(c, t).forEach((n) => sub.append(n));
      card.append(sub);
    });
    card.append(h('div', { class: 'row-end' },
      ...((t.also || []).length ? [field('Fires when', selectIn(t, 'match', [{ v: 'all', t: 'All of these have happened (AND)' }, { v: 'any', t: 'Any one of these happens (OR)' }]))] : []),
      (t.also || []).length < 3 ? h('button', { class: 'btn small', type: 'button', onclick: () => {
        t.also = t.also || [];
        if (!t.match) t.match = 'all';
        t.also.push({ when: 'counter', area: '', group: '', trigger: '', seconds: 0, count: 1, counter: (s.counters[0] || {}).id || '', compare: '>=' });
        changed();
      } }, t.also && t.also.length ? '+ Another when' : '+ And / or another when') : null));
    if ((t.also || []).length && t.match !== 'any') card.append(h('small', { class: 'muted', style: 'display:block;margin:-4px 0 10px' },
      'Something that happens at a moment (a player walking in, a timer, a death) counts from then until the trigger fires; something that stays true (a group down, a counter\'s value) only while it is.'));
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
  for (const k of ['points', 'routes', 'areas', 'groups', 'triggers', 'npcTypes', 'counters', 'props', 'items', 'vehicles', 'effects', 'sounds']) if (!Array.isArray(s[k])) s[k] = [];
  if (!s.joinTeam) s.joinTeam = 'any';
  if (!s.mode) s.mode = s.classMode === 'legends' ? 'legends' : 'fa';
  s.classMode = s.mode === 'legends' ? 'legends' : 'map';
  if (!s.respawnSeconds) s.respawnSeconds = 5;
  s.routes.forEach((r) => { if (!Array.isArray(r.points)) r.points = []; });
  s.groups.forEach((g) => { if (!Array.isArray(g.npcs)) g.npcs = []; if (!g.attacks) g.attacks = 'all'; });
  s.npcTypes.forEach((n) => {
    if (!n.saberColor) n.saberColor = 'blue';
    if (!n.saber2Color) n.saber2Color = 'red';
    if (n.saberStyle === undefined) n.saberStyle = 0;
    if (!Array.isArray(n.attributes)) n.attributes = [];
  });
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
    return true;
  } catch (err) {
    $('#save-state').textContent = 'Not saved';
    toast(err.message, true);
    return false;
  }
}

// A copy of the saved scenario, opened in the editor. Unsaved changes are
// saved first, so the copy has them too.
async function cloneScenario() {
  if (S.dirty && !(await save())) return;
  try {
    const r = await api('/api/scenarios/' + SCENARIO_ID + '/duplicate', {});
    location.href = '/edit/' + r.id;
  } catch (err) { toast(err.message, true); }
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
    setupHKinds();
    loadList('props', '/api/props', 'props').then(() => draw()); // props' real sizes on the map
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
$('#clone-btn').addEventListener('click', cloneScenario);
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
  const tools = { v: 'select', p: 'point', r: 'route', a: 'area', o: 'prop', i: 'item', h: 'vehicle', e: 'effect', u: 'sound' };
  if (tools[e.key.toLowerCase()]) setTool(tools[e.key.toLowerCase()]);
  if (e.key.toLowerCase() === 'f') fit();
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') S.space = false; });
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

setTool('select');
load().catch((err) => { $('#loading').textContent = err.message; toast(err.message, true); });
