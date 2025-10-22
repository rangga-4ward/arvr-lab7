import * as THREE from 'three';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ===== Konfigurasi =====
const VARIANTS = {
  standard: '/models/standard.glb',
  pro: '/models/pro.glb'
};
const DEFAULT_COLOR = 0x3b82f6; // biru
const COLOR_SWATCHES = [0x3b82f6, 0x22c55e, 0xf59e0b, 0xef4444, 0x94a3b8, 0x111827];

let camera, scene, renderer;
let controller, reticle;
let hitTestSource = null, hitTestSourceRequested = false;

// Root/anchor
let anchorGroup;     // ditempatkan saat tap (reticle)
let productGroup;    // baseModel + attachments
let baseModel = null; // GLB atau placeholder
let attachments = {}; // {guard, stand, hose}
let activeModel = null; // gesture target
let allowReposition = false; // tombol Reposition aktifkan relokasi berikutnya

// UI refs
const ui = {
  variant: null, variantStatus: null,
  swatches: null,
  scale: null, scaleVal: null,
  attGuard: null, attStand: null, attHose: null,
  w: null, d: null, h: null, area: null,
  reposition: null, reset: null, export: null
};

init();

function init(){
  const container = document.getElementById('app');

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 40);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(1,2,1); scene.add(dir);

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.1, 32).rotateX(-Math.PI/2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.9, transparent: true })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  controller = renderer.xr.getController(0);
  controller.addEventListener('select', onSelect);
  scene.add(controller);

  anchorGroup = new THREE.Group();
  scene.add(anchorGroup);

  const button = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.body }
  });
  document.body.appendChild(button);

  setupUI();
  setupGestureControls(renderer.domElement);
  window.addEventListener('resize', onResize);
  renderer.setAnimationLoop(render);
}

function onResize(){
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function onSelect(){
  if (!reticle.visible) return;
  // Reposition mode → geser anchor
  if (allowReposition){
    anchorGroup.position.setFromMatrixPosition(reticle.matrix);
    allowReposition = false;
    return;
  }

  // Place untuk pertama kali
  anchorGroup.position.setFromMatrixPosition(reticle.matrix);

  if (!productGroup){
    productGroup = new THREE.Group();
    anchorGroup.add(productGroup);

    // muat varian awal
    await loadVariant(ui.variant.value);

    // attachments default
    updateAttachment('guard', ui.attGuard.checked);
    updateAttachment('stand', ui.attStand.checked);
    updateAttachment('hose', ui.attHose.checked);

    activeModel = productGroup; // gesture target keseluruhan
    updateFootprint();
  }
}

// ===== UI =====
function setupUI(){
  ui.variant = document.getElementById('variant');
  ui.variantStatus = document.getElementById('variantStatus');
  ui.swatches = document.getElementById('swatches');
  ui.scale = document.getElementById('scale');
  ui.scaleVal = document.getElementById('scaleVal');
  ui.attGuard = document.getElementById('att-guard');
  ui.attStand = document.getElementById('att-stand');
  ui.attHose = document.getElementById('att-hose');
  ui.w = document.getElementById('w'); ui.d = document.getElementById('d'); ui.h = document.getElementById('h'); ui.area = document.getElementById('area');
  ui.reposition = document.getElementById('reposition');
  ui.reset = document.getElementById('reset');
  ui.export = document.getElementById('export');

  // swatches
  COLOR_SWATCHES.forEach(c => {
    const s = document.createElement('div'); s.className = 'swatch'; s.style.background = '#' + c.toString(16).padStart(6,'0');
    s.addEventListener('click', () => applyColor(c));
    ui.swatches.appendChild(s);
  });

  ui.variant.addEventListener('change', async ()=>{
    if (!productGroup) return; // belum ditempatkan
    await loadVariant(ui.variant.value);
    updateFootprint();
  });

  ui.scale.addEventListener('input', ()=>{
    const k = parseFloat(ui.scale.value);
    ui.scaleVal.textContent = `${k.toFixed(2)}×`;
    if (productGroup){ productGroup.scale.setScalar(k); updateFootprint(); }
  });

  ui.attGuard.addEventListener('change', ()=>{ updateAttachment('guard', ui.attGuard.checked); updateFootprint(); });
  ui.attStand.addEventListener('change', ()=>{ updateAttachment('stand', ui.attStand.checked); updateFootprint(); });
  ui.attHose.addEventListener('change', ()=>{ updateAttachment('hose', ui.attHose.checked); updateFootprint(); });

  ui.reposition.addEventListener('click', ()=>{ allowReposition = true; });
  ui.reset.addEventListener('click', ()=> resetAll());
  ui.export.addEventListener('click', ()=> exportConfig());

  ui.scaleVal.textContent = `${parseFloat(ui.scale.value).toFixed(2)}×`;
  setVariantStatus('(menunggu)');
}

function setVariantStatus(text){ ui.variantStatus.textContent = text; }

// ===== Variant Loading =====
async function loadVariant(key){
  // bersihkan baseModel lama
  if (baseModel){ productGroup.remove(baseModel); baseModel.traverse(disposeNode); baseModel = null; }

  const url = VARIANTS[key];
  if (!url){
    baseModel = buildPlaceholder();
    productGroup.add(baseModel);
    applyColor(DEFAULT_COLOR);
    setVariantStatus('placeholder');
    return;
  }

  try{
    const gltf = await new GLTFLoader().loadAsync(url);
    const obj = gltf.scene || gltf.scenes?.[0] || gltf;
    obj.traverse(n => { if (n.isMesh){ n.castShadow = true; n.receiveShadow = true; } });
    baseModel = obj;
    productGroup.add(baseModel);
    applyColor(DEFAULT_COLOR);
    setVariantStatus('GLB');
  }catch(e){
    console.warn('Gagal load varian', key, e);
    baseModel = buildPlaceholder(key);
    productGroup.add(baseModel);
    applyColor(DEFAULT_COLOR);
    setVariantStatus('placeholder');
  }
}

function disposeNode(n){
  if (n.isMesh){ n.geometry?.dispose(); if (n.material){ if (Array.isArray(n.material)) n.material.forEach(m=>m.dispose()); else n.material.dispose(); } }
}

// ===== Placeholder Base =====
function buildPlaceholder(key='standard'){
  const g = new THREE.Group(); g.name = 'Placeholder';
  const bodyColor = key==='pro' ? 0x0ea5e9 : 0x60a5fa;

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.16, 0.4),
    new THREE.MeshStandardMaterial({ color: bodyColor, roughness:0.6 })
  );
  base.position.y = 0.08; g.add(base);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.14, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness:0.6 })
  );
  head.position.y = 0.23; g.add(head);

  const pipe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.36, 24),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness:0.2, roughness:0.4 })
  );
  pipe.rotation.z = Math.PI/2; pipe.position.set(0.18, 0.23, 0); g.add(pipe);

  return g;
}

// ===== Color Apply =====
function applyColor(hex){
  if (!productGroup) return;
  productGroup.traverse(n => {
    if (n.isMesh && n.material && n.material.color){
      n.material.color.setHex(hex);
    }
  });
}

// ===== Attachments =====
function updateAttachment(name, enabled){
  if (!attachments[name]) attachments[name] = buildAttachment(name);
  const obj = attachments[name];
  if (!obj) return;
  obj.visible = !!enabled;
  if (!obj.parent && productGroup) productGroup.add(obj);
}

function buildAttachment(name){
  switch(name){
    case 'guard':{
      // ring pelindung (silinder tipis)
      const r = 0.36, h = 0.22, t = 0.01;
      const geom = new THREE.CylinderGeometry(r, r, h, 48, 1, true);
      const mat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent:true, opacity:0.25, side:THREE.DoubleSide, depthWrite:false });
      const wall = new THREE.Mesh(geom, mat); wall.position.y = 0.23;
      const top = new THREE.Mesh(new THREE.TorusGeometry(r, t, 12, 48), new THREE.MeshBasicMaterial({ color:0x22c55e, transparent:true, opacity:0.35, depthWrite:false })); top.rotation.x = Math.PI/2; top.position.y = 0.23 + h/2;
      const bot = new THREE.Mesh(new THREE.TorusGeometry(r, t, 12, 48), new THREE.MeshBasicMaterial({ color:0x22c55e, transparent:true, opacity:0.35, depthWrite:false })); bot.rotation.x = Math.PI/2; bot.position.y = 0.23 - h/2;
      const g = new THREE.Group(); g.add(wall, top, bot); return g;
    }
    case 'stand':{
      const stand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.28, 0.06, 32),
        new THREE.MeshStandardMaterial({ color: 0x475569, roughness:0.8 })
      );
      stand.position.y = 0.03; return stand;
    }
    case 'hose':{
      // selang sederhana (TubeGeometry)
      const path = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.18, 0.23, 0),
        new THREE.Vector3(0.35, 0.30, 0.1),
        new THREE.Vector3(0.50, 0.20, 0.20)
      ]);
      const geom = new THREE.TubeGeometry(path, 32, 0.02, 16, false);
      const mat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, metalness:0.1, roughness:0.5 });
      const tube = new THREE.Mesh(geom, mat);
      return tube;
    }
  }
  return null;
}

// ===== Footprint =====
function updateFootprint(){
  if (!productGroup) return;
  // compute box in world, lalu konversi ke local anchor
  const box = new THREE.Box3().setFromObject(productGroup);
  const size = new THREE.Vector3(); box.getSize(size);
  const w = size.x, d = size.z, h = size.y;
  ui.w.textContent = `${w.toFixed(2)} m`;
  ui.d.textContent = `${d.toFixed(2)} m`;
  ui.h.textContent = `${h.toFixed(2)} m`;
  ui.area.textContent = `${(w*d).toFixed(2)} m²`;
}

// ===== Export Config =====
function exportConfig(){
  const cfg = {
    variant: ui.variant.value,
    color: `#${getCurrentColorHex()}`,
    scale: parseFloat(ui.scale.value),
    attachments: { guard: ui.attGuard.checked, stand: ui.attStand.checked, hose: ui.attHose.checked },
    footprint: { w: ui.w.textContent, d: ui.d.textContent, h: ui.h.textContent, area: ui.area.textContent }
  };
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'config.json'; a.click();
  URL.revokeObjectURL(url);
}

function getCurrentColorHex(){
  // ambil warna pertama yang ditemukan
  let hex = DEFAULT_COLOR.toString(16).padStart(6,'0');
  if (!productGroup) return hex;
  productGroup.traverse(n => {
    if (n.isMesh && n.material && n.material.color){ hex = n.material.color.getHexString(); }
  });
  return hex;
}

// ===== Reset =====
function resetAll(){
  // hapus productGroup
  if (productGroup){
    productGroup.traverse(disposeNode);
    anchorGroup.remove(productGroup);
    productGroup = null; baseModel = null; attachments = {}; activeModel = null;
  }
  // reset UI
  ui.variant.value = 'standard';
  ui.scale.value = 1.0; ui.scaleVal.textContent = '1.00×';
  ui.attGuard.checked = true; ui.attStand.checked = false; ui.attHose.checked = false;
  setVariantStatus('(menunggu)');
}

// ===== Render Loop (XR hit-test) =====
function render(timestamp, frame){
  if (frame){
    const refSpace = renderer.xr.getReferenceSpace();
    const session = renderer.xr.getSession();

    if (!hitTestSourceRequested){
      session.requestReferenceSpace('viewer').then(viewerSpace => {
        session.requestHitTestSource({ space: viewerSpace }).then(source => { hitTestSource = source; });
      });
      session.addEventListener('end', ()=>{ hitTestSourceRequested=false; hitTestSource=null; });
      hitTestSourceRequested = true;
    }

    if (hitTestSource){
      const hits = frame.getHitTestResults(hitTestSource);
      if (hits.length){
        const hit = hits[0];
        const pose = hit.getPose(refSpace);
        reticle.visible = true; reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        reticle.visible = false;
      }
    }
  }

  // update footprint realtime jika ada
  if (productGroup) updateFootprint();

  renderer.render(scene, camera);
}

// ===== Gesture: two-finger rotate & pinch-to-scale =====
function setupGestureControls(canvas){
  let startDistance = 0, startAngle = 0, startScale = 1, startRotationY = 0;
  canvas.addEventListener('touchstart', (e)=>{
    if (!productGroup) return;
    if (e.touches.length === 2){
      const [t0, t1] = e.touches;
      startDistance = distance(t0,t1); startAngle = angle(t0,t1);
      startScale = productGroup.scale.x; startRotationY = productGroup.rotation.y;
    }
  }, { passive:true });
  canvas.addEventListener('touchmove', (e)=>{
    if (!productGroup) return;
    if (e.touches.length === 2){
      const [t0, t1] = e.touches;
      const k = distance(t0,t1) / (startDistance || 1);
      const nextScale = THREE.MathUtils.clamp(startScale * k, 0.5, 2.0);
      productGroup.scale.setScalar(nextScale);
      ui.scale.value = nextScale; ui.scaleVal.textContent = `${nextScale.toFixed(2)}×`;
      const dAng = angle(t0,t1) - startAngle;
      productGroup.rotation.y = startRotationY + dAng;
    }
  }, { passive:true });
}
function distance(a,b){ const dx=a.clientX-b.clientX, dy=a.clientY-b.clientY; return Math.hypot(dx,dy); }
function angle(a,b){ return Math.atan2(b.clientY-a.clientY, b.clientX-a.clientX); }