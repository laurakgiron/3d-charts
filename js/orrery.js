// Castid 3D — builds one chart as a small solar system.
//
// The ecliptic is the ground plane. Each planet has its own shell, nested in
// Chaldean order (Moon innermost … Saturn, then the moderns beyond), and sits
// on that shell at its true geocentric longitude and latitude. The horizon
// and meridian are drawn as the tilted great circles they really are, so the
// Ascendant is simply where the horizon cuts the ecliptic on the east, and
// the Midheaven where the meridian does. Stacked charts (transits,
// progressions, returns) become storeys above the natal floor; cross-ring
// aspects are rods between storeys.
//
// Coordinates: celestial.js works in the ecliptic frame (x → 0° Aries,
// z → north ecliptic pole). three.js is y-up, so ecliptic (x, y, z) maps to
// three (x, z, −y); longitude runs counter-clockwise seen from above, like a
// chart wheel.

import * as THREE from 'three';
import { GLYPHS, SIGN_KEYS } from './glyphs.js';
import { formatLon } from './ephemeris.js';
import { skyFrame, greatCircle, moonOrbitPole, lonLatToVec, antiscion, norm, V } from './celestial.js';

export const RING_COLORS = ['#0755BB', '#8A2B20', '#2E6B5E', '#9C6B1F', '#5B3A6E', '#3A3F47'];
export const ASPECT_COLORS = {
  conjunction: '#6B6E73', sextile: '#2E6B5E', square: '#C0392B', trine: '#0755BB', opposition: '#8A2B20',
};
const INK = '#0755BB', PLASTER = '#EDEAE4', GOLD = '#B8922E';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

export const R_OUT = 10, R_IN = 8.7, R_HUB = 1.1, STOREY = 2.2;
// Chaldean shells, innermost first. Nodes ride the Moon's shell.
export const SHELL = {
  moon: 2.1, mercury: 2.9, venus: 3.7, sun: 4.5, mars: 5.3, jupiter: 6.1, saturn: 6.9,
  uranus: 7.45, neptune: 7.9, pluto: 8.35, node: 2.1, snode: 2.1,
};
const BODY_RADIUS = { sun: 0.3, moon: 0.22, jupiter: 0.26, saturn: 0.25, uranus: 0.2, neptune: 0.2 };

const DEG = Math.PI / 180;
export const toThree = v => new THREE.Vector3(v[0], v[2], -v[1]);
const Y = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------- textures

// Static textures (glyphs, sign glyphs, fixed text) are cached and shared.
// Textures that change with the chart (degree labels) are NOT cached: a
// running animation would otherwise mint a new texture for every body on
// every step and never release any of them. Those are tagged `owned` and
// disposed with the sprite that carries them (see disposeGroup).
const texCache = new Map();
function canvasTexture(key, w, h, draw) {
  if (key && texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace;
  if (key) texCache.set(key, t); else t.userData.owned = true;
  return t;
}

function strokeGlyph(ctx, key, cx, cy, px, color, lw = 1.6) {
  const paths = key === 'snode' || key === 'node' ? GLYPHS.nnode : GLYPHS[key];
  if (!paths) return false;
  ctx.save();
  ctx.translate(cx, cy);
  if (key === 'snode') ctx.rotate(Math.PI);
  ctx.scale(px / 16, px / 16);
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const d of paths) ctx.stroke(new Path2D(d));
  ctx.restore();
  return true;
}

// Planet label: glyph above, degree below, optional ℞.
function planetLabelTexture(p, color, showDeg) {
  const f = formatLon(p.lon);
  const deg = showDeg ? `${f.deg}°${String(f.min).padStart(2, '0')}` : '';
  const key = deg ? null : `pl|${p.key}|${color}|${p.retro ? 'r' : ''}`;
  return canvasTexture(key, 160, 200, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    if (!strokeGlyph(ctx, p.key, w / 2, 62, 88, color, 1.5)) {
      ctx.fillStyle = color; ctx.font = '84px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.glyph || '?', w / 2, 62);
    }
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (deg) { ctx.font = '600 38px Cinzel, serif'; ctx.fillText(deg + (p.retro ? ' ℞' : ''), w / 2, 150); }
    else if (p.retro) { ctx.font = '600 38px Cinzel, serif'; ctx.fillText('℞', w / 2, 150); }
  });
}

function textTexture(text, color, size = 64, weight = 600) {
  return canvasTexture(`tx|${text}|${color}|${size}|${weight}`, 256, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${weight} ${size}px Cinzel, serif`;
    ctx.fillText(text, w / 2, h / 2);
  });
}

function signTexture(key, color) {
  return canvasTexture(`sg|${key}|${color}`, 128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    strokeGlyph(ctx, key, w / 2, h / 2, 88, color, 1.5);
  });
}

function sprite(tex, worldH, aspect = 1, opts = {}) {
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: opts.opacity ?? 1 });
  const s = new THREE.Sprite(m);
  s.scale.set(worldH * aspect, worldH, 1);
  if (opts.center) s.center.copy(opts.center);
  s.renderOrder = 5;
  return s;
}

// ------------------------------------------------------------ primitives

const matCache = new Map();
function lineMat(color, opacity = 1) {
  const k = `l|${color}|${opacity}`;
  if (!matCache.has(k)) matCache.set(k, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
  return matCache.get(k);
}
function solidMat(color, opts = {}) {
  const k = `s|${color}|${JSON.stringify(opts)}`;
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08, ...opts }));
  return matCache.get(k);
}
function glassMat(color, opacity) {
  const k = `g|${color}|${opacity}`;
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  return matCache.get(k);
}

function polyline(points, mat, closed = false) {
  const pts = points.map(p => (p instanceof THREE.Vector3 ? p : toThree(p)));
  if (closed) pts.push(pts[0].clone());
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.Line(g, mat);
}

function flatCircle(r, mat, y = 0, n = 180) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; pts.push(new THREE.Vector3(r * Math.cos(a), y, -r * Math.sin(a))); }
  return polyline(pts, mat);
}

// A rod between two points: the "glass rod" of a molecule model.
function rod(a, b, radius, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-6) return new THREE.Group();
  const g = new THREE.CylinderGeometry(radius, radius, len, 10, 1, true);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(Y, dir.normalize());
  return m;
}

const planePos = (lon, r, y = 0) => new THREE.Vector3(r * Math.cos(lon * DEG), y, -r * Math.sin(lon * DEG));

// --------------------------------------------------------------- pieces

function zodiacBand(y = 0) {
  const g = new THREE.Group();
  for (let s = 0; s < 12; s++) {
    if (s % 2 === 0) {
      const geo = new THREE.RingGeometry(R_IN, R_OUT, 24, 1, s * 30 * DEG, 30 * DEG);
      const m = new THREE.Mesh(geo, glassMat(PLASTER, 0.55));
      m.rotation.x = -Math.PI / 2; m.position.y = y; m.renderOrder = -1;
      g.add(m);
    }
    g.add(polyline([planePos(s * 30, R_IN, y), planePos(s * 30, R_OUT, y)], lineMat(INK)));
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.86), new THREE.MeshBasicMaterial({ map: signTexture(SIGN_KEYS[s], INK), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    gl.rotation.x = -Math.PI / 2;
    gl.position.copy(planePos(s * 30 + 15, (R_IN + R_OUT) / 2, y + 0.005));
    g.add(gl);
  }
  g.add(flatCircle(R_OUT, lineMat(INK), y));
  g.add(flatCircle(R_IN, lineMat(INK), y));
  // degree ticks
  const tp = [];
  for (let d = 0; d < 360; d += 5) {
    const len = d % 10 === 0 ? 0.32 : 0.16;
    tp.push(planePos(d, R_IN, y), planePos(d, R_IN - len, y));
  }
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tp), lineMat(INK, 0.5)));
  g.add(flatCircle(R_HUB, lineMat(INK, 0.7), y));
  return g;
}

function houses(chart, y = 0) {
  const g = new THREE.Group();
  if (!chart.cusps) return g;
  for (let h = 0; h < 12; h++) {
    const c = chart.cusps[h];
    const major = h % 3 === 0;
    if (major) g.add(rod(planePos(c, R_HUB, y), planePos(c, R_IN, y), 0.028, solidMat(INK)));
    else g.add(polyline([planePos(c, R_HUB, y), planePos(c, R_IN, y)], lineMat(INK, 0.45)));
    const mid = c + norm(chart.cusps[(h + 1) % 12] - c) / 2;
    const s = sprite(textTexture(ROMAN[h], INK, 56, 500), 0.55, 2, { opacity: 0.8 });
    s.position.copy(planePos(mid, R_HUB + 0.55, y + 0.05));
    g.add(s);
  }
  return g;
}

// Horizon, meridian, equator and the four angles for the natal storey.
function sky(frame, y = 0) {
  const g = new THREE.Group();
  const horizonPts = greatCircle(frame.zenith, R_OUT, 180, frame.ascV).map(toThree);
  g.add(polyline(horizonPts, lineMat(INK)));
  // translucent horizon disc
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R_OUT, 96), glassMat(PLASTER, 0.28));
  disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), toThree(frame.zenith).normalize());
  disc.renderOrder = -2;
  g.add(disc);
  // meridian & equator
  g.add(polyline(greatCircle(frame.east, R_OUT, 180, frame.mcV).map(toThree), lineMat(INK, 0.7)));
  const eq = polyline(greatCircle(frame.pole, R_OUT, 180).map(toThree), new THREE.LineDashedMaterial({ color: INK, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.5 }));
  eq.computeLineDistances();
  g.add(eq);
  // axes across the ecliptic
  const ascP = toThree(V.scale(frame.ascV, R_OUT)), mcP = toThree(V.scale(frame.mcV, R_OUT));
  g.add(rod(ascP.clone().negate(), ascP, 0.045, solidMat(INK)));
  g.add(rod(mcP.clone().negate(), mcP, 0.03, solidMat(INK)));
  const lab = (t, v, k) => { const s = sprite(textTexture(t, INK, 60, 700), 0.62, 2); s.position.copy(toThree(V.scale(v, k))); g.add(s); };
  lab('AC', frame.ascV, R_OUT + 0.9); lab('DC', V.scale(frame.ascV, -1), R_OUT + 0.9);
  lab('MC', frame.mcV, R_OUT + 0.9); lab('IC', V.scale(frame.mcV, -1), R_OUT + 0.9);
  // zenith & north celestial pole markers
  const z = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), solidMat(INK));
  z.position.copy(toThree(V.scale(frame.zenith, R_OUT))); g.add(z);
  const zl = sprite(textTexture('ZENITH', INK, 40, 500), 0.42, 2, { opacity: 0.75 });
  zl.position.copy(toThree(V.scale(frame.zenith, R_OUT + 0.7))); g.add(zl);
  const np = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 6), solidMat(INK));
  np.position.copy(toThree(V.scale(frame.pole, R_OUT))); g.add(np);
  const nl = sprite(textTexture('POLE', INK, 40, 500), 0.4, 2, { opacity: 0.6 });
  nl.position.copy(toThree(V.scale(frame.pole, R_OUT + 0.6))); g.add(nl);
  g.position.y = y;
  return g;
}

function bodyRadius(key) { return BODY_RADIUS[key] || 0.17; }

// One chart's planets on their shells. Returns { group, pickables }.
function storey(ring, idx, opts, base) {
  const g = new THREE.Group();
  const y = idx * STOREY;
  const color = ring.color;
  const chart = ring.chart;
  const pickables = [];
  const useLat = opts.latitude !== false;
  const showDeg = opts.degrees !== false;

  if (idx > 0) {
    g.add(flatCircle(R_IN, lineMat(color, 0.5), y));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R_IN, 96), glassMat(color, 0.05));
    disc.rotation.x = -Math.PI / 2; disc.position.y = y; disc.renderOrder = -1;
    g.add(disc);
    const t = sprite(textTexture(ring.label.toUpperCase().slice(0, 18), color, 44, 500), 0.5, 4, { opacity: 0.85 });
    t.position.set(0, y + 0.3, R_IN + 0.9);
    g.add(t);
  }

  // shells
  const seen = new Set();
  for (const p of chart.planets) {
    const r = SHELL[p.key]; if (!r || seen.has(r)) continue; seen.add(r);
    if (p.key === 'moon' || p.key === 'node' || p.key === 'snode') continue;
    g.add(flatCircle(r, lineMat(color, 0.35), y));
  }
  // Moon: her real inclined orbit, tilted about the nodal line.
  const nodeP = chart.planets.find(p => p.key === 'node');
  if (chart.planets.some(p => p.key === 'moon')) {
    const pole = nodeP ? moonOrbitPole(nodeP.lon) : [0, 0, 1];
    const pts = greatCircle(pole, SHELL.moon, 180, nodeP ? lonLatToVec(nodeP.lon) : null).map(v => toThree(v).setY(toThree(v).y + y));
    g.add(polyline(pts, lineMat(color, 0.55)));
    g.add(flatCircle(SHELL.moon, lineMat(color, 0.18), y));
  }

  for (const p of chart.planets) {
    const r = SHELL[p.key]; if (!r) continue;
    const lat = useLat ? (p.lat || 0) : 0;
    const pos = toThree(V.scale(lonLatToVec(p.lon, lat), r)); pos.y += y;
    if (p.isPoint) {
      const s = sprite(planetLabelTexture({ ...p, retro: false }, color, false), 0.55, 0.8);
      s.position.copy(pos);
      s.userData = { pick: { ring: idx, ...pickInfo(p, ring, base) } };
      g.add(s); pickables.push(s);
      continue;
    }
    const isSun = p.key === 'sun';
    const mat = isSun ? solidMat(GOLD, { emissive: GOLD, emissiveIntensity: 0.55 })
      : p.key === 'moon' ? solidMat(PLASTER, { emissive: color, emissiveIntensity: 0.12 })
      : solidMat(color);
    const m = new THREE.Mesh(new THREE.SphereGeometry(bodyRadius(p.key), 28, 18), mat);
    m.position.copy(pos);
    m.userData = { pick: { ring: idx, ...pickInfo(p, ring, base) }, baseScale: 1 };
    g.add(m); pickables.push(m);
    if (p.key === 'moon' || isSun) {
      const halo = new THREE.Mesh(new THREE.SphereGeometry(bodyRadius(p.key) * 1.6, 20, 12), glassMat(isSun ? GOLD : PLASTER, 0.18));
      halo.position.copy(pos); g.add(halo);
    }
    if (p.key === 'saturn') {
      const rg = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.5, 40), glassMat(color, 0.7));
      rg.position.copy(pos); rg.rotation.x = -Math.PI / 2 + 0.45; rg.rotation.y = 0.3; g.add(rg);
    }
    // stem down to the plane when the body is off the ecliptic
    const foot = planePos(p.lon, r, y);
    if (Math.abs(pos.y - y) > 0.02) {
      g.add(polyline([foot, pos], lineMat(color, 0.45)));
      const fm = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), solidMat(color));
      fm.position.copy(foot); g.add(fm);
    }
    const lab = sprite(planetLabelTexture(p, color, showDeg), 1.3, 0.8, { center: new THREE.Vector2(0.5, -0.05) });
    lab.position.copy(pos).add(new THREE.Vector3(0, bodyRadius(p.key) + 0.05, 0));
    g.add(lab);
  }

  if (opts.antiscia && idx === 0) g.add(antiscia(chart, color, y, useLat));
  return { group: g, pickables };
}

function pickInfo(p, ring, base) {
  const f = formatLon(p.lon);
  return {
    key: p.key, name: p.name, lon: p.lon, lat: p.lat || 0, retro: !!p.retro, text: f.text,
    house: p.house ?? null, ringName: ring.label,
  };
}

// Antiscia: mirror each body across the solstitial axis (0°♋–0°♑). The
// mirror is a vertical plane through that axis; ghosts sit where the
// reflection lands, on the same shell, joined by a rod that crosses the
// mirror at right angles.
function antiscia(chart, color, y, useLat) {
  const g = new THREE.Group();
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(2 * R_OUT, 3.2), glassMat('#9C6B1F', 0.1));
  mirror.rotation.y = Math.PI / 2; mirror.position.y = y; mirror.renderOrder = -1; // plane x = 0 → contains 0°♋/0°♑
  g.add(mirror);
  g.add(rod(planePos(90, R_OUT, y), planePos(270, R_OUT, y), 0.025, solidMat('#9C6B1F')));
  const lab = sprite(textTexture('ANTISCIA', '#9C6B1F', 40, 500), 0.42, 3, { opacity: 0.85 });
  lab.position.copy(planePos(90, R_OUT + 1.2, y)); g.add(lab);
  for (const p of chart.planets) {
    const r = SHELL[p.key]; if (!r || p.isPoint) continue;
    const lat = useLat ? (p.lat || 0) : 0;
    const pos = toThree(V.scale(lonLatToVec(p.lon, lat), r)); pos.y += y;
    const ghostPos = toThree(V.scale(lonLatToVec(antiscion(p.lon), lat), r)); ghostPos.y += y;
    const gh = new THREE.Mesh(new THREE.SphereGeometry(bodyRadius(p.key), 20, 12), new THREE.MeshBasicMaterial({ color: '#9C6B1F', wireframe: true, transparent: true, opacity: 0.55 }));
    gh.position.copy(ghostPos); g.add(gh);
    g.add(polyline([pos, ghostPos], lineMat('#9C6B1F', 0.5)));
    const s = sprite(planetLabelTexture({ ...p, retro: false }, '#9C6B1F', true), 0.7, 0.8, { center: new THREE.Vector2(0.5, -0.05), opacity: 0.8 });
    s.position.copy(ghostPos); g.add(s);
  }
  return g;
}

// Aspects as rods between bodies (the honest geometry), or as chords on the
// rim (the familiar wheel figure: a grand trine is a triangle again).
function aspects(list, rings, opts) {
  const g = new THREE.Group();
  const useLat = opts.latitude !== false;
  const rim = opts.aspectStyle === 'rim';
  for (const asp of list) {
    const pa = asp.a, pb = asp.b, ia = asp.ia || 0, ib = asp.ib || 0;
    let A, B;
    if (rim) { A = planePos(pa.lon, R_IN - 0.25, ia * STOREY); B = planePos(pb.lon, R_IN - 0.25, ib * STOREY); }
    else {
      A = toThree(V.scale(lonLatToVec(pa.lon, useLat ? pa.lat || 0 : 0), SHELL[pa.key] || R_HUB)); A.y += ia * STOREY;
      B = toThree(V.scale(lonLatToVec(pb.lon, useLat ? pb.lat || 0 : 0), SHELL[pb.key] || R_HUB)); B.y += ib * STOREY;
    }
    const w = 0.055 - asp.orb * 0.005;
    const c = ASPECT_COLORS[asp.type] || INK;
    g.add(rod(A, B, Math.max(0.012, w), solidMat(c, { transparent: true, opacity: 0.85 })));
  }
  return g;
}

// ------------------------------------------------------------------ main

// model: { rings: [{label, color, chart}], anchorLon, aspects: [{a,b,ia,ib,type,orb}],
//          options: { houses, sky, latitude, antiscia, aspectStyle, degrees } }
// Returns { root, pickables, frame, anchorRot }.
export function buildOrrery(model) {
  const { rings, anchorLon, options = {} } = model;
  const root = new THREE.Group();
  const base = rings[0].chart;
  const pickables = [];

  root.add(zodiacBand(0));
  let frame = null;
  if (!base.houseless && base.asc != null) {
    // Recover the frame from the chart's own RAMC/lat/eps if provided; else from asc/mc.
    frame = model.frame || null;
  }
  if (options.houses !== false) root.add(houses(base, 0));
  if (frame && options.sky !== false) root.add(sky(frame, 0));

  rings.forEach((ring, i) => {
    const s = storey(ring, i, options, base);
    root.add(s.group); pickables.push(...s.pickables);
  });
  if (model.aspects && model.aspects.length) root.add(aspects(model.aspects, rings, options));

  // Anchor: the Ascendant to the left, as on the wheel.
  const anchorRot = (180 - anchorLon) * DEG;
  root.rotation.y = anchorRot;
  const showSky = !!(frame && options.sky !== false);
  const fit = fitPoints(rings.length, showSky ? frame : null, !!options.antiscia, anchorRot);
  const fitSig = `${rings.length}|${showSky ? 1 : 0}|${options.antiscia ? 1 : 0}`;
  return { root, pickables, frame, anchorRot, fit, fitSig };
}

// World-space points that bound the model: the labelled rim of every storey,
// and, when the sky is drawn, the horizon / meridian / equator circles with
// their zenith and pole markers. The stage fits the camera to these, so a
// window of any shape shows the whole chart. Independent of planet positions,
// so the fit is stable while a ring animates.
export function fitPoints(storeys, frame, withAntiscia, anchorRot) {
  const pts = [];
  const circle = (r, y, n = 36) => {
    for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a))); }
  };
  circle(R_OUT + (withAntiscia ? 1.9 : 1.3), 0);           // rim + AC/DC/MC/IC (or ANTISCIA) labels
  for (let i = 1; i < storeys; i++) circle(R_IN + 1.1, i * STOREY); // storey rim + its name label
  if (frame) {
    const w = v => toWorld(v, anchorRot);
    const Rf = R_OUT + 1.0;
    for (const pole of [frame.zenith, frame.east, frame.pole]) {
      for (const p of greatCircle(pole, 1, 36)) pts.push(w(p).multiplyScalar(R_OUT));
    }
    pts.push(w(frame.zenith).multiplyScalar(Rf), w(frame.pole).multiplyScalar(Rf));
  }
  return pts;
}

export function disposeGroup(g) {
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    // materials & textures are cached and shared; sprite materials are not,
    // nor are the per-moment degree-label textures they may carry
    if (o.isSprite && o.material) {
      if (o.material.map && o.material.map.userData.owned) o.material.map.dispose();
      o.material.dispose();
    }
    if (o.isMesh && o.material && (o.material.wireframe || (o.material.map && !o.material.isSpriteMaterial))) o.material.dispose();
  });
}

// World-space direction of an ecliptic-frame vector after the anchor rotation.
export function toWorld(v, anchorRot) {
  return toThree(v).applyAxisAngle(Y, anchorRot).normalize();
}
