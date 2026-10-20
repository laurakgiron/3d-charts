// Castid 3D — application shell: chart-window grid, casting forms, ring
// management, time animation, persistence, and the bridge to the 3D stage.
// Ported from castid's app.js; the SVG wheel is replaced by an orrery.

import { computeChart, computeAspects, findSunrise, findSunReturn, formatLon, houseOf, sunLongitude, directedAngles, ascMc } from './ephemeris.js';
import { searchPlaces, localToUtcMs, utcToLocalParts, formatInTz, addUnit } from './geo.js';
import { buildOrrery, RING_COLORS, ASPECT_COLORS, SHELL, toThree } from './orrery.js';
import { Stage } from './stage.js';
import { skyFrame, lonLatToVec, V } from './celestial.js';
import { glyphHtml, SIGN_KEYS } from './glyphs.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MAX_PANES = 12;
const MAX_RINGS = 6;
const STORE_KEY = 'castid3d-state-v1';
const DEFAULT_VIEW = { houses: true, sky: true, latitude: true, antiscia: false, degrees: true, aspectStyle: 'bodies' };

let state = { panes: [] };
let nextId = 1;
const anims = new Map();
let stage = null;

// ---------------------------------------------------------------- persistence

function persist() {
  const slim = {
    nextId,
    panes: state.panes.map(p => ({
      id: p.id, title: p.title, aspectMode: p.aspectMode, expanded: p.expanded, sideCollapsed: p.sideCollapsed,
      view: p.view,
      rings: p.rings.map(r => ({
        name: r.name, kind: r.kind, parts: r.parts, unknown: r.unknown, unknownMode: r.unknownMode,
        sunrise: r.sunrise, place: r.place, houseSystem: r.houseSystem,
        planetSet: r.planetSet, utcMs: r.utcMs,
      })),
    })),
  };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(slim)); } catch { /* full/blocked */ }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const slim = JSON.parse(raw);
    nextId = slim.nextId || 1;
    state.panes = (slim.panes || []).map(p => {
      const rings = [];
      for (const r of p.rings) {
        const rc = { ...r };
        computeRing(rc, rings[0]);
        rings.push(rc);
      }
      return { ...p, view: { ...DEFAULT_VIEW, ...(p.view || {}) }, draft: null, rings };
    });
  } catch { state.panes = []; }
}

// ---------------------------------------------------------------- chart math

const YEAR_DAYS = 365.2425;
const normDeg = d => ((d % 360) + 360) % 360;

function computeDerived(rc, base) {
  if (!base || !base.chart) return rc;
  if (rc.utcMs == null) rc.utcMs = Date.now();
  const pMs = base.utcMs + (rc.utcMs - base.utcMs) / YEAR_DAYS;
  if (rc.kind === 'progressed') {
    rc.chart = computeChart({
      utcMs: pMs, lat: base.place.lat, lon: base.place.lon,
      houseSystem: base.houseSystem, planetSet: base.planetSet,
      houseless: true,
    });
    if (!base.chart.houseless && base.chart.asc != null) {
      const natalSun = base.chart.planets.find(p => p.key === 'sun');
      const arc = normDeg(sunLongitude(pMs) - natalSun.lon);
      const dir = directedAngles(base.chart, arc, base.place.lat, base.utcMs);
      rc.chart.asc = dir.asc; rc.chart.mc = dir.mc; rc.chart.cusps = dir.cusps;
      rc.chart.houseless = false;
      for (const p of rc.chart.planets) p.house = houseOf(p.lon, dir.cusps);
    }
  } else {
    const natalSun = base.chart.planets.find(p => p.key === 'sun');
    const arc = normDeg(sunLongitude(pMs) - natalSun.lon);
    const b = base.chart;
    rc.chart = {
      planets: b.planets.map(p => ({ ...p, lon: normDeg(p.lon + arc), retro: false, house: null })),
      asc: b.asc == null ? null : normDeg(b.asc + arc),
      mc: b.mc == null ? null : normDeg(b.mc + arc),
      cusps: b.cusps ? b.cusps.map(c => normDeg(c + arc)) : null,
      houseless: b.houseless, houseSystem: b.houseSystem, notes: [], utcMs: pMs,
    };
  }
  return rc;
}

function computeRing(rc, base) {
  if (rc.kind === 'progressed' || rc.kind === 'solararc') return computeDerived(rc, base);
  const { place } = rc;
  if (rc.utcMs == null) {
    if (rc.unknown && rc.unknownMode === 'sunrise') {
      const midnight = localToUtcMs({ ...rc.parts, h: 0, mi: 0, s: 0 }, place.tz);
      const rise = findSunrise(midnight, place.lat, place.lon);
      if (rise != null) { rc.utcMs = rise; rc.sunrise = true; }
      else { rc.utcMs = localToUtcMs({ ...rc.parts, h: 12, mi: 0, s: 0 }, place.tz); rc.sunrise = false; }
    } else if (rc.unknown) {
      rc.utcMs = localToUtcMs({ ...rc.parts, h: 12, mi: 0, s: 0 }, place.tz);
    } else {
      rc.utcMs = localToUtcMs(rc.parts, place.tz);
    }
  }
  const houseless = rc.unknown && !(rc.sunrise);
  rc.chart = computeChart({
    utcMs: rc.utcMs, lat: place.lat, lon: place.lon,
    houseSystem: rc.houseSystem, planetSet: rc.planetSet, houseless,
  });
  return rc;
}

// ------------------------------------------------------------------- helpers

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function nowPartsFor(tz) {
  return utcToLocalParts(Date.now(), tz || Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function placeLabel(pl) {
  if (!pl) return '';
  return [pl.name, pl.admin, pl.country].filter(Boolean).join(', ');
}

function fmtLat(lat) {
  if (lat == null) return '';
  const a = Math.abs(lat), d = Math.floor(a), m = Math.round((a - d) * 60);
  return `${lat < 0 ? '−' : '+'}${d}°${String(m).padStart(2, '0')}′`;
}

// ------------------------------------------------------------------- render

function render() {
  const root = $('#panes');
  // The side panel scrolls on its own when it sits beside the scene; keep each
  // window's scroll position across the rebuild (e.g. pressing STOP).
  const sideScroll = new Map();
  root.querySelectorAll('.pane').forEach(el => {
    const side = $('.side', el);
    if (side && side.scrollTop) sideScroll.set(el.dataset.id, side.scrollTop);
  });
  root.className = 'panes n' + Math.min(state.panes.length, MAX_PANES);
  root.innerHTML = '';
  state.panes.forEach((pane, idx) => root.appendChild(renderPane(pane, idx)));
  for (const [id, top] of sideScroll) {
    const side = $(`.pane[data-id="${id}"] .side`, root);
    if (side) side.scrollTop = top;
  }
  const addBtn = $('#add-pane');
  addBtn.style.display = state.panes.some(p => p.rings.length) ? '' : 'none';
  addBtn.disabled = state.panes.length >= MAX_PANES;
  $('#empty-hint').style.display = state.panes.length ? 'none' : 'block';
  // Bind 3D views to the freshly built DOM; drop views of closed windows.
  const live = new Set();
  for (const pane of state.panes) {
    if (!pane.rings.length || pane.draft) continue;
    const box = $(`.pane[data-id="${pane.id}"] .scene-box`);
    if (!box) continue;
    live.add(pane.id);
    stage.mount(pane.id, box);
    stage.setRoot(pane.id, buildOrrery(sceneModel(pane)));
  }
  for (const id of [...stage.views.keys()]) if (!live.has(id)) stage.unmount(id);
}

function renderPane(pane, idx) {
  const el = document.createElement('section');
  el.className = 'pane' + (pane.expanded ? ' expanded' : '');
  el.dataset.id = pane.id;
  const title = pane.title || (pane.rings[0] ? pane.rings[0].name : 'UNCAST');
  el.innerHTML = `
    <header class="pane-head">
      <span class="pane-idx">CHART · ${ROMAN[idx] || idx + 1}</span>
      <span class="pane-title">${esc(title)}</span>
      <span class="pane-actions">
        ${pane.rings.length && !pane.draft ? `<button data-act="panel" title="${pane.sideCollapsed ? 'show the side panel' : 'hide the side panel — full view'}">${pane.sideCollapsed ? '◧' : '◨'}</button>` : ''}
        <button data-act="expand" title="expand / contract">${pane.expanded ? '⊟' : '⊞'}</button>
        <button data-act="dup" title="duplicate this chart window">⧉</button>
        <button data-act="close" title="close this chart window">✕</button>
      </span>
    </header>
    <div class="pane-body"></div>`;
  const body = $('.pane-body', el);
  if (pane.draft) { body.classList.add('form'); body.appendChild(renderForm(pane)); }
  else if (pane.rings.length) body.appendChild(renderSceneView(pane));
  else { pane.draft = newDraft(pane); body.classList.add('form'); body.appendChild(renderForm(pane)); }

  $('.pane-actions', el).addEventListener('click', e => {
    const act = e.target.dataset.act;
    if (!act) return;
    if (act === 'close') {
      if (pane.rings.length && !confirm('Close this chart window?')) return;
      stopAnim(pane.id);
      state.panes = state.panes.filter(p => p.id !== pane.id);
      if (!state.panes.length) state.panes.push(blankPane());
    } else if (act === 'dup') {
      if (state.panes.length >= MAX_PANES) return;
      const ringsCopy = [];
      for (const r of pane.rings) {
        const rc = JSON.parse(JSON.stringify({
          name: r.name, kind: r.kind, parts: r.parts, unknown: r.unknown, unknownMode: r.unknownMode,
          sunrise: r.sunrise, place: r.place, houseSystem: r.houseSystem,
          planetSet: r.planetSet, utcMs: r.utcMs,
        }));
        computeRing(rc, ringsCopy[0]);
        ringsCopy.push(rc);
      }
      state.panes.splice(idx + 1, 0, {
        id: nextId++, title: pane.title, aspectMode: pane.aspectMode, expanded: false, draft: null,
        view: { ...pane.view }, rings: ringsCopy,
      });
    } else if (act === 'expand') {
      pane.expanded = !pane.expanded;
    } else if (act === 'panel') {
      pane.sideCollapsed = !pane.sideCollapsed;
    }
    persist(); render();
    if (act === 'expand' && pane.expanded) {
      setTimeout(() => {
        const el = document.querySelector(`.pane[data-id="${pane.id}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 30);
    }
  });
  return el;
}

function blankPane() {
  return { id: nextId++, rings: [], aspectMode: 'in:0', expanded: false, draft: null, view: { ...DEFAULT_VIEW } };
}

function newDraft(pane, prefill) {
  const base = pane.rings[0];
  const tz = prefill?.place?.tz || base?.place?.tz;
  const now = nowPartsFor(tz);
  return {
    editIndex: prefill?.editIndex ?? null,
    name: prefill?.name || '',
    parts: prefill?.parts || { y: now.y, mo: now.mo, d: now.d, h: now.h, mi: now.mi, s: 0 },
    unknown: prefill?.unknown || false,
    unknownMode: prefill?.unknownMode || 'noon',
    place: prefill?.place || base?.place || null,
    houseSystem: prefill?.houseSystem || base?.houseSystem || 'placidus',
    planetSet: prefill?.planetSet || base?.planetSet || 'modern',
    results: [],
  };
}

function renderForm(pane) {
  const d = pane.draft;
  const wrap = document.createElement('div');
  wrap.className = 'cast-form';
  const pad = n => String(n).padStart(2, '0');
  const dateVal = `${String(d.parts.y).padStart(4, '0')}-${pad(d.parts.mo)}-${pad(d.parts.d)}`;
  const timeVal = `${pad(d.parts.h)}:${pad(d.parts.mi)}:${pad(d.parts.s || 0)}`;
  const editing = d.editIndex != null;
  const isNewRing = !editing && pane.rings.length > 0;
  wrap.innerHTML = `
    <div class="form-title">${editing ? 'EDIT RING' : isNewRing ? 'ADD RING' : 'CAST A CHART'}</div>
    <label class="f-label">NAME
      <input type="text" id="f-name" value="${esc(d.name)}" placeholder="e.g. Hypatia · Natal" autocomplete="off" />
    </label>
    <div class="f-row">
      <label class="f-label">DATE <input type="date" id="f-date" value="${dateVal}" /></label>
      <label class="f-label ${d.unknown ? 'f-dim' : ''}">TIME (LOCAL)
        <input type="time" id="f-time" step="1" value="${timeVal}" ${d.unknown ? 'disabled' : ''} />
      </label>
    </div>
    <div class="f-row">
      <label class="f-check"><input type="checkbox" id="f-unknown" ${d.unknown ? 'checked' : ''} /> UNKNOWN TIME</label>
      <label class="f-label" id="f-unkmode-wrap" style="${d.unknown ? '' : 'display:none'}">CAST AS
        <select id="f-unkmode">
          <option value="noon" ${d.unknownMode === 'noon' ? 'selected' : ''}>NOON · NO HOUSES</option>
          <option value="sunrise" ${d.unknownMode === 'sunrise' ? 'selected' : ''}>SUNRISE CHART</option>
        </select>
      </label>
    </div>
    <label class="f-label">LOCATION
      <input type="text" id="f-loc" placeholder="search a city…" autocomplete="off"
        value="${esc(d.place ? placeLabel(d.place) : '')}" />
      <div class="loc-results" id="f-loc-results"></div>
      <div class="loc-chosen" id="f-loc-chosen">${d.place ? locChosenText(d.place) : ''}</div>
    </label>
    <div class="f-row">
      <label class="f-label">HOUSES
        <select id="f-houses">
          <option value="placidus" ${d.houseSystem === 'placidus' ? 'selected' : ''}>PLACIDUS</option>
          <option value="whole" ${d.houseSystem === 'whole' ? 'selected' : ''}>WHOLE SIGN</option>
        </select>
      </label>
      <label class="f-label">PLANETS
        <select id="f-planets">
          <option value="traditional" ${d.planetSet === 'traditional' ? 'selected' : ''}>TRADITIONAL · VII</option>
          <option value="modern" ${d.planetSet === 'modern' ? 'selected' : ''}>MODERN · X</option>
        </select>
      </label>
    </div>
    <div class="f-actions">
      <button class="btn-solid btn-block" id="f-cast">${editing ? 'RECAST' : 'CAST'}</button>
      ${(!editing && !isNewRing) ? '<button class="btn-ghost btn-block" id="f-spread" title="cast this chart, its solar return, and one window for each of the twelve monthly revolutions of the current solar year">CAST A YEAR OF REVOLUTIONS · XII</button>' : ''}
      ${(isNewRing || editing) ? '<button class="btn-ghost btn-block" id="f-cancel">CANCEL</button>' : ''}
    </div>
    <div class="f-error" id="f-error"></div>`;

  const readParts = () => {
    const [y, mo, day] = ($('#f-date', wrap).value || dateVal).split('-').map(Number);
    const t = ($('#f-time', wrap).value || '12:00:00').split(':').map(Number);
    return { y, mo, d: day, h: t[0] || 0, mi: t[1] || 0, s: t[2] || 0 };
  };

  $('#f-unknown', wrap).addEventListener('change', e => {
    d.unknown = e.target.checked;
    d.parts = readParts(); d.name = $('#f-name', wrap).value;
    pane.draft = d; render();
  });
  $('#f-unkmode', wrap).addEventListener('change', e => { d.unknownMode = e.target.value; });
  $('#f-houses', wrap).addEventListener('change', e => { d.houseSystem = e.target.value; });
  $('#f-planets', wrap).addEventListener('change', e => { d.planetSet = e.target.value; });
  $('#f-name', wrap).addEventListener('input', e => { d.name = e.target.value; });

  const resultsEl = $('#f-loc-results', wrap);
  const doSearch = debounce(async q => {
    if (q.trim().length < 2) { resultsEl.innerHTML = ''; return; }
    try {
      const places = await searchPlaces(q);
      resultsEl.innerHTML = places.map((pl, i) =>
        `<button class="loc-opt" data-i="${i}">${esc(placeLabel(pl))} <span class="loc-tz">${esc(pl.tz)}</span></button>`).join('');
      resultsEl._places = places;
    } catch {
      resultsEl.innerHTML = '<div class="loc-err">search unavailable — check connection</div>';
    }
  }, 350);
  $('#f-loc', wrap).addEventListener('input', e => doSearch(e.target.value));
  resultsEl.addEventListener('click', e => {
    const btn = e.target.closest('.loc-opt');
    if (!btn) return;
    d.place = resultsEl._places[+btn.dataset.i];
    $('#f-loc', wrap).value = placeLabel(d.place);
    $('#f-loc-chosen', wrap).innerHTML = locChosenText(d.place);
    resultsEl.innerHTML = '';
  });

  const cancelBtn = $('#f-cancel', wrap);
  if (cancelBtn) cancelBtn.addEventListener('click', () => { pane.draft = null; render(); });

  $('#f-cast', wrap).addEventListener('click', () => {
    d.parts = readParts(); d.name = $('#f-name', wrap).value;
    if (!d.place) { $('#f-error', wrap).textContent = 'CHOOSE A LOCATION FIRST'; return; }
    if (!d.parts.y || !d.parts.mo || !d.parts.d) { $('#f-error', wrap).textContent = 'DATE IS INCOMPLETE'; return; }
    const rc = {
      name: d.name.trim() || (pane.rings.length ? `Ring ${pane.rings.length + 1}` : 'Untitled'),
      parts: d.parts, unknown: d.unknown, unknownMode: d.unknownMode, sunrise: false,
      place: d.place, houseSystem: d.houseSystem, planetSet: d.planetSet, utcMs: null,
    };
    try { computeRing(rc); } catch (err) {
      $('#f-error', wrap).textContent = 'COULD NOT CAST — ' + String(err.message || err).toUpperCase();
      return;
    }
    stopAnim(pane.id);
    if (d.editIndex != null) pane.rings[d.editIndex] = rc;
    else pane.rings.push(rc);
    if (d.editIndex === 0) {
      for (let i = 1; i < pane.rings.length; i++) {
        const r = pane.rings[i];
        if (r.kind === 'progressed' || r.kind === 'solararc') computeDerived(r, rc);
      }
    }
    pane.draft = null;
    if (!pane.aspectMode) pane.aspectMode = 'in:0';
    persist(); render();
  });

  const spreadBtn = $('#f-spread', wrap);
  if (spreadBtn) spreadBtn.addEventListener('click', () => {
    d.parts = readParts(); d.name = $('#f-name', wrap).value;
    if (!d.place) { $('#f-error', wrap).textContent = 'CHOOSE A LOCATION FIRST'; return; }
    if (!d.parts.y || !d.parts.mo || !d.parts.d) { $('#f-error', wrap).textContent = 'DATE IS INCOMPLETE'; return; }
    const baseName = d.name.trim() || 'Untitled';
    const natalProto = {
      name: baseName, parts: d.parts, unknown: d.unknown, unknownMode: d.unknownMode, sunrise: false,
      place: d.place, houseSystem: d.houseSystem, planetSet: d.planetSet, utcMs: null,
    };
    let natal0;
    try { natal0 = computeRing(JSON.parse(JSON.stringify(natalProto))); } catch (err) {
      $('#f-error', wrap).textContent = 'COULD NOT CAST — ' + String(err.message || err).toUpperCase();
      return;
    }
    const natalSun = natal0.chart.planets.find(p => p.key === 'sun').lon;
    const sr = findSunReturn(natalSun, Date.now() - 370 * 86400e3, 375);
    if (sr == null) { $('#f-error', wrap).textContent = 'COULD NOT FIND THE SOLAR RETURN'; return; }
    const moments = [sr];
    for (let k = 1; k < 12; k++) {
      const m = findSunReturn(normDeg(natalSun + 30 * k), moments[k - 1] + 86400e3, 45);
      if (m == null) { $('#f-error', wrap).textContent = 'COULD NOT COMPUTE ALL XII REVOLUTIONS'; return; }
      moments.push(m);
    }
    const mkRadixRing = (name, ms) => computeRing({
      name, parts: utcToLocalParts(ms, d.place.tz), unknown: false, unknownMode: 'noon',
      sunrise: false, place: d.place, houseSystem: d.houseSystem, planetSet: d.planetSet, utcMs: ms,
    });
    const srYear = utcToLocalParts(sr, d.place.tz).y;
    stopAnim(pane.id);
    const newPanes = moments.map(ms => {
      const rings = [computeRing(JSON.parse(JSON.stringify(natalProto)))];
      rings.push(mkRadixRing(`SR ${srYear}`, sr));
      if (Math.abs(ms - sr) > 60e3) rings.push(mkRadixRing('Monthly Rev', ms));
      const momentRing = rings[rings.length - 1];
      const f = formatLon(momentRing.chart.planets.find(p => p.key === 'sun').lon);
      const lp = utcToLocalParts(ms, d.place.tz);
      const title = `${baseName} · ${MONTHS[lp.mo - 1]} ${lp.d} · ${f.sign.glyph}${f.deg}° · ${lp.y}`;
      return { id: nextId++, title, aspectMode: 'in:0', expanded: false, draft: null, view: { ...pane.view }, rings };
    });
    pane.rings = newPanes[0].rings;
    pane.title = newPanes[0].title;
    pane.aspectMode = 'in:0';
    pane.draft = null;
    const idx = state.panes.indexOf(pane);
    state.panes.splice(idx + 1, 0, ...newPanes.slice(1));
    persist(); render();
  });
  return wrap;
}

function locChosenText(pl) {
  const ns = pl.lat >= 0 ? 'N' : 'S', ew = pl.lon >= 0 ? 'E' : 'W';
  return `${Math.abs(pl.lat).toFixed(2)}° ${ns} · ${Math.abs(pl.lon).toFixed(2)}° ${ew} · ${esc(pl.tz)}`;
}

// ---------------------------------------------------------------- 3D view

function sceneModel(pane) {
  const rings = pane.rings.map((rc, i) => ({ label: rc.name, color: RING_COLORS[i], chart: rc.chart }));
  const base = pane.rings[0];
  const anchorLon = base.chart.houseless ? 0 : base.chart.asc;
  let aspects = [];
  const m = pane.aspectMode || 'in:0';
  if (m.startsWith('in:')) {
    const i = +m.slice(3);
    if (rings[i]) aspects = computeAspects(rings[i].chart.planets).map(a => ({ ...a, ia: i, ib: i }));
  } else if (m.startsWith('x:')) {
    const [, a, b] = m.split(':').map(Number);
    if (rings[a] && rings[b]) aspects = computeAspects(rings[a].chart.planets, rings[b].chart.planets).map(x => ({ ...x, ia: a, ib: b }));
  }
  let frame = null;
  if (!base.chart.houseless && base.chart.asc != null) {
    const { ramc, eps } = ascMc(base.utcMs, base.place.lat, base.place.lon);
    frame = skyFrame(ramc, base.place.lat, eps);
    if (base.kind) frame = null; // derived rings never sit at the base
  }
  return { rings, anchorLon, aspects, frame, options: pane.view || DEFAULT_VIEW };
}

const PRESETS = [['oblique', 'OBLIQUE'], ['above', 'ABOVE · WHEEL'], ['edge', 'EDGE'], ['sky', 'STAND UNDER THE SKY']];

function renderSceneView(pane) {
  const wrap = document.createElement('div');
  wrap.className = 'wheel-wrap' + (pane.sideCollapsed ? ' nosides' : '');
  const anim = anims.get(pane.id);
  const animRing = anim ? anim.ringIdx : pane.rings.length - 1;
  const hasSky = !pane.rings[0].chart.houseless;
  const ringChips = pane.rings.map((rc, i) => `
    <div class="ring-chip" style="--rc:${RING_COLORS[i]}">
      <span class="ring-dot"></span>
      <span class="ring-name">${esc(rc.name)}</span>
      <span class="ring-when">${formatInTz(rc.utcMs, rc.place.tz, false)}${rc.kind === 'progressed' ? ' · PROGRESSED' : rc.kind === 'solararc' ? ' · SOLAR ARC' : rc.unknown ? (rc.sunrise ? ' · SUNRISE' : ' · NOON, NO HOUSES') : ''}</span>
      <span class="ring-acts">
        ${(!rc.kind || rc.kind === 'radix') ? `<button data-act="edit" data-i="${i}" title="edit">✎</button>` : ''}
        ${i > 0 ? `<button data-act="del" data-i="${i}" title="remove ring">✕</button>` : ''}
      </span>
    </div>`).join('');

  const aspectOpts = [`<option value="off" ${pane.aspectMode === 'off' ? 'selected' : ''}>OFF</option>`];
  pane.rings.forEach((rc, i) => {
    aspectOpts.push(`<option value="in:${i}" ${pane.aspectMode === 'in:' + i ? 'selected' : ''}>WITHIN · ${esc(rc.name.toUpperCase())}</option>`);
  });
  for (let k = 1; k < pane.rings.length; k++) {
    aspectOpts.push(`<option value="x:0:${k}" ${pane.aspectMode === `x:0:${k}` ? 'selected' : ''}>${esc(pane.rings[0].name.toUpperCase())} × ${esc(pane.rings[k].name.toUpperCase())}</option>`);
  }
  const ringSel = pane.rings.map((rc, i) =>
    `<option value="${i}" ${i === animRing ? 'selected' : ''}>${esc(rc.name.toUpperCase())}</option>`).join('');
  const notes = pane.rings.flatMap(rc => rc.chart.notes.map(n => `${rc.name}: ${n}`));
  const v = pane.view;
  const tog = (k, label, dis = false) => `<label><input type="checkbox" data-view="${k}" ${v[k] ? 'checked' : ''} ${dis ? 'disabled' : ''}/> ${label}</label>`;
  const legend = Object.entries(ASPECT_COLORS).map(([k, c]) => `<span style="--lc:${c}">${k.toUpperCase()}</span>`).join('');

  wrap.innerHTML = `
    <div class="scene-box">
      <div class="view-bar">
        ${PRESETS.map(([k, l]) => `<button class="btn-ghost" data-preset="${k}" ${k === 'sky' && !hasSky ? 'disabled' : ''}>${l}</button>`).join('')}
      </div>
      <div class="hud"></div>
    </div>
    <aside class="side">
      <div class="side-sec">
        <div class="side-label">RINGS · ${pane.rings.length} OF ${MAX_RINGS}</div>
        ${ringChips}
        <div class="ring-add">
          <button class="btn-ghost" data-act="addring" ${pane.rings.length >= MAX_RINGS ? 'disabled' : ''}>+ ADD RING</button>
          <button class="btn-ghost" data-act="transits" ${pane.rings.length >= MAX_RINGS ? 'disabled' : ''}>TRANSITS NOW</button>
          <button class="btn-ghost" data-act="progressed" ${pane.rings.length >= MAX_RINGS ? 'disabled' : ''}>PROGRESSED</button>
          <button class="btn-ghost" data-act="solararc" ${pane.rings.length >= MAX_RINGS ? 'disabled' : ''}>SOLAR ARC</button>
        </div>
      </div>
      <div class="side-sec">
        <div class="side-label">SHOW</div>
        <div class="toggles">
          ${tog('sky', 'HORIZON · MERIDIAN', !hasSky)}
          ${tog('houses', 'HOUSE CUSPS', !hasSky)}
          ${tog('latitude', 'TRUE LATITUDE')}
          ${tog('degrees', 'DEGREE LABELS')}
          ${tog('antiscia', 'ANTISCIA')}
        </div>
      </div>
      <div class="side-sec">
        <div class="side-label">ASPECTS</div>
        <select id="aspect-mode">${aspectOpts.join('')}</select>
        <div class="toggles" style="margin-top:8px">
          <select data-view="aspectStyle">
            <option value="bodies" ${v.aspectStyle === 'bodies' ? 'selected' : ''}>RODS BETWEEN BODIES</option>
            <option value="rim" ${v.aspectStyle === 'rim' ? 'selected' : ''}>CHORDS ON THE RIM</option>
          </select>
        </div>
        <div class="legend" style="margin-top:8px">${legend}</div>
      </div>
      <div class="side-sec">
        <div class="side-label">ANIMATE</div>
        <div class="anim-row">
          <select id="anim-ring">${ringSel}</select>
          <select id="anim-unit">
            ${['second', 'minute', 'hour', 'day', 'week', 'month', 'year'].map(u =>
              `<option value="${u}" ${(anim?.unit || 'day') === u ? 'selected' : ''}>${u.toUpperCase()}S</option>`).join('')}
          </select>
          <input type="number" id="anim-mult" value="${anim?.mult || 1}" min="1" max="999" title="step size" />
        </div>
        <div class="anim-row">
          <button class="btn-ghost" data-act="stepback" title="step back">−1</button>
          <button class="btn-ghost" data-act="stepfwd" title="step forward">+1</button>
          <button class="btn-ghost" data-act="playback" title="play backward">◂◂</button>
          <button class="btn-solid" data-act="play">${anim ? 'STOP' : 'PLAY ▸'}</button>
        </div>
        <div class="anim-row">
          <input type="datetime-local" id="anim-goto" step="1" value="${gotoValue(pane, animRing)}" title="jump the selected ring to an exact moment (its local time)" />
          <button class="btn-ghost" data-act="goto">GO</button>
        </div>
        <div class="anim-readout" id="anim-readout">${animReadout(pane, animRing)}</div>
      </div>
      <div class="side-sec tables">${dataTables(pane)}</div>
      <div class="side-sec"><button class="btn-ghost export" data-act="export" title="download this window's geometry as JSON (for Blender via blender/castid_orrery.py)">EXPORT · SCENE JSON</button></div>
      ${notes.length ? `<div class="side-sec notes">${notes.map(esc).join('<br>')}</div>` : ''}
    </aside>`;

  const liveAnim = anims.get(pane.id);
  if (liveAnim) liveAnim.wrap = wrap;

  // The orbit controls capture the pointer on the scene box; keep presses on
  // the overlay buttons from reaching them so the click lands on the button.
  $('.view-bar', wrap).addEventListener('pointerdown', e => e.stopPropagation());

  wrap.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.preset) {
      stage.preset(pane.id, btn.dataset.preset);
      wrap.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('on', b === btn));
      return;
    }
    const act = btn.dataset.act;
    if (act === 'edit') {
      const i = +btn.dataset.i;
      stopAnim(pane.id);
      pane.draft = newDraft(pane, { ...pane.rings[i], editIndex: i });
      render();
    } else if (act === 'del') {
      stopAnim(pane.id);
      pane.rings.splice(+btn.dataset.i, 1);
      pane.aspectMode = 'in:0';
      persist(); render();
    } else if (act === 'addring') {
      stopAnim(pane.id);
      pane.draft = newDraft(pane);
      render();
    } else if (act === 'transits') {
      const base = pane.rings[0];
      const rc = {
        name: 'Transits', parts: nowPartsFor(base.place.tz), unknown: false, unknownMode: 'noon',
        sunrise: false, place: base.place, houseSystem: base.houseSystem,
        planetSet: base.planetSet, utcMs: null,
      };
      computeRing(rc);
      pane.rings.push(rc);
      persist(); render();
    } else if (act === 'progressed' || act === 'solararc') {
      const base = pane.rings[0];
      const rc = {
        name: act === 'progressed' ? 'Progressed' : 'Solar Arc', kind: act,
        parts: nowPartsFor(base.place.tz), unknown: false, unknownMode: 'noon', sunrise: false,
        place: base.place, houseSystem: base.houseSystem, planetSet: base.planetSet,
        utcMs: Date.now(),
      };
      computeRing(rc, base);
      pane.rings.push(rc);
      persist(); render();
    } else if (act === 'goto') {
      const idx = +($('#anim-ring', wrap)?.value ?? pane.rings.length - 1);
      const rc = pane.rings[idx];
      const val = $('#anim-goto', wrap).value;
      if (!rc || !val) return;
      const [ds, ts] = val.split('T');
      const [y, mo, day] = ds.split('-').map(Number);
      const t = (ts || '00:00:00').split(':').map(Number);
      rc.utcMs = localToUtcMs({ y, mo, d: day, h: t[0] || 0, mi: t[1] || 0, s: t[2] || 0 }, rc.place.tz);
      rc.parts = utcToLocalParts(rc.utcMs, rc.place.tz);
      computeRingInPlace(pane, rc);
      refreshSceneOnly(pane, wrap);
      persist();
    } else if (act === 'play') {
      if (anims.get(pane.id)) stopAnim(pane.id, pane); else startAnim(pane, wrap, +1);
    } else if (act === 'playback') {
      stopAnim(pane.id);
      startAnim(pane, wrap, -1);
    } else if (act === 'stepfwd' || act === 'stepback') {
      stepRing(pane, wrap, act === 'stepfwd' ? 1 : -1);
    } else if (act === 'export') {
      exportScene(pane);
    }
  });

  $('#aspect-mode', wrap).addEventListener('change', e => {
    pane.aspectMode = e.target.value;
    persist();
    stage.setRoot(pane.id, buildOrrery(sceneModel(pane)));
  });
  wrap.querySelectorAll('[data-view]').forEach(inp => inp.addEventListener('change', e => {
    const k = e.target.dataset.view;
    pane.view[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    persist();
    stage.setRoot(pane.id, buildOrrery(sceneModel(pane)));
  }));
  $('#anim-ring', wrap).addEventListener('change', e => {
    const a = anims.get(pane.id);
    if (a) a.ringIdx = +e.target.value;
    $('#anim-readout', wrap).textContent = animReadout(pane, +e.target.value);
    $('#anim-goto', wrap).value = gotoValue(pane, +e.target.value);
  });
  $('#anim-unit', wrap).addEventListener('change', e => { const a = anims.get(pane.id); if (a) a.unit = e.target.value; });
  $('#anim-mult', wrap).addEventListener('change', e => { const a = anims.get(pane.id); if (a) a.mult = Math.max(1, +e.target.value || 1); });
  const firstPreset = wrap.querySelector(`[data-preset="${stage.views.get(pane.id)?.presetName || 'oblique'}"]`);
  if (firstPreset) firstPreset.classList.add('on');
  return wrap;
}

function hudHtml(info) {
  if (!info) return '';
  const f = formatLon(info.lon);
  const line1 = `<b>${esc(info.name.toUpperCase())}</b> · ${f.deg}° ${glyphHtml(SIGN_KEYS[f.signIndex], 11)} ${String(f.min).padStart(2, '0')}′${info.retro ? ' ℞' : ''}`;
  const bits = [];
  if (info.house) bits.push(`HOUSE ${ROMAN[info.house - 1]}`);
  if (info.key !== 'node' && info.key !== 'snode') bits.push(`LAT ${fmtLat(info.lat)}`);
  bits.push(esc(info.ringName.toUpperCase()));
  return `${line1}<span class="hud-sub">${bits.join(' · ')}</span>`;
}

function gotoValue(pane, ringIdx) {
  const rc = pane.rings[ringIdx];
  if (!rc) return '';
  const p = utcToLocalParts(rc.utcMs, rc.place.tz);
  const pad = n => String(n).padStart(2, '0');
  return `${String(p.y).padStart(4, '0')}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

function animReadout(pane, ringIdx) {
  const rc = pane.rings[ringIdx];
  if (!rc) return '';
  return `${rc.name.toUpperCase()} · ${formatInTz(rc.utcMs, rc.place.tz)} (${rc.place.tz})`;
}

const PHASE_NAMES = ['NEW MOON', 'WAXING CRESCENT', 'FIRST QUARTER', 'WAXING GIBBOUS',
  'FULL MOON', 'WANING GIBBOUS', 'LAST QUARTER', 'WANING CRESCENT'];

function moonBadge(chart, color) {
  const sun = chart.planets.find(p => p.key === 'sun');
  const moon = chart.planets.find(p => p.key === 'moon');
  if (!sun || !moon) return '';
  const angle = normDeg(moon.lon - sun.lon);
  const k = Math.cos(angle * Math.PI / 180);
  const pct = Math.round((1 - k) / 2 * 100);
  const name = PHASE_NAMES[Math.floor(((angle + 22.5) % 360) / 45)];
  const r = 6, c = 7, rx = (Math.abs(k) * r).toFixed(2);
  const d = angle < 180
    ? `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${rx} ${r} 0 0 ${k > 0 ? 0 : 1} ${c} ${c - r} Z`
    : `M ${c} ${c - r} A ${r} ${r} 0 0 0 ${c} ${c + r} A ${rx} ${r} 0 0 ${k > 0 ? 1 : 0} ${c} ${c - r} Z`;
  return `<span class="moonbadge" title="${name} · ${pct}% ILLUMINATED">
    <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="1"/><path d="${d}" fill="${color}"/></svg>
    <span>${pct}%</span></span>`;
}

function lonHtml(f) {
  return `${f.deg}° ${glyphHtml(SIGN_KEYS[f.signIndex], 11)} ${String(f.min).padStart(2, '0')}′`;
}

function dataTables(pane) {
  const baseCusps = pane.rings[0].chart.cusps;
  return pane.rings.map((rc, i) => {
    const rows = rc.chart.planets.map(p => {
      const f = formatLon(p.lon);
      const house = baseCusps ? (i === 0 ? p.house ?? houseOf(p.lon, baseCusps) : houseOf(p.lon, baseCusps)) : null;
      return `<tr><td class="t-glyph" style="color:${RING_COLORS[i]}">${glyphHtml(p.key, 13) || p.glyph}</td>
        <td>${p.name.toUpperCase()}${p.key === 'moon' ? moonBadge(rc.chart, RING_COLORS[i]) : ''}</td><td class="t-lon">${lonHtml(f)}</td>
        <td class="t-lat" title="ecliptic latitude">${p.isPoint ? '' : fmtLat(p.lat)}</td>
        <td class="t-house">${house ? ROMAN[house - 1] : '—'}</td>
        <td class="t-rx">${p.retro ? '℞' : ''}</td></tr>`;
    }).join('');
    const ang = (!rc.chart.houseless && rc.chart.asc != null)
      ? `<tr><td class="t-glyph" style="color:${RING_COLORS[i]}">AC</td><td>ASCENDANT</td><td class="t-lon">${lonHtml(formatLon(rc.chart.asc))}</td><td></td><td class="t-house">${baseCusps ? ROMAN[houseOf(rc.chart.asc, baseCusps) - 1] : '—'}</td><td></td></tr>
         <tr><td class="t-glyph" style="color:${RING_COLORS[i]}">MC</td><td>MIDHEAVEN</td><td class="t-lon">${lonHtml(formatLon(rc.chart.mc))}</td><td></td><td class="t-house">${baseCusps ? ROMAN[houseOf(rc.chart.mc, baseCusps) - 1] : '—'}</td><td></td></tr>`
      : '';
    return `<details ${i === 0 ? 'open' : ''}><summary style="color:${RING_COLORS[i]}">${esc(rc.name.toUpperCase())}</summary>
      <table class="postable"><tbody>${rows}${ang}</tbody></table></details>`;
  }).join('');
}

// ------------------------------------------------------------------ export

// Geometry of one window as plain JSON (world units match the web scene:
// zodiac rim at radius 10, storeys 2.2 apart, ecliptic frame x→0°♈, z→pole).
function exportScene(pane) {
  const model = sceneModel(pane);
  const out = {
    app: 'castid-3d', version: 1, title: pane.title || pane.rings[0].name,
    frame: model.frame ? { zenith: model.frame.zenith, east: model.frame.east, north: model.frame.north, pole: model.frame.pole, asc: model.frame.asc, mc: model.frame.mc } : null,
    anchorLon: model.anchorLon,
    rings: pane.rings.map((rc, i) => ({
      name: rc.name, kind: rc.kind || 'radix', color: RING_COLORS[i], storey: i,
      when: formatInTz(rc.utcMs, rc.place.tz), tz: rc.place.tz, place: rc.place,
      asc: rc.chart.asc, mc: rc.chart.mc, cusps: rc.chart.cusps,
      planets: rc.chart.planets.map(p => ({
        key: p.key, name: p.name, lon: p.lon, lat: p.lat || 0, retro: !!p.retro, house: p.house ?? null,
        shell: SHELL[p.key] || null, xyz: V.scale(lonLatToVec(p.lon, p.lat || 0), SHELL[p.key] || 1),
      })),
    })),
    aspects: model.aspects.map(a => ({ a: a.a.key, b: a.b.key, ringA: a.ia, ringB: a.ib, type: a.type, orb: a.orb })),
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${(out.title || 'chart').replace(/[^\w\-]+/g, '_')}.castid3d.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- animation

function refreshSceneOnly(pane, wrap) {
  stage.setRoot(pane.id, buildOrrery(sceneModel(pane)));
  const ringSel = $('#anim-ring', wrap);
  const idx = ringSel ? +ringSel.value : pane.rings.length - 1;
  $('#anim-readout', wrap).textContent = animReadout(pane, idx);
  $('.tables', wrap).innerHTML = dataTables(pane);
}

function stepRing(pane, wrap, dir) {
  const ringSel = $('#anim-ring', wrap);
  const idx = ringSel ? +ringSel.value : pane.rings.length - 1;
  const unit = $('#anim-unit', wrap).value;
  const mult = Math.max(1, +$('#anim-mult', wrap).value || 1);
  const rc = pane.rings[idx];
  rc.utcMs = addUnit(rc.utcMs, unit, dir * mult, rc.place.tz);
  rc.parts = utcToLocalParts(rc.utcMs, rc.place.tz);
  computeRingInPlace(pane, rc);
  refreshSceneOnly(pane, wrap);
  persist();
}

function computeRingInPlace(pane, rc) {
  if (rc.kind === 'progressed' || rc.kind === 'solararc') { computeDerived(rc, pane.rings[0]); return; }
  const houseless = rc.unknown && !rc.sunrise;
  rc.chart = computeChart({
    utcMs: rc.utcMs, lat: rc.place.lat, lon: rc.place.lon,
    houseSystem: rc.houseSystem, planetSet: rc.planetSet, houseless,
  });
}

function startAnim(pane, wrap, dir) {
  const idx = +($('#anim-ring', wrap)?.value ?? pane.rings.length - 1);
  const unit = $('#anim-unit', wrap).value;
  const mult = Math.max(1, +$('#anim-mult', wrap).value || 1);
  const a = { ringIdx: idx, unit, mult, dir, lastPersist: 0, wrap };
  a.timer = setInterval(() => {
    const rc = pane.rings[a.ringIdx];
    if (!rc) { stopAnim(pane.id); return; }
    rc.utcMs = addUnit(rc.utcMs, a.unit, a.dir * a.mult, rc.place.tz);
    computeRingInPlace(pane, rc);
    refreshSceneOnly(pane, a.wrap);
    const t = Date.now();
    if (t - a.lastPersist > 3000) {
      rc.parts = utcToLocalParts(rc.utcMs, rc.place.tz);
      persist(); a.lastPersist = t;
    }
  }, 120);
  anims.set(pane.id, a);
  const playBtn = wrap.querySelector('[data-act="play"]');
  if (playBtn) playBtn.textContent = 'STOP';
}

function stopAnim(paneId, pane) {
  const a = anims.get(paneId);
  if (a) {
    clearInterval(a.timer);
    anims.delete(paneId);
    if (pane) {
      const rc = pane.rings[a.ringIdx];
      if (rc) rc.parts = utcToLocalParts(rc.utcMs, rc.place.tz);
      persist(); render();
    }
  }
}

// ------------------------------------------------------------------- boot

function addPane() {
  if (state.panes.length >= MAX_PANES) return;
  state.panes.push(blankPane());
  persist(); render();
}

document.addEventListener('DOMContentLoaded', () => {
  stage = new Stage();
  stage.onHover = (paneId, info) => {
    const hud = document.querySelector(`.pane[data-id="${paneId}"] .hud`);
    if (hud) hud.innerHTML = hudHtml(info);
  };
  restore();
  $('#add-pane').addEventListener('click', addPane);
  if (!state.panes.length) addPane();
  render();
  // Sprite labels are drawn with Cinzel; redraw once the webfont is in.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
    if (document.fonts.check('12px Cinzel')) render();
  });
  // Debug/test hook: window.__castid3d.cast({...}) casts a pane without the form.
  window.__castid3d = {
    get state() { return state; },
    stage: () => stage,
    cast(cfg) {
      const rc = { name: cfg.name || 'Test', parts: cfg.parts, unknown: !!cfg.unknown, unknownMode: cfg.unknownMode || 'noon', sunrise: false,
        place: cfg.place, houseSystem: cfg.houseSystem || 'placidus', planetSet: cfg.planetSet || 'modern', utcMs: cfg.utcMs ?? null };
      computeRing(rc);
      const pane = state.panes.find(p => !p.rings.length) || (state.panes.push(blankPane()), state.panes[state.panes.length - 1]);
      pane.rings = [rc]; pane.draft = null; pane.aspectMode = 'in:0';
      persist(); render();
      return pane;
    },
  };
});
