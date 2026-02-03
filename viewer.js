import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const SYSTEMS = {
  bones:   { fbx: './assets/bones.fbx',   groups: './meta/bones_groups.json'   },
  muscles: { fbx: './assets/muscles.fbx', groups: './meta/muscles_groups.json' },
  nerves:  { fbx: './assets/nerves.fbx',  groups: './meta/nerves_groups.json'  },
  vessels: { fbx: './assets/vessels.fbx', groups: './meta/vessels_groups.json' },
  organs:  { fbx: './assets/organs.fbx',  groups: './meta/organs_groups.json'  }
};

// Readability colors (geometry is the scientifically-accurate part; these are just display tints)
const SYS_COLOR = {
  bones:   0xbfc5cc,
  muscles: 0x8f3f3f,
  nerves:  0xb7b04a,
  vessels: 0x2b6cff,
  organs:  0x3aa16a,
};

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 2000);
camera.position.set(0, 1.4, 4.2);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;     // zero inertia, per your preference
controls.enableZoom = true;
controls.enablePan = true;
controls.target.set(0, 1.2, 0);
controls.touches.ONE = THREE.TOUCH.ROTATE;
controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
controls.update();

const hemi = new THREE.HemisphereLight(0xffffff, 0x1a2633, 1.0);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(2.5, 6, 3.0);
scene.add(dir);

const loader = new FBXLoader();

const infoEl = document.getElementById('info');
const chipsEl = document.getElementById('chips');
const searchEl = document.getElementById('search');
const clearSearchEl = document.getElementById('clearSearch');
const clearSelEl = document.getElementById('clearSel');

const sysButtons = Array.from(document.querySelectorAll('[data-sys]'));

const metaCache = new Map();   // sysKey -> groups json
const loaded = new Map();      // sysKey -> { root, rawToMeshes(Map), baseMat }

let worldOffset = null;        // THREE.Vector3
let currentSystemForSearch = 'muscles';

const highlightMat = new THREE.MeshStandardMaterial({
  color: 0xff3b30,
  roughness: 0.55,
  metalness: 0.0,
  emissive: new THREE.Color(0x2a0500),
  emissiveIntensity: 1.0,
  side: THREE.DoubleSide,
  depthTest: true,
  depthWrite: true,
});

let selectedMeshes = [];
let selectedChipKey = null;

function setInfo(html) {
  infoEl.innerHTML = html;
}

function setSystemButtonState() {
  sysButtons.forEach(btn => {
    const k = btn.dataset.sys;
    btn.classList.toggle('on', loaded.has(k));
  });
}

function disposeObject3D(root) {
  root.traverse(obj => {
    if (!obj.isMesh) return;
    if (obj.geometry) obj.geometry.dispose?.();
    // materials are shared base mats; do not dispose highlightMat
    const mat = obj.material;
    if (Array.isArray(mat)) mat.forEach(m => m?.dispose?.());
    else mat?.dispose?.();
  });
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'force-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.json();
}

async function ensureGroups(sysKey) {
  if (metaCache.has(sysKey)) return metaCache.get(sysKey);
  const groups = await fetchJson(SYSTEMS[sysKey].groups);
  metaCache.set(sysKey, groups);
  return groups;
}

function computeOffsetFromObject(root) {
  const box = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  box.getCenter(center);
  return center;
}

function fitCameraToObject(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const maxSize = Math.max(size.x, size.y, size.z);
  const fitHeightDistance = maxSize / (2 * Math.tan((Math.PI * camera.fov) / 360));
  const fitWidthDistance = fitHeightDistance / camera.aspect;
  const distance = 1.15 * Math.max(fitHeightDistance, fitWidthDistance);

  const dir = new THREE.Vector3(0, 0, 1);
  camera.position.copy(center).add(dir.multiplyScalar(distance));
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

async function loadSystem(sysKey) {
  if (loaded.has(sysKey)) return;

  setInfo(`<small>Loading:</small> ${sysKey}…`);

  const baseMat = new THREE.MeshStandardMaterial({
    color: SYS_COLOR[sysKey] ?? 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
  });

  const root = await new Promise((resolve, reject) => {
    loader.load(
      SYSTEMS[sysKey].fbx,
      obj => resolve(obj),
      undefined,
      err => reject(err)
    );
  });

  // Ensure consistent alignment across separately loaded systems:
  if (worldOffset == null) {
    worldOffset = computeOffsetFromObject(root);
  }
  root.position.sub(worldOffset);

  const rawToMeshes = new Map();

  root.traverse(obj => {
    if (!obj.isMesh) return;

    // Force a single readable material per system (keeps selection/highlighting stable)
    obj.material = baseMat;
    obj.userData.baseMat = baseMat;
    obj.userData.system = sysKey;

    // Use mesh name as key (it matches your raw Model names like "...rModel")
    const raw = obj.name || '';
    obj.userData.raw = raw;

    if (!rawToMeshes.has(raw)) rawToMeshes.set(raw, []);
    rawToMeshes.get(raw).push(obj);
  });

  scene.add(root);
  loaded.set(sysKey, { root, rawToMeshes, baseMat });

  // Fit camera on first load
  if (loaded.size === 1) {
    fitCameraToObject(root);
  }

  setSystemButtonState();
  setInfo(`<small>Loaded:</small> ${[...loaded.keys()].join(', ')}. Tap a part to select. Search targets muscles.`);

  // If we load muscles, refresh chips UI
  if (sysKey === currentSystemForSearch) renderChipsFromSearch();
}

function unloadSystem(sysKey) {
  const entry = loaded.get(sysKey);
  if (!entry) return;

  // clear selection that uses meshes from this system
  clearSelection();

  scene.remove(entry.root);
  disposeObject3D(entry.root);
  loaded.delete(sysKey);

  setSystemButtonState();
  setInfo(`<small>Loaded:</small> ${loaded.size ? [...loaded.keys()].join(', ') : '(none)'}`);
}

function clearSelection() {
  // Restore base materials for selected meshes
  for (const m of selectedMeshes) {
    if (m && m.userData && m.userData.baseMat) {
      m.material = m.userData.baseMat;
    }
  }
  selectedMeshes = [];

  // Un-highlight chip
  selectedChipKey = null;
  Array.from(chipsEl.querySelectorAll('.chip.on')).forEach(el => el.classList.remove('on'));
}

function selectMeshes(meshes, labelHtml) {
  clearSelection();
  selectedMeshes = meshes.filter(Boolean);

  for (const m of selectedMeshes) {
    m.material = highlightMat;
  }

  const extra = selectedMeshes.length ? ` <small>(${selectedMeshes.length} mesh${selectedMeshes.length>1?'es':''})</small>` : '';
  setInfo(labelHtml + extra);
}

function pick(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = -(((clientY - rect.top) / rect.height) * 2 - 1);

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);

  // Intersect against all loaded roots (recursive)
  const roots = [...loaded.values()].map(v => v.root);
  const hits = raycaster.intersectObjects(roots, true);
  if (!hits.length) {
    clearSelection();
    setInfo(`<small>No selection.</small>`);
    return;
  }

  // Find the first mesh hit
  let obj = hits[0].object;
  while (obj && !obj.isMesh) obj = obj.parent;
  if (!obj) return;

  const sysKey = obj.userData.system || 'unknown';
  const raw = obj.userData.raw || obj.name || '(unnamed)';
  selectMeshes([obj], `<small>Selected:</small> <b>${raw}</b> <small>(${sysKey})</small>`);
}

let down = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
}, { passive: true });

canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const dx = e.clientX - down.x;
  const dy = e.clientY - down.y;
  down = null;

  // treat as tap if finger didn’t move much
  if ((dx*dx + dy*dy) <= 36) pick(e.clientX, e.clientY);
}, { passive: true });

async function renderChipsFromSearch() {
  const q = (searchEl.value || '').trim().toLowerCase();
  chipsEl.innerHTML = '';

  const groups = await ensureGroups(currentSystemForSearch);

  // Build list [{key, name, variants}]
  const items = Object.entries(groups).map(([k, v]) => ({
    key: k,
    name: v.name || k,
    variants: v.variants || {}
  }));

  let filtered = items;
  if (q) {
    filtered = items.filter(it => it.name.toLowerCase().includes(q) || it.key.includes(q));
  }

  // Sort shortest-first then alpha (your preference)
  filtered.sort((a,b) => (a.name.length - b.name.length) || a.name.localeCompare(b.name));

  // Limit chips to keep UI snappy
  filtered = filtered.slice(0, 140);

  for (const it of filtered) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = it.name;

    chip.addEventListener('click', () => {
      // Toggle chip selection
      if (selectedChipKey === it.key) {
        clearSelection();
        setInfo(`<small>Selection cleared.</small>`);
        return;
      }

      // Need muscles loaded to highlight muscles
      if (!loaded.has('muscles')) {
        setInfo(`<small>Load Muscles first, then search/select muscles.</small>`);
        return;
      }

      // Mark chip on
      Array.from(chipsEl.querySelectorAll('.chip.on')).forEach(el => el.classList.remove('on'));
      chip.classList.add('on');
      selectedChipKey = it.key;

      const mus = loaded.get('muscles');
      const rawToMeshes = mus.rawToMeshes;

      const raws = [
        ...(it.variants.L || []),
        ...(it.variants.R || []),
        ...(it.variants.M || []),
        ...(it.variants.G || []),
      ];

      const meshes = [];
      for (const raw of raws) {
        const arr = rawToMeshes.get(raw);
        if (arr) meshes.push(...arr);
      }

      if (!meshes.length) {
        setInfo(`<small>Found in meta, but not currently loaded as meshes:</small> <b>${it.name}</b>`);
        return;
      }

      selectMeshes(meshes, `<small>Selected group:</small> <b>${it.name}</b>`);
    });

    chipsEl.appendChild(chip);
  }
}

searchEl.addEventListener('input', () => renderChipsFromSearch());
clearSearchEl.addEventListener('click', () => { searchEl.value = ''; renderChipsFromSearch(); });

clearSelEl.addEventListener('click', () => {
  clearSelection();
  setInfo(`<small>Selection cleared.</small>`);
});

sysButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    const sysKey = btn.dataset.sys;
    if (!SYSTEMS[sysKey]) return;

    if (loaded.has(sysKey)) {
      unloadSystem(sysKey);
    } else {
      await loadSystem(sysKey);
    }
  });
});

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}, { passive: true });

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();

// Default load: bones + muscles (you can toggle others)
(async () => {
  await loadSystem('bones');
  await loadSystem('muscles');
  renderChipsFromSearch();
})();
