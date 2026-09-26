// Castid 3D — one WebGL renderer, many chart windows.
// Browsers allow only a handful of WebGL contexts, so every pane shares a
// single full-window canvas fixed behind the page; each pane's scene is
// rendered into the rectangle its placeholder element occupies (scissored),
// with its own camera and orbit controls bound to that element.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeGroup, toWorld } from './orrery.js';

const PANEL = 0xDCDCDC;
const DIST = 23.5;

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
      v = { id, scene, camera, root: null, pickables: [], anchorRot: 0, frame: null, hovered: null, el: null, controls: null, presetName: 'oblique', fresh: true };
      this.views.set(id, v);
    }
    if (v.controls) v.controls.dispose();
    v.el = el;
    if (v.fresh) { v.fresh = false; this.preset(id, 'oblique'); }
    const c = new OrbitControls(v.camera, el);
    c.enableDamping = true; c.dampingFactor = 0.08;
    c.enablePan = false; c.minDistance = 6; c.maxDistance = 90;
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
    // Frame the wheel: pull back on tall or narrow windows.
    const r = v.el ? v.el.getBoundingClientRect() : null;
    const aspect = r && r.height ? r.width / r.height : 1.6;
    const d = DIST * Math.max(1, 1.25 / aspect) * (name === 'above' ? 1.02 : 1);
    if (name === 'above') cam.position.set(0, d, 0.02);
    else if (name === 'edge') cam.position.set(0, d * 0.16, d);
    else if (name === 'sky' && v.frame) {
      const north = toWorld(v.frame.north, v.anchorRot), zen = toWorld(v.frame.zenith, v.anchorRot);
      cam.up.copy(zen);
      cam.position.copy(north).multiplyScalar(d * 0.85).addScaledVector(zen, d * 0.42);
    } else { v.presetName = 'oblique'; cam.position.set(0, d * Math.sin(0.62), d * Math.cos(0.62)); }
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
    const w = window.innerWidth, h = window.innerHeight;
    if (this.canvas.width !== Math.floor(w * this.renderer.getPixelRatio()) || this.canvas.height !== Math.floor(h * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
    }
    const R = this.renderer;
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
      v.camera.aspect = rect.width / rect.height;
      v.camera.updateProjectionMatrix();
      v.controls.update();
      R.render(v.scene, v.camera);
    }
    this.frames++;
  }
}
