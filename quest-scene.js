// React Three Fiber scene for the Meta Quest 3 model.
// The page owns scroll (GSAP + ScrollTrigger) and writes plain numbers into `store.k`.
// This scene reads them every frame inside useFrame, so scrolling never triggers React renders.
const V = { react: '18.3.1', three: '0.169.0', fiber: '8.17.10', drei: '9.114.0' };
const DEPS = `deps=react@${V.react},react-dom@${V.react},three@${V.three},@react-three/fiber@${V.fiber}`;
const SRC = {
  react: `https://esm.sh/react@${V.react}`,
  three: `https://esm.sh/three@${V.three}`,
  gltf: `https://esm.sh/three@${V.three}/examples/jsm/loaders/GLTFLoader.js`,
  fiber: `https://esm.sh/@react-three/fiber@${V.fiber}?${DEPS}`,
  drei: `https://esm.sh/@react-three/drei@${V.drei}?${DEPS}`,
  htm: 'https://esm.sh/htm@3.1.1',
};
const MODEL_BYTES = 8632068;

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Model request failed (' + res.status + ')');
  const total = +res.headers.get('content-length') || MODEL_BYTES;
  if (!res.body || !res.body.getReader) return res.arrayBuffer();
  const reader = res.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const all = new Uint8Array(got);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return all.buffer;
}

// Splits the single exported mesh into its connected pieces and regroups them into named parts,
// keeping the loader's geometry attributes and PBR material untouched.
function buildModel(THREE, gltf, classify, defs, order) {
  gltf.scene.updateMatrixWorld(true);
  let src = null;
  gltf.scene.traverse(o => { if (!src && o.isMesh) src = o; });
  if (!src || !src.geometry.index) throw new Error('The model does not contain an indexed mesh');
  const g0 = src.geometry, mat0 = src.material;
  // Node = Z-up→Y-up rotation + 0.01 scale. Keep the rotation; work in centimetres (1 unit = 1 cm).
  const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  src.matrixWorld.decompose(t, q, s);
  const M = new THREE.Matrix4().compose(t.divideScalar(s.x || 1), q, new THREE.Vector3(1, 1, 1));
  const NM = new THREE.Matrix3().getNormalMatrix(M);
  const pa = g0.attributes.position, na = g0.attributes.normal, ua = g0.attributes.uv, u1 = g0.attributes.uv1;
  const VN = pa.count, I = g0.index.array;
  const P = new Float32Array(VN * 3), N = new Float32Array(VN * 3);
  const U = ua ? new Float32Array(VN * 2) : null, U1 = u1 ? new Float32Array(VN * 2) : null;
  const weld = new Map(), rep = new Int32Array(VN), v = new THREE.Vector3();
  for (let i = 0; i < VN; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    const key = Math.round(x * 1000) + ',' + Math.round(y * 1000) + ',' + Math.round(z * 1000);
    let r = weld.get(key); if (r === undefined) { r = i; weld.set(key, i); } rep[i] = r;
    v.set(x, y, z).applyMatrix4(M); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
    if (na) { v.set(na.getX(i), na.getY(i), na.getZ(i)).applyMatrix3(NM).normalize(); N[i * 3] = v.x; N[i * 3 + 1] = v.y; N[i * 3 + 2] = v.z; }
    if (U) { U[i * 2] = ua.getX(i); U[i * 2 + 1] = ua.getY(i); }
    if (U1) { U1[i * 2] = u1.getX(i); U1[i * 2 + 1] = u1.getY(i); }
  }
  const par = new Int32Array(VN); for (let i = 0; i < VN; i++) par[i] = i;
  const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let k = 0; k < I.length; k += 3) {
    const a = find(rep[I[k]]), b = find(rep[I[k + 1]]);
    if (a !== b) par[a] = b;
    const b2 = find(b), c = find(rep[I[k + 2]]); if (c !== b2) par[c] = b2;
  }
  const comps = new Map();
  for (let k = 0; k < I.length; k += 3) {
    const r = find(rep[I[k]]);
    let c = comps.get(r);
    if (!c) { c = { tris: [], min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] }; comps.set(r, c); }
    c.tris.push(k);
    for (let j = 0; j < 3; j++) { const vi = I[k + j]; for (let a = 0; a < 3; a++) { const p = P[vi * 3 + a]; if (p < c.min[a]) c.min[a] = p; if (p > c.max[a]) c.max[a] = p; } }
  }
  const list = [...comps.values()].sort((a, b) => b.tris.length - a.tris.length);
  list.forEach((c, i) => { c.id = i; c.ctr = c.min.map((x, a) => (x + c.max[a]) / 2); });
  const groups = new Map();
  for (const c of list) { const g = classify(c, list); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }

  const parts = [];
  for (const [name, cs] of groups) {
    const remap = new Map(), pos = [], nor = [], uv = [], uv1 = [], idx = [];
    const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    for (const c of cs) for (const k of c.tris) for (let j = 0; j < 3; j++) {
      const vi = I[k + j]; let n = remap.get(vi);
      if (n === undefined) {
        n = remap.size; remap.set(vi, n);
        pos.push(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]); nor.push(N[vi * 3], N[vi * 3 + 1], N[vi * 3 + 2]);
        if (U) uv.push(U[vi * 2], U[vi * 2 + 1]);
        if (U1) uv1.push(U1[vi * 2], U1[vi * 2 + 1]);
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], P[vi * 3 + a]); max[a] = Math.max(max[a], P[vi * 3 + a]); }
      }
      idx.push(n);
    }
    const ctr = min.map((x, a) => (x + max[a]) / 2);
    for (let i = 0; i < pos.length; i += 3) { pos[i] -= ctr[0]; pos[i + 1] -= ctr[1]; pos[i + 2] -= ctr[2]; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    if (U) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (U1) g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
    g.setIndex(remap.size > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    const mat = mat0.clone();
    mat.emissive = new THREE.Color(0xf0461e); mat.emissiveIntensity = 0;
    const def = defs[name] || { label: 'shell', vec: [0, 0, 0], bump: [0, 0, 0], rot: [0, 0, 0], w: [0, 1], anchor: [0, 0, 0] };
    parts.push({ name, label: def.label, def, geometry: g, mat, center: ctr, min, max, pieces: cs.length, tris: idx.length / 3, hover: 0, dim: 1, mesh: null, ray: null });
  }
  const byName = {}, centers = {}, stats = {};
  parts.forEach(p => { byName[p.name] = p; centers[p.name] = p.center.slice(); });
  for (const id of order) {
    const ps = parts.filter(p => p.label === id); if (!ps.length) continue;
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; let pieces = 0, tris = 0;
    ps.forEach(p => { pieces += p.pieces; tris += p.tris; for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p.min[a]); mx[a] = Math.max(mx[a], p.max[a]); } });
    const sz = mx.map((x, a) => x - mn[a]);
    stats[id] = { pieces: String(pieces), tris: tris.toLocaleString('en-US'), size: sz[0].toFixed(1) + ' × ' + sz[1].toFixed(1) + ' × ' + sz[2].toFixed(1) + ' cm', radius: Math.hypot(sz[0], sz[1], sz[2]) / 2 };
  }
  const textures = [...new Set(['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].map(k => mat0[k]).filter(Boolean))];
  return {
    parts, byName, centers, stats, textures, pieceCount: list.length,
    dispose() { parts.forEach(p => { p.geometry.dispose(); p.mat.dispose(); }); textures.forEach(t => t.dispose()); g0.dispose(); mat0.dispose(); },
  };
}

const VTX = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const GLOW_FS = 'varying vec2 vUv; uniform vec3 uC; uniform float uO; void main(){ float d = length(vUv - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 2.6); float core = pow(max(0.0, 1.0 - d), 9.0); vec3 c = mix(uC, vec3(1.0, 0.92, 0.85), core); gl_FragColor = vec4(c, (a * 0.55 + core * 0.35) * uO); }';
const BEAM_VS = 'varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }';
const BEAM_FS = 'varying vec2 vUv; varying vec3 vN; varying vec3 vV; uniform float uO; void main(){ float f = pow(abs(dot(normalize(vN), normalize(vV))), 2.0); float a = (0.25 + 0.75 * pow(vUv.y, 1.4)) * smoothstep(0.0, 0.3, vUv.y) * f * uO; gl_FragColor = vec4(vec3(1.0, 0.95, 0.9), a); }';
const GRID_VS = 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }';
const GRID_FS = 'varying vec3 vW; uniform float uO; uniform vec3 uA; uniform vec3 uL; void main(){ vec2 p = vW.xz; float r = length(p); vec2 q = p / 8.0; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q); float line = 1.0 - min(min(g.x, g.y), 1.0); float rq = r / 24.0; float ring = 1.0 - min(abs(fract(rq - 0.5) - 0.5) / fwidth(rq), 1.0); float fade = smoothstep(170.0, 10.0, r); vec3 c = mix(uL, uA, ring); gl_FragColor = vec4(c, (line * 0.09 + ring * 0.28) * fade * uO); }';
const DUST_VS = 'attribute float aSeed; attribute float aSize; uniform float uT; uniform float uPx; varying float vA; void main(){ vec3 p = position; p.y = mod(p.y + uT * (0.5 + aSeed * 1.2) + 60.0, 120.0) - 60.0; p.x += sin(uT * 0.13 + aSeed * 40.0) * 4.0; p.z += cos(uT * 0.11 + aSeed * 23.0) * 4.0; vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uPx / max(1.0, -mv.z); vA = smoothstep(60.0, 42.0, abs(p.y)) * smoothstep(320.0, 40.0, -mv.z) * smoothstep(2.0, 14.0, -mv.z) * (0.3 + 0.7 * fract(aSeed * 7.13)) * (0.65 + 0.35 * sin(uT * 1.3 + aSeed * 50.0)); }';
const DUST_FS = 'uniform vec3 uC; uniform float uO; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(uC, a * vA * uO); }';

export async function mountScene(host, store, api) {
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2')) throw new Error('WebGL 2 is not available on this device');
  const report = f => api.onProgress && api.onProgress(f);
  const libs = Promise.all([SRC.react, SRC.three, SRC.gltf, SRC.fiber, SRC.drei, SRC.htm].map(u => import(u)));
  const bytes = fetchBytes(api.modelUrl, f => report(f * 0.9));
  const [[RM, THREE, GLM, FIBER, DREI, HTM], buf] = await Promise.all([libs, bytes]);
  const React = RM.default || RM;
  const html = (HTM.default || HTM).bind(React.createElement);
  const { useFrame, useThree } = FIBER;
  const { Environment, Lightformer, ContactShadows, PerformanceMonitor, Bvh } = DREI;
  const gltf = await new Promise((res, rej) => new GLM.GLTFLoader().parse(buf, '', res, rej));
  report(0.96);
  const model = buildModel(THREE, gltf, api.classify, api.defs, api.order);
  const tier = store.tier;
  const D2R = Math.PI / 180, noRay = () => {};
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = x => x * x * (3 - 2 * x);
  const eio = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const shared = { down: null };
  const frameInfo = { labels: 0, cx: 0, cy: 0, w: 1, h: 1, hov: null, items: api.order.map(id => ({ id, ax: 0, ay: 0 })) };

  class Boundary extends React.Component {
    constructor(p) { super(p); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    componentDidCatch(err) { api.onError && api.onError(err); }
    render() { return this.state.err ? null : this.props.children; }
  }

  function Rig() {
    const gl = useThree(s => s.gl), scene = useThree(s => s.scene), camera = useThree(s => s.camera);
    const R = React.useRef({ fx: [] }).current;
    const S = React.useRef({ ppx: 0, ppy: 0, yaw: 0, pitch: 0, vyaw: 0, vpitch: 0, focus: 0, userEx: 0, lastInput: 0, drag: null, pick: null, hover: null, cursor: '', first: true, selT: null, selD: 30 }).current;
    const T = React.useMemo(() => ({ v: new THREE.Vector3(), fw: new THREE.Vector3(), up: new THREE.Vector3(), rt: new THREE.Vector3() }), []);
    const U = React.useMemo(() => ({
      glow: { uC: { value: new THREE.Color(1, 0.3, 0.12) }, uO: { value: 0 } },
      beam: { uO: { value: 0 } },
      grid: { uO: { value: 0 }, uA: { value: new THREE.Color(1, 0.3, 0.12) }, uL: { value: new THREE.Color(0.95, 0.92, 0.88) } },
      dust: { uT: { value: 0 }, uO: { value: 0 }, uPx: { value: 200 }, uC: { value: new THREE.Color(1, 0.88, 0.8) } },
    }), []);
    const dustGeo = React.useMemo(() => {
      const n = tier.dust, pos = new Float32Array(n * 3), seed = new Float32Array(n), size = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 240; pos[i * 3 + 1] = (Math.random() - 0.5) * 120; pos[i * 3 + 2] = (Math.random() - 0.5) * 240 - 30;
        seed[i] = Math.random(); size[i] = 0.5 + Math.pow(Math.random(), 3) * 2.6;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      return g;
    }, []);

    React.useEffect(() => {
      const an = Math.min(8, gl.capabilities.getMaxAnisotropy());
      model.textures.forEach(tx => { tx.anisotropy = an; tx.needsUpdate = true; });
      const el = gl.domElement;
      const down = e => {
        shared.down = { x: e.clientX, y: e.clientY };
        if ((store.k.orbit || 0) > 0.5) { S.drag = { x: e.clientX, y: e.clientY }; try { el.setPointerCapture(e.pointerId); } catch (_) {} el.style.cursor = 'grabbing'; S.cursor = 'grabbing'; }
      };
      const move = e => {
        if (!S.drag) return;
        const dx = e.clientX - S.drag.x, dy = e.clientY - S.drag.y;
        S.drag = { x: e.clientX, y: e.clientY };
        S.vyaw = dx * 0.006; S.vpitch = dy * 0.004;
        S.yaw += S.vyaw; S.pitch = clamp(S.pitch + S.vpitch, -0.5, 0.6);
        S.lastInput = performance.now();
      };
      const up = () => { if (S.drag) { S.drag = null; S.vpitch = 0; el.style.cursor = 'grab'; S.cursor = 'grab'; } };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      return () => {
        el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        dustGeo.dispose();
      };
    }, [gl]);

    const setCursor = c => { if (S.cursor !== c && !S.drag) { S.cursor = c; gl.domElement.style.cursor = c; } };
    const hitLabel = e => { for (const h of e.intersections) { const m = h.object; if (m.userData.label && m.material.opacity > 0.5) return m.userData.label; } return null; };
    const onMove = e => { if (!store.kPick) return; e.stopPropagation(); S.hover = hitLabel(e); setCursor(S.hover ? 'pointer' : (store.k.orbit > 0.5 ? 'grab' : '')); };
    const onOut = () => { S.hover = null; setCursor(store.k.orbit > 0.5 ? 'grab' : ''); };
    const onClick = e => { e.stopPropagation(); if (!store.kPick || e.delta > 6) return; const id = hitLabel(e); if (id) api.onPick(id); else api.onMiss(); };

    useFrame((state, delta) => {
      if (S.first) { S.first = false; api.onReady && api.onReady({ stats: model.stats, centers: model.centers, pieces: model.pieceCount }); }
      const k = store.k, grp = R.group;
      if (!grp || k.az === undefined || store.paused) return;
      const dt = Math.min(0.05, delta), now = performance.now(), time = state.clock.elapsedTime;
      const w = state.size.width, h = state.size.height, aspect = w / Math.max(1, h);
      const red = store.reduced, mob = store.mobile, sel = store.sel, intro = store.intro;

      const kPick = k.pick > 0.5 || (k.orbit > 0.5 && S.userEx > 0.9);
      store.kPick = kPick;
      if (kPick !== S.pick) {
        S.pick = kPick;
        for (const p of model.parts) { if (!p.mesh) continue; if (!p.ray) p.ray = p.mesh.raycast; p.mesh.raycast = kPick ? p.ray : noRay; }
        if (!kPick) { S.hover = null; setCursor(k.orbit > 0.5 ? 'grab' : ''); }
      }
      if (!S.hover && !S.drag) setCursor(k.orbit > 0.5 ? 'grab' : '');

      const pt = store.props.pointerTilt && !red ? k.pointer : 0;
      const a = Math.min(1, dt * 2.4);
      S.ppx += (store.px - S.ppx) * a; S.ppy += (store.py - S.ppy) * a;
      if (!S.drag) {
        S.yaw += S.vyaw; S.vyaw *= 0.93;
        S.pitch = clamp(S.pitch + S.vpitch, -0.5, 0.6); S.vpitch *= 0.9;
        if (k.orbit > 0.5 && !red && now - S.lastInput > 2500) S.yaw += dt * 0.12;
      }
      S.yaw = Math.atan2(Math.sin(S.yaw), Math.cos(S.yaw));
      const tE = store.userEx ? 1 : 0;
      S.userEx += Math.sign(tE - S.userEx) * Math.min(Math.abs(tE - S.userEx), dt * (red ? 3 : 0.55));

      const sc = store.props.explodeScale;
      const e = Math.max(k.e, S.userEx * k.orbit);
      const labelsF = Math.max(k.labels, smooth(clamp((S.userEx - 0.85) / 0.15)) * k.orbit);
      grp.rotation.set(k.mrx + S.ppy * 0.08 * pt + S.pitch * k.orbit, k.mry + S.ppx * 0.2 * pt + S.yaw * k.orbit, k.mrz);
      grp.position.set(k.mx, k.my + (red ? 0 : Math.sin(time * 0.7) * 0.35 * (1 - e) * pt), k.mz);
      grp.scale.setScalar(k.ms);

      const hov = store.hoverDom || S.hover;
      for (const p of model.parts) {
        const m = p.mesh; if (!m) continue;
        const d = p.def;
        const l = eio(clamp((e - d.w[0]) / (d.w[1] - d.w[0]))), s = Math.sin(Math.PI * l);
        m.position.set(
          p.center[0] + (d.vec[0] * l + d.bump[0] * s) * sc,
          p.center[1] + (d.vec[1] * l + d.bump[1] * s) * sc,
          p.center[2] + (d.vec[2] * l + d.bump[2] * s) * sc);
        m.rotation.set(d.rot[0] * l, d.rot[1] * l, d.rot[2] * l);
        const isSel = sel === p.label;
        p.hover += ((hov === p.label ? 1 : 0) - p.hover) * Math.min(1, dt * 8);
        p.mat.emissiveIntensity = s * 0.12 + p.hover * 0.2 + (isSel ? 0.1 + 0.05 * Math.sin(time * 3) : 0);
        p.dim += ((sel && !isSel ? 0.12 : 1) - p.dim) * Math.min(1, dt * 5);
        const tr = p.dim < 0.995;
        if (p.mat.transparent !== tr) { p.mat.transparent = tr; p.mat.depthWrite = !tr; p.mat.needsUpdate = true; }
        p.mat.opacity = p.dim;
      }
      grp.updateMatrixWorld(true);

      // camera: scroll pose → aspect fit → optional focus on the selected part
      const fit = aspect < 1.3 ? Math.pow(1.3 / aspect, 0.85) : 1;
      let tx = k.tx, ty = k.ty, tz = k.tz;
      let dist = k.dist * fit * (1 + 0.6 * (1 - intro));
      let shift = mob ? 0 : k.shift, shiftY = mob ? 0.08 : 0;
      S.focus += ((sel ? 1 : 0) - S.focus) * Math.min(1, dt * 3);
      if (sel) {
        const ap = model.byName[api.anchors[sel]];
        if (ap && ap.mesh) { T.v.set(0, 0, 0); ap.mesh.localToWorld(T.v); S.selT = [T.v.x, T.v.y, T.v.z]; S.selD = ((model.stats[sel] ? model.stats[sel].radius : 8) * 2.4 + 16) * fit; }
      }
      const fE = smooth(clamp(S.focus));
      if (fE > 0.001 && S.selT) {
        tx += (S.selT[0] - tx) * fE; ty += (S.selT[1] - ty) * fE; tz += (S.selT[2] - tz) * fE;
        dist += (S.selD - dist) * fE;
        shift += ((mob ? 0 : -0.13) - shift) * fE; shiftY += ((mob ? 0.2 : 0) - shiftY) * fE;
      }
      const az = (k.az + S.ppx * 3 * pt) * D2R, el = (k.el - S.ppy * 2 * pt) * D2R;
      camera.position.set(tx + Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, tz + Math.cos(az) * Math.cos(el) * dist);
      camera.lookAt(tx, ty, tz);
      camera.fov = k.fov; camera.aspect = aspect;
      camera.near = Math.max(0.05, dist * 0.02); camera.far = dist + 420;
      camera.setViewOffset(w, h, -shift * w, shiftY * h, w, h);
      camera.updateProjectionMatrix(); camera.updateMatrixWorld();

      // camera-relative lighting rig
      const L = k.light * intro;
      R.key.intensity = 2.4 * L; R.rim2.intensity = 0.9 * L; R.hemi.intensity = 0.22 * L;
      R.rim.color.setRGB(k.rr, k.rg, k.rb, THREE.SRGBColorSpace);
      R.rim.intensity = 2.6 * (0.4 + 0.6 * intro);
      scene.environmentIntensity = (0.12 + 0.7 * L) * (store.light ? 1.2 : 1);
      const fw = camera.getWorldDirection(T.fw), up = T.up.set(0, 1, 0).applyQuaternion(camera.quaternion), rt = T.rt.set(1, 0, 0).applyQuaternion(camera.quaternion);
      const place = (lt, x, y, z) => {
        lt.position.set(tx + (rt.x * x + up.x * y - fw.x * z) * 50, ty + (rt.y * x + up.y * y - fw.y * z) * 50, tz + (rt.z * x + up.z * y - fw.z * z) * 50);
        lt.target.position.set(tx, ty, tz); lt.target.updateMatrixWorld();
      };
      place(R.key, -0.6, 0.9, 0.75); place(R.rim, 0.65, 0.4, -1); place(R.rim2, -0.75, 0.25, -0.9);

      R.glow.position.set(tx + fw.x * 30, ty + fw.y * 30, tz + fw.z * 30);
      R.glow.quaternion.copy(camera.quaternion);
      const lt = !!store.light;
      U.glow.uO.value = k.glow * 0.5 * intro * (1 - 0.55 * k.e) * (lt ? 0.6 : 1);
      U.glow.uC.value.setRGB(k.rr, k.rg, k.rb, THREE.SRGBColorSpace);
      R.beam.position.set(tx, ty + 50, tz - 4);
      U.beam.uO.value = k.beam * 0.07 * intro;
      U.grid.uO.value = k.grid * (lt ? 0.8 : 1);
      if (lt) U.grid.uL.value.setRGB(0.22, 0.19, 0.17); else U.grid.uL.value.setRGB(0.95, 0.92, 0.88);
      U.grid.uA.value.setRGB(k.rr, k.rg, k.rb, THREE.SRGBColorSpace);
      U.dust.uT.value = time;
      U.dust.uO.value = (store.props.particles && !red ? (lt ? 0.45 : 0.7) : 0) * intro;
      if (lt) U.dust.uC.value.setRGB(0.45, 0.22, 0.14); else U.dust.uC.value.setRGB(1, 0.88, 0.8);
      U.dust.uPx.value = 210 * gl.getPixelRatio() * (h / 900);

      if (k.vis > 0.003) {
        for (const o of R.fx) o.visible = true;
        gl.render(scene, camera);
        for (const o of R.fx) o.visible = false; // keeps glow/dust out of the contact-shadow depth pass
      }

      frameInfo.labels = labelsF; frameInfo.w = w; frameInfo.h = h; frameInfo.hov = hov;
      if (labelsF > 0.01) {
        T.v.set(tx, ty, tz).project(camera);
        frameInfo.cx = (T.v.x + 1) / 2 * w; frameInfo.cy = (1 - T.v.y) / 2 * h;
        for (const it of frameInfo.items) {
          const p = model.byName[api.anchors[it.id]]; if (!p || !p.mesh) continue;
          const an = p.def.anchor;
          T.v.set(an[0], an[1], an[2]); p.mesh.localToWorld(T.v); T.v.project(camera);
          it.ax = (T.v.x + 1) / 2 * w; it.ay = (1 - T.v.y) / 2 * h;
        }
      }
      api.frame && api.frame(frameInfo);
    }, 1);

    const fx = o => { if (o && !R.fx.includes(o)) R.fx.push(o); };
    return html`<${React.Fragment}>
      <${Bvh} firstHitOnly=${false}>
        <group ref=${o => { R.group = o; }} onPointerMove=${onMove} onPointerOut=${onOut} onClick=${onClick}>
          ${model.parts.map(p => html`<mesh key=${p.name} ref=${o => { p.mesh = o; if (o) o.userData.label = p.label; }} geometry=${p.geometry} material=${p.mat} position=${p.center} />`)}
        </group>
      <//>
      <hemisphereLight ref=${o => { R.hemi = o; }} args=${[0xffffff, 0x1d1714, 0.2]} />
      <directionalLight ref=${o => { R.key = o; }} color="#fff3e8" intensity=${2.3} />
      <directionalLight ref=${o => { R.rim = o; }} color="#ff5a2a" intensity=${3.4} />
      <directionalLight ref=${o => { R.rim2 = o; }} color="#c4d6ff" intensity=${0.9} />
      <mesh ref=${o => { R.glow = o; fx(o); }} renderOrder=${-2}>
        <planeGeometry args=${[150, 150]} />
        <shaderMaterial transparent=${true} depthWrite=${false} uniforms=${U.glow} vertexShader=${VTX} fragmentShader=${GLOW_FS} />
      </mesh>
      <mesh ref=${o => { R.beam = o; fx(o); }} renderOrder=${-1}>
        <cylinderGeometry args=${[1.2, 30, 120, 64, 1, true]} />
        <shaderMaterial transparent=${true} depthWrite=${false} side=${THREE.DoubleSide} uniforms=${U.beam} vertexShader=${BEAM_VS} fragmentShader=${BEAM_FS} />
      </mesh>
      <mesh ref=${o => { R.grid = o; fx(o); }} rotation-x=${-Math.PI / 2} position-y=${-19}>
        <planeGeometry args=${[500, 500]} />
        <shaderMaterial transparent=${true} depthWrite=${false} uniforms=${U.grid} vertexShader=${GRID_VS} fragmentShader=${GRID_FS} />
      </mesh>
      <points ref=${o => { R.dust = o; fx(o); }} geometry=${dustGeo} frustumCulled=${false}>
        <shaderMaterial transparent=${true} depthWrite=${false} uniforms=${U.dust} vertexShader=${DUST_VS} fragmentShader=${DUST_FS} />
      </points>
    <//>`;
  }

  // Contact shadow only mounts while the floor is visible, so its depth pass costs nothing elsewhere.
  function Shadow() {
    const [on, setOn] = React.useState(false);
    const ref = React.useRef(null), cur = React.useRef(false);
    useFrame(() => {
      const k = store.k, want = !store.paused && !store.noRaf && (k.grid || 0) > 0.02 && (k.vis || 0) > 0.02;
      if (want !== cur.current) { cur.current = want; setOn(want); }
      const m = ref.current && ref.current.children && ref.current.children[0];
      if (m && m.material) m.material.opacity = 0.6 * (k.grid || 0) * (k.vis || 0);
    });
    return on ? html`<${ContactShadows} ref=${ref} position=${[0, -18.9, 0]} scale=${160} resolution=${512} blur=${2.4} far=${15} opacity=${0.6} color="#000000" frames=${Infinity} />` : null;
  }

  const GL_OPTS = { antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: true };
  const CAM_OPTS = { fov: 30, near: 0.1, far: 1000, position: [0, 0, 120] };

  function App() {
    const setDpr = useThree(st => st.setDpr);
    return html`<${React.Fragment}>
      <${PerformanceMonitor} flipflops=${3} onDecline=${() => setDpr(1)} onIncline=${() => setDpr([1, tier.dpr])} onFallback=${() => setDpr(1)} />
      <${Environment} resolution=${tier.envRes} frames=${1}>
        <color attach="background" args=${['#080808']} />
        <${Lightformer} form="rect" intensity=${4} color="#fffaf4" position=${[0, 46, 8]} scale=${[60, 26, 1]} target=${[0, 0, 0]} />
        <${Lightformer} form="rect" intensity=${2.3} color="#eef1ff" position=${[-46, 4, 16]} scale=${[10, 50, 1]} target=${[0, 0, 0]} />
        <${Lightformer} form="rect" intensity=${3.2} color="#ff5020" position=${[46, 6, -22]} scale=${[10, 50, 1]} target=${[0, 0, 0]} />
        <${Lightformer} form="rect" intensity=${1.1} color="#ffffff" position=${[0, -14, 46]} scale=${[44, 8, 1]} target=${[0, 0, 0]} />
      <//>
      <${Rig} />
      ${tier.shadows ? html`<${Shadow} />` : null}
    <//>`;
  }

  // R3F's createRoot API on our own canvas: sized from the viewport, so start-up never waits on a ResizeObserver.
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:pan-y';
  host.appendChild(canvas);
  FIBER.extend(THREE);
  const root = FIBER.createRoot(canvas);
  const size = () => ({ width: host.clientWidth || innerWidth, height: host.clientHeight || innerHeight, top: 0, left: 0 });
  const onMissed = ev => {
    const d = shared.down;
    if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6) return;
    if (store.kPick) api.onMiss();
  };
  const onCreated = st => {
    st.gl.setClearColor(0x000000, 0);
    st.gl.toneMappingExposure = 1.05;
    st.gl.domElement.addEventListener('webglcontextlost', ev => { ev.preventDefault(); api.onError && api.onError(new Error('The WebGL context was lost')); });
  };
  root.configure({ gl: GL_OPTS, camera: CAM_OPTS, dpr: [1, tier.dpr], size: size(), events: FIBER.events, frameloop: 'always', onCreated, onPointerMissed: onMissed });
  root.render(html`<${Boundary}><${App} /><//>`);
  const onResize = () => root.configure({ size: size() });
  window.addEventListener('resize', onResize);
  return {
    unmount() { window.removeEventListener('resize', onResize); root.unmount(); model.dispose(); canvas.remove(); },
    advance: t => FIBER.advance(t),
    versions: V,
  };
}
