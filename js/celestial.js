// Castid 3D — spherical astronomy for the model.
// Everything lives in the ECLIPTIC FRAME: a right-handed basis where
//   x → 0° Aries (the vernal point), y → 0° Cancer, z → north ecliptic pole.
// A point at ecliptic longitude λ and latitude β is
//   (cos β cos λ, cos β sin λ, sin β).
// The horizon, meridian and celestial equator are great circles of the
// celestial sphere; their poles are computed here from the local sidereal
// time (RAMC), latitude and obliquity, exactly as the Ascendant and MC in
// ephemeris.js are — so the angles marked in 3D sit where the planes cut
// the ecliptic, and agree with the 2D chart to floating-point precision.

const DEG = Math.PI / 180;
export const norm = d => ((d % 360) + 360) % 360;

export function lonLatToVec(lonDeg, latDeg = 0) {
  const l = lonDeg * DEG, b = latDeg * DEG;
  return [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
}

export function vecToLon(v) {
  return norm(Math.atan2(v[1], v[0]) / DEG);
}

// Equatorial (X toward vernal point, Z toward celestial north pole) →
// ecliptic frame.
export function equatorialToEcliptic([X, Y, Z], epsDeg) {
  const e = epsDeg * DEG;
  return [X, Y * Math.cos(e) + Z * Math.sin(e), -Y * Math.sin(e) + Z * Math.cos(e)];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const unit = a => { const n = Math.hypot(...a); return n ? scale(a, 1 / n) : a; };
export const V = { dot, cross, scale, unit };

// Unit vectors (ecliptic frame) describing the observer's sky at one moment.
//   zenith  — pole of the horizon
//   east    — the east point of the horizon (pole of the meridian)
//   pole    — celestial north pole (pole of the equator)
//   asc/mc  — longitudes where horizon and meridian cut the ecliptic
export function skyFrame(ramcDeg, latDeg, epsDeg) {
  const th = ramcDeg * DEG, phi = latDeg * DEG;
  const zenith = equatorialToEcliptic([Math.cos(phi) * Math.cos(th), Math.cos(phi) * Math.sin(th), Math.sin(phi)], epsDeg);
  const east = equatorialToEcliptic([-Math.sin(th), Math.cos(th), 0], epsDeg);
  const pole = equatorialToEcliptic([0, 0, 1], epsDeg);
  const north = unit(cross(zenith, east)); // north point of the horizon

  // Horizon ∩ ecliptic: in-plane direction perpendicular to the zenith.
  let ascV = unit([-zenith[1], zenith[0], 0]);
  if (dot(ascV, east) < 0) ascV = scale(ascV, -1);
  // Meridian ∩ ecliptic: in-plane direction perpendicular to the east point,
  // on the upper (zenith) side.
  let mcV = unit([-east[1], east[0], 0]);
  if (dot(mcV, zenith) < 0) mcV = scale(mcV, -1);

  return { zenith, east, north, pole, ascV, mcV, asc: vecToLon(ascV), mc: vecToLon(mcV) };
}

// Points along a great circle whose pole is `poleVec`, radius r, n segments.
// `from` fixes where the circle starts (projected into the plane).
export function greatCircle(poleVec, r = 1, n = 128, from = null) {
  const p = unit(poleVec);
  let a = from ? unit(from) : (Math.abs(p[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
  a = unit(cross(cross(p, a), p)); // component of `a` perpendicular to p
  const b = cross(p, a);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push([
      r * (a[0] * Math.cos(t) + b[0] * Math.sin(t)),
      r * (a[1] * Math.cos(t) + b[1] * Math.sin(t)),
      r * (a[2] * Math.cos(t) + b[2] * Math.sin(t)),
    ]);
  }
  return pts;
}

// The Moon's orbit as an inclined great circle: ascending node at Ω,
// inclination i ≈ 5.145°. The nodes are exactly where it crosses z = 0.
export const MOON_INCL = 5.145;
export function moonOrbitPole(nodeLonDeg, inclDeg = MOON_INCL) {
  const O = nodeLonDeg * DEG, i = inclDeg * DEG;
  // Pole of a plane tilted by i about the node line (direction Ω).
  const n = lonLatToVec(nodeLonDeg);           // node line
  const up = [0, 0, 1];
  // rotate `up` about `n` by i (Rodrigues)
  const c = Math.cos(i), s = Math.sin(i);
  const k = n;
  const kxu = cross(k, up), kdu = dot(k, up);
  return [
    up[0] * c + kxu[0] * s + k[0] * kdu * (1 - c),
    up[1] * c + kxu[1] * s + k[1] * kdu * (1 - c),
    up[2] * c + kxu[2] * s + k[2] * kdu * (1 - c),
  ];
  void O;
}

// Antiscion: mirror across the solstitial axis (0°♋ – 0°♑).
export const antiscion = lon => norm(180 - lon);
// Contra-antiscion: mirror across the equinoctial axis (0°♈ – 0°♎).
export const contraAntiscion = lon => norm(360 - lon);
