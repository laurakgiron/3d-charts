// Castid — location search & timezone handling.
// Geocoding via Open-Meteo (free, keyless). Historical local-time → UTC
// conversion rides the browser's built-in IANA timezone database.

export async function searchPlaces(query) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name='
    + encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) throw new Error('geocoding failed');
  const data = await res.json();
  return (data.results || []).map(r => ({
    name: r.name,
    admin: r.admin1 || '',
    country: r.country_code || '',
    lat: r.latitude,
    lon: r.longitude,
    tz: r.timezone,
  }));
}

function wallParts(tz, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: +p.hour === 24 ? 0 : +p.hour, mi: +p.minute, s: +p.second,
  };
}

function partsToPseudoUtc({ y, mo, d, h, mi, s }) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s || 0, 0);
  return dt.getTime();
}

export function tzOffsetMs(tz, utcMs) {
  return partsToPseudoUtc(wallParts(tz, utcMs)) - utcMs;
}

// Local wall-clock parts in `tz` → UTC epoch ms. Iterates so DST edges land.
export function localToUtcMs(parts, tz) {
  const wall = partsToPseudoUtc(parts);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - tzOffsetMs(tz, guess);
  return guess;
}

export function utcToLocalParts(utcMs, tz) {
  return wallParts(tz, utcMs);
}

export function formatInTz(utcMs, tz, withSeconds = true) {
  const p = wallParts(tz, utcMs);
  const pad = n => String(n).padStart(2, '0');
  const date = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  const time = withSeconds
    ? `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`
    : `${pad(p.h)}:${pad(p.mi)}`;
  return `${date} ${time}`;
}

const UNIT_MS = { second: 1e3, minute: 60e3, hour: 3600e3 };

// Step a moment by n units. Seconds/minutes/hours are exact; day/week/month/
// year step the wall clock in `tz` (so "one day" keeps the same local time).
export function addUnit(utcMs, unit, n, tz) {
  if (UNIT_MS[unit]) return utcMs + n * UNIT_MS[unit];
  const p = wallParts(tz, utcMs);
  if (unit === 'day') p.d += n;
  else if (unit === 'week') p.d += 7 * n;
  else if (unit === 'month') p.mo += n;
  else if (unit === 'year') p.y += n;
  return localToUtcMs(p, tz);
}
