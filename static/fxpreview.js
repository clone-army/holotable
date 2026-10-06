// A rough preview of a game effect (.efx), played in the browser.
//
// The effect's own file is read and its parts simulated on a canvas - seen
// from the side, its forward axis pointing up (as a placed effect, or one
// played on the floor, is). Particles, tails, lines, cylinders, lights and
// the effects it runs are drawn with the game's own pictures, tinted and
// faded as the file says. It's an approximation: no lighting, no models, no
// distortion, and some of the finer flags are only guessed at.

const FX = { files: {}, tex: {}, tint: {} };

// --- Reading the file --------------------------------------------------------

// Tokens with their line numbers; braces and brackets on their own.
function fxTokens(text) {
  const out = [];
  text.replace(/\/\/[^\n]*/g, '').split('\n').forEach((line, ln) => {
    const re = /"([^"]*)"|([{}\[\]])|([^\s{}\[\]"]+)/g;
    let m;
    while ((m = re.exec(line))) out.push({ v: m[1] !== undefined ? m[1] : (m[2] || m[3]), ln, br: !!m[2] });
  });
  return out;
}

// A block: { key: [values] | {sub-block} | [list] }, keys lower case. A key
// can repeat (several Particle blocks): those are kept in order in .parts.
function fxParse(text) {
  const toks = fxTokens(text);
  let i = 0;
  const block = (top) => {
    const obj = { parts: [] };
    while (i < toks.length) {
      const t = toks[i];
      if (t.br && t.v === '}') { i++; break; }
      if (t.br) { i++; continue; }
      const key = t.v.toLowerCase();
      i++;
      const nx = toks[i];
      if (nx && nx.br && nx.v === '{') {
        i++;
        const sub = block(false);
        if (top) obj.parts.push({ type: key, ...sub });
        else obj[key] = sub;
      } else if (nx && nx.br && nx.v === '[') {
        i++;
        const list = [];
        while (i < toks.length && !(toks[i].br && toks[i].v === ']')) list.push(toks[i++].v);
        i++;
        obj[key] = list;
      } else {
        const vals = [];
        while (i < toks.length && toks[i].ln === t.ln && !toks[i].br) vals.push(toks[i++].v);
        obj[key] = vals;
      }
    }
    return obj;
  };
  return block(true);
}

// --- Values --------------------------------------------------------------------

const rnd = (a, b) => a + Math.random() * (b - a);
const nums = (v) => (v || []).map(Number).filter((x) => !isNaN(x));
// "a" or "a b": a number from the range.
function range(v, def) {
  const n = nums(v);
  if (!n.length) return def;
  return n.length === 1 ? n[0] : rnd(n[0], n[1]);
}
// "x y z" or "x y z x2 y2 z2": a vector from the box.
function vrange(v, def) {
  const n = nums(v);
  if (n.length >= 6) return [rnd(n[0], n[3]), rnd(n[1], n[4]), rnd(n[2], n[5])];
  if (n.length >= 3) return [n[0], n[1], n[2]];
  return def ? def.slice() : [0, 0, 0];
}

// A start / end / parm / flags block: what it is at t (0..1 of its life).
// dim 1 for a number, 3 for a colour; comp: each part picked on its own.
function curve(b, def, dim, comp) {
  b = b || {};
  const pick = (v, d) => {
    const n = nums(v);
    if (!n.length) return d;
    if (dim === 1) return n.length >= 2 ? rnd(n[0], n[1]) : n[0];
    if (n.length >= 6) {
      const k = Math.random();
      return [0, 1, 2].map((j) => (comp ? rnd(n[j], n[j + 3]) : n[j] + (n[j + 3] - n[j]) * k));
    }
    return [n[0], n[1] ?? n[0], n[2] ?? n[0]];
  };
  const start = pick(b.start, def);
  const end = pick(b.end, start);
  const flags = (b.flags || []).map((f) => f.toLowerCase());
  const parm = range(b.parm || b.parms, 50);
  const has = (f) => flags.includes(f);
  return (t) => {
    let k;
    if (has('random')) k = Math.random();
    else if (has('wave')) k = 0.5 - 0.5 * Math.cos(t * Math.max(1, parm) * 0.6);
    else if (has('nonlinear')) { const p = Math.min(0.99, parm / 100); k = t < p ? 0 : (t - p) / (1 - p); }
    else if (has('clamp')) { const p = Math.max(0.01, parm / 100); k = Math.min(1, t / p); }
    else if (has('linear')) k = t;
    else k = (b.end ? t : 0); // an end with no flags: straight there
    if (dim === 1) return start + (end - start) * k;
    return [0, 1, 2].map((j) => start[j] + (end[j] - start[j]) * k);
  };
}

// --- Pictures ------------------------------------------------------------------

function fxSoftDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, '#fff'); grd.addColorStop(0.4, 'rgba(255,255,255,0.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return { img: c, blend: 'add' };
}

async function fxTexture(name) {
  const key = String(name || '').toLowerCase();
  if (FX.tex[key]) return FX.tex[key];
  FX.tex[key] = (async () => {
    try {
      const r = await fetch('/api/texture?name=' + encodeURIComponent(key), { credentials: 'same-origin' });
      if (!r.ok) throw new Error('none');
      const blend = r.headers.get('X-Blend') || 'add';
      const img = await createImageBitmap(await r.blob());
      return { img, blend };
    } catch (e) {
      return fxSoftDot();
    }
  })();
  return FX.tex[key];
}

// The picture tinted to a colour (kept, in 16 steps a colour).
function fxTinted(tex, rgb) {
  const q = rgb.map((c) => Math.max(0, Math.min(15, Math.round(c * 15))));
  if (q[0] === 15 && q[1] === 15 && q[2] === 15) return tex.img;
  tex.tints = tex.tints || {};
  const key = q.join(',');
  if (tex.tints[key]) return tex.tints[key];
  const w = Math.min(128, tex.img.width), hgt = Math.min(128, tex.img.height);
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const g = c.getContext('2d');
  g.drawImage(tex.img, 0, 0, w, hgt);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = 'rgb(' + q.map((x) => Math.round(x * 17)).join(',') + ')';
  g.fillRect(0, 0, w, hgt);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(tex.img, 0, 0, w, hgt);
  tex.tints[key] = c;
  return c;
}

async function fxLoad(name, depth = 0) {
  const key = String(name || '').toLowerCase().replace(/\\/g, '/').replace(/^effects\//, '').replace(/\.efx$/, '');
  if (!FX.files[key]) {
    FX.files[key] = api('/api/effects/file?name=' + encodeURIComponent(key)).then((r) => fxParse(r.text)).catch(() => null);
  }
  const fx = await FX.files[key];
  if (!fx) return null;
  // Pictures and the effects it runs, ready before it plays.
  const waits = [];
  for (const p of fx.parts) {
    const list = p.shaders || p.shader || [];
    p._tex = [];
    list.forEach((s, k) => waits.push(fxTexture(s).then((t) => { p._tex[k] = t; })));
    if (!list.length) waits.push(Promise.resolve(fxSoftDot()).then((t) => { p._tex = [t]; }));
    if (depth < 3 && (p.playfx || p.effects)) {
      p._sub = [];
      (p.playfx || p.effects).forEach((e, k) => waits.push(fxLoad(e, depth + 1).then((s) => { p._sub[k] = s; })));
    }
  }
  await Promise.all(waits);
  return fx;
}

// --- Simulating ----------------------------------------------------------------

// Every piece an effect makes, from t0 (ms) at origin org (effect space:
// x forward - up on screen - y across, z depth).
function fxSpawn(fx, t0, org, out, depth = 0) {
  for (const p of fx.parts) {
    const type = p.type;
    if (['sound', 'camerashake', 'decal'].includes(type)) continue;
    const count = Math.max(0, Math.round(range(p.count, 1)));
    const flags = (p.spawnflags || []).map((f) => f.toLowerCase());
    const dn = nums(p.delay);
    for (let i = 0; i < count; i++) {
      let delay = range(p.delay, 0);
      if (flags.includes('evendistribution') && dn.length >= 2 && count > 1) delay = dn[0] + (dn[1] - dn[0]) * (i / (count - 1));
      let o = vrange(p.origin);
      const radius = range(p.radius, 0), height = range(p.height, 0);
      if (radius && (flags.includes('orgonsphere') || flags.includes('orgoncylinder'))) {
        const a = Math.random() * Math.PI * 2, b = flags.includes('orgonsphere') ? Math.acos(rnd(-1, 1)) : Math.PI / 2;
        o = [o[0] + radius * Math.cos(b) + (height ? rnd(-height / 2, height / 2) : 0), o[1] + radius * Math.sin(b) * Math.cos(a), o[2] + radius * Math.sin(b) * Math.sin(a)];
      }
      let vel = vrange(p.velocity);
      if (flags.includes('axisfromsphere')) {
        const len = Math.hypot(...o) || 1, sp = Math.hypot(...vel) || range(p.velocity, 0);
        vel = o.map((c) => (c / len) * sp);
      }
      const piece = {
        type, t0: t0 + delay, life: Math.max(1, range(p.life, 50)),
        pos: [org[0] + o[0], org[1] + o[1], org[2] + o[2]], vel,
        acc: vrange(p.acceleration), grav: range(p.gravity, 0),
        rot: range(p.rotation, 0), rotD: range(p.rotationdelta, 0),
        size: curve(p.size, 1, 1), size2: curve(p.size2, 1, 1), len: curve(p.length, 0, 1),
        alpha: curve(p.alpha, 1, 1), rgb: curve(p.rgb, [1, 1, 1], 3, flags.includes('rgbcomponentinterpolation')),
        tex: p._tex[Math.floor(Math.random() * p._tex.length)] || fxSoftDot(),
        org2: vrange(p.origin2, o), done: false,
      };
      if (type === 'fxrunner' || p._sub) {
        // Runs other effects (one picked) from here.
        const sub = (p._sub || []).filter(Boolean);
        if (sub.length && depth < 3) out.push({ type: 'run', t0: piece.t0, life: 1, pos: piece.pos, fx: sub[Math.floor(Math.random() * sub.length)], depth: depth + 1 });
        continue;
      }
      out.push(piece);
    }
  }
}

// --- The preview window ----------------------------------------------------------

function openFxPreview(name, every) {
  if (!name) { toast('Pick an effect first.', true); return; }
  const W = 640, H = 420;
  const canvas = h('canvas', { width: W, height: H, class: 'fx-canvas' });
  const info = h('small', { class: 'muted' }, 'Loading ' + name + '...');
  const state = { zoom: 1, speed: 1, loop: true, bg: 'dark' };
  const dlg = h('dialog', { class: 'sound-dlg fx-dlg' });
  const btn = (label, fn) => h('button', { class: 'btn tiny', type: 'button', onclick: fn }, label);
  const zoom = h('input', { type: 'range', min: 0.2, max: 4, step: 0.1, value: 1, oninput: (e) => { state.zoom = +e.target.value; } });
  const speed = h('select', { onchange: (e) => { state.speed = +e.target.value; } },
    ...[0.25, 0.5, 1, 2].map((s) => h('option', { value: s, selected: s === 1 }, s + 'x')));
  dlg.append(h('div', { class: 'dlg-head' }, h('b', {}, 'Effect: ' + name), h('button', { class: 'btn tiny', type: 'button', onclick: () => dlg.close() }, 'Close')),
    canvas,
    h('div', { class: 'input-row' }, btn('Replay', () => restart()),
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { state.loop = e.target.checked; } }), h('span', { class: 'small' }, 'Loop')),
      h('span', { class: 'muted small' }, 'Zoom'), zoom, h('span', { class: 'muted small' }, 'Speed'), speed,
      btn('Light / dark', () => { state.bg = state.bg === 'dark' ? 'light' : 'dark'; })),
    info,
    h('small', { class: 'muted' }, 'A rough preview, seen from the side - the effect\'s forward direction is up, as when it\'s placed on the floor. ' +
      'Colours, fading and movement come from the effect\'s own file; lighting, models and heat haze aren\'t shown. In the game it may look different.'));
  dlg.addEventListener('close', () => { state.closed = true; dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();

  const g = canvas.getContext('2d');
  let fx = null, pieces = [], clock = 0, last = 0, span = 1000, fit = 2;
  const restart = () => {
    pieces = [];
    clock = 0;
    if (fx) fxSpawn(fx, 0, [0, 0, 0], pieces);
  };
  const lengthOf = () => pieces.reduce((m, p) => Math.max(m, p.t0 + p.life), 0);

  fxLoad(name).then((loaded) => {
    if (!loaded) { info.textContent = 'Couldn\'t read that effect - is the name right?'; return; }
    fx = loaded;
    restart();
    span = Math.max(300, lengthOf());
    // A scale that fits it: from where its pieces start and how far they go.
    let ext = 16;
    pieces.forEach((p) => {
      if (!p.size) return;
      const lifeS = p.life / 1000, reach = Math.hypot(p.vel[0], p.vel[1]) * lifeS + Math.abs(p.grav) * lifeS * lifeS * 0.5;
      ext = Math.max(ext, Math.abs(p.pos[0]) + reach + p.size(1), Math.abs(p.pos[1]) + reach + p.size(1), p.size(0));
    });
    fit = Math.max(0.3, Math.min(8, (H * 0.42) / ext));
    const kinds = {};
    fx.parts.forEach((p) => { kinds[p.type] = (kinds[p.type] || 0) + 1; });
    info.textContent = Object.entries(kinds).map(([k, n]) => n + ' ' + k).join(', ') + ' - lasts about ' + (span / 1000).toFixed(1) + 's' +
      (every ? ', played every ' + every + 's here' : '');
  });

  const frame = (now) => {
    if (state.closed) return;
    const dt = last ? Math.min(50, now - last) * state.speed : 0;
    last = now;
    clock += dt;
    const loopAt = every ? every * 1000 : span + 400;
    if (fx && state.loop && clock > loopAt) {
      // Again - those still going carry on, as a looping effect does.
      const left = pieces.filter((p) => p.type !== 'run' && clock < p.t0 + p.life).map((p) => Object.assign(p, { t0: p.t0 - clock }));
      restart();
      pieces = left.concat(pieces);
    }
    draw(dt);
    requestAnimationFrame(frame);
  };

  const draw = (dt) => {
    const dark = state.bg === 'dark';
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = dark ? '#06090f' : '#8a96a8';
    g.fillRect(0, 0, W, H);
    const scale = fit * state.zoom;
    const ox = W / 2, oy = H * 0.72;
    // The floor, and a grid of 32 units.
    g.strokeStyle = dark ? 'rgba(70,200,255,0.10)' : 'rgba(0,0,0,0.12)';
    g.lineWidth = 1;
    const step = 32 * scale;
    if (step > 6) {
      for (let x = ox % step; x < W; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      for (let y = oy % step; y < H; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    }
    g.strokeStyle = dark ? 'rgba(70,200,255,0.45)' : 'rgba(0,0,0,0.4)';
    g.beginPath(); g.moveTo(0, oy); g.lineTo(W, oy); g.stroke();
    g.fillStyle = dark ? 'rgba(70,200,255,0.6)' : 'rgba(0,0,0,0.5)';
    g.font = '11px sans-serif';
    g.fillText('32 units', 8, H - 8);
    const sx = (p) => ox + (p[1] + p[2] * 0.25) * scale, sy = (p) => oy - (p[0] + p[2] * 0.15) * scale;

    const spawned = [];
    for (const p of pieces) {
      if (p.done || clock < p.t0) continue;
      if (p.type === 'run') { fxSpawn(p.fx, p.t0, p.pos, spawned, p.depth); p.done = true; continue; }
      const age = clock - p.t0;
      if (age > p.life) { p.done = true; continue; }
      const t = age / p.life, s = dt / 1000;
      // Moving: velocity, acceleration, and gravity along the up axis.
      if (s > 0) {
        p.vel[0] += (p.acc[0] + p.grav) * s; p.vel[1] += p.acc[1] * s; p.vel[2] += p.acc[2] * s;
        p.pos[0] += p.vel[0] * s; p.pos[1] += p.vel[1] * s; p.pos[2] += p.vel[2] * s;
        p.rot += p.rotD * s * 10;
      }
      const a = Math.max(0, Math.min(1, p.alpha(t)));
      if (a <= 0.003) continue;
      const rgb = p.rgb(t).map((c) => Math.max(0, Math.min(1, c)));
      const blend = p.tex.blend;
      g.globalCompositeOperation = blend === 'add' ? (dark ? 'lighter' : 'screen') : blend === 'multiply' ? 'multiply' : 'source-over';
      g.globalAlpha = a;
      const img = fxTinted(p.tex, rgb);
      const x = sx(p.pos), y = sy(p.pos);
      const size = Math.max(0.5, p.size(t)) * scale;
      switch (p.type) {
        case 'tail': {
          // A streak back along its way of going.
          const len = Math.max(size, p.len(t) * scale), ang = Math.atan2(-(p.vel[0]), p.vel[1] + p.vel[2] * 0.25);
          g.save(); g.translate(x, y); g.rotate(ang); g.drawImage(img, -len, -size / 2, len, size); g.restore();
          break;
        }
        case 'line': case 'electricity': {
          const x2 = sx(p.org2), y2 = sy(p.org2);
          const ang = Math.atan2(y2 - y, x2 - x), len = Math.hypot(x2 - x, y2 - y);
          g.save(); g.translate(x, y); g.rotate(ang);
          if (p.type === 'electricity') {
            g.strokeStyle = 'rgb(' + rgb.map((c) => Math.round(c * 255)).join(',') + ')';
            g.lineWidth = Math.max(1, size * 0.3);
            g.beginPath(); g.moveTo(0, 0);
            for (let k = 1; k <= 8; k++) g.lineTo((len * k) / 8, k < 8 ? rnd(-size, size) : 0);
            g.stroke();
          } else g.drawImage(img, 0, -size / 2, len, size);
          g.restore();
          break;
        }
        case 'cylinder': {
          // Seen from the side: its rings, bottom and top.
          const r2 = Math.max(0.5, p.size2(t)) * scale, hgt = p.len(t) * scale;
          g.save();
          g.beginPath(); g.ellipse(x, y, size, size * 0.22, 0, 0, Math.PI * 2);
          g.moveTo(x + r2, y - hgt); g.ellipse(x, y - hgt, r2, r2 * 0.22, 0, 0, Math.PI * 2);
          g.strokeStyle = 'rgb(' + rgb.map((c) => Math.round(c * 255)).join(',') + ')';
          g.lineWidth = Math.max(1.5, (size + r2) * 0.06);
          g.stroke();
          g.restore();
          break;
        }
        case 'light': case 'flash': {
          const grd = g.createRadialGradient(x, y, 0, x, y, size * 2);
          const col = rgb.map((c) => Math.round(c * 255)).join(',');
          grd.addColorStop(0, 'rgba(' + col + ',0.5)'); grd.addColorStop(1, 'rgba(' + col + ',0)');
          g.fillStyle = grd; g.fillRect(x - size * 2, y - size * 2, size * 4, size * 4);
          break;
        }
        case 'orientedparticle': {
          g.save(); g.translate(x, y); g.scale(1, 0.3); g.rotate((p.rot * Math.PI) / 180); g.drawImage(img, -size, -size, size * 2, size * 2); g.restore();
          break;
        }
        default: {
          g.save(); g.translate(x, y); g.rotate((p.rot * Math.PI) / 180); g.drawImage(img, -size, -size, size * 2, size * 2); g.restore();
        }
      }
    }
    if (spawned.length) pieces = pieces.concat(spawned);
    if (pieces.length > 4000) pieces = pieces.filter((p) => !p.done);
  };
  requestAnimationFrame(frame);
}
