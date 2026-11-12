// Geometrie, solver en export voor de Lasermeter-app.
// Werkt in de browser (window.Geo) en in node (module.exports) voor tests.
(function (root) {
'use strict';
const DEG = Math.PI / 180;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------- model ----------
// room = { id, name, height, heightMeasured, thick, walls:[wall], corners:[corner] }
// corners[i] ligt aan het BEGIN van walls[i]. Ruimte wordt met de klok mee doorlopen
// (binnenkant rechts), zodat "begin van de muur" = linkerhoek gezien van binnenuit.
// wall   = { id, len, measured, openings:[opening] }
// corner = { mode: 'aanname' | 'ingegeven' | 'vrij', angle (doel, graden), cur (berekend, graden) }
// opening = { id, type:'raam'|'deur', offset, width, height, sill, hinge:'links'|'rechts', measured:{...} }

function makeWall(len) { return { id: uid(), len, measured: false, openings: [] }; }
function makeCorner(angle, mode) { return { mode: mode || 'aanname', angle, cur: angle }; }

const TEMPLATES = {
  rechthoek: { name: 'Rechthoek', lens: [4, 3, 4, 3], angles: [90, 90, 90, 90] },
  lvorm:     { name: 'L-vorm', lens: [5, 2, 2, 2, 3, 4], angles: [90, 90, 90, 270, 90, 90] },
  schuin:    { name: 'Met schuine muur', lens: [4, 2, Math.SQRT2, 3, 3], angles: [90, 90, 135, 135, 90],
               modes: ['aanname', 'aanname', 'vrij', 'vrij', 'aanname'] },
};

function makeRoom(type, name) {
  const t = TEMPLATES[type] || TEMPLATES.rechthoek;
  return {
    id: uid(), name: name || 'Ruimte', height: 2.6, heightMeasured: false, thick: 0.1,
    walls: t.lens.map(makeWall),
    corners: t.angles.map((a, i) => makeCorner(a, t.modes ? t.modes[i] : 'aanname')),
  };
}

function makeOpening(type, wallLen) {
  const raam = type === 'raam';
  const width = raam ? 1.2 : 0.9;
  return {
    id: uid(), type, width, height: raam ? 1.2 : 2.1, sill: raam ? 0.9 : 0,
    offset: Math.max(0, (wallLen - width) / 2), hinge: 'links',
    measured: { width: false, height: false, sill: !raam, offset: false },
  };
}

// muur splitsen: nieuwe hoek van 180° (rechte lijn) die de gebruiker daarna aanpast
function splitWall(room, i) {
  const w = room.walls[i];
  const half = w.len / 2;
  const nw = makeWall(half);
  w.len = half; w.measured = false;
  // openingen die op de tweede helft liggen verhuizen
  nw.openings = w.openings.filter(o => o.offset >= half).map(o => ({ ...o, offset: o.offset - half }));
  w.openings = w.openings.filter(o => o.offset < half);
  room.walls.splice(i + 1, 0, nw);
  room.corners.splice(i + 1, 0, makeCorner(180, 'ingegeven'));
}

// hoek i verwijderen: muur i-1 en muur i samenvoegen
function removeCorner(room, i) {
  const n = room.walls.length;
  if (n <= 3) return false;
  const prev = (i - 1 + n) % n;
  const g = geometry(room);
  const a = g.pts[prev], b = g.pts[(i + 1) % n];
  const wp = room.walls[prev], wi = room.walls[i];
  const shift = wp.len;
  wp.len = Math.hypot(b.x - a.x, b.y - a.y);
  wp.measured = false;
  wp.openings = wp.openings.concat(wi.openings.map(o => ({ ...o, offset: o.offset + shift })));
  const newPts = g.pts.filter((_, k) => k !== i);
  room.walls.splice(i, 1);
  room.corners.splice(i, 1);
  // hoeken aan beide uiteinden van de samengevoegde muur volgen de nieuwe vorm
  const m = newPts.length, ang = anglesFromPts(newPts);
  for (const k of [(i - 1 + m) % m, i % m]) {
    room.corners[k].mode = 'vrij'; room.corners[k].angle = room.corners[k].cur = ang[k];
  }
  if (i === 0) { // eerste hoek weg: lijst roteren zodat corners[0] bij walls[0] blijft
    room.walls.unshift(room.walls.pop());
    room.corners.unshift(room.corners.pop());
  }
  return true;
}

// binnenhoeken (graden) van een veelhoek die met de klok mee loopt
function anglesFromPts(pts) {
  const n = pts.length;
  return pts.map((p, k) => {
    const a = pts[(k - 1 + n) % n], b = pts[(k + 1) % n];
    const din = { x: p.x - a.x, y: p.y - a.y }, dout = { x: b.x - p.x, y: b.y - p.y };
    const turn = Math.atan2(din.x * dout.y - din.y * dout.x, din.x * dout.x + din.y * dout.y);
    return (Math.PI + turn) / DEG;
  });
}

// ---------- solver ----------
// Onbekenden: alle muurlengtes + binnenhoeken 1..n-1 (hoek 0 volgt uit de som).
// Gewogen kleinste kwadraten (Levenberg–Marquardt): plan moet sluiten,
// gemeten lengtes/ingegeven hoeken liggen (bijna) vast, de rest past zich aan.
function solveRoom(room, pass = 0) {
  const W = room.walls, C = room.corners, n = W.length;
  if (n < 3) return { closure: 0 };
  const tL = W.map(w => w.len);
  const wL = W.map(w => (w.measured ? 1000 : 1));
  const tA = C.map(c => (c.mode === 'vrij' ? (c.cur ?? c.angle) : c.angle) * DEG);
  const wA = C.map(c => (c.mode === 'ingegeven' ? 1000 : c.mode === 'aanname' ? 300 : 0.05));
  const WC = 1e5;

  let x = W.map(w => w.len).concat(C.slice(1).map(c => (c.cur ?? c.angle) * DEG));

  function walk(x) {
    let th = 0, px = 0, py = 0, sumA = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) { const a = x[n + i - 1]; sumA += a; th -= Math.PI - a; }
      px += x[i] * Math.cos(th); py += x[i] * Math.sin(th);
    }
    return { px, py, a0: (n - 2) * Math.PI - sumA };
  }
  function res(x) {
    const { px, py, a0 } = walk(x);
    const r = [WC * px, WC * py];
    for (let i = 0; i < n; i++) r.push(wL[i] * (x[i] - tL[i]));
    r.push(wA[0] * (a0 - tA[0]));
    for (let i = 1; i < n; i++) r.push(wA[i] * (x[n + i - 1] - tA[i]));
    return r;
  }
  const cost = r => r.reduce((s, v) => s + v * v, 0);

  const m = x.length;
  let r = res(x), c0 = cost(r), lambda = 1e-3;
  for (let it = 0; it < 80; it++) {
    // numerieke Jacobiaan
    const J = [];
    for (let j = 0; j < m; j++) {
      const h = 1e-7 * Math.max(1, Math.abs(x[j]));
      const xp = x.slice(); xp[j] += h;
      const rp = res(xp);
      J.push(rp.map((v, k) => (v - r[k]) / h)); // J[j][k] = d r_k / d x_j
    }
    const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => {
      let s = 0; for (let k = 0; k < r.length; k++) s += J[i][k] * J[j][k]; return s;
    }));
    const g = Array.from({ length: m }, (_, i) => { let s = 0; for (let k = 0; k < r.length; k++) s += J[i][k] * r[k]; return -s; });
    let improved = false;
    for (let tries = 0; tries < 10 && !improved; tries++) {
      const M = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const d = gauss(M, g.slice());
      if (!d) { lambda *= 10; continue; }
      const xn = x.map((v, i) => v + d[i]);
      for (let i = 0; i < n; i++) if (xn[i] < 0.01) xn[i] = 0.01;
      const rn = res(xn), cn = cost(rn);
      if (cn < c0) { x = xn; r = rn; improved = c0 - cn > 1e-14 * (1 + c0); c0 = cn; lambda = Math.max(lambda / 3, 1e-9); improved = true; }
      else lambda *= 5;
    }
    if (!improved) break;
    const step = Math.sqrt(g.reduce((s, v) => s + v * v, 0));
    if (step < 1e-12) break;
  }

  const { px, py, a0 } = walk(x);
  for (let i = 0; i < n; i++) if (!W[i].measured) W[i].len = x[i];
  C[0].cur = a0 / DEG;
  for (let i = 1; i < n; i++) C[i].cur = x[n + i - 1] / DEG;
  for (const c of C) if (c.mode === 'vrij') c.angle = c.cur;
  // controle: verschil tussen gemeten en resulterende lengte (overbepaald plan)
  let maxDev = 0;
  for (let i = 0; i < n; i++) if (W[i].measured) maxDev = Math.max(maxDev, Math.abs(x[i] - W[i].len));
  room.closure = Math.hypot(px, py) + maxDev;
  // vrije hoeken hadden hun oude waarde als (zwak) doel: nog een ronde vanaf de nieuwe stand
  if (pass < 3 && C.some(c => c.mode === 'vrij')) return solveRoom(room, pass + 1);
  return { closure: room.closure };
}

function gauss(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-18) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

// ---------- geometrie ----------
function geometry(room) {
  const W = room.walls, C = room.corners, n = W.length, t = room.thick || 0.1;
  const pts = [], dirs = [], norms = [];
  let th = 0, x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) th -= Math.PI - (C[i].cur ?? C[i].angle) * DEG;
    const d = { x: Math.cos(th), y: Math.sin(th) };
    pts.push({ x, y }); dirs.push(d); norms.push({ x: -d.y, y: d.x }); // buitenkant = links
    x += W[i].len * d.x; y += W[i].len * d.y;
  }
  // buitenhoeken: snijpunt van verschoven lijnen van muur i-1 en muur i
  const outer = [];
  for (let i = 0; i < n; i++) {
    const j = (i - 1 + n) % n;
    const a1 = { x: pts[j].x + norms[j].x * t, y: pts[j].y + norms[j].y * t }, d1 = dirs[j];
    const a2 = { x: pts[i].x + norms[i].x * t, y: pts[i].y + norms[i].y * t }, d2 = dirs[i];
    const den = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(den) < 1e-6) outer.push(a2);
    else {
      const s = ((a2.x - a1.x) * d2.y - (a2.y - a1.y) * d2.x) / den;
      outer.push({ x: a1.x + d1.x * s, y: a1.y + d1.y * s });
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outer.concat(pts)) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { pts, dirs, norms, outer, t, bbox: { minX, minY, maxX, maxY } };
}

function area(room) {
  const { pts } = geometry(room);
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
const perimeter = room => room.walls.reduce((s, w) => s + w.len, 0);
function wallNetArea(room, w) {
  return w.len * room.height - w.openings.reduce((s, o) => s + o.width * o.height, 0);
}

// ---------- export: CSV ----------
const nl = (v, d = 3) => v.toFixed(d).replace('.', ',');
function csvExport(project) {
  const rows = [['Ruimte', 'Element', 'Maat', 'Waarde', 'Eenheid', 'Status']];
  const st = b => (b ? 'gemeten' : 'berekend');
  for (const r of project.rooms) {
    rows.push([r.name, 'Ruimte', 'Vloeroppervlakte', nl(area(r), 2), 'm²', 'berekend']);
    rows.push([r.name, 'Ruimte', 'Omtrek', nl(perimeter(r)), 'm', 'berekend']);
    rows.push([r.name, 'Ruimte', 'Hoogte', nl(r.height), 'm', st(r.heightMeasured)]);
    rows.push([r.name, 'Ruimte', 'Volume', nl(area(r) * r.height, 2), 'm³', 'berekend']);
    r.walls.forEach((w, i) => {
      const wn = 'Muur ' + (i + 1);
      rows.push([r.name, wn, 'Lengte', nl(w.len), 'm', st(w.measured)]);
      rows.push([r.name, wn, 'Netto muuroppervlakte', nl(wallNetArea(r, w), 2), 'm²', 'berekend']);
      rows.push([r.name, 'Hoek ' + String.fromCharCode(65 + i), 'Binnenhoek', nl(r.corners[i].cur ?? r.corners[i].angle, 1), '°',
        r.corners[i].mode === 'ingegeven' ? 'ingegeven' : r.corners[i].mode === 'aanname' ? 'aanname' : 'berekend']);
      w.openings.forEach((o, k) => {
        const on = wn + ' – ' + (o.type === 'raam' ? 'Raam ' : 'Deur ') + (k + 1);
        rows.push([r.name, on, 'Breedte', nl(o.width), 'm', st(o.measured.width)]);
        rows.push([r.name, on, 'Hoogte', nl(o.height), 'm', st(o.measured.height)]);
        if (o.type === 'raam') rows.push([r.name, on, 'Borstwering', nl(o.sill), 'm', st(o.measured.sill)]);
        rows.push([r.name, on, 'Afstand tot linkerhoek', nl(o.offset), 'm', st(o.measured.offset)]);
      });
    });
  }
  return rows.map(r => r.map(v => (/[;"\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v)).join(';')).join('\n');
}

// ---------- export: IFC4 ----------
const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
function ifcGuid() {
  const bytes = new Uint8Array(16);
  if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = B64[parseInt(bits.slice(0, 2), 2)];
  for (let i = 2; i < 128; i += 6) out += B64[parseInt(bits.slice(i, i + 6), 2)];
  return out;
}
function ifcReal(v) {
  let s = String(Math.round(v * 1e6) / 1e6);
  if (s === '-0') s = '0';
  if (!/[.eE]/.test(s)) s += '.';
  return s;
}
function ifcStr(s) {
  if (s == null || s === '') return '$';
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (c >= 32 && c < 127) out += ch;
    else if (c <= 0xffff) out += '\\X2\\' + c.toString(16).toUpperCase().padStart(4, '0') + '\\X0\\';
  }
  return "'" + out + "'";
}

function ifcExport(project, opts = {}) {
  const lines = []; let id = 0;
  const add = s => { id++; lines.push('#' + id + '=' + s + ';'); return '#' + id; };
  const f = ifcReal, g = () => "'" + ifcGuid() + "'";
  const P2 = (x, y) => add(`IFCCARTESIANPOINT((${f(x)},${f(y)}))`);
  const P3 = (x, y, z) => add(`IFCCARTESIANPOINT((${f(x)},${f(y)},${f(z)}))`);
  const D3 = (x, y, z) => add(`IFCDIRECTION((${f(x)},${f(y)},${f(z)}))`);
  const Z = D3(0, 0, 1), X = D3(1, 0, 0);
  const AX = (p, xd) => add(`IFCAXIS2PLACEMENT3D(${p || P3(0, 0, 0)},${Z},${xd || X})`);
  const LP = (rel, ax) => add(`IFCLOCALPLACEMENT(${rel || '$'},${ax || AX()})`);

  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${AX()},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const uL = add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`);
  const uA = add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
  const uV = add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
  const uP = add(`IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)`);
  const units = add(`IFCUNITASSIGNMENT((${uL},${uA},${uV},${uP}))`);
  const proj = add(`IFCPROJECT(${g()},$,${ifcStr(project.name)},$,$,$,$,(${ctx}),${units})`);
  const lpSite = LP(), lpBld = LP(lpSite), lpSt = LP(lpBld);
  const site = add(`IFCSITE(${g()},$,'Terrein',$,$,${lpSite},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bld = add(`IFCBUILDING(${g()},$,${ifcStr(project.name)},$,$,${lpBld},$,$,.ELEMENT.,$,$,$)`);
  const st = add(`IFCBUILDINGSTOREY(${g()},$,'Verdieping',$,$,${lpSt},$,$,.ELEMENT.,0.)`);
  add(`IFCRELAGGREGATES(${g()},$,$,$,${proj},(${site}))`);
  add(`IFCRELAGGREGATES(${g()},$,$,$,${site},(${bld}))`);
  add(`IFCRELAGGREGATES(${g()},$,$,$,${bld},(${st}))`);

  const shape = solid => {
    const rep = add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solid}))`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
  };
  const extrude = (prof, h) => add(`IFCEXTRUDEDAREASOLID(${prof},${AX()},${Z},${f(h)})`);
  const polyProf = pts => {
    const ids = pts.map(p => P2(p.x, p.y)); ids.push(ids[0]);
    const pl = add(`IFCPOLYLINE((${ids.join(',')}))`);
    return add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${pl})`);
  };
  const rectProf = (cx, cy, xd, yd) => {
    const pos = add(`IFCAXIS2PLACEMENT2D(${P2(cx, cy)},$)`);
    return add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${pos},${f(xd)},${f(yd)})`);
  };

  const spaces = [], contained = [];
  let cursor = 0;
  for (const room of project.rooms) {
    const geo = geometry(room), H = room.height, t = geo.t;
    // ruimtes naast elkaar leggen (onderlinge positie is niet gemeten)
    const tx = cursor - geo.bbox.minX, ty = -geo.bbox.minY;
    cursor += geo.bbox.maxX - geo.bbox.minX + 1;
    const lpRoom = LP(lpSt, AX(P3(tx, ty, 0)));

    const sp = add(`IFCSPACE(${g()},$,${ifcStr(room.name)},$,$,${LP(lpRoom)},${shape(extrude(polyProf(geo.pts), H))},${ifcStr(room.name)},.ELEMENT.,.INTERNAL.,$)`);
    spaces.push(sp);
    const a = area(room);
    const q = [
      add(`IFCQUANTITYLENGTH('Height',$,$,${f(H)},$)`),
      add(`IFCQUANTITYAREA('NetFloorArea',$,$,${f(a)},$)`),
      add(`IFCQUANTITYLENGTH('NetPerimeter',$,$,${f(perimeter(room))},$)`),
      add(`IFCQUANTITYVOLUME('NetVolume',$,$,${f(a * H)},$)`),
    ];
    const eq = add(`IFCELEMENTQUANTITY(${g()},$,'Qto_SpaceBaseQuantities',$,$,(${q.join(',')}))`);
    add(`IFCRELDEFINESBYPROPERTIES(${g()},$,$,$,(${sp}),${eq})`);

    const n = room.walls.length;
    room.walls.forEach((w, i) => {
      const p0 = geo.pts[i], p1 = geo.pts[(i + 1) % n], o0 = geo.outer[i], o1 = geo.outer[(i + 1) % n];
      const lpW = LP(lpRoom);
      const wall = add(`IFCWALL(${g()},$,${ifcStr(room.name + ' – Muur ' + (i + 1))},$,$,${lpW},${shape(extrude(polyProf([p0, p1, o1, o0]), H))},$,.STANDARD.)`);
      contained.push(wall);
      const d = geo.dirs[i];
      w.openings.forEach((o, k) => {
        const xs = o.offset;
        const lpO = LP(lpW, AX(P3(p0.x + d.x * xs, p0.y + d.y * xs, o.sill), D3(d.x, d.y, 0)));
        const op = add(`IFCOPENINGELEMENT(${g()},$,'Opening',$,$,${lpO},${shape(extrude(rectProf(o.width / 2, t / 2, o.width, t + 0.04), o.height))},$,.OPENING.)`);
        add(`IFCRELVOIDSELEMENT(${g()},$,$,$,${wall},${op})`);
        const ft = Math.min(0.06, t);
        const fShape = shape(extrude(rectProf(o.width / 2, t / 2, o.width, ft), o.height));
        const nm = ifcStr((o.type === 'raam' ? 'Raam ' : 'Deur ') + (i + 1) + '.' + (k + 1));
        const fill = o.type === 'raam'
          ? add(`IFCWINDOW(${g()},$,${nm},$,$,${LP(lpO)},${fShape},$,${f(o.height)},${f(o.width)},.WINDOW.,.SINGLE_PANEL.,$)`)
          : add(`IFCDOOR(${g()},$,${nm},$,$,${LP(lpO)},${fShape},$,${f(o.height)},${f(o.width)},.DOOR.,${o.hinge === 'rechts' ? '.SINGLE_SWING_RIGHT.' : '.SINGLE_SWING_LEFT.'},$)`);
        add(`IFCRELFILLSELEMENT(${g()},$,$,$,${op},${fill})`);
        contained.push(fill);
      });
    });
  }
  if (spaces.length) add(`IFCRELAGGREGATES(${g()},$,$,$,${st},(${spaces.join(',')}))`);
  if (contained.length) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${g()},$,$,$,(${contained.join(',')}),${st})`);

  const now = (opts.date || new Date()).toISOString().slice(0, 19);
  const fname = (project.name || 'project').replace(/[^\w\-]+/g, '_') + '.ifc';
  return [
    'ISO-10303-21;', 'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    `FILE_NAME(${ifcStr(fname)},'${now}',(''),(''),'Lasermeter app','Lasermeter app','');`,
    "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}


// ---------- LiDAR-scan (Apple RoomPlan) -> ruimte ----------
// scan = { walls:[{cx,cy,cz,ax,az,w,h}], openings:[{type:'deur'|'raam'|'opening',cx,cy,cz,w,h}] }
// (ax,az) = richting van de muur in wereldcoördinaten. Plan: X = x, Y = -z (bovenaanzicht).
function roomFromScan(scan, name) {
  const segs = (scan.walls || []).filter(w => w.w > 0.15).map(w => {
    const L = Math.hypot(w.ax, w.az) || 1, d = { x: w.ax / L, y: -w.az / L }, c = { x: w.cx, y: -w.cz }, h2 = w.w / 2;
    return { a: { x: c.x - d.x * h2, y: c.y - d.y * h2 }, b: { x: c.x + d.x * h2, y: c.y + d.y * h2 }, d, h: w.h, y0: w.cy - w.h / 2 };
  });
  if (segs.length < 3) throw new Error('te weinig muren gescand (' + segs.length + ')');
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  // muren aan elkaar rijgen op dichtstbijzijnde uiteinden
  const used = new Set([0]), chain = [segs[0]];
  let end = segs[0].b;
  while (used.size < segs.length) {
    let best = -1, bd = Infinity, flip = false;
    segs.forEach((s, k) => {
      if (used.has(k)) return;
      const da = dist(end, s.a), db = dist(end, s.b);
      if (da < bd) { bd = da; best = k; flip = false; }
      if (db < bd) { bd = db; best = k; flip = true; }
    });
    if (best < 0 || bd > 1.2) break;
    const s = segs[best]; used.add(best);
    const o = flip ? { a: s.b, b: s.a, d: { x: -s.d.x, y: -s.d.y }, h: s.h, y0: s.y0 } : s;
    chain.push(o); end = o.b;
  }
  const n0 = chain.length;
  if (n0 < 3) throw new Error('muren vormen geen gesloten ruimte');
  // hoekpunten = snijpunt van opeenvolgende muurlijnen
  let pts = chain.map((s, k) => {
    const p = chain[(k - 1 + n0) % n0];
    const den = p.d.x * s.d.y - p.d.y * s.d.x;
    if (Math.abs(den) < 0.05) return { x: (p.b.x + s.a.x) / 2, y: (p.b.y + s.a.y) / 2 };
    const t = ((s.a.x - p.a.x) * s.d.y - (s.a.y - p.a.y) * s.d.x) / den;
    return { x: p.a.x + p.d.x * t, y: p.a.y + p.d.y * t };
  });
  // met de klok mee (binnenkant rechts)
  let sa = 0;
  for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; sa += a.x * b.y - b.x * a.y; }
  if (sa > 0) pts.reverse();
  // rechte hoeken van ~180° (muur in twee stukken gescand) samenvoegen
  for (let guard = 0; guard < 50 && pts.length > 3; guard++) {
    const ang = anglesFromPts(pts), k = ang.findIndex(a => Math.abs(a - 180) < 6);
    if (k < 0) break;
    pts.splice(k, 1);
  }
  const n = pts.length, ang = anglesFromPts(pts);
  const hs = chain.map(s => s.h).sort((a, b) => a - b);
  const height = hs[Math.floor(hs.length / 2)];
  const floorY = Math.min(...chain.map(s => s.y0));
  const room = {
    id: uid(), name: name || 'Scan', height: Math.round(height * 1000) / 1000, heightMeasured: false, thick: 0.1, scanned: true,
    walls: pts.map((p, k) => makeWall(dist(p, pts[(k + 1) % n]))),
    corners: ang.map(a => {
      if (Math.abs(a - 90) < 4) return makeCorner(90, 'aanname');
      if (Math.abs(a - 270) < 4) return makeCorner(270, 'aanname');
      return makeCorner(a, 'aanname'); // gescande hoek als (zachte) aanname
    }),
  };
  // ramen & deuren op de dichtstbijzijnde muur
  for (const o of scan.openings || []) {
    const c = { x: o.cx, y: -o.cz };
    let bestK = -1, bestD = Infinity, bestT = 0;
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[(k + 1) % n], L = dist(a, b);
      const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
      const t = Math.max(0, Math.min(L, (c.x - a.x) * ux + (c.y - a.y) * uy));
      const dd = Math.hypot(a.x + ux * t - c.x, a.y + uy * t - c.y);
      if (dd < bestD) { bestD = dd; bestK = k; bestT = t; }
    }
    if (bestK < 0 || bestD > 0.6) continue;
    const w = room.walls[bestK], type = o.type === 'raam' ? 'raam' : 'deur';
    const op = makeOpening(type, w.len);
    op.width = Math.min(o.w, w.len);
    op.height = o.h;
    op.offset = Math.max(0, Math.min(w.len - op.width, bestT - op.width / 2));
    op.sill = type === 'raam' ? Math.max(0, o.cy - o.h / 2 - floorY) : 0;
    if (o.type === 'opening') op.passage = true;
    w.openings.push(op);
  }
  solveRoom(room);
  return room;
}

const Geo = { roomFromScan, uid, TEMPLATES, makeRoom, makeWall, makeCorner, makeOpening, splitWall, removeCorner,
  solveRoom, geometry, area, perimeter, wallNetArea, csvExport, ifcExport, ifcGuid };
if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
else root.Geo = Geo;
})(typeof window !== 'undefined' ? window : globalThis);
