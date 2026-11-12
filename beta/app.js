'use strict';
/* Lasermeter – plannen & aanzichten met een Bosch-lasermeter via Web Bluetooth (Bluefy op iPhone). */
const VERSION = 6;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl = (v, d = 3) => (v == null || !isFinite(v) ? '–' : v.toFixed(d).replace('.', ','));
const parseNum = s => { const v = parseFloat(String(s).replace(',', '.').replace(/[^\d.\-]/g, '')); return isFinite(v) ? v : null; };
const LETTER = i => String.fromCharCode(65 + (i % 26));

// ---------- opslag ----------
const KEY_P = 'lasermeter.projects.v1', KEY_M = 'lasermeter.metingen.v1', KEY_NAV = 'lasermeter.nav.v1';
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const S = {
  projects: load(KEY_P, []),
  loose: load(KEY_M, []),
  view: 'projects', pid: null, rid: null,
  tab: 'plan', sel: null, wallIdx: 0, openSel: null,
  target: null,
};
Object.assign(S, (({ view, pid, rid, tab }) => ({ view, pid, rid, tab }))(load(KEY_NAV, {})));
if (!['projects', 'project', 'room', 'loose'].includes(S.view)) S.view = 'projects';

function save() {
  store(KEY_P, S.projects); store(KEY_M, S.loose);
  store(KEY_NAV, { view: S.view, pid: S.pid, rid: S.rid, tab: S.tab });
}
const project = () => S.projects.find(p => p.id === S.pid);
const room = () => { const p = project(); return p && p.rooms.find(r => r.id === S.rid); };

// ---------- toast & sheets ----------
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}
let sheetHandlers = {};
function openSheet(html, handlers = {}) {
  $('sheet').innerHTML = html; sheetHandlers = handlers; $('veil').hidden = false;
  const inp = $('sheet').querySelector('input[type=text]');
  if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 60);
}
function closeSheet() { $('veil').hidden = true; $('sheet').innerHTML = ''; sheetHandlers = {}; }
$('veil').addEventListener('click', e => {
  if (e.target === $('veil')) return closeSheet();
  const b = e.target.closest('[data-sh]'); if (!b) return;
  const fn = sheetHandlers[b.dataset.sh]; if (fn) fn(b);
});
$('sheet').addEventListener('keydown', e => { if (e.key === 'Enter' && sheetHandlers.ok) { e.preventDefault(); sheetHandlers.ok(); } });

function askText(title, value, onOk, opts = {}) {
  openSheet(`<h3>${esc(title)}</h3>
    <input type="text" id="askIn" value="${esc(value)}" ${opts.num ? 'inputmode="decimal"' : ''} autocomplete="off">
    ${opts.hint ? `<p class="muted">${esc(opts.hint)}</p>` : ''}
    <div class="btns" style="margin-top:12px">
      ${opts.extra ? `<button class="btn ghost" data-sh="extra">${esc(opts.extra)}</button>` : ''}
      <button class="btn ghost" data-sh="cancel">Annuleren</button>
      <button class="btn" data-sh="ok">OK</button></div>`, {
    cancel: closeSheet,
    extra: () => { closeSheet(); opts.onExtra && opts.onExtra(); },
    ok: () => {
      const v = $('askIn').value;
      if (opts.num) { const n = parseNum(v); if (n == null || n < 0) return toast('Ongeldige waarde'); closeSheet(); onOk(n); }
      else { closeSheet(); onOk(v.trim()); }
    },
  });
}
function confirmTap(btn, label, fn) {
  if (btn.dataset.armed) { fn(); return; }
  const old = btn.textContent; btn.dataset.armed = 1; btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { btn.textContent = old; delete btn.dataset.armed; } }, 3000);
}

// ======================================================================
// Bluetooth (Bosch MT-protocol; GLM 50 C via 02a6c0d1, AdvancedDistance 50C via 02a6c0d2)
// ======================================================================
const SVC = '02a6c0d0-0451-4000-b000-fb3210111989';
const EXTRA_SVCS = ['0000fde8-0000-1000-8000-00805f9b34fb', '0000180a-0000-1000-8000-00805f9b34fb'];
const CMD_AUTOSYNC = [0xC0, 0x55, 0x02, 0x01, 0x00, 0x1A];
const CMD_MEASURE = [0xC0, 0x56, 0x01, 0x00, 0x1E];
const BLE = { device: null, chr: null, manualClose: false, state: 'off', last: null, log: [] };

const hex = dv => Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)).map(b => b.toString(16).padStart(2, '0')).join(' ');
function blog(msg) {
  BLE.log.push('[' + new Date().toLocaleTimeString('nl-BE') + '] ' + msg);
  if (BLE.log.length > 400) BLE.log.splice(0, 100);
  const el = $('blelog'); if (el) { el.textContent = BLE.log.join('\n'); el.scrollTop = el.scrollHeight; }
}
function errText(e) {
  if (e === undefined) return '(undefined)';
  if (e === null || typeof e !== 'object') return typeof e + ': ' + String(e);
  return (e.name || 'Error') + ': ' + (e.message || String(e));
}
window.addEventListener('error', ev => blog('JS-fout: ' + ev.message + ' (r' + ev.lineno + ')'));
window.addEventListener('unhandledrejection', ev => blog('Onafgehandeld: ' + errText(ev.reason)));

function setBle(state, text) {
  BLE.state = state;
  $('dot').className = 'dot' + (state === 'on' ? ' on' : state === 'busy' ? ' busy' : '');
  $('pillText').textContent = text || (state === 'on' ? (BLE.last != null ? nl(BLE.last) + ' m' : (BLE.device?.name || 'Verbonden')) : 'Verbind meter');
  if (!$('veil').hidden && $('sheet').querySelector('#bleSheet')) bleSheet();
  if (S.view === 'room') renderBanner();
}

function parseDistance(dv) {
  if (dv.byteLength >= 11 && dv.getUint8(0) === 0xC0 && dv.getUint8(1) === 0x55 && dv.getUint8(2) === 0x10 && dv.getUint8(3) === 0x06) {
    const m = dv.getFloat32(7, true);
    if (isFinite(m) && m > 0 && m < 300) return m;
  }
  return null;
}
async function bleWrite(bytes) {
  const c = BLE.chr; if (!c) throw new Error('niet verbonden');
  const data = new Uint8Array(bytes); blog('→ ' + hex(new DataView(data.buffer)));
  const p = c.properties || {};
  const order = p.writeWithoutResponse && !p.write ? ['writeValueWithoutResponse', 'writeValue'] : ['writeValueWithResponse', 'writeValue', 'writeValueWithoutResponse'];
  let last;
  for (const fn of order) {
    if (typeof c[fn] !== 'function') continue;
    try { return await c[fn](data); } catch (e) { last = e; blog('  ' + fn + ' mislukt: ' + errText(e)); }
  }
  throw last || new Error('geen schrijfmethode');
}

async function bleConnect() {
  if (!navigator.bluetooth) {
    openSheet(`<h3>Geen Bluetooth in deze browser</h3><p>Open deze pagina op je iPhone in de gratis app <b>Bluefy – Web BLE Browser</b>. Op Android of computer: Chrome.</p>
      <div class="btns"><button class="btn" data-sh="cancel">OK</button></div>`, { cancel: closeSheet });
    return;
  }
  BLE.device = null;
  setBle('busy', 'Zoeken…');
  const tries = [
    { acceptAllDevices: true, optionalServices: [SVC, ...EXTRA_SVCS] },
    { acceptAllDevices: true, optionalServices: [SVC] },
    { acceptAllDevices: true },
  ];
  try {
    let lastErr;
    for (let i = 0; i < tries.length && !BLE.device; i++) {
      const t0 = Date.now();
      try { BLE.device = await navigator.bluetooth.requestDevice(tries[i]); }
      catch (e) { lastErr = e; const ms = Date.now() - t0; blog('Zoeken mislukt na ' + ms + ' ms: ' + errText(e)); if (ms > 1500) throw e; }
    }
    if (!BLE.device) throw lastErr;
    blog('Gekozen: ' + (BLE.device.name || '(geen naam)'));
    BLE.device.addEventListener('gattserverdisconnected', bleDisconnected);
    await bleOpen();
  } catch (e) {
    blog('Fout: ' + errText(e));
    setBle('off');
  }
}

async function bleOpen() {
  setBle('busy', 'Verbinden…');
  const server = await BLE.device.gatt.connect();
  blog('GATT verbonden');
  let chr = null;
  try { // klassieke GLM: service 02a6c0d0 / kenmerk 02a6c0d1
    const svc = await server.getPrimaryService(SVC);
    chr = await svc.getCharacteristic('02a6c0d1-0451-4000-b000-fb3210111989');
  } catch {
    // nieuwere toestellen (AdvancedDistance 50C): zoek een 02a6c0dX-kenmerk in alle services
    let svcs = [];
    try { svcs = await server.getPrimaryServices(); } catch (e) { blog('Services: ' + errText(e)); }
    blog('Services: ' + svcs.map(s => s.uuid).join(', '));
    for (const s of svcs) {
      let cs = []; try { cs = await s.getCharacteristics(); } catch { continue; }
      for (const c of cs) {
        const p = c.properties || {};
        if (/^02a6c0d/i.test(c.uuid) && (p.notify || p.indicate) && (p.write || p.writeWithoutResponse)) { chr = c; break; }
      }
      if (chr) break;
    }
  }
  if (!chr) { blog('Geen Bosch-meetkanaal gevonden'); toast('Dit toestel wordt niet herkend'); BLE.device.gatt.disconnect(); return; }
  blog('Meetkanaal: ' + chr.uuid);
  BLE.chr = chr;
  chr.addEventListener('characteristicvaluechanged', ev => {
    const dv = ev.target.value; blog('← ' + hex(dv));
    const m = parseDistance(dv);
    if (m) onMeasurement(m);
  });
  await chr.startNotifications();
  await bleWrite(CMD_AUTOSYNC);
  BLE.manualClose = false;
  setBle('on');
  toast('Verbonden met ' + (BLE.device.name || 'meter'));
}

function bleDisconnected() {
  blog('Verbinding verbroken'); BLE.chr = null; setBle('off');
  if (!BLE.manualClose && BLE.device) {
    setTimeout(async () => {
      if (!BLE.device || BLE.device.gatt.connected || BLE.manualClose) return;
      try { blog('Opnieuw verbinden…'); await bleOpen(); } catch (e) { blog('Herverbinden mislukt: ' + errText(e)); setBle('off'); }
    }, 1500);
  }
}
async function bleMeasure() { try { await bleWrite(CMD_MEASURE); } catch (e) { toast('Meten vanop telefoon mislukt'); } }

function bleSheet() {
  const on = BLE.state === 'on';
  openSheet(`<div id="bleSheet"></div><h3>Lasermeter</h3>
    <p class="muted">${on ? 'Verbonden met <b>' + esc(BLE.device?.name || 'meter') + '</b>' : BLE.state === 'busy' ? 'Bezig…' : 'Niet verbonden'}
    ${BLE.last != null ? ' · laatste meting ' + nl(BLE.last) + ' m' : ''}</p>
    <div class="btns">
      ${on ? '<button class="btn soft" data-sh="measure">Meet vanop telefoon</button><button class="btn ghost" data-sh="disc">Verbreek</button>'
           : '<button class="btn" data-sh="conn">Verbind met meter</button>'}
    </div>
    <p class="muted" style="margin-top:12px">Tip: zet Bluetooth aan op de meter en sluit de Bosch-app, anders is de meter bezet.</p>
    <details style="margin-top:8px"><summary class="muted">Debug-log</summary><pre class="log" id="blelog">${esc(BLE.log.join('\n'))}</pre>
      <button class="btn ghost small" data-sh="copylog">Kopieer log</button></details>
    <div class="btns" style="margin-top:12px"><button class="btn ghost" data-sh="cancel">Sluiten</button></div>`, {
    conn: () => { closeSheet(); bleConnect(); },
    disc: () => { BLE.manualClose = true; if (BLE.device?.gatt.connected) BLE.device.gatt.disconnect(); closeSheet(); },
    measure: () => { closeSheet(); bleMeasure(); },
    copylog: () => copyText(BLE.log.join('\n'), 'Log'),
    cancel: closeSheet,
  });
}
$('pill').onclick = () => (BLE.state === 'on' || BLE.state === 'busy' ? bleSheet() : bleConnect());

// ======================================================================
// Metingen verwerken
// ======================================================================
function onMeasurement(m) {
  BLE.last = m; setBle(BLE.state);
  if (navigator.vibrate) navigator.vibrate(30);
  const r = room();
  if (S.view === 'room' && r && S.target) { applyValue(r, S.target, m); return; }
  S.loose.unshift({ id: Date.now() + Math.random(), m, label: '', t: new Date().toISOString() });
  save();
  toast(nl(m) + ' m – opgeslagen bij losse metingen');
  if (S.view === 'loose' || S.view === 'projects') render();
}

const OPEN_PROPS = { raam: ['width', 'height', 'sill', 'offset'], deur: ['width', 'height', 'offset'] };
const PROP_NL = { width: 'Breedte', height: 'Hoogte', sill: 'Borstwering', offset: 'Afstand tot linkerhoek' };

function findOpening(r, t) { const w = r.walls[t.i]; return w && w.openings.find(o => o.id === t.oid); }
function targetLabel(r, t) {
  if (!t) return '';
  if (t.kind === 'wall') return 'Muur ' + (t.i + 1) + ' – lengte';
  if (t.kind === 'height') return 'Plafondhoogte';
  if (t.kind === 'open') {
    const o = findOpening(r, t); if (!o) return '';
    const k = r.walls[t.i].openings.indexOf(o) + 1;
    return 'Muur ' + (t.i + 1) + ' · ' + (o.type === 'raam' ? 'Raam ' : 'Deur ') + k + ' – ' + PROP_NL[t.prop].toLowerCase();
  }
  return '';
}
function sameTarget(a, b) { return a && b && a.kind === b.kind && a.i === b.i && a.oid === b.oid && a.prop === b.prop; }

function applyValue(r, t, v, measured = true) {
  if (t.kind === 'wall') { const w = r.walls[t.i]; if (!w) return; w.len = v; w.measured = measured; }
  else if (t.kind === 'height') { r.height = v; r.heightMeasured = measured; }
  else if (t.kind === 'open') { const o = findOpening(r, t); if (!o) return; o[t.prop] = v; o.measured[t.prop] = measured; }
  Geo.solveRoom(r);
  save();
  if (sameTarget(S.target, t)) S.target = nextTarget(r, t);
  toast(targetLabel(r, t) + ': ' + nl(v) + ' m');
  render();
}
function nextTarget(r, t) {
  if (t.kind === 'wall') return t.i + 1 < r.walls.length ? { kind: 'wall', i: t.i + 1 } : null;
  if (t.kind === 'open') {
    const o = findOpening(r, t); if (!o) return null;
    const props = OPEN_PROPS[o.type], k = props.indexOf(t.prop);
    return k + 1 < props.length ? { ...t, prop: props[k + 1] } : null;
  }
  return null;
}
function setTarget(t) {
  S.target = sameTarget(S.target, t) ? null : t;
  if (S.target && S.target.kind === 'wall') S.sel = { type: 'wall', i: S.target.i };
  render();
  if (S.target && BLE.state !== 'on') toast('Verbind eerst de meter (rechtsboven)');
}
function editValue(r, t) {
  let cur, measured;
  if (t.kind === 'wall') { cur = r.walls[t.i].len; measured = r.walls[t.i].measured; }
  else if (t.kind === 'height') { cur = r.height; measured = r.heightMeasured; }
  else { const o = findOpening(r, t); cur = o[t.prop]; measured = o.measured[t.prop]; }
  askText(targetLabel(r, t) + ' (m)', nl(cur), v => applyValue(r, t, v, true), {
    num: true,
    hint: t.kind === 'wall' ? 'Een ingegeven lengte ligt vast, net zoals een gemeten lengte.' : '',
    extra: measured && t.kind === 'wall' ? 'Laten berekenen' : '',
    onExtra: () => { r.walls[t.i].measured = false; Geo.solveRoom(r); save(); render(); },
  });
}

// ======================================================================
// Tekeningen (SVG)
// ======================================================================
const COL = { wall: '#2b2f2c', floor: '#f2f5f0', dim: '#1c211e', calc: '#8a928c', sel: '#0b7a3e', target: '#e8590c', open: '#ffffff', glass: '#5aa9e6', door: '#8a5a2b' };
const fmtSvg = v => (Math.round(v * 1000) / 1000).toString();

function textAt(x, y, s, size, opts = {}) {
  let rot = opts.rot || 0;
  while (rot > 90) rot -= 180; while (rot <= -90) rot += 180;
  return `<text x="${fmtSvg(x)}" y="${fmtSvg(y)}" font-size="${fmtSvg(size)}" text-anchor="middle" dominant-baseline="central"
    ${rot ? `transform="rotate(${fmtSvg(rot)} ${fmtSvg(x)} ${fmtSvg(y)})"` : ''} fill="${opts.fill || COL.dim}"
    font-family="-apple-system, Helvetica, Arial, sans-serif" font-weight="${opts.bold ? 700 : 400}" ${opts.italic ? 'font-style="italic"' : ''}>${esc(s)}</text>`;
}

// plan: geeft {vb, w, h, body}
function planSVG(r, opts = {}) {
  const g = Geo.geometry(r), n = r.walls.length, t = g.t;
  const b = g.bbox, span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
  const fs = Math.min(Math.max(span * 0.034, 0.11), 0.45);
  const m = fs * 3.2;
  const vb = { x: b.minX - m, y: -(b.maxY + m), w: b.maxX - b.minX + 2 * m, h: b.maxY - b.minY + 2 * m };
  const P = p => fmtSvg(p.x) + ',' + fmtSvg(-p.y);
  const add = (p, d, s) => ({ x: p.x + d.x * s, y: p.y + d.y * s });
  let s = `<rect x="${fmtSvg(vb.x)}" y="${fmtSvg(vb.y)}" width="${fmtSvg(vb.w)}" height="${fmtSvg(vb.h)}" fill="#fff"/>`;
  s += `<polygon points="${g.pts.map(P).join(' ')}" fill="${COL.floor}"/>`;
  s += `<path d="M${g.outer.map(P).join('L')}Z M${g.pts.map(P).join('L')}Z" fill="${COL.wall}" fill-rule="evenodd"/>`;

  // openingen
  r.walls.forEach((w, i) => {
    const p0 = g.pts[i], d = g.dirs[i], nn = g.norms[i];
    for (const o of w.openings) {
      const a = add(p0, d, o.offset), c = add(p0, d, o.offset + o.width);
      const ao = add(a, nn, t), co = add(c, nn, t);
      const sel = opts.openSel === o.id;
      s += `<polygon points="${[a, c, co, ao].map(P).join(' ')}" fill="${COL.open}" stroke="${sel ? COL.sel : COL.wall}" stroke-width="${fmtSvg(fs * (sel ? 0.18 : 0.06))}"/>`;
      if (o.type === 'raam') {
        for (const f of [0.38, 0.62]) s += `<line x1="${fmtSvg(a.x + nn.x * t * f)}" y1="${fmtSvg(-(a.y + nn.y * t * f))}" x2="${fmtSvg(c.x + nn.x * t * f)}" y2="${fmtSvg(-(c.y + nn.y * t * f))}" stroke="${COL.glass}" stroke-width="${fmtSvg(fs * 0.08)}"/>`;
      } else {
        const hinge = o.hinge === 'rechts' ? c : a, other = o.hinge === 'rechts' ? a : c;
        const inward = { x: -nn.x, y: -nn.y };
        const tip = add(hinge, inward, o.width);
        s += `<line x1="${fmtSvg(hinge.x)}" y1="${fmtSvg(-hinge.y)}" x2="${fmtSvg(tip.x)}" y2="${fmtSvg(-tip.y)}" stroke="${COL.door}" stroke-width="${fmtSvg(fs * 0.12)}"/>`;
        const pts = [];
        const v0 = { x: tip.x - hinge.x, y: tip.y - hinge.y }, v1 = { x: other.x - hinge.x, y: other.y - hinge.y };
        let a0 = Math.atan2(v0.y, v0.x), a1 = Math.atan2(v1.y, v1.x);
        let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        for (let k = 0; k <= 16; k++) { const aa = a0 + da * k / 16; pts.push({ x: hinge.x + Math.cos(aa) * o.width, y: hinge.y + Math.sin(aa) * o.width }); }
        s += `<polyline points="${pts.map(P).join(' ')}" fill="none" stroke="${COL.door}" stroke-width="${fmtSvg(fs * 0.05)}" stroke-dasharray="${fmtSvg(fs * 0.2)} ${fmtSvg(fs * 0.15)}"/>`;
      }
    }
  });

  // selectie / doel
  r.walls.forEach((w, i) => {
    const p0 = g.pts[i], p1 = g.pts[(i + 1) % n];
    const isT = opts.target && opts.target.kind === 'wall' && opts.target.i === i;
    const isS = opts.sel && opts.sel.type === 'wall' && opts.sel.i === i;
    if (isT || isS) s += `<line x1="${fmtSvg(p0.x)}" y1="${fmtSvg(-p0.y)}" x2="${fmtSvg(p1.x)}" y2="${fmtSvg(-p1.y)}" stroke="${isT ? COL.target : COL.sel}" stroke-width="${fmtSvg(fs * 0.32)}" stroke-linecap="round"/>`;
  });

  // maten
  r.walls.forEach((w, i) => {
    const p0 = g.pts[i], p1 = g.pts[(i + 1) % n], d = g.dirs[i], nn = g.norms[i];
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const pos = add(mid, nn, t + fs * 1.1);
    const rot = -Math.atan2(d.y, d.x) / (Math.PI / 180);
    const isT = opts.target && opts.target.kind === 'wall' && opts.target.i === i;
    const label = (w.measured ? '' : '≈') + nl(w.len, w.measured ? 3 : 2);
    s += textAt(pos.x, -pos.y, label, fs, { rot, bold: w.measured, italic: !w.measured, fill: isT ? COL.target : w.measured ? COL.dim : COL.calc });
    if (!opts.export) {
      const inner = add(mid, nn, -fs * 0.9);
      s += textAt(inner.x, -inner.y, String(i + 1), fs * 0.75, { fill: COL.calc, rot });
    }
  });

  // hoeken
  g.pts.forEach((p, i) => {
    const c = r.corners[i], ang = c.cur ?? c.angle;
    const isS = opts.sel && opts.sel.type === 'corner' && opts.sel.i === i;
    const o = g.outer[i];
    const lp = add(p, { x: o.x - p.x, y: o.y - p.y }, 1 + fs * 1.4 / Math.max(Math.hypot(o.x - p.x, o.y - p.y), 1e-6));
    if (!opts.export || Math.abs(ang - 90) > 0.5 && Math.abs(ang - 270) > 0.5) {
      const odd = Math.abs(ang - 90) > 0.5 && Math.abs(ang - 270) > 0.5;
      if (!opts.export) s += `<circle cx="${fmtSvg(p.x)}" cy="${fmtSvg(-p.y)}" r="${fmtSvg(fs * (isS ? 0.42 : 0.26))}" fill="${isS ? COL.sel : '#fff'}" stroke="${COL.sel}" stroke-width="${fmtSvg(fs * 0.08)}"/>`;
      const txt = (opts.export ? '' : LETTER(i) + (odd ? ' ' : '')) + (odd ? nl(ang, 1) + '°' : '');
      if (txt) s += textAt(lp.x, -lp.y, txt, fs * 0.8, { fill: isS ? COL.sel : COL.calc, bold: isS });
    }
  });

  // tikzones
  if (!opts.export) {
    r.walls.forEach((w, i) => {
      const p0 = g.pts[i], p1 = g.pts[(i + 1) % n], nn = g.norms[i];
      const a = add(p0, nn, t / 2), c = add(p1, nn, t / 2);
      s += `<line data-wall="${i}" x1="${fmtSvg(a.x)}" y1="${fmtSvg(-a.y)}" x2="${fmtSvg(c.x)}" y2="${fmtSvg(-c.y)}" stroke="transparent" stroke-width="${fmtSvg(Math.max(fs * 2.2, t * 2))}"/>`;
    });
    g.pts.forEach((p, i) => { s += `<circle data-corner="${i}" cx="${fmtSvg(p.x)}" cy="${fmtSvg(-p.y)}" r="${fmtSvg(fs * 1.3)}" fill="transparent"/>`; });
  }
  return { vb: `${fmtSvg(vb.x)} ${fmtSvg(vb.y)} ${fmtSvg(vb.w)} ${fmtSvg(vb.h)}`, w: vb.w, h: vb.h, body: s };
}

// aanzicht van muur i, gezien van binnenuit (linkerhoek = begin van de muur)
function elevSVG(r, i, opts = {}) {
  const w = r.walls[i], L = w.len, H = r.height;
  const fs = Math.min(Math.max(Math.max(L, H) * 0.04, 0.1), 0.35);
  const mx = fs * 3, mt = fs * 2.2, mb = fs * 5.2;
  const vb = { x: -mx, y: -(H + mt), w: L + 2 * mx, h: H + mt + mb };
  let s = `<rect x="${fmtSvg(vb.x)}" y="${fmtSvg(vb.y)}" width="${fmtSvg(vb.w)}" height="${fmtSvg(vb.h)}" fill="#fff"/>`;
  s += `<rect x="0" y="${fmtSvg(-H)}" width="${fmtSvg(L)}" height="${fmtSvg(H)}" fill="${COL.floor}" stroke="${COL.wall}" stroke-width="${fmtSvg(fs * 0.12)}"/>`;
  const line = (x1, y1, x2, y2, col = COL.dim, sw = fs * 0.05) => `<line x1="${fmtSvg(x1)}" y1="${fmtSvg(y1)}" x2="${fmtSvg(x2)}" y2="${fmtSvg(y2)}" stroke="${col}" stroke-width="${fmtSvg(sw)}"/>`;
  const ticks = [0, L];
  w.openings.forEach((o, k) => {
    const x = o.offset, y = -(o.sill + o.height), sel = opts.openSel === o.id;
    ticks.push(o.offset, o.offset + o.width);
    if (o.type === 'raam') {
      s += `<rect x="${fmtSvg(x)}" y="${fmtSvg(y)}" width="${fmtSvg(o.width)}" height="${fmtSvg(o.height)}" fill="#e3f1fb" stroke="${sel ? COL.sel : COL.glass}" stroke-width="${fmtSvg(fs * (sel ? 0.2 : 0.1))}"/>`;
      s += line(x + o.width / 2, y, x + o.width / 2, y + o.height, COL.glass, fs * 0.05);
      // borstwering
      if (o.sill > 0.01) {
        s += line(x + o.width + fs * 0.6, 0, x + o.width + fs * 0.6, -o.sill, COL.calc, fs * 0.04);
        s += textAt(x + o.width + fs * 1.2, -o.sill / 2, nl(o.sill, 2), fs * 0.75, { rot: -90, fill: o.measured.sill ? COL.dim : COL.calc, italic: !o.measured.sill });
      }
    } else {
      s += `<rect x="${fmtSvg(x)}" y="${fmtSvg(y)}" width="${fmtSvg(o.width)}" height="${fmtSvg(o.height)}" fill="#f4ebe1" stroke="${sel ? COL.sel : COL.door}" stroke-width="${fmtSvg(fs * (sel ? 0.2 : 0.1))}"/>`;
      const hx = o.hinge === 'rechts' ? x + o.width : x, kx = o.hinge === 'rechts' ? x + o.width * 0.12 : x + o.width * 0.88;
      s += `<polyline points="${fmtSvg(kx)},${fmtSvg(y)} ${fmtSvg(hx)},${fmtSvg(y + o.height / 2)} ${fmtSvg(kx)},${fmtSvg(-0.001)}" fill="none" stroke="${COL.door}" stroke-width="${fmtSvg(fs * 0.04)}" stroke-dasharray="${fmtSvg(fs * 0.2)} ${fmtSvg(fs * 0.15)}"/>`;
    }
    const mb2 = o.measured.width && o.measured.height;
    s += textAt(x + o.width / 2, y + o.height / 2, (o.type === 'raam' ? 'R' : 'D') + (k + 1), fs * 0.8, { bold: true, fill: COL.calc });
    s += textAt(x + o.width / 2, y - fs * 0.6, nl(o.width, 2) + ' × ' + nl(o.height, 2), fs * 0.75, { fill: mb2 ? COL.dim : COL.calc, italic: !mb2 });
    if (!opts.export) s += `<rect data-open="${o.id}" x="${fmtSvg(x)}" y="${fmtSvg(y - fs)}" width="${fmtSvg(o.width)}" height="${fmtSvg(o.height + fs)}" fill="transparent"/>`;
  });
  // maatketting onderaan
  const tk = [...new Set(ticks.map(v => Math.round(v * 1000) / 1000))].filter(v => v >= -0.0005 && v <= L + 0.0005).sort((a, b) => a - b);
  const y1 = fs * 1.6, y2 = fs * 3.6;
  if (tk.length > 2) {
    s += line(0, y1, L, y1);
    tk.forEach(v => { s += line(v, y1 - fs * 0.4, v, y1 + fs * 0.4); });
    for (let k = 0; k < tk.length - 1; k++) {
      const a = tk[k], b2 = tk[k + 1];
      if (b2 - a > 0.02) s += textAt((a + b2) / 2, y1 - fs * 0.7, nl(b2 - a, 2), fs * 0.7);
    }
  }
  s += line(0, y2, L, y2); s += line(0, y2 - fs * 0.4, 0, y2 + fs * 0.4); s += line(L, y2 - fs * 0.4, L, y2 + fs * 0.4);
  s += textAt(L / 2, y2 + fs * 0.85, nl(L, w.measured ? 3 : 2), fs * 0.9, { bold: w.measured, italic: !w.measured, fill: w.measured ? COL.dim : COL.calc });
  // hoogte
  s += line(-fs * 1.4, 0, -fs * 1.4, -H); s += line(-fs * 1.8, 0, -fs, 0); s += line(-fs * 1.8, -H, -fs, -H);
  s += textAt(-fs * 2.1, -H / 2, nl(H, r.heightMeasured ? 3 : 2), fs * 0.85, { rot: -90, bold: r.heightMeasured, italic: !r.heightMeasured, fill: r.heightMeasured ? COL.dim : COL.calc });
  // hoekletters
  s += textAt(0, -H - fs * 1.1, LETTER(i), fs * 0.85, { bold: true, fill: COL.sel });
  s += textAt(L, -H - fs * 1.1, LETTER((i + 1) % r.walls.length), fs * 0.85, { bold: true, fill: COL.sel });
  return { vb: `${fmtSvg(vb.x)} ${fmtSvg(vb.y)} ${fmtSvg(vb.w)} ${fmtSvg(vb.h)}`, w: vb.w, h: vb.h, body: s };
}
const svgTag = (d, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${d.vb}" ${extra}>${d.body}</svg>`;

// ======================================================================
// Weergaven
// ======================================================================
function render() {
  const back = $('back');
  if (S.view === 'project' && !project()) S.view = 'projects';
  if (S.view === 'room' && !room()) S.view = project() ? 'project' : 'projects';
  if (S.view !== 'room') S.target = null;
  back.hidden = S.view === 'projects';
  const app = $('app');
  if (S.view === 'projects') { $('title').textContent = 'Projecten'; app.innerHTML = viewProjects(); }
  else if (S.view === 'loose') { $('title').textContent = 'Losse metingen'; app.innerHTML = viewLoose(); }
  else if (S.view === 'project') { $('title').textContent = project().name; app.innerHTML = viewProject(); }
  else if (S.view === 'room') { $('title').textContent = room().name; app.innerHTML = viewRoom(); }
  save();
}
$('back').onclick = () => {
  if (S.view === 'room') { S.view = 'project'; S.sel = null; S.openSel = null; }
  else S.view = 'projects';
  render(); window.scrollTo(0, 0);
};

function thumb(r) {
  const d = planSVG(r, { export: true });
  return `<svg class="thumb" xmlns="http://www.w3.org/2000/svg" viewBox="${d.vb}" preserveAspectRatio="xMidYMid meet">${d.body.replace(/<text[\s\S]*?<\/text>/g, '')}</svg>`;
}

function viewProjects() {
  const list = S.projects.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return `<div class="card">
    ${list.length ? `<ul class="list">${list.map(p => {
      const a = p.rooms.reduce((s, r) => s + Geo.area(r), 0);
      return `<li class="item" data-act="openProject" data-id="${p.id}">
        ${p.rooms[0] ? thumb(p.rooms[0]) : '<div class="thumb"></div>'}
        <div class="grow"><div class="name">${esc(p.name)}</div>
        <div class="sub">${p.rooms.length} ${p.rooms.length === 1 ? 'ruimte' : 'ruimtes'} · ${nl(a, 1)} m²</div></div><span class="chev">›</span></li>`;
    }).join('')}</ul>` : '<div class="empty">Nog geen projecten.<br>Maak er een aan en voeg ruimtes toe.</div>'}
    <div class="btns" style="margin-top:8px"><button class="btn" data-act="newProject">+ Nieuw project</button></div></div>
  <div class="card"><ul class="list">
    <li class="item" data-act="goLoose"><div class="grow"><div class="name">Losse metingen</div>
      <div class="sub">Metingen zonder actief maatveld komen hier terecht</div></div><span class="muted">${S.loose.length}</span><span class="chev">›</span></li>
    <li class="item" data-act="importJson"><div class="grow"><div class="name">Project importeren</div><div class="sub">Van een eerder geëxporteerd .json-bestand</div></div><span class="chev">›</span></li>
  </ul></div>
  <p class="muted" style="text-align:center">Versie ${VERSION}</p>`;
}

function viewLoose() {
  return `<div class="card">${S.loose.length ? `<ul class="list">${S.loose.map(it => {
    const d = new Date(it.t);
    return `<li class="item"><div style="font-weight:700;min-width:84px;font-variant-numeric:tabular-nums">${nl(it.m)} m</div>
      <div class="grow"><div class="name" data-act="labelLoose" data-id="${it.id}">${esc(it.label || '—')} ✎</div>
      <div class="sub">${d.toLocaleDateString('nl-BE')} ${d.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}</div></div>
      <button class="aim" data-act="delLoose" data-id="${it.id}">×</button></li>`;
  }).join('')}</ul>` : '<div class="empty">Nog geen losse metingen.</div>'}
  <div class="btns" style="margin-top:8px"><button class="btn soft" data-act="copyLoose">Kopieer (CSV)</button>
    <button class="btn danger" data-act="clearLoose">Wis alles</button></div></div>`;
}

function viewProject() {
  const p = project();
  return `<div class="card"><h2>Ruimtes</h2>
    ${p.rooms.length ? `<ul class="list">${p.rooms.map(r => `<li class="item" data-act="openRoom" data-id="${r.id}">${thumb(r)}
      <div class="grow"><div class="name">${esc(r.name)}</div><div class="sub">${nl(Geo.area(r), 2)} m² · h ${nl(r.height, 2)} m · ${r.walls.length} muren</div></div>
      <span class="chev">›</span></li>`).join('')}</ul>` : '<div class="empty">Nog geen ruimtes.</div>'}
    <div class="btns" style="margin-top:8px"><button class="btn" data-act="newRoom">+ Ruimte</button></div></div>
  <div class="card"><h2>Exporteren</h2>
    <div class="btns"><button class="btn soft" data-act="exportPng">Afbeelding</button><button class="btn soft" data-act="exportCsv">CSV</button>
    <button class="btn soft" data-act="exportIfc">IFC</button><button class="btn soft" data-act="exportJson">Project (JSON)</button></div>
    <p class="muted" style="margin-bottom:0">In IFC liggen de ruimtes naast elkaar: hun onderlinge ligging is niet gemeten.</p></div>
  <div class="btns"><button class="btn ghost" data-act="renameProject">Naam wijzigen</button><button class="btn danger" data-act="delProject">Project verwijderen</button></div>`;
}

function mrow(r, t, label, value, measured, extraCls = '') {
  const isT = sameTarget(S.target, t);
  return `<div class="mrow ${isT ? 'target' : ''} ${extraCls}" data-act="aim" data-t='${esc(JSON.stringify(t))}'>
    <div class="lbl">${label}</div>
    <button class="val ${measured ? '' : 'calc'}" data-act="edit" data-t='${esc(JSON.stringify(t))}'>${measured ? '' : '≈ '}${nl(value)}</button>
    <button class="aim" data-act="aim" data-t='${esc(JSON.stringify(t))}' aria-label="Meten met laser">◎</button></div>`;
}

function bannerHTML() {
  const r = room();
  if (S.target) {
    return `<div class="banner" id="banner"><div class="grow">▶ Volgende meting: ${esc(targetLabel(r, S.target))}</div>
      ${BLE.state === 'on' ? '<button data-act="measure">Meet</button>' : '<button data-act="connect">Verbind</button>'}
      <button data-act="clearTarget" aria-label="Stop">✕</button></div>`;
  }
  return `<div class="banner idle" id="banner"><div class="grow">Tik ◎ naast een maat (of een muur in het plan) en meet met de laser.</div></div>`;
}
function renderBanner() { const b = $('banner'); if (b) b.outerHTML = bannerHTML(); }

function viewRoom() {
  const r = room(), n = r.walls.length;
  let html = bannerHTML();
  html += `<div class="tabs"><button class="${S.tab === 'plan' ? 'on' : ''}" data-act="tab" data-tab="plan">Plan</button>
    <button class="${S.tab === 'aanzicht' ? 'on' : ''}" data-act="tab" data-tab="aanzicht">Aanzicht</button></div>`;
  if (S.tab === 'plan') {
    const d = planSVG(r, { sel: S.sel, target: S.target });
    const a = Geo.area(r);
    html += `<div class="drawing" id="plan">${svgTag(d)}</div>
      <div class="stats"><span>Opp. <b>${nl(a, 2)} m²</b></span><span>Omtrek ${nl(Geo.perimeter(r), 2)} m</span><span>Volume ${nl(a * r.height, 1)} m³</span></div>
      ${r.closure > 0.01 ? `<div class="warn">⚠ De maten sluiten niet helemaal (${nl(r.closure * 100, 1)} cm verschil). Controleer de metingen of zet een hoek op “vrij”.</div>` : ''}`;
    html += selPanel(r);
    html += `<div class="card"><h2>Muren</h2>${r.walls.map((w, i) =>
      mrow(r, { kind: 'wall', i }, `Muur ${i + 1} <span class="muted">${LETTER(i)}→${LETTER((i + 1) % n)}${w.openings.length ? ' · ' + w.openings.length + '× opening' : ''}</span>`, w.len, w.measured,
        S.sel && S.sel.type === 'wall' && S.sel.i === i ? 'sel' : '')).join('')}</div>`;
    html += `<div class="card"><h2>Ruimte</h2>
      ${mrow(r, { kind: 'height' }, 'Plafondhoogte', r.height, r.heightMeasured)}
      <div class="mrow"><div class="lbl">Muurdikte (tekening/IFC)</div><button class="val" data-act="thick">${nl(r.thick, 2)}</button><span style="width:36px"></span></div>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" data-act="renameRoom">Naam wijzigen</button><button class="btn danger" data-act="delRoom">Ruimte verwijderen</button></div></div>`;
  } else {
    html += viewElev(r);
  }
  return html;
}

function selPanel(r) {
  const n = r.walls.length;
  if (S.sel && S.sel.type === 'corner') {
    const i = S.sel.i, c = r.corners[i], ang = c.cur ?? c.angle;
    const is = (mode, a) => c.mode === mode && (a == null || Math.abs(c.angle - a) < 0.01);
    return `<div class="card"><h2>Hoek ${LETTER(i)} · ${nl(ang, 1)}°</h2>
      <div class="seg">
        <button class="${is('aanname', 90) ? 'on' : ''}" data-act="corner" data-mode="aanname" data-a="90">90°</button>
        <button class="${is('aanname', 270) ? 'on' : ''}" data-act="corner" data-mode="aanname" data-a="270">270° (inspringend)</button>
        <button class="${c.mode === 'ingegeven' ? 'on' : ''}" data-act="cornerCustom">${c.mode === 'ingegeven' ? nl(c.angle, 1) + '°' : 'Andere hoek…'}</button>
        <button class="${c.mode === 'vrij' ? 'on' : ''}" data-act="corner" data-mode="vrij">Vrij (berekenen)</button>
      </div>
      <p class="muted">90°/270° = haaks verondersteld. “Vrij” laat de app de hoek uit de muurlengtes afleiden.</p>
      <div class="btns"><button class="btn ghost small" data-act="removeCorner" ${n <= 3 ? 'disabled' : ''}>Hoek verwijderen</button>
      <button class="btn ghost small" data-act="deselect">Sluiten</button></div></div>`;
  }
  if (S.sel && S.sel.type === 'wall') {
    const i = S.sel.i, w = r.walls[i];
    return `<div class="card"><h2>Muur ${i + 1} · ${nl(w.len)} m</h2>
      <div class="btns"><button class="btn soft" data-act="addOpen" data-type="raam">+ Raam</button><button class="btn soft" data-act="addOpen" data-type="deur">+ Deur</button>
      <button class="btn ghost" data-act="split">Hoek toevoegen</button><button class="btn ghost" data-act="toElev">Aanzicht ›</button></div>
      <p class="muted" style="margin-bottom:0">“Hoek toevoegen” splitst de muur in twee; tik daarna de nieuwe hoek aan om hem te draaien.</p></div>`;
  }
  return `<p class="muted">Tik een muur aan om te meten, of een hoek (●) om de hoek aan te passen.</p>`;
}

function viewElev(r) {
  const n = r.walls.length;
  if (S.wallIdx >= n) S.wallIdx = 0;
  const i = S.wallIdx, w = r.walls[i];
  const d = elevSVG(r, i, { openSel: S.openSel });
  let html = `<div class="wallnav"><button data-act="wallPrev">‹</button>
    <div class="grow">Muur ${i + 1} <span class="muted">(${LETTER(i)}→${LETTER((i + 1) % n)}, van binnenuit)</span></div><button data-act="wallNext">›</button></div>
    <div class="drawing" id="elev">${svgTag(d)}</div>
    <div class="stats"><span>Muur ${nl(w.len, 2)} × ${nl(r.height, 2)} m</span><span>Netto ${nl(Geo.wallNetArea(r, w), 2)} m²</span></div>
    <div class="card" style="margin-top:10px">${mrow(r, { kind: 'wall', i }, 'Lengte muur ' + (i + 1), w.len, w.measured)}${mrow(r, { kind: 'height' }, 'Plafondhoogte', r.height, r.heightMeasured)}</div>`;
  html += `<div class="card"><h2>Ramen &amp; deuren</h2>`;
  if (!w.openings.length) html += '<p class="muted">Nog geen ramen of deuren op deze muur.</p>';
  w.openings.forEach((o, k) => {
    html += `<div class="ocard ${S.openSel === o.id ? 'sel' : ''}" id="o_${o.id}"><div class="ohead"><span class="grow">${o.type === 'raam' ? 'Raam' : 'Deur'} ${k + 1}</span>
      ${o.type === 'deur' ? `<div class="seg" style="margin:0"><button class="${o.hinge !== 'rechts' ? 'on' : ''}" data-act="hinge" data-oid="${o.id}" data-h="links">Scharnier L</button>
      <button class="${o.hinge === 'rechts' ? 'on' : ''}" data-act="hinge" data-oid="${o.id}" data-h="rechts">R</button></div>` : ''}
      <button class="aim" data-act="delOpen" data-oid="${o.id}" aria-label="Verwijderen">×</button></div>
      ${OPEN_PROPS[o.type].map(p => mrow(r, { kind: 'open', i, oid: o.id, prop: p }, PROP_NL[p], o[p], o.measured[p])).join('')}</div>`;
  });
  html += `<div class="btns"><button class="btn soft" data-act="addOpen" data-type="raam">+ Raam</button><button class="btn soft" data-act="addOpen" data-type="deur">+ Deur</button></div>
    <p class="muted" style="margin-bottom:0">Afstand tot linkerhoek = vanaf hoek ${LETTER(i)} tot de rand van de opening, gezien van binnenuit.</p></div>`;
  return html;
}

// ======================================================================
// Acties
// ======================================================================
function touch() { const p = project(); if (p) p.updated = Date.now(); }

$('app').addEventListener('click', e => {
  // tikken in de tekening
  const wallEl = e.target.closest('[data-wall]'), cornerEl = e.target.closest('[data-corner]'), openEl = e.target.closest('[data-open]');
  if (cornerEl) { S.sel = { type: 'corner', i: +cornerEl.dataset.corner }; return render(); }
  if (wallEl) { const i = +wallEl.dataset.wall; S.sel = { type: 'wall', i }; S.target = { kind: 'wall', i }; render(); if (BLE.state !== 'on') toast('Verbind de meter om te meten, of tik de maat aan om ze in te typen'); return; }
  if (openEl) { S.openSel = openEl.dataset.open; render(); const c = $('o_' + S.openSel); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }

  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, r = room(), p = project();
  const T = () => JSON.parse(el.dataset.t);
  switch (act) {
    case 'openProject': S.pid = el.dataset.id; S.view = 'project'; render(); window.scrollTo(0, 0); break;
    case 'openRoom': S.rid = el.dataset.id; S.view = 'room'; S.sel = null; S.openSel = null; S.wallIdx = 0; S.target = null; render(); window.scrollTo(0, 0); break;
    case 'goLoose': S.view = 'loose'; render(); break;
    case 'newProject':
      askText('Naam van het project', 'Project ' + (S.projects.length + 1), name => {
        const np = { id: Geo.uid(), name: name || 'Project', rooms: [], created: Date.now(), updated: Date.now() };
        S.projects.push(np); S.pid = np.id; S.view = 'project'; render();
      }); break;
    case 'renameProject': askText('Naam van het project', p.name, v => { if (v) { p.name = v; touch(); render(); } }); break;
    case 'delProject': confirmTap(el, 'Zeker? Tik opnieuw', () => { S.projects = S.projects.filter(x => x !== p); S.view = 'projects'; render(); }); break;
    case 'newRoom':
      openSheet(`<h3>Nieuwe ruimte</h3><input type="text" id="roomName" value="Ruimte ${p.rooms.length + 1}">
        <p class="muted">Kies een startvorm. Daarna meet je de muren en past het plan zich aan.</p>
        <div class="btns"><button class="btn soft" data-sh="t" data-type="rechthoek">Rechthoek</button><button class="btn soft" data-sh="t" data-type="lvorm">L-vorm</button>
        <button class="btn soft" data-sh="t" data-type="schuin">Met schuine muur</button></div>
        <div class="btns" style="margin-top:10px"><button class="btn ghost" data-sh="cancel">Annuleren</button></div>`, {
        cancel: closeSheet,
        t: b => {
          const nr = Geo.makeRoom(b.dataset.type, $('roomName').value.trim() || 'Ruimte');
          Geo.solveRoom(nr); p.rooms.push(nr); touch(); closeSheet();
          S.rid = nr.id; S.view = 'room'; S.tab = 'plan'; S.sel = null; S.target = { kind: 'wall', i: 0 }; render(); window.scrollTo(0, 0);
        },
      }); break;
    case 'renameRoom': askText('Naam van de ruimte', r.name, v => { if (v) { r.name = v; touch(); render(); } }); break;
    case 'delRoom': confirmTap(el, 'Zeker? Tik opnieuw', () => { p.rooms = p.rooms.filter(x => x !== r); touch(); S.view = 'project'; render(); }); break;
    case 'tab': S.tab = el.dataset.tab; if (S.tab === 'aanzicht' && S.sel && S.sel.type === 'wall') S.wallIdx = S.sel.i; render(); break;
    case 'aim': if (e.target.closest('[data-act="edit"]')) break; setTarget(T()); break;
    case 'edit': editValue(r, T()); break;
    case 'clearTarget': S.target = null; render(); break;
    case 'measure': bleMeasure(); break;
    case 'connect': bleConnect(); break;
    case 'thick': askText('Muurdikte (m)', nl(r.thick, 2), v => { r.thick = Math.min(Math.max(v, 0.02), 1); touch(); render(); }, { num: true }); break;
    case 'deselect': S.sel = null; render(); break;
    case 'corner': {
      const c = r.corners[S.sel.i];
      c.mode = el.dataset.mode;
      if (el.dataset.a) { c.angle = +el.dataset.a; c.cur = c.angle; } else c.angle = c.cur ?? c.angle;
      Geo.solveRoom(r); touch(); render(); break;
    }
    case 'cornerCustom': {
      const c = r.corners[S.sel.i];
      askText('Binnenhoek ' + LETTER(S.sel.i) + ' (graden)', nl(c.cur ?? c.angle, 1), v => {
        if (v <= 0 || v >= 360) return toast('Hoek moet tussen 0 en 360° liggen');
        c.mode = 'ingegeven'; c.angle = v; Geo.solveRoom(r); touch(); render();
      }, { num: true, hint: 'Binnenhoek gemeten aan de binnenkant van de ruimte. 90° = haaks, groter dan 180° = inspringende hoek.' });
      break;
    }
    case 'removeCorner': if (Geo.removeCorner(r, S.sel.i)) { S.sel = null; S.target = null; Geo.solveRoom(r); touch(); render(); } break;
    case 'split': Geo.splitWall(r, S.sel.i); S.sel = { type: 'corner', i: S.sel.i + 1 }; S.target = null; Geo.solveRoom(r); touch(); render(); toast('Hoek ' + LETTER(S.sel.i) + ' toegevoegd'); break;
    case 'toElev': S.tab = 'aanzicht'; S.wallIdx = S.sel.i; render(); window.scrollTo(0, 0); break;
    case 'wallPrev': S.wallIdx = (S.wallIdx - 1 + r.walls.length) % r.walls.length; S.openSel = null; render(); break;
    case 'wallNext': S.wallIdx = (S.wallIdx + 1) % r.walls.length; S.openSel = null; render(); break;
    case 'addOpen': {
      const i = S.tab === 'aanzicht' ? S.wallIdx : S.sel.i, w = r.walls[i];
      const o = Geo.makeOpening(el.dataset.type, w.len);
      w.openings.push(o); touch();
      S.tab = 'aanzicht'; S.wallIdx = i; S.openSel = o.id; S.target = { kind: 'open', i, oid: o.id, prop: 'width' };
      render(); window.scrollTo(0, 0); break;
    }
    case 'delOpen': {
      const w = r.walls[S.wallIdx];
      confirmTap(el, '?', () => { w.openings = w.openings.filter(o => o.id !== el.dataset.oid); if (S.target && S.target.oid === el.dataset.oid) S.target = null; touch(); render(); });
      break;
    }
    case 'hinge': { const o = r.walls[S.wallIdx].openings.find(x => x.id === el.dataset.oid); o.hinge = el.dataset.h; touch(); render(); break; }
    case 'labelLoose': { const it = S.loose.find(x => String(x.id) === el.dataset.id); askText('Label', it.label, v => { it.label = v; render(); }); break; }
    case 'delLoose': S.loose = S.loose.filter(x => String(x.id) !== el.dataset.id); render(); break;
    case 'copyLoose': copyText(['datum;tijd;label;afstand_m', ...S.loose.slice().reverse().map(it => {
      const d = new Date(it.t); return [d.toLocaleDateString('nl-BE'), d.toLocaleTimeString('nl-BE'), it.label, nl(it.m)].join(';');
    })].join('\n'), 'Metingen'); break;
    case 'clearLoose': confirmTap(el, 'Zeker? Tik opnieuw', () => { S.loose = []; render(); }); break;
    case 'importJson': $('fileIn').value = ''; $('fileIn').click(); break;
    case 'exportCsv': exportFile(fname(p, 'csv'), 'text/csv;charset=utf-8', '﻿' + Geo.csvExport(p)); break;
    case 'exportIfc': exportFile(fname(p, 'ifc'), 'application/x-step', Geo.ifcExport(p)); break;
    case 'exportJson': exportFile(fname(p, 'json'), 'application/json', JSON.stringify({ app: 'lasermeter', version: 1, project: p }, null, 1)); break;
    case 'exportPng': exportPng(p); break;
  }
});

// ---------- import / export ----------
const fname = (p, ext) => (p.name || 'project').replace(/[^\w\-]+/g, '_') + '.' + ext;

$('fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const p = data.project || data;
    if (!p || !Array.isArray(p.rooms)) throw new Error('geen projectbestand');
    if (S.projects.some(x => x.id === p.id)) { p.id = Geo.uid(); p.name += ' (kopie)'; }
    p.rooms.forEach(r => Geo.solveRoom(r));
    p.updated = Date.now();
    S.projects.push(p); S.pid = p.id; S.view = 'project'; render(); toast('Project geïmporteerd');
  } catch (err) { toast('Import mislukt: ' + err.message); }
});

async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(what + ' gekopieerd'); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(what + ' gekopieerd'); } catch { toast('Kopiëren mislukt'); }
    ta.remove();
  }
}

function exportFile(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const canShare = (() => { try { return navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: mime })] }); } catch { return false; } })();
  openSheet(`<h3>${esc(name)}</h3><p class="muted">${(blob.size / 1024).toFixed(1)} kB</p>
    <div class="btns">${canShare ? '<button class="btn" data-sh="share">Delen / bewaren…</button>' : ''}
    <button class="btn ${canShare ? 'soft' : ''}" data-sh="dl">Downloaden</button>
    ${mime.startsWith('image') ? '' : '<button class="btn soft" data-sh="copy">Kopieer tekst</button>'}</div>
    <p class="muted">Lukt downloaden niet in Bluefy? Gebruik “Delen” of “Kopieer tekst” en plak in Notities of Bestanden.</p>
    <div class="btns"><button class="btn ghost" data-sh="cancel">Sluiten</button></div>`, {
    share: async () => {
      try { await navigator.share({ files: [new File([blob], name, { type: mime })], title: name }); closeSheet(); }
      catch (e) { if (e.name !== 'AbortError') toast('Delen mislukt: ' + errText(e)); }
    },
    dl: () => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },
    copy: () => copyText(content, 'Inhoud'),
    cancel: closeSheet,
  });
}

function sheetSVG(p) {
  const W = 1000, pad = 30; let y = pad, parts = [];
  const title = (txt, size, yy, bold) => `<text x="${pad}" y="${yy}" font-size="${size}" font-family="-apple-system, Helvetica, Arial, sans-serif" font-weight="${bold ? 700 : 400}" fill="#1c211e">${esc(txt)}</text>`;
  parts.push(title(p.name, 34, y + 30, true)); y += 50;
  parts.push(title(new Date().toLocaleDateString('nl-BE') + ' · ' + p.rooms.length + ' ruimtes · ' + nl(p.rooms.reduce((s, r) => s + Geo.area(r), 0), 2) + ' m²', 18, y + 14)); y += 40;
  for (const r of p.rooms) {
    parts.push(`<line x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}" stroke="#ccc"/>`); y += 16;
    parts.push(title(r.name + ' – ' + nl(Geo.area(r), 2) + ' m² · hoogte ' + nl(r.height, 2) + ' m', 24, y + 22, true)); y += 40;
    const d = planSVG(r, { export: true });
    const pw = W - 2 * pad, ph = Math.min(pw * d.h / d.w, 700), pw2 = ph * d.w / d.h;
    parts.push(`<svg x="${pad + (pw - pw2) / 2}" y="${y}" width="${pw2}" height="${ph}" viewBox="${d.vb}">${d.body}</svg>`); y += ph + 16;
    const cw = (W - 2 * pad - 20) / 2;
    let rowH = 0;
    r.walls.forEach((w, i) => {
      const e = elevSVG(r, i, { export: true }), eh = cw * e.h / e.w;
      const col = i % 2, x = pad + col * (cw + 20);
      if (col === 0 && i > 0) { y += rowH; rowH = 0; }
      parts.push(`<text x="${x}" y="${y + 14}" font-size="16" font-family="-apple-system, Helvetica, Arial, sans-serif" font-weight="700" fill="#1c211e">Aanzicht muur ${i + 1}</text>`);
      parts.push(`<svg x="${x}" y="${y + 20}" width="${cw}" height="${eh}" viewBox="${e.vb}">${e.body}</svg>`);
      rowH = Math.max(rowH, eh + 30);
    });
    y += rowH + 10;
  }
  y += pad;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.ceil(y)}" viewBox="0 0 ${W} ${Math.ceil(y)}"><rect width="100%" height="100%" fill="#fff"/>${parts.join('')}</svg>`, w: W, h: Math.ceil(y) };
}

async function exportPng(p) {
  if (!p.rooms.length) return toast('Nog geen ruimtes');
  const { svg, w, h } = sheetSVG(p);
  try {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const scale = Math.min(2, 8000 / h);
    const cv = document.createElement('canvas'); cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL('image/png');
    const blob = await (await fetch(url)).blob();
    const name = fname(p, 'png');
    const canShare = (() => { try { return navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: 'image/png' })] }); } catch { return false; } })();
    openSheet(`<h3>Plannen &amp; aanzichten</h3><img src="${url}" alt="Plan">
      <p class="muted">Houd de afbeelding ingedrukt → “Bewaar in Foto's”.</p>
      <div class="btns">${canShare ? '<button class="btn" data-sh="share">Delen…</button>' : ''}<button class="btn soft" data-sh="dl">Downloaden</button>
      <button class="btn ghost" data-sh="cancel">Sluiten</button></div>`, {
      share: async () => { try { await navigator.share({ files: [new File([blob], name, { type: 'image/png' })] }); } catch (e) { if (e.name !== 'AbortError') toast('Delen mislukt'); } },
      dl: () => { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); },
      cancel: closeSheet,
    });
  } catch (e) { toast('Afbeelding maken mislukt: ' + errText(e)); }
}

// ---------- start ----------
for (const p of S.projects) for (const r of p.rooms) Geo.solveRoom(r);
render();
blog('Klaar · versie ' + VERSION + ' · Web Bluetooth: ' + (navigator.bluetooth ? 'ja' : 'nee'));
// voor testen in een browser zonder meter: Lasermeter.simulate(2.345)
window.Lasermeter = { simulate: m => onMeasurement(m), S };
