import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const SYSTEMS = {
  bones:   { label: 'Bones',   fbx: './assets/bones.fbx',   groups: './meta/bones_groups.json'   },
  muscles: { label: 'Muscles', fbx: './assets/muscles.fbx', groups: './meta/muscles_groups.json' },
  nerves:  { label: 'Nerves',  fbx: './assets/nerves.fbx',  groups: './meta/nerves_groups.json'  },
  vessels: { label: 'Vessels', fbx: './assets/vessels.fbx', groups: './meta/vessels_groups.json' },
  organs:  { label: 'Organs',  fbx: './assets/organs.fbx',  groups: './meta/organs_groups.json'  },
};

const el = {
  canvas: document.getElementById('c'),
  chips: document.getElementById('chips'),
  filter: document.getElementById('filter'),
  clearFilterBtn: document.getElementById('clearFilterBtn'),
  clearSelectionBtn: document.getElementById('clearSelectionBtn'),
  status: document.getElementById('status'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText'),
};

let scene, camera, renderer, controls;
let modelRoot = null;

// Mesh index
let meshList = [];
let meshByKey = new Map(); // key -> Mesh[]

// Group index (deduped)
let groupByKey = new Map(); // key -> { key, name, meshKeys:Set<string> }

let selectedGroupKeys = new Set();
let activeSystem = 'muscles';
let loadToken = 0;

function setStatus(msg) {
  if (el.status) el.status.textContent = msg;
}

function setLoading(show, msg = 'Loading…') {
  if (!el.loading) return;
  el.loading.classList.toggle('show', !!show);
  if (el.loadingText) el.loadingText.textContent = msg;
}

function normalizeLabel(raw) {
  let s = String(raw ?? '').replace(/\u0000/g, '').trim();
  if (!s) return '';

  // Strip FBX exporter suffixes
  s = s.replace(/(Model|Geometry)$/i, '').trim();

  // Strip common side/group suffix .l / .r / .j (case-insensitive)
  const m = s.match(/^(.*)\.([lrj])$/i);
  if (m) s = m[1].trim();

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

function slugify(raw) {
  const s = normalizeLabel(raw).toLowerCase();
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function partKeyFromName(rawName) {
  return slugify(rawName);
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function buildGroupIndex(groupsJson) {
  groupByKey.clear();

  const entries = Object.entries(groupsJson || {});
  for (const [k, v] of entries) {
    const name =
      v && typeof v.name === 'string' && v.name.trim().length
        ? v.name.trim()
        : String(k);

    const groupKey = slugify(name);
    if (!groupKey) continue;

    const meshKeys = new Set();
    // Use variants to allow composite groups (like hip flexors) to map to multiple meshes
    if (v && typeof v.variants === 'object' && v.variants) {
      for (const arr of Object.values(v.variants)) {
        if (!Array.isArray(arr)) continue;
        for (const raw of arr) {
          const mk = slugify(raw);
          if (mk) meshKeys.add(mk);
        }
      }
    }

    // Also allow direct name -> meshKey matching
    meshKeys.add(groupKey);

    if (!groupByKey.has(groupKey)) {
      groupByKey.set(groupKey, { key: groupKey, name, meshKeys });
    } else {
      const g = groupByKey.get(groupKey);
      for (const mk of meshKeys) g.meshKeys.add(mk);
    }
  }
}

function renderChips() {
  if (!el.chips) return;
  el.chips.innerHTML = '';

  const groups = Array.from(groupByKey.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );

  for (const g of groups) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = g.name;
    b.dataset.key = g.key;
    b.dataset.search = slugify(g.name);
    b.addEventListener('click', () => toggleGroup(g.key));
    el.chips.appendChild(b);
  }

  updateChipSelectionUI();
  applyFilter(el.filter ? el.filter.value : '');
}

function updateChipSelectionUI() {
  if (!el.chips) return;
  const chips = el.chips.querySelectorAll('.chip');
  for (const c of chips) {
    const k = c.dataset.key || '';
    c.classList.toggle('selected', selectedGroupKeys.has(k));
  }
}

function applyFilter(text) {
  if (!el.chips) return;
  const q = slugify(text || '');
  const chips = el.chips.querySelectorAll('.chip');
  for (const c of chips) {
    if (!q) {
      c.hidden = false;
      continue;
    }
    const sk = c.dataset.search || '';
    c.hidden = !sk.includes(q);
  }
}

function toggleGroup(key) {
  if (!key) return;
  if (selectedGroupKeys.has(key)) selectedGroupKeys.delete(key);
  else selectedGroupKeys.add(key);

  updateChipSelectionUI();
  applySelectionToMeshes();
}

function clearSelection() {
  selectedGroupKeys.clear();
  updateChipSelectionUI();
  applySelectionToMeshes();
}

function computeSelectedMeshKeys() {
  const out = new Set();
  for (const gk of selectedGroupKeys) {
    const g = groupByKey.get(gk);
    if (g && g.meshKeys && g.meshKeys.size) {
      for (const mk of g.meshKeys) out.add(mk);
    } else {
      // If selection came from mesh picking but group meta doesn't include it, still support it
      out.add(gk);
    }
  }
  return out;
}

function snapshotMaterial(m) {
  return {
    hasColor: !!m.color,
    color: m.color ? m.color.clone() : null,
    hasEmissive: !!m.emissive,
    emissive: m.emissive ? m.emissive.clone() : null,
    opacity: typeof m.opacity === 'number' ? m.opacity : 1.0,
    transparent: !!m.transparent,
    depthWrite: 'depthWrite' in m ? !!m.depthWrite : true,
    depthTest: 'depthTest' in m ? !!m.depthTest : true,
  };
}

function ensureUniqueMaterials(mesh) {
  // Clone per-mesh materials so selection changes do not affect other meshes sharing the same material object.
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const cloned = mats.map((m) => (m && m.clone ? m.clone() : null));

  // If there were null materials, replace with a basic one
  for (let i = 0; i < cloned.length; i++) {
    if (!cloned[i]) cloned[i] = new THREE.MeshStandardMaterial({ color: 0x888888 });
  }

  mesh.userData._matBase = cloned.map(snapshotMaterial);

  mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
}

function setMeshState(mesh, state) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const base = mesh.userData._matBase || [];

  for (let i = 0; i < mats.length; i++) {
    const m = mats[i];
    if (!m) continue;

    const o = base[i] || null;

    if (state === 'base') {
      if (o) {
        if (m.color && o.color) m.color.copy(o.color);
        if (m.emissive && o.emissive) m.emissive.copy(o.emissive);
        m.opacity = o.opacity;
        m.transparent = o.transparent;
        if ('depthWrite' in m) m.depthWrite = o.depthWrite;
        if ('depthTest' in m) m.depthTest = o.depthTest;
      }
    } else if (state === 'dim') {
      if (m.color) m.color.set(0x444444);
      if (m.emissive) m.emissive.set(0x000000);
      m.transparent = true;
      m.opacity = 0.07;
      if ('depthWrite' in m) m.depthWrite = false;
      if ('depthTest' in m) m.depthTest = true;
    } else if (state === 'sel') {
      // preserve base color, add emissive highlight
      if (o && m.color && o.color) m.color.copy(o.color);
      if (m.emissive) m.emissive.set(0xff2222);
      m.transparent = false;
      m.opacity = 1.0;
      if ('depthWrite' in m) m.depthWrite = true;
      if ('depthTest' in m) m.depthTest = true;
    }

    m.needsUpdate = true;
  }

  mesh.renderOrder = state === 'sel' ? 2 : 0;
}

function applySelectionToMeshes() {
  const selectedMeshKeys = computeSelectedMeshKeys();
  const hasSelection = selectedMeshKeys.size > 0;

  let highlighted = 0;

  for (const mesh of meshList) {
    const mk = mesh.userData.partKey || '';
    if (!hasSelection) {
      setMeshState(mesh, 'base');
      continue;
    }
    if (mk && selectedMeshKeys.has(mk)) {
      setMeshState(mesh, 'sel');
      highlighted++;
    } else {
      setMeshState(mesh, 'dim');
    }
  }

  setStatus(
    `${SYSTEMS[activeSystem].label}: meshes=${meshList.length}  selected_groups=${selectedGroupKeys.size}  highlighted_meshes=${highlighted}`
  );
}

function disposeObject(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (obj && obj.isMesh) {
      if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m && m.dispose) m.dispose();
      }
    }
  });
}

function fitCameraToObject(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // Center root at origin
  root.position.sub(center);
  controls.target.set(0, 0, 0);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = (camera.fov * Math.PI) / 180.0;
  const dist = (maxDim / 2) / Math.tan(fov / 2);

  camera.near = Math.max(0.01, maxDim / 100);
  camera.far = maxDim * 100;
  camera.position.set(0, maxDim * 0.08, dist * 1.35);
  camera.updateProjectionMatrix();

  controls.minDistance = maxDim / 20;
  controls.maxDistance = maxDim * 10;
  controls.update();
}

async function loadGroups(systemKey, token) {
  const sys = SYSTEMS[systemKey];
  if (!sys) throw new Error(`Unknown system: ${systemKey}`);

  setLoading(true, `Loading ${sys.label} metadata…`);
  const groupsJson = await fetchJson(sys.groups);
  if (token !== loadToken) return;

  buildGroupIndex(groupsJson);
  renderChips();

  setLoading(false);
}

async function loadModel(systemKey, token) {
  const sys = SYSTEMS[systemKey];
  if (!sys) throw new Error(`Unknown system: ${systemKey}`);

  setLoading(true, `Loading ${sys.label} model…`);

  const loader = new FBXLoader();
  const obj = await loader.loadAsync(sys.fbx);

  if (token !== loadToken) {
    disposeObject(obj);
    return;
  }

  if (modelRoot) {
    scene.remove(modelRoot);
    disposeObject(modelRoot);
    modelRoot = null;
  }

  modelRoot = obj;
  scene.add(modelRoot);

  // Rebuild mesh index
  meshList = [];
  meshByKey = new Map();

  modelRoot.traverse((child) => {
    if (!child || !child.isMesh) return;

    // Key from mesh name
    const key = partKeyFromName(child.name || '');
    child.userData.partKey = key;

    ensureUniqueMaterials(child);

    meshList.push(child);
    if (!meshByKey.has(key)) meshByKey.set(key, []);
    meshByKey.get(key).push(child);
  });

  fitCameraToObject(modelRoot);

  setLoading(false);

  // Apply selection after model load
  applySelectionToMeshes();
}

async function loadSystem(systemKey) {
  if (!SYSTEMS[systemKey]) throw new Error(`Unknown system: ${systemKey}`);

  activeSystem = systemKey;

  // update tab active state
  document.querySelectorAll('[data-system]').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-system') === systemKey);
  });

  selectedGroupKeys.clear();
  updateChipSelectionUI();
  setStatus(`Switching to ${SYSTEMS[systemKey].label}…`);

  const token = ++loadToken;

  await loadGroups(systemKey, token);
  await loadModel(systemKey, token);
}

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0b0c);

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(0, 1, 3);

  renderer = new THREE.WebGLRenderer({
    canvas: el.canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  controls = new OrbitControls(camera, el.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;

  // Lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.85);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(5, 10, 7);
  scene.add(dir);

  function onResize() {
    const w = el.canvas.clientWidth || window.innerWidth;
    const h = el.canvas.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  window.addEventListener('resize', onResize, { passive: true });
  onResize();

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

function initPicking() {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let activePointers = new Set();
  let down = null;

  function pick(clientX, clientY) {
    const rect = el.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    ndc.set(x, y);

    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshList, false);
    if (!hits.length) return;

    const obj = hits[0].object;
    const k = obj?.userData?.partKey || partKeyFromName(obj?.name || '');
    if (k) toggleGroup(k);
  }

  el.canvas.addEventListener('pointerdown', (e) => {
    activePointers.add(e.pointerId);
    if (activePointers.size === 1) {
      down = { x: e.clientX, y: e.clientY };
    } else {
      down = null; // multi-touch (pinch/pan) -> do not treat as selection tap
    }
  });

  el.canvas.addEventListener('pointerup', (e) => {
    activePointers.delete(e.pointerId);
    if (!down) return;

    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    const dist2 = dx * dx + dy * dy;

    down = null;

    // ignore drags (OrbitControls interaction)
    if (dist2 > 36) return; // > 6px

    // tap = select
    pick(e.clientX, e.clientY);
  });

  el.canvas.addEventListener('pointercancel', () => {
    activePointers.clear();
    down = null;
  });
}

function initUI() {
  document.querySelectorAll('[data-system]').forEach((b) => {
    b.addEventListener('click', () => {
      const sys = b.getAttribute('data-system');
      if (sys) loadSystem(sys).catch((err) => setStatus(`❌ ${String(err)}`));
    });
  });

  el.clearSelectionBtn?.addEventListener('click', clearSelection);

  el.clearFilterBtn?.addEventListener('click', () => {
    if (el.filter) el.filter.value = '';
    applyFilter('');
  });

  el.filter?.addEventListener('input', () => {
    applyFilter(el.filter.value);
  });
}

initThree();
initPicking();
initUI();

loadSystem(activeSystem).catch((err) => {
  console.error(err);
  setStatus(`❌ Failed to start: ${String(err?.message || err)}`);
});
