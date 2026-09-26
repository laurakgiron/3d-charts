# Castid 3D — tiny solar systems

A three-dimensional interface for [castid](https://castid.app)'s chart engine.
Each chart window is a small orrery: the ecliptic is the floor, every planet
rides its own shell in Chaldean order, the horizon and meridian are drawn as
the tilted great circles they really are, and stacked rings (transits,
progressions, solar returns) become storeys above the natal floor.

- **Positions** — geocentric, tropical, ecliptic of date, with true ecliptic
  latitude (Pluto really does sit 15° above the plane).
- **Angles** — the Ascendant is where the horizon disc cuts the ecliptic on
  the east; the Midheaven where the meridian does. Switch to *Stand under the
  sky* to see why charts put east on the left.
- **Nodes** — on the Moon's inclined orbit, exactly where it crosses the
  ecliptic.
- **Aspects** — rods between bodies (molecule-model style, colour by type) or
  chords on the rim; within one ring or natal × transit.
- **Antiscia** — toggle a translucent mirror through 0°♋–0°♑ and see every
  body's reflection.
- **Animate** — step or play any ring through time; go to an exact moment.
- **Export · Scene JSON** — dump a window's geometry; `blender/castid_orrery.py`
  rebuilds it in Blender for cinematic renders.

## Run locally

```bash
python3 -m http.server 8421
```

then open http://localhost:8421. Zero build: plain ES modules with pinned CDN
imports (three.js 0.170 and astronomy-engine 2.1.19 via jsDelivr, Cinzel from
Google Fonts, Open-Meteo geocoding).

## Files

| file | what |
| --- | --- |
| `index.html` | shell + import map |
| `css/charts3d.css` | Wild Week Athens tokens, 3D stage layout |
| `js/app.js` | chart windows, forms, rings, animation, persistence |
| `js/stage.js` | one WebGL renderer shared by every window (scissored viewports), orbit controls, hover |
| `js/orrery.js` | builds a chart as a three.js scene |
| `js/celestial.js` | horizon / meridian / equator poles, Moon's orbit, antiscia |
| `js/ephemeris.js` `js/geo.js` `js/glyphs.js` | castid's engine (ephemeris adds ecliptic latitude) |
| `blender/castid_orrery.py` | rebuild an exported window in Blender |
