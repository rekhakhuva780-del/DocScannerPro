// ===== 1. OFFLINE INDEXEDDB STORAGE =====
let db;
let currentFolderId = "root";
let folderStack = [{ id: "root", name: "Home" }];
let flashOn = false;
let lastGeneratedQr = "";

// ===== EDITOR & 4-CORNER PERSPECTIVE STATE =====
let sourceImg = null;
let rotationDeg = 0;
let editorMode = "crop"; // "crop" | "filter"
let currentFilter = "original";

// Offscreen working canvases
let rotCanvas = document.createElement("canvas");
let warpedCanvas = document.createElement("canvas");
let filteredCanvas = document.createElement("canvas");

// 4 normalized corners on rotCanvas: [TL, TR, BR, BL]
let cropCorners = [
  { x: 0.08, y: 0.08 },
  { x: 0.92, y: 0.08 },
  { x: 0.92, y: 0.92 },
  { x: 0.08, y: 0.92 }
];
let activeCornerIdx = -1;
let imgDrawRect = { x: 0, y: 0, w: 1, h: 1 }; // Where current image sits inside #editorCanvas (CSS px)

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

// ===== 3. FOLDERS & DOCUMENTS =====
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
      <img src="${doc.dataUrl}" alt="${doc.name}" />
      <div class="doc-meta">
        <p>${doc.name}</p>
        <div class="doc-actions">
          <button class="small-btn" onclick="exportSingleJpg('${doc.id}', 'save')">JPG</button>
          <button class="small-btn" onclick="runOcrFromDoc('${doc.id}')">OCR</button>
          <button class="small-btn" onclick="exportSingleJpg('${doc.id}', 'share')">Share</button>
          <button class="small-btn" onclick="deleteDoc('${doc.id}')">Del</button>
        </div>
      </div>
    `;
    dList.appendChild(card);
  });
}

// ===== 4. IMAGE LOADING & 4-CORNER PERSPECTIVE EDITOR =====
function handleImageInput(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (files.length === 0) return;

  if (files.length === 1) {
    loadFileIntoEditor(files[0]);
  } else {
    batchImportImages(files);
  }
}

async function batchImportImages(files) {
  for (let i = 0; i < files.length; i++) {
    const dataUrl = await readAndCompressFile(files[i]);
    await dbPut("docs", {
      id: "doc_" + Date.now() + "_" + i,
      folderId: currentFolderId,
      name: "Scan_" + (i + 1) + ".jpg",
      dataUrl,
      createdAt: Date.now() + i
    });
  }
  notify(files.length + " images import ho gayi! Ab Save PDF dabayein.");
  loadFolderContents();
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

function loadFileIntoEditor(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      sourceImg = img;
      rotationDeg = 0;
      currentFilter = "original";
      document.getElementById("editorEmptyHint").classList.add("hidden");
      rebuildRotatedCanvas();
      autoDetectCorners(true);
      setEditorMode("crop");
      switchTab("editor");
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
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
  rebuildRotatedCanvas();
  resetFullCorners();
}

function setEditorMode(mode) {
  editorMode = mode;
  const isCrop = mode === "crop";
  document.getElementById("cropTopBar").classList.toggle("hidden", !isCrop);
  document.getElementById("cropBottomHint").classList.toggle("hidden", !isCrop);
  document.getElementById("filterTopBar").classList.toggle("hidden", isCrop);
  document.getElementById("filterStrip").classList.toggle("hidden", isCrop);
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

// Auto-detect tilted document corners (finds 4 extreme corners of bright paper region)
function autoDetectCorners(silent = false) {
  if (!sourceImg || !rotCanvas.width) return;
  const sw = 200;
  const sh = Math.max(60, Math.round((rotCanvas.height / rotCanvas.width) * sw));
  const tmp = document.createElement("canvas");
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(rotCanvas, 0, 0, sw, sh);
  const d = tctx.getImageData(0, 0, sw, sh).data;

  // Estimate average brightness
  let lumSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    lumSum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const threshold = Math.max(110, Math.min(185, lumSum / (sw * sh) + 12));

  let tl = null, tr = null, br = null, bl = null;
  let minSum = Infinity, maxDiff = -Infinity, maxSum = -Infinity, minDiff = Infinity;
  let count = 0;

  for (let y = 3; y < sh - 3; y++) {
    for (let x = 3; x < sw - 3; x++) {
      const idx = (y * sw + x) * 4;
      const lum = 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
      if (lum > threshold) {
        count++;
        const s = x + y;
        const diff = x - y;
        if (s < minSum) { minSum = s; tl = { x: x / sw, y: y / sh }; }
        if (diff > maxDiff) { maxDiff = diff; tr = { x: x / sw, y: y / sh }; }
        if (s > maxSum) { maxSum = s; br = { x: x / sw, y: y / sh }; }
        if (diff < minDiff) { minDiff = diff; bl = { x: x / sw, y: y / sh }; }
      }
    }
  }

  const areaRatio = count / (sw * sh);
  if (tl && tr && br && bl && areaRatio > 0.1 && areaRatio < 0.94) {
    cropCorners = [tl, tr, br, bl];
    if (!silent) notify("4 konon ka auto-detect ho gaya");
  } else {
    cropCorners = [
      { x: 0.08, y: 0.08 },
      { x: 0.92, y: 0.08 },
      { x: 0.92, y: 0.92 },
      { x: 0.08, y: 0.92 }
    ];
    if (!silent) notify("Konon ko ungli se paper par set karein");
  }
  drawEditorStage();
}

// ===== FULL-FIT CANVAS RENDERER (POORI IMAGE HAMESHA DIKHEGI) =====
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

  // 26px margin around image so handles at corners are super easy to grab
  const pad = editorMode === "crop" ? 26 : 12;
  const availW = Math.max(20, cssW - pad * 2);
  const availH = Math.max(20, cssH - pad * 2);
  const fitScale = Math.min(availW / imgSrc.width, availH / imgSrc.height);

  const drawW = imgSrc.width * fitScale;
  const drawH = imgSrc.height * fitScale;
  const drawX = (cssW - drawW) / 2;
  const drawY = (cssH - drawH) / 2;
  imgDrawRect = { x: drawX, y: drawY, w: drawW, h: drawH };

  ctx.drawImage(imgSrc, drawX, drawY, drawW, drawH);

  if (editorMode !== "crop") return;

  // Convert normalized corners to canvas CSS coordinates
  const pts = cropCorners.map((c) => ({
    x: drawX + c.x * drawW,
    y: drawY + c.y * drawH
  }));

  // Dim outside the selected quadrilateral
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

  // Draw bright polygon outline
  ctx.save();
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();

  // Draw 4 large draggable handles
  pts.forEach((p, idx) => {
    const isActive = idx === activeCornerIdx;
    ctx.beginPath();
    ctx.arc(p.x, p.y, isActive ? 16 : 13, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? "#facc15" : "rgba(14, 165, 233, 0.85)";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  });
  ctx.restore();

  // Draw Magnifier Loupe while dragging a corner so finger doesn't hide the corner
  if (activeCornerIdx >= 0) {
    drawMagnifierLoupe(ctx, cssW, cropCorners[activeCornerIdx]);
  }
}

function drawMagnifierLoupe(ctx, cssW, normPt) {
  const radius = 48;
  const cx = normPt.x < 0.5 ? cssW - radius - 14 : radius + 14;
  const cy = radius + 14;

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

  // Crosshair inside magnifier
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx, cy + 12);
  ctx.stroke();
  ctx.restore();

  // Outer border of magnifier
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#38bdf8";
  ctx.stroke();
  ctx.restore();
}

// ===== TOUCH & POINTER DRAG HANDLERS FOR 4 CORNERS =====
(function bindCropTouchEvents() {
  const canvas = document.getElementById("editorCanvas");

  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    };
  }

  function onStart(e) {
    if (editorMode !== "crop" || !sourceImg) return;
    const pos = getCanvasPos(e);
    let bestIdx = -1;
    let bestDist = 42; // Comfortable finger hit area

    cropCorners.forEach((c, idx) => {
      const px = imgDrawRect.x + c.x * imgDrawRect.w;
      const py = imgDrawRect.y + c.y * imgDrawRect.h;
      const dist = Math.hypot(pos.x - px, pos.y - py);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    });

    if (bestIdx >= 0) {
      e.preventDefault();
      activeCornerIdx = bestIdx;
      drawEditorStage();
    }
  }

  function onMove(e) {
    if (activeCornerIdx < 0 || editorMode !== "crop") return;
    e.preventDefault();
    const pos = getCanvasPos(e);
    const nx = Math.max(0, Math.min(1, (pos.x - imgDrawRect.x) / imgDrawRect.w));
    const ny = Math.max(0, Math.min(1, (pos.y - imgDrawRect.y) / imgDrawRect.h));
    cropCorners[activeCornerIdx] = { x: nx, y: ny };
    drawEditorStage();
  }

  function onEnd() {
    if (activeCornerIdx >= 0) {
      activeCornerIdx = -1;
      drawEditorStage();
    }
  }

  canvas.addEventListener("touchstart", onStart, { passive: false });
  canvas.addEventListener("touchmove", onMove, { passive: false });
  canvas.addEventListener("touchend", onEnd);
  canvas.addEventListener("touchcancel", onEnd);

  canvas.addEventListener("mousedown", onStart);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onEnd);
  window.addEventListener("resize", () => {
    if (document.getElementById("tab-editor").classList.contains("active")) {
      drawEditorStage();
    }
  });
})();

// ===== 5. HOMOGRAPHY PERSPECTIVE WARP (TEDHI IMAGE KO SEEDHA KARNA) =====
function applyPerspectiveCrop() {
  if (!sourceImg || !rotCanvas.width) return;

  const srcW = rotCanvas.width;
  const srcH = rotCanvas.height;

  // Source quadrilateral points in pixel coordinates: TL, TR, BR, BL
  const p0 = { x: cropCorners[0].x * srcW, y: cropCorners[0].y * srcH };
  const p1 = { x: cropCorners[1].x * srcW, y: cropCorners[1].y * srcH };
  const p2 = { x: cropCorners[2].x * srcW, y: cropCorners[2].y * srcH };
  const p3 = { x: cropCorners[3].x * srcW, y: cropCorners[3].y * srcH };

  // Compute natural straightened width & height
  const widthTop = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const widthBot = Math.hypot(p2.x - p3.x, p2.y - p3.y);
  const heightLeft = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const heightRight = Math.hypot(p2.x - p1.x, p2.y - p1.y);

  let dstW = Math.max(80, Math.round(Math.max(widthTop, widthBot)));
  let dstH = Math.max(80, Math.round(Math.max(heightLeft, heightRight)));

  // Cap max dimension to 1400px for super fast mobile processing + sharp text
  const maxOut = 1400;
  if (dstW > maxOut || dstH > maxOut) {
    const r = Math.min(maxOut / dstW, maxOut / dstH);
    dstW = Math.round(dstW * r);
    dstH = Math.round(dstH * r);
  }

  // Solve inverse homography mapping destination rectangle -> source quad
  const dstPts = [
    { x: 0, y: 0 },
    { x: dstW - 1, y: 0 },
    { x: dstW - 1, y: dstH - 1 },
    { x: 0, y: dstH - 1 }
  ];
  const srcPts = [p0, p1, p2, p3];
  const H = computeHomography(dstPts, srcPts);

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

  // Bilinear perspective mapping
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

  // Reset filter selection to original or keep current
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

// ===== 6. FILTERS & SAVE =====
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

function applyPixelFilter(ctx, w, h, mode) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

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
          let val = avg + (copy[idx] - avg) * 0.4;
          val = (val - 128) * 1.25 + 138;
          d[idx] = Math.max(0, Math.min(255, val));
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    const grey = 0.299 * r + 0.587 * g + 0.114 * b;

    if (mode === "magic") {
      r = (r - 115) * 1.45 + 135;
      g = (g - 115) * 1.45 + 135;
      b = (b - 115) * 1.45 + 135;
    } else if (mode === "bw") {
      const v = grey > 132 ? 255 : 0;
      r = g = b = v;
    } else if (mode === "grey") {
      const v = (grey - 120) * 1.2 + 128;
      r = g = b = v;
    } else if (mode === "skyblue") {
      const v = (grey - 110) * 1.3 + 128;
      r = v * 0.85;
      g = v * 0.96;
      b = Math.min(255, v * 1.15 + 18);
    } else if (mode === "lighten") {
      r += 40; g += 40; b += 40;
    } else if (mode === "dark") {
      r = (r - 128) * 1.35 + 95;
      g = (g - 128) * 1.35 + 95;
      b = (b - 128) * 1.35 + 95;
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

  await dbPut("docs", {
    id: "doc_" + Date.now(),
    folderId: currentFolderId,
    name: "Doc_" + new Date().toLocaleTimeString().replace(/[: ]/g, "_") + ".jpg",
    dataUrl,
    createdAt: Date.now()
  });

  notify("Straightened document save ho gaya!");
  switchTab("docs");
  loadFolderContents();
}

// ===== 7. OFFLINE OCR TEXT RECOGNITION =====
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
    statusEl.textContent = "Image mein koi saaf text detect nahi hua. Better light ya B/W filter try karein.";
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

// ===== 8. EXPORT JPEG & PURE-JS MULTI-PAGE PDF GENERATOR =====
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

// ===== 9. QR CODE & BARCODE =====
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
