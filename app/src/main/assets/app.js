// ===== 1. OFFLINE INDEXEDDB STORAGE =====
let db;
let currentFolderId = "root";
let folderStack = [{ id: "root", name: "Home" }];
let flashOn = false;
let lastGeneratedQr = "";

// ===== EDITOR, RE-EDIT & BATCH GALLERY STATE =====
let sourceImg = null;
let currentOrigDataUrl = "";
let editingDocId = null;
let editingDocMeta = null;

let batchEditQueue = [];
let batchEditIndex = -1;

let rotationDeg = 0;
let editorMode = "crop"; // "crop" | "filter"
let currentFilter = "color";

// Zoom & Pan State
let viewZoom = 1.0;
let viewPanX = 0;
let viewPanY = 0;
let imgDrawRect = { x: 0, y: 0, w: 1, h: 1 };

// Offscreen Canvases
let rotCanvas = document.createElement("canvas");
let warpedCanvas = document.createElement("canvas");
let filteredCanvas = document.createElement("canvas");

// 4 Normalized Corners on rotCanvas: [TL, TR, BR, BL]
let cropCorners = [
  { x: 0.08, y: 0.08 },
  { x: 0.92, y: 0.08 },
  { x: 0.92, y: 0.92 },
  { x: 0.08, y: 0.92 }
];

// Active Touch / Drag State
let dragMode = null; // "corner" | "edge" | "pan" | "pinch"
let activeHandleIdx = -1;
let dragStartCanvas = { x: 0, y: 0 };
let dragStartNorm = { x: 0, y: 0 };
let dragStartEdgePts = null;
let panStartOffset = { x: 0, y: 0 };
let pinchStartDist = 0;
let pinchStartZoom = 1;

const PDF_SIZES = {
  A1: [1684, 2384],
  A2: [1191, 1684],
  A3: [842, 1191],
  A4: [595, 842],
  A5: [420, 595],
  A6: [298, 420],
  Letter: [612, 792],
  Postcard: [283, 419],
  Note: [540, 720]
};

function initDB() {
  const req = indexedDB.open("DocScannerProDB", 1);
  req.onupgradeneeded = (e) => {
    const database = e.target.result;
    if (!database.objectStoreNames.contains("folders")) {
      database.createObjectStore("folders", { keyPath: "id" });
    }
    if (!database.objectStoreNames.contains("docs")) {
      database.createObjectStore("docs", { keyPath: "id" });
    }
  };
  req.onsuccess = (e) => {
    db = e.target.result;
    loadFolderContents();
  };
}

function dbGetAll(storeName) {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
  });
}

function dbPut(storeName, item) {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve();
  });
}

function dbDelete(storeName, id) {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
  });
}

// ===== 2. NAVIGATION & FLASHLIGHT =====
function switchTab(tabName) {
  document.querySelectorAll(".tab-panel").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((el) => el.classList.remove("active"));
  document.getElementById("tab-" + tabName).classList.add("active");
  const idx = ["docs", "editor", "qr", "ocr"].indexOf(tabName);
  if (idx >= 0) document.querySelectorAll(".nav-btn")[idx].classList.add("active");

  if (tabName === "editor") {
    requestAnimationFrame(() => drawEditorStage());
  }
}

function toggleFlashlight() {
  flashOn = !flashOn;
  if (window.AndroidBridge) {
    const ok = AndroidBridge.toggleFlash(flashOn);
    if (!ok) {
      flashOn = false;
      AndroidBridge.showToast("Flash hardware unavailable");
    }
  }
  document.getElementById("flashBtn").textContent = "Flash: " + (flashOn ? "ON" : "OFF");
}

function notify(msg) {
  if (window.AndroidBridge) AndroidBridge.showToast(msg);
  else alert(msg);
}

// ===== 3. FOLDERS & DOCUMENTS (WITH RE-EDIT OPTION) =====
async function createFolderPrompt() {
  const name = prompt("Naya Folder / Subfolder ka naam likhein:");
  if (!name || !name.trim()) return;
  await dbPut("folders", {
    id: "fld_" + Date.now(),
    parentId: currentFolderId,
    name: name.trim(),
    createdAt: Date.now()
  });
  loadFolderContents();
}

function openFolder(id, name) {
  currentFolderId = id;
  folderStack.push({ id, name });
  loadFolderContents();
}

function goUpFolder() {
  if (folderStack.length <= 1) return;
  folderStack.pop();
  currentFolderId = folderStack[folderStack.length - 1].id;
  loadFolderContents();
}

async function deleteFolder(id) {
  if (!confirm("Is folder ko delete karein?")) return;
  await dbDelete("folders", id);
  loadFolderContents();
}

async function deleteDoc(id) {
  if (!confirm("Is scan ko delete karein?")) return;
  await dbDelete("docs", id);
  loadFolderContents();
}

async function loadFolderContents() {
  document.getElementById("folderPath").textContent = folderStack.map((f) => f.name).join(" / ");
  const allFolders = await dbGetAll("folders");
  const allDocs = await dbGetAll("docs");

  const subFolders = allFolders.filter((f) => f.parentId === currentFolderId);
  const folderDocs = allDocs
    .filter((d) => d.folderId === currentFolderId)
    .sort((a, b) => b.createdAt - a.createdAt);

  const fList = document.getElementById("folderList");
  fList.innerHTML = "";
  subFolders.forEach((f) => {
    const div = document.createElement("div");
    div.className = "folder-item";
    div.innerHTML = `
      <span onclick="openFolder('${f.id}', '${f.name.replace(/'/g, "")}')" style="cursor:pointer;flex:1;">
        [Folder] ${f.name}
      </span>
      <button class="small-btn" onclick="deleteFolder('${f.id}')">Del</button>
    `;
    fList.appendChild(div);
  });

  const dList = document.getElementById("docList");
  dList.innerHTML = "";
  if (folderDocs.length === 0 && subFolders.length === 0) {
    dList.innerHTML = `<p class="muted" style="grid-column:1/-1;text-align:center;">Koi scan nahi hai. Upar se Camera Scan ya Gallery chunein.</p>`;
    return;
  }

  folderDocs.forEach((doc) => {
    const card = document.createElement("div");
    card.className = "doc-card";
    card.innerHTML = `
      <img src="${doc.dataUrl}" alt="${doc.name}" onclick="editSavedDoc('${doc.id}', false)" />
      <div class="doc-meta">
        <p>${doc.name}</p>
        <div class="doc-actions">
          <button class="small-btn primary" onclick="editSavedDoc('${doc.id}', false)">Edit</button>
          <button class="small-btn" onclick="runOcrFromDoc('${doc.id}')">OCR</button>
          <button class="small-btn" onclick="exportSingleJpg('${doc.id}', 'save')">JPG</button>
          <button class="small-btn" onclick="exportSingleJpg('${doc.id}', 'share')">Share</button>
          <button class="small-btn" onclick="deleteDoc('${doc.id}')">Del</button>
        </div>
      </div>
    `;
    dList.appendChild(card);
  });
}

// ===== 4. IMAGE LOADING, GALLERY BATCH EDIT & RE-EDIT =====
function handleImageInput(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (files.length === 0) return;

  if (files.length === 1) {
    clearBatchState();
    editingDocId = null;
    editingDocMeta = null;
    readAndCompressFile(files[0]).then((dataUrl) => {
      openImageInEditor(dataUrl);
    });
  } else {
    batchImportAndEdit(files);
  }
}

async function batchImportAndEdit(files) {
  notify(files.length + " photos import ho rahi hain...");
  const newIds = [];
  const baseTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const dataUrl = await readAndCompressFile(files[i]);
    const docId = "doc_" + baseTime + "_" + i;
    await dbPut("docs", {
      id: docId,
      folderId: currentFolderId,
      name: "Scan_" + (i + 1) + ".jpg",
      dataUrl,
      origDataUrl: dataUrl,
      createdAt: baseTime + i
    });
    newIds.push(docId);
  }

  await loadFolderContents();
  batchEditQueue = newIds;
  batchEditIndex = 0;
  notify("Sabhi photos save ho gayi! Ab ek-ek karke crop aur enhance karein.");
  await editSavedDoc(batchEditQueue[0], true);
}

async function editSavedDoc(docId, fromBatch = false) {
  if (!fromBatch) clearBatchState();
  const allDocs = await dbGetAll("docs");
  const doc = allDocs.find((d) => d.id === docId);
  if (!doc) return;

  editingDocId = doc.id;
  editingDocMeta = doc;
  const srcUrl = doc.origDataUrl || doc.dataUrl;
  openImageInEditor(srcUrl);
  updateBatchUI();
}

function clearBatchState() {
  batchEditQueue = [];
  batchEditIndex = -1;
  updateBatchUI();
}

function updateBatchUI() {
  const bar = document.getElementById("batchBar");
  const label = document.getElementById("batchLabel");
  const saveBtn = document.getElementById("saveScanBtn");

  if (batchEditQueue.length > 0 && batchEditIndex >= 0) {
    bar.classList.remove("hidden");
    const cur = batchEditIndex + 1;
    const tot = batchEditQueue.length;
    label.textContent = `Gallery Edit: ${cur} / ${tot}`;
    saveBtn.textContent = cur < tot ? `Save & Next (${cur}/${tot})` : "Save & Finish";
  } else {
    bar.classList.add("hidden");
    saveBtn.textContent = editingDocId ? "Update Scan" : "Save Scan";
  }
}

async function skipBatchItem() {
  if (batchEditQueue.length === 0) return;
  if (batchEditIndex + 1 < batchEditQueue.length) {
    batchEditIndex++;
    await editSavedDoc(batchEditQueue[batchEditIndex], true);
  } else {
    exitBatchEdit();
  }
}

function exitBatchEdit() {
  clearBatchState();
  editingDocId = null;
  editingDocMeta = null;
  switchTab("docs");
  loadFolderContents();
}

function cancelEditor() {
  if (batchEditQueue.length > 0) {
    exitBatchEdit();
  } else {
    editingDocId = null;
    editingDocMeta = null;
    switchTab("docs");
  }
}

function readAndCompressFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1600;
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.9));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function openImageInEditor(dataUrl) {
  const img = new Image();
  img.onload = () => {
    sourceImg = img;
    currentOrigDataUrl = dataUrl;
    rotationDeg = 0;
    currentFilter = "color";
    syncFilterChipUI("color");
    resetZoom(false);
    document.getElementById("editorEmptyHint").classList.add("hidden");
    rebuildRotatedCanvas();
    autoDetectCorners(true);
    setEditorMode("crop");
    switchTab("editor");
    updateBatchUI();
  };
  img.src = dataUrl;
}

function syncFilterChipUI(filterName) {
  document.querySelectorAll(".filter-chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === filterName);
  });
}

function rebuildRotatedCanvas() {
  if (!sourceImg) return;
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(sourceImg.width, sourceImg.height));
  const rawW = Math.round(sourceImg.width * scale);
  const rawH = Math.round(sourceImg.height * scale);

  const isOdd = rotationDeg === 90 || rotationDeg === 270;
  rotCanvas.width = isOdd ? rawH : rawW;
  rotCanvas.height = isOdd ? rawW : rawH;
  const rctx = rotCanvas.getContext("2d");
  rctx.clearRect(0, 0, rotCanvas.width, rotCanvas.height);
  rctx.save();
  rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
  rctx.rotate((rotationDeg * Math.PI) / 180);
  rctx.drawImage(sourceImg, -rawW / 2, -rawH / 2, rawW, rawH);
  rctx.restore();
}

function rotateImage() {
  if (!sourceImg) return;
  rotationDeg = (rotationDeg + 90) % 360;
  resetZoom(false);
  rebuildRotatedCanvas();
  autoDetectCorners(true);
}

function setEditorMode(mode) {
  editorMode = mode;
  resetZoom(false);
  const isCrop = mode === "crop";
  document.getElementById("cropTopBar").classList.toggle("hidden", !isCrop);
  document.getElementById("cropBottomHint").classList.toggle("hidden", !isCrop);
  document.getElementById("filterTopBar").classList.toggle("hidden", isCrop);
  document.getElementById("filterStrip").classList.toggle("hidden", isCrop);
  updateBatchUI();
  requestAnimationFrame(() => drawEditorStage());
}

function backToCropMode() {
  setEditorMode("crop");
}

function resetFullCorners() {
  cropCorners = [
    { x: 0.02, y: 0.02 },
    { x: 0.98, y: 0.02 },
    { x: 0.98, y: 0.98 },
    { x: 0.02, y: 0.98 }
  ];
  drawEditorStage();
}

// ===== 5. ZOOM CONTROLS =====
function stepZoom(delta) {
  if (!sourceImg) return;
  viewZoom = Math.max(1.0, Math.min(4.0, +(viewZoom + delta).toFixed(2)));
  if (viewZoom <= 1.01) {
    viewZoom = 1.0;
    viewPanX = 0;
    viewPanY = 0;
  }
  updateZoomLabel();
  drawEditorStage();
}

function resetZoom(redraw = true) {
  viewZoom = 1.0;
  viewPanX = 0;
  viewPanY = 0;
  updateZoomLabel();
  if (redraw) drawEditorStage();
}

function updateZoomLabel() {
  const lbl = document.getElementById("zoomLabel");
  if (lbl) lbl.textContent = Math.round(viewZoom * 100) + "%";
}

// ===== 6. IMPROVED SMART AUTO-CROP (OTSU + CONNECTED COMPONENT + CONVEX HULL MAX-QUAD) =====
function autoDetectCorners(silent = false) {
  if (!sourceImg || !rotCanvas.width) return;

  const sw = 240;
  const sh = Math.max(80, Math.round((rotCanvas.height / rotCanvas.width) * sw));
  const tmp = document.createElement("canvas");
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(rotCanvas, 0, 0, sw, sh);
  const rgba = tctx.getImageData(0, 0, sw, sh).data;

  // Step 1: Paper-likeness score (high brightness + low color saturation)
  const rawScore = new Uint8Array(sw * sh);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    rawScore[p] = Math.max(0, Math.min(255, Math.round(lum - 0.42 * sat)));
  }

  // Step 2: 3x3 Box Blur to remove text/grain inside paper
  const blur = new Uint8Array(sw * sh);
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * sw;
        s += rawScore[row + x - 1] + rawScore[row + x] + rawScore[row + x + 1];
      }
      blur[y * sw + x] = (s / 9) | 0;
    }
  }

  // Step 3: Otsu automatic threshold
  const hist = new Int32Array(256);
  const total = (sw - 2) * (sh - 2);
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      hist[blur[y * sw + x]]++;
    }
  }
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, otsuThresh = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      otsuThresh = t;
    }
  }

  // Step 4: Binary mask + Morphological Closing (dilate -> erode) to fill dark text gaps
  let mask = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    mask[i] = blur[i] >= otsuThresh ? 1 : 0;
  }
  mask = morphPass(mask, sw, sh, 1); // dilate
  mask = morphPass(mask, sw, sh, 0); // erode

  // Step 5: Connected Component Labeling -> pick best paper region
  const visited = new Uint8Array(sw * sh);
  const queue = new Int32Array(sw * sh);
  let bestScore = -1;
  let bestBoundary = null;

  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const start = y * sw + x;
      if (!mask[start] || visited[start]) continue;

      let head = 0, tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      let area = 0, sumX = 0, sumY = 0;
      const boundary = [];

      while (head < tail) {
        const idx = queue[head++];
        const cx = idx % sw;
        const cy = (idx / sw) | 0;
        area++;
        sumX += cx;
        sumY += cy;

        let isEdge = false;
        const neighbors = [idx - 1, idx + 1, idx - sw, idx + sw];
        for (let k = 0; k < 4; k++) {
          const nIdx = neighbors[k];
          const nx = nIdx % sw;
          const ny = (nIdx / sw) | 0;
          if (nx <= 0 || nx >= sw - 1 || ny <= 0 || ny >= sh - 1 || !mask[nIdx]) {
            isEdge = true;
          } else if (!visited[nIdx]) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
        if (isEdge) boundary.push({ x: cx, y: cy });
      }

      const ratio = area / (sw * sh);
      if (ratio < 0.07 || ratio > 0.96) continue;

      const meanX = sumX / area;
      const meanY = sumY / area;
      const distCenter = Math.hypot((meanX - sw / 2) / sw, (meanY - sh / 2) / sh);
      const score = area * (1.25 - 0.65 * distCenter);

      if (score > bestScore) {
        bestScore = score;
        bestBoundary = boundary;
      }
    }
  }

  let detected = null;
  if (bestBoundary && bestBoundary.length >= 12) {
    let hull = computeConvexHull(bestBoundary);
    if (hull.length >= 4) {
      // Reduce hull to max 22 vertices keeping true sharp corners
      hull = simplifyHullToMax(hull, 22);
      const quad = findMaxAreaQuad(hull);
      if (quad) {
        const ordered = orderQuadClockwise(quad);
        detected = ordered.map((pt) => ({
          x: Math.max(0.01, Math.min(0.99, pt.x / sw)),
          y: Math.max(0.01, Math.min(0.99, pt.y / sh))
        }));
      }
    }
  }

  if (detected) {
    cropCorners = detected;
    if (!silent) notify("Paper ke 4 kone auto-detect ho gaye!");
  } else {
    cropCorners = [
      { x: 0.07, y: 0.07 },
      { x: 0.93, y: 0.07 },
      { x: 0.93, y: 0.93 },
      { x: 0.07, y: 0.93 }
    ];
    if (!silent) notify("Kone clear nahi mile — 4 dots ya side sliders se set karein.");
  }
  drawEditorStage();
}

function morphPass(src, w, h, targetVal) {
  const out = new Uint8Array(src.length);
  const fillVal = targetVal ? 1 : 0;
  const invVal = targetVal ? 0 : 1;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) {
        const row = (y + dy) * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (src[row + x + dx] === fillVal) {
            found = true;
            break;
          }
        }
      }
      out[y * w + x] = found ? fillVal : invVal;
    }
  }
  return out;
}

function computeConvexHull(points) {
  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function simplifyHullToMax(hull, maxN) {
  const pts = hull.slice();
  const triArea = (a, b, c) => Math.abs((a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) * 0.5);

  while (pts.length > maxN) {
    let minA = Infinity;
    let minIdx = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = triArea(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]);
      if (a < minA) {
        minA = a;
        minIdx = i;
      }
    }
    pts.splice(minIdx, 1);
  }
  return pts;
}

function findMaxAreaQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  const triArea = (a, b, c) => Math.abs((a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) * 0.5);

  let bestArea = -1;
  let best = null;
  for (let a = 0; a < n - 3; a++) {
    for (let b = a + 1; b < n - 2; b++) {
      for (let c = b + 1; c < n - 1; c++) {
        const area1 = triArea(hull[a], hull[b], hull[c]);
        for (let d = c + 1; d < n; d++) {
          const totalArea = area1 + triArea(hull[a], hull[c], hull[d]);
          if (totalArea > bestArea) {
            bestArea = totalArea;
            best = [hull[a], hull[b], hull[c], hull[d]];
          }
        }
      }
    }
  }
  return best;
}

function orderQuadClockwise(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  // Rotate so top-left (min x + y) is index 0
  let tlIdx = 0;
  let minSum = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < minSum) {
      minSum = s;
      tlIdx = i;
    }
  }
  const ordered = [
    sorted[tlIdx],
    sorted[(tlIdx + 1) % 4],
    sorted[(tlIdx + 2) % 4],
    sorted[(tlIdx + 3) % 4]
  ];

  // Ensure clockwise orientation in screen space (Y down): TL -> TR -> BR -> BL
  const cross =
    (ordered[1].x - ordered[0].x) * (ordered[2].y - ordered[0].y) -
    (ordered[1].y - ordered[0].y) * (ordered[2].x - ordered[0].x);
  if (cross < 0) {
    return [ordered[0], ordered[3], ordered[2], ordered[1]];
  }
  return ordered;
}

// ===== 7. CANVAS STAGE WITH ZOOM, 4 CORNERS + 4 SIDE SLIDER HANDLES =====
function getEdgeMidpoints(pts) {
  return [
    { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, ang: Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) },
    { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2, ang: Math.atan2(pts[2].y - pts[1].y, pts[2].x - pts[1].x) },
    { x: (pts[2].x + pts[3].x) / 2, y: (pts[2].y + pts[3].y) / 2, ang: Math.atan2(pts[3].y - pts[2].y, pts[3].x - pts[2].x) },
    { x: (pts[3].x + pts[0].x) / 2, y: (pts[3].y + pts[0].y) / 2, ang: Math.atan2(pts[0].y - pts[3].y, pts[0].x - pts[3].x) }
  ];
}

function drawEditorStage() {
  const stage = document.getElementById("canvasStage");
  const canvas = document.getElementById("editorCanvas");
  if (!stage || !canvas) return;

  const cssW = stage.clientWidth;
  const cssH = stage.clientHeight;
  if (cssW < 10 || cssH < 10) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const imgSrc = editorMode === "crop" ? rotCanvas : filteredCanvas;
  if (!sourceImg || !imgSrc.width || !imgSrc.height) return;

  const pad = editorMode === "crop" ? 26 : 12;
  const availW = Math.max(20, cssW - pad * 2);
  const availH = Math.max(20, cssH - pad * 2);
  const fitScale = Math.min(availW / imgSrc.width, availH / imgSrc.height);

  const drawW = imgSrc.width * fitScale * viewZoom;
  const drawH = imgSrc.height * fitScale * viewZoom;

  const maxPanX = Math.max(0, (drawW - cssW) / 2 + pad);
  const maxPanY = Math.max(0, (drawH - cssH) / 2 + pad);
  viewPanX = Math.max(-maxPanX, Math.min(maxPanX, viewPanX));
  viewPanY = Math.max(-maxPanY, Math.min(maxPanY, viewPanY));

  const drawX = (cssW - drawW) / 2 + viewPanX;
  const drawY = (cssH - drawH) / 2 + viewPanY;
  imgDrawRect = { x: drawX, y: drawY, w: drawW, h: drawH };

  ctx.drawImage(imgSrc, drawX, drawY, drawW, drawH);

  if (editorMode !== "crop") return;

  const pts = cropCorners.map((c) => ({
    x: drawX + c.x * drawW,
    y: drawY + c.y * drawH
  }));

  // Dim outside selected quad
  ctx.save();
  ctx.fillStyle = "rgba(2, 6, 23, 0.55)";
  ctx.beginPath();
  ctx.rect(drawX, drawY, drawW, drawH);
  ctx.moveTo(pts[0].x, pts[0].y);
  ctx.lineTo(pts[3].x, pts[3].y);
  ctx.lineTo(pts[2].x, pts[2].y);
  ctx.lineTo(pts[1].x, pts[1].y);
  ctx.closePath();
  ctx.fill("evenodd");
  ctx.restore();

  // Polygon border
  ctx.save();
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();

  // 4 Side Slider Handles (Pill bars on Top, Right, Bottom, Left edges)
  const mids = getEdgeMidpoints(pts);
  mids.forEach((m, idx) => {
    const isActive = dragMode === "edge" && activeHandleIdx === idx;
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(m.ang);
    const barW = isActive ? 32 : 26;
    const barH = isActive ? 12 : 10;
    const r = barH / 2;
    ctx.beginPath();
    ctx.roundRect(-barW / 2, -barH / 2, barW, barH, r);
    ctx.fillStyle = isActive ? "#facc15" : "#0ea5e9";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.restore();
  });

  // 4 Corner Handles (Circles)
  pts.forEach((p, idx) => {
    const isActive = dragMode === "corner" && activeHandleIdx === idx;
    ctx.beginPath();
    ctx.arc(p.x, p.y, isActive ? 15 : 12, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? "#facc15" : "rgba(14, 165, 233, 0.9)";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  });
  ctx.restore();

  // Magnifier Loupe when dragging corner or side slider
  if ((dragMode === "corner" || dragMode === "edge") && activeHandleIdx >= 0) {
    let focusNorm;
    if (dragMode === "corner") {
      focusNorm = cropCorners[activeHandleIdx];
    } else {
      const a = cropCorners[activeHandleIdx];
      const b = cropCorners[(activeHandleIdx + 1) % 4];
      focusNorm = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    drawMagnifierLoupe(ctx, cssW, focusNorm);
  }
}

function drawMagnifierLoupe(ctx, cssW, normPt) {
  const radius = 46;
  const cx = normPt.x < 0.5 ? cssW - radius - 12 : radius + 12;
  const cy = radius + 12;

  const srcX = normPt.x * rotCanvas.width;
  const srcY = normPt.y * rotCanvas.height;
  const sampleSize = Math.min(rotCanvas.width, rotCanvas.height) * 0.16;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#020617";
  ctx.fill();
  ctx.clip();

  ctx.drawImage(
    rotCanvas,
    srcX - sampleSize / 2,
    srcY - sampleSize / 2,
    sampleSize,
    sampleSize,
    cx - radius,
    cy - radius,
    radius * 2,
    radius * 2
  );

  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx, cy + 12);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#38bdf8";
  ctx.stroke();
  ctx.restore();
}

// ===== 8. TOUCH, PINCH-ZOOM, PAN, CORNER & SIDE-SLIDER GESTURES =====
(function bindStageGestures() {
  const canvas = document.getElementById("editorCanvas");

  function getPos(touchLike) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: touchLike.clientX - rect.left,
      y: touchLike.clientY - rect.top
    };
  }

  function onTouchStart(e) {
    if (!sourceImg) return;

    // 2-finger Pinch-to-Zoom
    if (e.touches && e.touches.length === 2) {
      e.preventDefault();
      const p1 = getPos(e.touches[0]);
      const p2 = getPos(e.touches[1]);
      dragMode = "pinch";
      activeHandleIdx = -1;
      pinchStartDist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      pinchStartZoom = viewZoom;
      dragStartCanvas = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      panStartOffset = { x: viewPanX, y: viewPanY };
      return;
    }

    const pos = getPos(e.touches ? e.touches[0] : e);

    if (editorMode === "crop") {
      // 1. Check 4 Corner Handles
      let bestCorner = -1, bestCDist = 34;
      cropCorners.forEach((c, idx) => {
        const px = imgDrawRect.x + c.x * imgDrawRect.w;
        const py = imgDrawRect.y + c.y * imgDrawRect.h;
        const d = Math.hypot(pos.x - px, pos.y - py);
        if (d < bestCDist) {
          bestCDist = d;
          bestCorner = idx;
        }
      });

      if (bestCorner >= 0) {
        e.preventDefault();
        dragMode = "corner";
        activeHandleIdx = bestCorner;
        drawEditorStage();
        return;
      }

      // 2. Check 4 Side Slider Handles
      const pts = cropCorners.map((c) => ({
        x: imgDrawRect.x + c.x * imgDrawRect.w,
        y: imgDrawRect.y + c.y * imgDrawRect.h
      }));
      const mids = getEdgeMidpoints(pts);
      let bestEdge = -1, bestEDist = 32;
      mids.forEach((m, idx) => {
        const d = Math.hypot(pos.x - m.x, pos.y - m.y);
        if (d < bestEDist) {
          bestEDist = d;
          bestEdge = idx;
        }
      });

      if (bestEdge >= 0) {
        e.preventDefault();
        dragMode = "edge";
        activeHandleIdx = bestEdge;
        dragStartNorm = {
          x: (pos.x - imgDrawRect.x) / imgDrawRect.w,
          y: (pos.y - imgDrawRect.y) / imgDrawRect.h
        };
        const a = cropCorners[bestEdge];
        const b = cropCorners[(bestEdge + 1) % 4];
        dragStartEdgePts = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
        drawEditorStage();
        return;
      }
    }

    // 3. Pan when zoomed in
    if (viewZoom > 1.01) {
      e.preventDefault();
      dragMode = "pan";
      dragStartCanvas = pos;
      panStartOffset = { x: viewPanX, y: viewPanY };
    }
  }

  function onTouchMove(e) {
    if (!dragMode || !sourceImg) return;

    if (dragMode === "pinch" && e.touches && e.touches.length === 2) {
      e.preventDefault();
      const p1 = getPos(e.touches[0]);
      const p2 = getPos(e.touches[1]);
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

      viewZoom = Math.max(1.0, Math.min(4.0, pinchStartZoom * (dist / pinchStartDist)));
      viewPanX = panStartOffset.x + (mid.x - dragStartCanvas.x);
      viewPanY = panStartOffset.y + (mid.y - dragStartCanvas.y);
      if (viewZoom <= 1.01) {
        viewZoom = 1.0;
        viewPanX = 0;
        viewPanY = 0;
      }
      updateZoomLabel();
      drawEditorStage();
      return;
    }

    const pos = getPos(e.touches ? e.touches[0] : e);

    if (dragMode === "corner" && activeHandleIdx >= 0) {
      e.preventDefault();
      const nx = Math.max(0, Math.min(1, (pos.x - imgDrawRect.x) / imgDrawRect.w));
      const ny = Math.max(0, Math.min(1, (pos.y - imgDrawRect.y) / imgDrawRect.h));
      cropCorners[activeHandleIdx] = { x: nx, y: ny };
      drawEditorStage();
    } else if (dragMode === "edge" && activeHandleIdx >= 0 && dragStartEdgePts) {
      e.preventDefault();
      const curNx = (pos.x - imgDrawRect.x) / imgDrawRect.w;
      const curNy = (pos.y - imgDrawRect.y) / imgDrawRect.h;
      const dx = curNx - dragStartNorm.x;
      const dy = curNy - dragStartNorm.y;

      const pA = dragStartEdgePts[0];
      const pB = dragStartEdgePts[1];
      const ex = pB.x - pA.x;
      const ey = pB.y - pA.y;
      const len = Math.hypot(ex, ey) || 1;

      // Slide edge smoothly along its perpendicular normal
      const nx = -ey / len;
      const ny = ex / len;
      const proj = dx * nx + dy * ny;
      const shiftX = nx * proj;
      const shiftY = ny * proj;

      const idxA = activeHandleIdx;
      const idxB = (activeHandleIdx + 1) % 4;
      cropCorners[idxA] = {
        x: Math.max(0, Math.min(1, pA.x + shiftX)),
        y: Math.max(0, Math.min(1, pA.y + shiftY))
      };
      cropCorners[idxB] = {
        x: Math.max(0, Math.min(1, pB.x + shiftX)),
        y: Math.max(0, Math.min(1, pB.y + shiftY))
      };
      drawEditorStage();
    } else if (dragMode === "pan") {
      e.preventDefault();
      viewPanX = panStartOffset.x + (pos.x - dragStartCanvas.x);
      viewPanY = panStartOffset.y + (pos.y - dragStartCanvas.y);
      drawEditorStage();
    }
  }

  function onTouchEnd() {
    if (dragMode) {
      dragMode = null;
      activeHandleIdx = -1;
      dragStartEdgePts = null;
      drawEditorStage();
    }
  }

  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("touchcancel", onTouchEnd);

  canvas.addEventListener("mousedown", onTouchStart);
  window.addEventListener("mousemove", onTouchMove);
  window.addEventListener("mouseup", onTouchEnd);
  window.addEventListener("resize", () => {
    if (document.getElementById("tab-editor").classList.contains("active")) {
      drawEditorStage();
    }
  });
})();

// ===== 9. HOMOGRAPHY PERSPECTIVE WARP =====
function applyPerspectiveCrop() {
  if (!sourceImg || !rotCanvas.width) return;

  const srcW = rotCanvas.width;
  const srcH = rotCanvas.height;

  const p0 = { x: cropCorners[0].x * srcW, y: cropCorners[0].y * srcH };
  const p1 = { x: cropCorners[1].x * srcW, y: cropCorners[1].y * srcH };
  const p2 = { x: cropCorners[2].x * srcW, y: cropCorners[2].y * srcH };
  const p3 = { x: cropCorners[3].x * srcW, y: cropCorners[3].y * srcH };

  const widthTop = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const widthBot = Math.hypot(p2.x - p3.x, p2.y - p3.y);
  const heightLeft = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const heightRight = Math.hypot(p2.x - p1.x, p2.y - p1.y);

  let dstW = Math.max(80, Math.round(Math.max(widthTop, widthBot)));
  let dstH = Math.max(80, Math.round(Math.max(heightLeft, heightRight)));

  const maxOut = 1400;
  if (dstW > maxOut || dstH > maxOut) {
    const r = Math.min(maxOut / dstW, maxOut / dstH);
    dstW = Math.round(dstW * r);
    dstH = Math.round(dstH * r);
  }

  const dstPts = [
    { x: 0, y: 0 },
    { x: dstW - 1, y: 0 },
    { x: dstW - 1, y: dstH - 1 },
    { x: 0, y: dstH - 1 }
  ];
  const H = computeHomography(dstPts, [p0, p1, p2, p3]);

  if (!H) {
    notify("Crop points sahi set karein (lines cross na hon)");
    return;
  }

  const sctx = rotCanvas.getContext("2d");
  const srcData = sctx.getImageData(0, 0, srcW, srcH).data;

  warpedCanvas.width = dstW;
  warpedCanvas.height = dstH;
  const wctx = warpedCanvas.getContext("2d");
  const outImg = wctx.createImageData(dstW, dstH);
  const dstData = outImg.data;

  const h0 = H[0], h1 = H[1], h2 = H[2];
  const h3 = H[3], h4 = H[4], h5 = H[5];
  const h6 = H[6], h7 = H[7];

  for (let v = 0; v < dstH; v++) {
    const rowOffset = v * dstW;
    const h1v_h2 = h1 * v + h2;
    const h4v_h5 = h4 * v + h5;
    const h7v_1 = h7 * v + 1;

    for (let u = 0; u < dstW; u++) {
      const denom = h6 * u + h7v_1;
      const sx = (h0 * u + h1v_h2) / denom;
      const sy = (h3 * u + h4v_h5) / denom;

      const x0 = sx | 0;
      const y0 = sy | 0;
      const dstIdx = (rowOffset + u) * 4;

      if (x0 >= 0 && y0 >= 0 && x0 < srcW - 1 && y0 < srcH - 1) {
        const fx = sx - x0;
        const fy = sy - y0;
        const ifx = 1 - fx;
        const ify = 1 - fy;

        const w00 = ifx * ify;
        const w10 = fx * ify;
        const w01 = ifx * fy;
        const w11 = fx * fy;

        const i00 = (y0 * srcW + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + srcW * 4;
        const i11 = i01 + 4;

        dstData[dstIdx]     = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
        dstData[dstIdx + 1] = srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11;
        dstData[dstIdx + 2] = srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11;
        dstData[dstIdx + 3] = 255;
      } else {
        dstData[dstIdx] = dstData[dstIdx + 1] = dstData[dstIdx + 2] = 255;
        dstData[dstIdx + 3] = 255;
      }
    }
  }

  wctx.putImageData(outImg, 0, 0);
  syncFilterChipUI(currentFilter);
  applyCurrentFilterToWarped();
  setEditorMode("filter");
}

function computeHomography(fromPts, toPts) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const u = fromPts[i].x, v = fromPts[i].y;
    const x = toPts[i].x, y = toPts[i].y;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  return solveLinearSystem(A, b);
}

function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    if (Math.abs(M[pivotRow][col]) < 1e-10) return null;
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
    const pivot = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

// ===== 10. UPGRADED FILTERS (WHITE PAPER + RICH TEXT COLOR) =====
function setFilter(filterName, btnEl) {
  currentFilter = filterName;
  document.querySelectorAll(".filter-chip").forEach((b) => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  applyCurrentFilterToWarped();
  drawEditorStage();
}

function applyCurrentFilterToWarped() {
  if (!warpedCanvas.width) return;
  filteredCanvas.width = warpedCanvas.width;
  filteredCanvas.height = warpedCanvas.height;
  const fctx = filteredCanvas.getContext("2d");
  fctx.drawImage(warpedCanvas, 0, 0);

  if (currentFilter !== "original") {
    applyPixelFilter(fctx, filteredCanvas.width, filteredCanvas.height, currentFilter);
  }
}

  // Estimates saturation-safe local paper background so shadows turn white
// without erasing colored boxes, stamps, or light-colored text
function buildLocalBackgroundMap(canvas, w, h) {
  const div = Math.max(16, Math.round(Math.max(w, h) / 26));
  const bw = Math.max(8, Math.round(w / div));
  const bh = Math.max(8, Math.round(h / div));

  const smallC = document.createElement("canvas");
  smallC.width = bw;
  smallC.height = bh;
  const sctx = smallC.getContext("2d");
  sctx.drawImage(canvas, 0, 0, bw, bh);

  const sImg = sctx.getImageData(0, 0, bw, bh);
  const sd = sImg.data;
  const copy = new Uint8ClampedArray(sd);

  // Step 1: Estimate global neutral paper white color (low saturation + high brightness)
  const neutralCandidates = [];
  for (let i = 0; i < copy.length; i += 4) {
    const r = copy[i], g = copy[i + 1], b = copy[i + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC - minC;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (sat < 38 && lum > 105) {
      neutralCandidates.push({ r, g, b, lum });
    }
  }
  let gPaperR = 235, gPaperG = 235, gPaperB = 235;
  if (neutralCandidates.length >= 6) {
    neutralCandidates.sort((a, b) => a.lum - b.lum);
    const pIdx = Math.min(neutralCandidates.length - 1, Math.floor(neutralCandidates.length * 0.85));
    gPaperR = Math.max(155, neutralCandidates[pIdx].r);
    gPaperG = Math.max(155, neutralCandidates[pIdx].g);
    gPaperB = Math.max(155, neutralCandidates[pIdx].b);
  }

  // Step 2: 5x5 local max filter (only trusting low-saturation paper pixels)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let bestLum = -1;
      let br = gPaperR, bg = gPaperG, bb = gPaperB;

      for (let dy = -2; dy <= 2; dy++) {
        const yy = Math.max(0, Math.min(bh - 1, y + dy));
        for (let dx = -2; dx <= 2; dx++) {
          const xx = Math.max(0, Math.min(bw - 1, x + dx));
          const ii = (yy * bw + xx) * 4;
          const r = copy[ii], g = copy[ii + 1], b = copy[ii + 2];
          const sat = Math.max(r, g, b) - Math.min(r, g, b);
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          // Prefer bright neutral paper pixels over colored blocks/logos
          const score = lum - sat * 1.1;
          if (score > bestLum) {
            bestLum = score;
            br = r; bg = g; bb = b;
          }
        }
      }

      // If local patch is strongly colored or too dark, pull back toward global paper white
      const localSat = Math.max(br, bg, bb) - Math.min(br, bg, bb);
      const pull = Math.min(1, Math.max(0, (localSat - 24) / 36));
      br = br * (1 - pull) + gPaperR * pull;
      bg = bg * (1 - pull) + gPaperG * pull;
      bb = bb * (1 - pull) + gPaperB * pull;

      const oi = (y * bw + x) * 4;
      sd[oi] = Math.max(105, Math.min(255, br));
      sd[oi + 1] = Math.max(105, Math.min(255, bg));
      sd[oi + 2] = Math.max(105, Math.min(255, bb));
    }
  }
  sctx.putImageData(sImg, 0, 0);

  const bgC = document.createElement("canvas");
  bgC.width = w;
  bgC.height = h;
  const bgCtx = bgC.getContext("2d");
  bgCtx.imageSmoothingEnabled = true;
  bgCtx.drawImage(smallC, 0, 0, w, h);
  return bgCtx.getImageData(0, 0, w, h).data;
}

function applyUnsharpLuminance(d, w, h, amount) {
  const copy = new Uint8ClampedArray(d);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      const top = idx - w * 4;
      const bot = idx + w * 4;
      const left = idx - 4;
      const right = idx + 4;

      for (let c = 0; c < 3; c++) {
        const blur = (copy[idx + c] * 4 + copy[top + c] + copy[bot + c] + copy[left + c] + copy[right + c]) * 0.125;
        const sharp = copy[idx + c] + (copy[idx + c] - blur) * amount;
        d[idx + c] = Math.max(0, Math.min(255, sharp));
      }
    }
  }
}

function applyPixelFilter(ctx, w, h, mode) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Color, Auto Enhance (magic), B/W, and Grey all use shadow-free paper whitening
  if (mode === "color" || mode === "magic" || mode === "bw" || mode === "grey") {
    const bgD = buildLocalBackgroundMap(ctx.canvas, w, h);

    for (let i = 0; i < d.length; i += 4) {
      const br = bgD[i];
      const bg = bgD[i + 1];
      const bb = bgD[i + 2];

      // Remove uneven shadow & yellow tint relative to local paper
      let r = Math.min(255, (d[i] / br) * 255);
      let g = Math.min(255, (d[i + 1] / bg) * 255);
      let b = Math.min(255, (d[i + 2] / bb) * 255);

      if (mode === "color" || mode === "magic") {
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const sat = maxC - minC;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;

        // Only neutral bright paper fades to white; colored or faint ink stays 100% protected
        const whiteStart = mode === "color" ? 218 : 224;
        const whiteFull = mode === "color" ? 242 : 246;
        const lumF = Math.max(0, Math.min(1, (lum - whiteStart) / (whiteFull - whiteStart)));
        const neuF = Math.max(0, Math.min(1, (26 - sat) / 16));
        const rawBlend = lumF * neuF;
        const paperBlend = rawBlend * rawBlend * (3 - 2 * rawBlend);

        // Smooth gamma ink-deepening (no hard white clipping on light text or colors)
        const gamma = mode === "color" ? 1.22 : 1.28;
        const lumNorm = lum / 255;
        const targetLum = Math.pow(lumNorm, gamma) * 255;
        const lumScale = lum > 1 ? targetLum / lum : 1;

        let cr = r * lumScale;
        let cg = g * lumScale;
        let cb = b * lumScale;

        // Keep colored ink (blue/red/green/yellow) rich & vivid without washing out
        const newLum = 0.299 * cr + 0.587 * cg + 0.114 * cb;
        const satBoost = mode === "color" ? 1.32 : 1.2;
        cr = newLum + (cr - newLum) * satBoost;
        cg = newLum + (cg - newLum) * satBoost;
        cb = newLum + (cb - newLum) * satBoost;

        r = cr + (255 - cr) * paperBlend;
        g = cg + (255 - cg) * paperBlend;
        b = cb + (255 - cb) * paperBlend;
      } else if (mode === "bw") {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const v = lum > 195 ? 255 : 0;
        r = g = b = v;
      } else if (mode === "grey") {
        let lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const lumF = Math.max(0, Math.min(1, (lum - 216) / 26));
        const ink = Math.pow(lum / 255, 1.25) * 255;
        r = g = b = ink + (255 - ink) * lumF;
      }

      d[i] = Math.max(0, Math.min(255, r));
      d[i + 1] = Math.max(0, Math.min(255, g));
      d[i + 2] = Math.max(0, Math.min(255, b));
    }

    // Add gentle crispness to text edges in Auto Enhance & Color modes
    if (mode === "magic") {
      applyUnsharpLuminance(d, w, h, 0.55);
    } else if (mode === "color") {
      applyUnsharpLuminance(d, w, h, 0.28);
    }

    ctx.putImageData(imgData, 0, 0);
    return;
  }

  if (mode === "denoise") {
    const copy = new Uint8ClampedArray(d);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              sum += copy[((y + dy) * w + (x + dx)) * 4 + c];
            }
          }
          const avg = sum / 9;
          const idx = (y * w + x) * 4 + c;
          let val = avg + (copy[idx] - avg) * 0.45;
          val = (val - 128) * 1.25 + 136;
          d[idx] = Math.max(0, Math.min(255, val));
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (mode === "dark") {
      r = (r - 128) * 1.38 + 92;
      g = (g - 128) * 1.38 + 92;
      b = (b - 128) * 1.38 + 92;
    }
    d[i] = Math.max(0, Math.min(255, r));
    d[i + 1] = Math.max(0, Math.min(255, g));
    d[i + 2] = Math.max(0, Math.min(255, b));
  }
  ctx.putImageData(imgData, 0, 0);
}
async function saveEditedDoc() {
  if (!filteredCanvas.width) return notify("Pehle photo scan aur straighten karein");
  const dataUrl = filteredCanvas.toDataURL("image/jpeg", 0.92);

  if (editingDocId && editingDocMeta) {
    await dbPut("docs", {
      ...editingDocMeta,
      dataUrl,
      origDataUrl: editingDocMeta.origDataUrl || currentOrigDataUrl || dataUrl
    });
  } else {
    await dbPut("docs", {
      id: "doc_" + Date.now(),
      folderId: currentFolderId,
      name: "Doc_" + new Date().toLocaleTimeString().replace(/[: ]/g, "_") + ".jpg",
      dataUrl,
      origDataUrl: currentOrigDataUrl || dataUrl,
      createdAt: Date.now()
    });
  }

  // If in Gallery Batch Edit mode, automatically open next photo
  if (batchEditQueue.length > 0 && batchEditIndex >= 0) {
    if (batchEditIndex + 1 < batchEditQueue.length) {
      batchEditIndex++;
      notify("Save ho gaya! Agli photo khul rahi hai...");
      await editSavedDoc(batchEditQueue[batchEditIndex], true);
      return;
    } else {
      notify("Sabhi gallery photos edit aur save ho gayi!");
      exitBatchEdit();
      return;
    }
  }

  notify(editingDocId ? "Document update ho gaya!" : "Document save ho gaya!");
  editingDocId = null;
  editingDocMeta = null;
  switchTab("docs");
  loadFolderContents();
}

// ===== 11. OFFLINE OCR TEXT RECOGNITION =====
function handleOcrFileInput(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  readAndCompressFile(file).then((dataUrl) => {
    triggerNativeOcr(dataUrl.split(",")[1]);
  });
}

function runOcrFromEditor() {
  if (!filteredCanvas.width) return notify("Pehle image ko Straighten karein");
  const b64 = filteredCanvas.toDataURL("image/jpeg", 0.92).split(",")[1];
  switchTab("ocr");
  triggerNativeOcr(b64);
}

async function runOcrFromDoc(docId) {
  const allDocs = await dbGetAll("docs");
  const doc = allDocs.find((d) => d.id === docId);
  if (!doc) return;
  switchTab("ocr");
  triggerNativeOcr(doc.dataUrl.split(",")[1]);
}

function triggerNativeOcr(base64Image) {
  const lang = document.getElementById("ocrLangSelect").value;
  document.getElementById("ocrStatus").textContent = "Text scan ho raha hai (Offline ML Kit)...";
  document.getElementById("ocrOutputText").value = "";

  if (window.AndroidBridge) {
    AndroidBridge.runOcrFromBase64(base64Image, lang);
  } else {
    document.getElementById("ocrStatus").textContent = "OCR sirf Android APK mein chalta hai.";
  }
}

window.onNativeOcrResult = function (text, errorMsg) {
  const statusEl = document.getElementById("ocrStatus");
  const outEl = document.getElementById("ocrOutputText");

  if (errorMsg) {
    statusEl.textContent = "OCR Error: " + errorMsg;
    return;
  }
  if (text && text.trim()) {
    outEl.value = text;
    statusEl.textContent = "Text mil gaya! Aap ise niche edit, copy ya share kar sakte hain.";
  } else {
    outEl.value = "";
    statusEl.textContent = "Image mein koi saaf text detect nahi hua. Color ya B/W filter lagakar try karein.";
  }
};

function copyOcrText() {
  const txt = document.getElementById("ocrOutputText").value.trim();
  if (!txt) return notify("Copy karne ke liye koi text nahi hai.");
  if (window.AndroidBridge) AndroidBridge.copyToClipboard(txt);
}

function shareOcrText() {
  const txt = document.getElementById("ocrOutputText").value.trim();
  if (!txt) return notify("Share karne ke liye koi text nahi hai.");
  if (window.AndroidBridge) AndroidBridge.shareText(txt);
}

function saveOcrTxtFile() {
  const txt = document.getElementById("ocrOutputText").value.trim();
  if (!txt) return notify("Save karne ke liye koi text nahi hai.");
  const utf8Bytes = new TextEncoder().encode(txt);
  const b64 = uint8ToBase64(utf8Bytes);
  if (window.AndroidBridge) {
    AndroidBridge.saveToDevice(b64, `OCR_${Date.now()}.txt`, "text/plain");
  }
}

function clearOcrText() {
  document.getElementById("ocrOutputText").value = "";
  document.getElementById("ocrStatus").textContent = "Cleared.";
}

// ===== 12. EXPORT JPEG & PURE-JS MULTI-PAGE PDF =====
async function exportSingleJpg(docId, action) {
  const allDocs = await dbGetAll("docs");
  const doc = allDocs.find((d) => d.id === docId);
  if (!doc) return;
  const b64 = doc.dataUrl.split(",")[1];
  if (window.AndroidBridge) {
    if (action === "save") AndroidBridge.saveToDevice(b64, doc.name, "image/jpeg");
    else AndroidBridge.shareFile(b64, doc.name, "image/jpeg");
  }
}

async function exportFolderPdf(action) {
  const allDocs = await dbGetAll("docs");
  const folderDocs = allDocs
    .filter((d) => d.folderId === currentFolderId)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (folderDocs.length === 0) {
    return notify("Is folder mein koi scanned document nahi hai.");
  }

  const sizeKey = document.getElementById("pdfSizeSelect").value;
  const [pageW, pageH] = PDF_SIZES[sizeKey] || PDF_SIZES.A4;

  const pages = [];
  for (const doc of folderDocs) {
    const dim = await getImageDimensions(doc.dataUrl);
    pages.push({
      bytes: base64ToUint8(doc.dataUrl.split(",")[1]),
      w: dim.w,
      h: dim.h
    });
  }

  const pdfBytes = buildMultiPagePdf(pages, pageW, pageH);
  const pdfBase64 = uint8ToBase64(pdfBytes);
  const fileName = `DocScanner_${sizeKey}_${Date.now()}.pdf`;

  if (window.AndroidBridge) {
    if (action === "save") AndroidBridge.saveToDevice(pdfBase64, fileName, "application/pdf");
    else if (action === "share") AndroidBridge.shareFile(pdfBase64, fileName, "application/pdf");
    else if (action === "print") AndroidBridge.printPdf(pdfBase64, fileName);
  }
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.width, h: img.height });
    img.src = dataUrl;
  });
}

function base64ToUint8(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function buildMultiPagePdf(pages, pageW, pageH) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;

  const pushStr = (s) => {
    const b = enc.encode(s);
    chunks.push(b);
    length += b.length;
  };
  const pushBytes = (b) => {
    chunks.push(b);
    length += b.length;
  };

  pushStr("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");

  const pageObjIds = [];
  for (let i = 0; i < pages.length; i++) {
    pageObjIds.push(3 + i * 3 + 2);
  }

  offsets.push(length);
  pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  offsets.push(length);
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => id + " 0 R").join(" ")}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((p, idx) => {
    const imgId = 3 + idx * 3;
    const contentId = imgId + 1;
    const pageId = imgId + 2;

    offsets.push(length);
    pushStr(
      `${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`
    );
    pushBytes(p.bytes);
    pushStr("\nendstream\nendobj\n");

    const margin = 18;
    const availW = pageW - margin * 2;
    const availH = pageH - margin * 2;
    const ratio = Math.min(availW / p.w, availH / p.h);
    const drawW = (p.w * ratio).toFixed(2);
    const drawH = (p.h * ratio).toFixed(2);
    const ox = ((pageW - drawW) / 2).toFixed(2);
    const oy = ((pageH - drawH) / 2).toFixed(2);

    const streamStr = `q\n${drawW} 0 0 ${drawH} ${ox} ${oy} cm\n/Im0 Do\nQ\n`;
    offsets.push(length);
    pushStr(`${contentId} 0 obj\n<< /Length ${streamStr.length} >>\nstream\n${streamStr}endstream\nendobj\n`);

    offsets.push(length);
    pushStr(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`
    );
  });

  const xrefPos = length;
  pushStr(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  offsets.forEach((off) => {
    pushStr(String(off).padStart(10, "0") + " 00000 n \n");
  });
  pushStr(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  const merged = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) {
    merged.set(c, pos);
    pos += c.length;
  }
  return merged;
}

// ===== 13. QR CODE & BARCODE =====
function scanQrImage(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const b64 = e.target.result.split(",")[1];
    document.getElementById("qrScanOutput").value = "Scanning...";
    if (window.AndroidBridge) {
      AndroidBridge.scanBarcodeFromBase64(b64);
    }
  };
  reader.readAsDataURL(file);
}

window.onNativeBarcodeResult = function (text) {
  const out = document.getElementById("qrScanOutput");
  if (text) {
    out.value = text;
    notify("QR / Barcode mil gaya!");
  } else {
    out.value = "";
    notify("Koi QR ya Barcode detect nahi hua. Clear photo lein.");
  }
};

function shareQrResult() {
  const val = document.getElementById("qrScanOutput").value.trim();
  if (!val) return notify("Pehle koi QR/Barcode scan karein.");
  if (window.AndroidBridge) AndroidBridge.shareText(val);
}

function createQrCode() {
  const txt = document.getElementById("qrInputText").value.trim();
  if (!txt) return notify("QR banane ke liye kuch text likhein.");
  if (window.AndroidBridge) {
    const dataUrl = AndroidBridge.generateQrCode(txt);
    if (dataUrl) {
      lastGeneratedQr = dataUrl;
      document.getElementById("qrPreviewBox").innerHTML = `<img src="${dataUrl}" alt="QR Code" />`;
    }
  }
}

function exportGeneratedQr(action) {
  if (!lastGeneratedQr) return notify("Pehle QR Code generate karein.");
  const b64 = lastGeneratedQr.split(",")[1];
  const name = `QR_${Date.now()}.png`;
  if (window.AndroidBridge) {
    if (action === "save") AndroidBridge.saveToDevice(b64, name, "image/png");
    else AndroidBridge.shareFile(b64, name, "image/png");
  }
}

initDB();
