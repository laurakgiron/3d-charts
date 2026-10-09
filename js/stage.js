// Castid 3D — one WebGL renderer, many chart windows.
// Browsers allow only a handful of WebGL contexts, so every pane shares a
// single full-window canvas fixed behind the page; each pane's scene is
// rendered into the rectangle its placeholder element occupies (scissored),
// with its own camera and orbit controls bound to that element.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeGroup, toWorld } from './orrery.js';

const PANEL = 0xDCDCDC;
const DEG = Math.PI / 180;
const FIT_PAD = 1.06;        // breathing room around the fitted model
const FALLBACK_ASPECT = 1.6; // used only before a window has a laid-out size
const SPHERE_R = 12;         // fit radius when a view has no model yet

export class Stage {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';
    document.body.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.views = new Map();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.onHover = null; // (paneId, info|null)
    this.frames = 0;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  mount(id, el) {
    let v = this.views.get(id);
    if (!v) {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(PANEL);
      scene.add(new THREE.HemisphereLight(0xFFFFFF, 0xB8B8B8, 1.15));
      const key = new THREE.DirectionalLight(0xFFFFFF, 1.6); key.position.set(-14, 22, 16); scene.add(key);
      const fill = new THREE.DirectionalLight(0xFFF6E8, 0.5); fill.position.set(18, 6, -10); scene.add(fill);
      const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 300);
      v = { id, scene, camera, root: null, pickables: [], anchorRot: 0, frame: null, hovered: null, el: null, controls: null, presetName: 'oblique', fresh: true, fit: null, fitSig: null, fitAspect: null };
      this.views.set(id, v);
    }
    if (v.controls) v.controls.dispose();
    v.el = el;
    const c = new OrbitControls(v.camera, el);
    c.enableDamping = true; c.dampingFactor = 0.08;
    c.enablePan = false; c.minDistance = 6; c.maxDistance = 200;
    c.rotateSpeed = 0.7; c.zoomSpeed = 0.8;
    v.controls = c;
    el.addEventListener('pointermove', e => this._pick(v, e));
    el.addEventListener('pointerleave', () => this._setHover(v, null));
    el.addEventListener('dblclick', () => this.preset(id, v.presetName));
    return v;
  }

  unmount(id) {
    const v = this.views.get(id);
    if (!v) return;
    if (v.controls) v.controls.dispose();
    if (v.root) { v.scene.remove(v.root); disposeGroup(v.root); }
    this.views.delete(id);
  }

  has(id) { return this.views.has(id); }

  setRoot(id, built) {
    const v = this.views.get(id);
    if (!v) return;
    if (v.root) { v.scene.remove(v.root); disposeGroup(v.root); }
    v.root = built.root; v.pickables = built.pickables;
    v.anchorRot = built.anchorRot; v.frame = built.frame; v.hovered = null;
    v.scene.add(v.root);
    // Keep the whole model in frame. First model: apply the default preset.
    // Later models whose extent changed (a storey added, the sky toggled):
    // rescale the current camera distance so the user's orbit and zoom stay
    // relative to the model.
    const prevFit = v.fit, prevSig = v.fitSig;
    v.fit = built.fit; v.fitSig = built.fitSig;
    if (v.fresh) { v.fresh = false; this.preset(id, v.presetName); }
    else if (prevFit && prevSig !== v.fitSig && v.fitAspect != null) {
      const k = this._fitDistance(v, v.fitAspect, v.fit) / this._fitDistance(v, v.fitAspect, prevFit);
      v.camera.position.multiplyScalar(k);
      if (v.controls) v.controls.update();
    }
  }

  _aspectOf(v) {
    const r = v.el ? v.el.getBoundingClientRect() : null;
    return r && r.width >= 4 && r.height >= 4 ? r.width / r.height : null;
  }

  // Camera distance along the camera's current direction at which every fit
  // point of the model lies inside the view frustum for this aspect ratio.
  // Closed form: for a point p with view-space depth z and lateral offsets
  // x, y the frustum needs d ≥ z + |x| / tan(hfov/2) and d ≥ z + |y| / tan(vfov/2).
  _fitDistance(v, aspect, pts = v.fit) {
    const cam = v.camera;
    const dir = cam.position.clone();
    if (dir.lengthSq() < 1e-9) dir.set(0, 0.58, 0.81);
    dir.normalize();
    const fwd = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, cam.up);
    if (right.lengthSq() < 1e-9) right.crossVectors(fwd, Math.abs(fwd.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1));
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    const tv = Math.tan(cam.fov / 2 * DEG), th = tv * aspect;
    let d = 0;
    if (pts && pts.length) {
      for (const p of pts) {
        const z = p.dot(dir);
        d = Math.max(d, z + Math.abs(p.dot(right)) / th, z + Math.abs(p.dot(up)) / tv);
      }
    } else {
      d = SPHERE_R / Math.sin(Math.atan(Math.min(tv, th)));
    }
    return d * FIT_PAD;
  }

  // The window changed shape: refit for the new aspect, preserving whatever
  // zoom the user applied relative to the old fit.
  _refit(v, aspect) {
    const cur = v.camera.position.length();
    const dNew = this._fitDistance(v, aspect);
    const dOld = v.fitAspect != null ? this._fitDistance(v, v.fitAspect) : cur;
    v.camera.position.multiplyScalar(dNew / dOld);
    v.fitAspect = aspect;
    if (v.controls) v.controls.update();
  }

  // Camera presets. 'sky' stands the viewer at the north point of the
  // horizon looking south with the zenith overhead — east (the Ascendant)
  // falls on the left, which is why the wheel is drawn that way.
  preset(id, name) {
    const v = this.views.get(id);
    if (!v) return;
    const cam = v.camera;
    v.presetName = name;
    cam.up.set(0, 1, 0);
    // Viewing direction first; the distance comes from fitting the model to
    // the window's actual shape, so narrow or wide windows never crop it.
    if (name === 'above') cam.position.set(0, 1, 0.001);
    else if (name === 'edge') cam.position.set(0, 0.16, 1);
    else if (name === 'sky' && v.frame) {
      const north = toWorld(v.frame.north, v.anchorRot), zen = toWorld(v.frame.zenith, v.anchorRot);
      cam.up.copy(zen);
      cam.position.copy(north).multiplyScalar(0.85).addScaledVector(zen, 0.42);
    } else { v.presetName = 'oblique'; cam.position.set(0, Math.sin(0.62), Math.cos(0.62)); }
    const aspect = this._aspectOf(v);
    cam.position.normalize().multiplyScalar(this._fitDistance(v, aspect ?? FALLBACK_ASPECT));
    v.fitAspect = aspect; // null → the render loop refits once the box has a size
    cam.lookAt(0, 0, 0);
    if (v.controls) v.controls.update();
  }

  _pick(v, e) {
    if (!v.el || !v.pickables.length) return;
    const r = v.el.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, v.camera);
    const hits = this.raycaster.intersectObjects(v.pickables, false);
    this._setHover(v, hits.length ? hits[0].object : null);
  }

  _setHover(v, obj) {
    if (v.hovered === obj) return;
    if (v.hovered) v.hovered.scale.setScalar(v.hovered.isSprite ? v.hovered.userData.s0 || 1 : 1);
    v.hovered = obj;
    if (obj) {
      if (obj.isSprite) { obj.userData.s0 = obj.userData.s0 || obj.scale.x; }
      else obj.scale.setScalar(1.45);
      if (v.el) v.el.style.cursor = 'pointer';
    } else if (v.el) v.el.style.cursor = '';
    if (this.onHover) this.onHover(v.id, obj ? obj.userData.pick : null);
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const R = this.renderer;
    // Size the drawing buffer from the canvas's own CSS box, not the window:
    // window.innerWidth includes a classic scrollbar, which would stretch the
    // buffer into a narrower box and shift every scene sideways.
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    if (pr !== R.getPixelRatio()) R.setPixelRatio(pr);
    if (this.canvas.width !== Math.floor(w * pr) || this.canvas.height !== Math.floor(h * pr)) {
      R.setSize(w, h, false);
    }
    R.setScissorTest(false);
    R.clear();
    R.setScissorTest(true);
    for (const v of this.views.values()) {
      if (!v.el || !v.el.isConnected || !v.root) continue;
      const rect = v.el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > h || rect.right < 0 || rect.left > w || rect.width < 4 || rect.height < 4) continue;
      const left = rect.left, bottom = h - rect.bottom;
      R.setViewport(left, bottom, rect.width, rect.height);
      R.setScissor(left, bottom, rect.width, rect.height);
      const aspect = rect.width / rect.height;
      if (v.fitAspect == null || Math.abs(aspect - v.fitAspect) > 1e-3) this._refit(v, aspect);
      v.camera.aspect = aspect;
      v.camera.updateProjectionMatrix();
      v.controls.update();
      R.render(v.scene, v.camera);
    }
    this.frames++;
  }
}
