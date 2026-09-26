// Castid 3D — ephemeris & house calculation (shared with castid; adds ecliptic latitude)
// Positions from astronomy-engine (pinned CDN ESM): geocentric apparent
// ecliptic-of-date longitudes. Houses (Placidus / Whole Sign), Asc/MC and
// the mean lunar node are computed here from standard spherical astronomy.

import * as A from 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/+esm';

const DEG = Math.PI / 180;
const norm = d => ((d % 360) + 360) % 360;

export const SIGNS = [
  { name: 'Aries', glyph: '♈︎' }, { name: 'Taurus', glyph: '♉︎' },
  { name: 'Gemini', glyph: '♊︎' }, { name: 'Cancer', glyph: '♋︎' },
  { name: 'Leo', glyph: '♌︎' }, { name: 'Virgo', glyph: '♍︎' },
  { name: 'Libra', glyph: '♎︎' }, { name: 'Scorpio', glyph: '♏︎' },
  { name: 'Sagittarius', glyph: '♐︎' }, { name: 'Capricorn', glyph: '♑︎' },
  { name: 'Aquarius', glyph: '♒︎' }, { name: 'Pisces', glyph: '♓︎' },
];

const PLANET_DEFS = [
  { key: 'sun', name: 'Sun', glyph: '☉︎', body: 'Sun', set: 'traditional' },
  { key: 'moon', name: 'Moon', glyph: '☽︎', body: 'Moon', set: 'traditional' },
  { key: 'mercury', name: 'Mercury', glyph: '☿︎', body: 'Mercury', set: 'traditional' },
  { key: 'venus', name: 'Venus', glyph: '♀︎', body: 'Venus', set: 'traditional' },
  { key: 'mars', name: 'Mars', glyph: '♂︎', body: 'Mars', set: 'traditional' },
  { key: 'jupiter', name: 'Jupiter', glyph: '♃︎', body: 'Jupiter', set: 'traditional' },
  { key: 'saturn', name: 'Saturn', glyph: '♄︎', body: 'Saturn', set: 'traditional' },
  { key: 'uranus', name: 'Uranus', glyph: '♅︎', body: 'Uranus', set: 'modern' },
  { key: 'neptune', name: 'Neptune', glyph: '♆︎', body: 'Neptune', set: 'modern' },
  { key: 'pluto', name: 'Pluto', glyph: '♇︎', body: 'Pluto', set: 'modern' },
];

function julianCenturies(ms) {
  const jd = ms / 86400000 + 2440587.5;
  return (jd - 2451545.0) / 36525;
}

function meanObliquity(ms) {
  const T = julianCenturies(ms);
  return 23.43929111 - 0.013004167 * T - 1.6389e-7 * T * T + 5.0361e-7 * T * T * T;
}

function meanLunarNode(ms) {
  const T = julianCenturies(ms);
  return norm(125.0445479 - 1934.1362891 * T + 0.0020754 * T * T
    + T * T * T / 467441 - T * T * T * T / 60616000);
}

function bodyLongitude(bodyName, date) {
  const vec = A.GeoVector(A.Body[bodyName], date, true);
  return norm(A.Ecliptic(vec).elon);
}

// Geocentric ecliptic longitude AND latitude — the 3D model places each
// body at its true height above or below the plane of the ecliptic.
function bodyEcliptic(bodyName, date) {
  const vec = A.GeoVector(A.Body[bodyName], date, true);
  const e = A.Ecliptic(vec);
  return { lon: norm(e.elon), lat: e.elat };
}

// Ecliptic longitude of the ecliptic point having right ascension `raDeg`.
function eclLonFromRA(raDeg, epsDeg) {
  const ra = raDeg * DEG, e = epsDeg * DEG;
  return norm(Math.atan2(Math.sin(ra), Math.cos(ra) * Math.cos(e)) / DEG);
}

function anglesFromRamc(ramc, latDeg, epsDeg) {
  const e = epsDeg * DEG, ra = ramc * DEG, phi = latDeg * DEG;
  const mc = norm(Math.atan2(Math.sin(ra), Math.cos(ra) * Math.cos(e)) / DEG);
  const asc = norm(Math.atan2(
    Math.cos(ra),
    -(Math.sin(ra) * Math.cos(e) + Math.tan(phi) * Math.sin(e))
  ) / DEG);
  return { asc, mc };
}

export function ascMc(ms, latDeg, lonDeg) {
  const date = new Date(ms);
  const gastHours = A.SiderealTime(date);
  const ramc = norm(gastHours * 15 + lonDeg);
  const eps = meanObliquity(ms);
  const { asc, mc } = anglesFromRamc(ramc, latDeg, eps);
  return { asc, mc, ramc, eps };
}

// Placidus intermediate cusp: iterate on RA. offset 30/60/120/150 from RAMC,
// frac is the fraction of the ascensional difference (1/3 or 2/3).
// Returns null when the iteration leaves the domain (polar latitudes).
function placidusCusp(ramc, eps, phi, offset, frac) {
  const e = eps * DEG, ph = phi * DEG;
  let ra = ramc + offset;
  for (let i = 0; i < 30; i++) {
    const lam = eclLonFromRA(ra, eps);
    const dec = Math.asin(Math.sin(e) * Math.sin(lam * DEG));
    const x = Math.tan(dec) * Math.tan(ph);
    if (Math.abs(x) >= 1) return null;
    const ad = Math.asin(x) / DEG;
    const next = ramc + offset + frac * ad;
    if (Math.abs(next - ra) < 1e-7) { ra = next; break; }
    ra = next;
  }
  return eclLonFromRA(ra, eps);
}

// Returns 12 cusp longitudes (index 0 = house 1) or null if Placidus is
// undefined at this latitude.
function placidusFromRamc(ramc, epsDeg, latDeg, asc, mc) {
  const c11 = placidusCusp(ramc, epsDeg, latDeg, 30, 1 / 3);
  const c12 = placidusCusp(ramc, epsDeg, latDeg, 60, 2 / 3);
  const c2 = placidusCusp(ramc, epsDeg, latDeg, 120, 2 / 3);
  const c3 = placidusCusp(ramc, epsDeg, latDeg, 150, 1 / 3);
  if (c11 == null || c12 == null || c2 == null || c3 == null) return null;
  const cusps = new Array(12);
  cusps[0] = asc; cusps[1] = c2; cusps[2] = c3;
  cusps[3] = norm(mc + 180); cusps[4] = norm(c11 + 180); cusps[5] = norm(c12 + 180);
  cusps[6] = norm(asc + 180); cusps[7] = norm(c2 + 180); cusps[8] = norm(c3 + 180);
  cusps[9] = mc; cusps[10] = c11; cusps[11] = c12;
  return cusps;
}

export function placidusCusps(ms, latDeg, lonDeg) {
  const { asc, mc, ramc, eps } = ascMc(ms, latDeg, lonDeg);
  return placidusFromRamc(ramc, eps, latDeg, asc, mc);
}

// Solar-arc directed angles: directed MC = natal MC + arc; the Ascendant and
// house cusps are recomputed from the directed RAMC at the natal latitude.
export function directedAngles(baseChart, arc, latDeg, natalMs) {
  if (baseChart.asc == null) return { asc: null, mc: null, cusps: null };
  const eps = meanObliquity(natalMs);
  const mc = norm(baseChart.mc + arc);
  const lam = mc * DEG, e = eps * DEG;
  const ramc = norm(Math.atan2(Math.sin(lam) * Math.cos(e), Math.cos(lam)) / DEG);
  const { asc } = anglesFromRamc(ramc, latDeg, eps);
  let cusps = null;
  if (baseChart.houseSystem === 'placidus') cusps = placidusFromRamc(ramc, eps, latDeg, asc, mc);
  if (!cusps) cusps = wholeSignCusps(asc);
  return { asc, mc, cusps };
}

export function wholeSignCusps(ascLon) {
  const start = Math.floor(ascLon / 30) * 30;
  return Array.from({ length: 12 }, (_, i) => norm(start + i * 30));
}

export function houseOf(lon, cusps) {
  if (!cusps) return null;
  for (let i = 0; i < 12; i++) {
    const a = cusps[i], b = cusps[(i + 1) % 12];
    const span = norm(b - a) || 360;
    if (norm(lon - a) < span) return i + 1;
  }
  return 12;
}

// config: { utcMs, lat, lon, houseSystem: 'placidus'|'whole',
//           planetSet: 'traditional'|'modern', houseless: bool }
export function computeChart(config) {
  const { utcMs, lat, lon, houseSystem, planetSet, houseless } = config;
  const date = new Date(utcMs);
  const notes = [];
  const defs = PLANET_DEFS.filter(p => planetSet === 'modern' || p.set === 'traditional');

  const planets = [];
  for (const def of defs) {
    try {
      const e1 = bodyEcliptic(def.body, date);
      const l2 = bodyLongitude(def.body, new Date(utcMs + 3600e3));
      const drift = ((l2 - e1.lon + 540) % 360) - 180;
      planets.push({ ...def, lon: e1.lon, lat: e1.lat, retro: drift < 0 });
    } catch (err) {
      notes.push(`${def.name} unavailable for this date`);
    }
  }
  const node = meanLunarNode(utcMs);
  planets.push({ key: 'node', name: 'North Node', glyph: '☊︎', lon: node, lat: 0, retro: true, isPoint: true });
  planets.push({ key: 'snode', name: 'South Node', glyph: '☋︎', lon: norm(node + 180), lat: 0, retro: true, isPoint: true });

  let asc = null, mc = null, cusps = null, usedSystem = houseSystem;
  if (!houseless) {
    const angles = ascMc(utcMs, lat, lon);
    asc = angles.asc; mc = angles.mc;
    if (houseSystem === 'placidus') {
      cusps = placidusCusps(utcMs, lat, lon);
      if (!cusps) {
        usedSystem = 'whole';
        cusps = wholeSignCusps(asc);
        notes.push('Placidus undefined at this latitude — using Whole Sign');
      }
    } else {
      cusps = wholeSignCusps(asc);
    }
    for (const p of planets) p.house = houseOf(p.lon, cusps);
  }

  return { planets, asc, mc, cusps, houseless: !!houseless, houseSystem: usedSystem, notes, utcMs };
}

export function sunLongitude(ms) {
  return bodyLongitude('Sun', new Date(ms));
}

// Exact moment the transiting Sun reaches `targetLonDeg`, searching forward
// from `startMs` for up to `limitDays`. Returns epoch ms, or null.
export function findSunReturn(targetLonDeg, startMs, limitDays) {
  try {
    const t = A.SearchSunLongitude(norm(targetLonDeg), new Date(startMs), limitDays);
    return t ? t.date.getTime() : null;
  } catch { return null; }
}

// Sunrise (upper limb, refracted) following local midnight `utcMidnightMs`.
export function findSunrise(utcMidnightMs, lat, lon) {
  try {
    const obs = new A.Observer(lat, lon, 0);
    const t = A.SearchRiseSet(A.Body.Sun, obs, +1, new Date(utcMidnightMs), 1.2);
    return t ? t.date.getTime() : null;
  } catch { return null; }
}

const ASPECT_DEFS = [
  { type: 'conjunction', angle: 0, orb: 8, glyph: '☌︎' },
  { type: 'sextile', angle: 60, orb: 4, glyph: '⚹︎' },
  { type: 'square', angle: 90, orb: 7, glyph: '□︎' },
  { type: 'trine', angle: 120, orb: 8, glyph: '△︎' },
  { type: 'opposition', angle: 180, orb: 8, glyph: '☍︎' },
];

// listB null → aspects within listA; otherwise cross-aspects A×B.
export function computeAspects(listA, listB) {
  const out = [];
  const pairs = [];
  if (listB) {
    for (const a of listA) for (const b of listB) pairs.push([a, b]);
  } else {
    for (let i = 0; i < listA.length; i++)
      for (let j = i + 1; j < listA.length; j++) pairs.push([listA[i], listA[j]]);
  }
  for (const [a, b] of pairs) {
    if (a.key === 'snode' || b.key === 'snode') continue;
    const sep = Math.abs(((a.lon - b.lon + 540) % 360) - 180); // separation 0..180
    for (const def of ASPECT_DEFS) {
      const delta = Math.abs(sep - def.angle);
      if (delta <= def.orb) { out.push({ a, b, type: def.type, glyph: def.glyph, orb: delta }); break; }
    }
  }
  return out;
}

export function formatLon(lon) {
  const s = Math.floor(norm(lon) / 30);
  const within = norm(lon) - s * 30;
  let d = Math.floor(within);
  let m = Math.round((within - d) * 60);
  if (m === 60) { m = 0; d += 1; }
  return { deg: d, min: m, sign: SIGNS[s % 12], signIndex: s % 12, text: `${d}° ${SIGNS[s % 12].glyph} ${String(m).padStart(2, '0')}′` };
}
