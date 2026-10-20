# Castid 3D — CLAUDE.md

3D sibling of castid (../castid): the same chart engine, rendered as tiny solar
systems with three.js. Repo `laurakgiron/3d-charts`.

## Status
- **LIVE:** https://castid3d.vercel.app (Vercel project `castid3d`, team
  `team_TCi1DDjT6lfbfyIpLTK9yGgn`, prj_QjhSQqpPiM77iHyXfKscxGH5N6Hi).
- **Git-linked:** the Vercel project is connected to this repo. A push to
  `main` auto-deploys to production (castid3d.vercel.app); a push to any other
  branch makes a preview deploy. To ship: merge to `main` and push. Confirm with
  `list_deployments` (meta.githubCommitSha = the pushed commit, target
  production, state READY). Do not hand-upload file snapshots any more.
- Verified 2026-10-20: commit ad6ec53 pushed to main produced production
  deploy dpl_CAAULukvDzEWjSs1BBFXkoVgmXPN with no manual step.
- First deploy: 2026-09-26, an inline upload of commit 8649132 (verified:
  deployment file SHA-1s equal `sha1sum` of that commit's nine files).

## Run locally
```bash
python3 -m http.server 8421
```
from this folder, open http://localhost:8421. Zero-build; never scaffold npm/Vite.

## Constraints
- Plain ES modules, pinned CDN imports via an import map in `index.html`:
  three.js **0.170.0** (`three`, `three/addons/`) and astronomy-engine 2.1.19
  from jsDelivr. Bump versions in the import map only.
- `js/ephemeris.js`, `js/geo.js`, `js/glyphs.js` are copies of castid's. Keep
  them in sync when castid changes; the only intentional divergence is
  `computeChart` returning `lat` (ecliptic latitude) per planet. Keep the
  AstroChart MIT license comment in glyphs.js.
- One WebGL context for the whole page (`js/stage.js`): browsers cap contexts,
  and "a year of revolutions" opens 12 windows. Each window's scene is
  rendered into its `.scene-box` rect with scissor. The canvas is `position:
  fixed; z-index: -1`, so windows must leave the scene area unpainted.
- Overlay buttons inside `.scene-box` must stop `pointerdown` propagation or
  OrbitControls' pointer capture eats the click.

## Model (js/orrery.js + js/celestial.js)
- Ecliptic frame: x → 0°♈, y → 0°♋, z → north ecliptic pole. three.js is y-up:
  ecliptic (x, y, z) → three (x, z, −y). Longitude counter-clockwise from above.
- Zodiac rim r=10, inner 8.7, hub 1.1. Chaldean shells: Moon 2.1 … Saturn 6.9,
  Uranus 7.45, Neptune 7.9, Pluto 8.35. Nodes on the Moon's shell.
- Horizon pole = zenith, meridian pole = east point, equator pole = celestial
  pole, all from RAMC/lat/obliquity (`skyFrame`). Verified: horizon∩ecliptic
  equals castid's Ascendant to 1e-13°.
- Stacked rings are storeys 2.2 apart; ring 0 owns houses, sky, antiscia.
- Scene is anchored so the Ascendant is on the left (rotation 180°−asc), like
  the wheel. Houseless charts anchor 0°♈ left.
- Camera presets: oblique, above (wheel), edge, sky (camera at the horizon's
  north point, zenith up → east on the left). A preset only fixes the viewing
  direction; the distance comes from `Stage._fitDistance`, which fits the
  model's `fit` points (from `fitPoints` in orrery.js: every storey's labelled
  rim plus the sky circles) to the window's real aspect ratio. The render loop
  refits whenever a window changes shape (expand, side panel, resize) and
  `setRoot` refits when the model's extent changes (storey added, sky toggled),
  both scaling the current distance so the user's orbit/zoom stay relative.
  Never size the camera from a constant distance again — that is what cropped
  the wheel's sides in narrow windows.
- Degree-label sprite textures are per-moment and owned by their sprite
  (`texture.userData.owned`), disposed in `disposeGroup`; only static glyph /
  text textures go in `texCache`. Caching per-moment labels leaked a texture
  per body per animation step.

## State
- localStorage key `castid3d-state-v1` (separate from castid's).
- `window.__castid3d.cast({...})` casts a window without the form (test hook).

## Testing without CDN access
The sandbox proxy may block cdn.jsdelivr.net. `npm pack three@0.170.0
astronomy-engine@2.1.19`, then intercept the CDN URLs in Playwright and serve
the local files (`--use-angle=swiftshader` for headless WebGL).

## Roadmap ideas (Laura's)
Synastry between two people as two interpenetrating systems; aspect geometry
studies (what does a grand cross look like in space?); custom Figma glyphs
(swap path arrays in glyphs.js); Blender renders via the JSON export.
