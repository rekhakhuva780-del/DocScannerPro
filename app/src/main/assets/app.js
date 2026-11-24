// ===== 1. OFFLINE INDEXEDDB STORAGE (FOLDERS, SUBFOLDERS & SCANS) =====
let db;
let currentFolderId = "root";
let folderStack = [{ id: "root", name: "Home" }];
let flashOn = false;

// Editor state
let sourceImg = null;
let currentFilter = "original";
let rotationDeg = 0;
let batchQueue = [];
let lastGeneratedQr = "";

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

// ===== 3. FOLDERS & SUBFOLDERS =====
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
          <button class="small-btn" onclick="exportSingleJpg('${doc.id}', 'share')">Share</button>
          <button class="small-btn" onclick="deleteDoc('${doc.id}')">Del</button>
        </div>
      </div>
    `;
    dList.appendChild(card);
  });
}

// ===== 4. IMAGE CAPTURE, SMART EDGE CROP & FILTERS =====
function handleImageInput(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (files.length === 0) return;

  if (files.length === 1) {
    loadFileIntoEditor(files[0]);
  } else {
    // Multiple gallery images -> seedha batch save in current folder
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
      ["cropTop", "cropBottom", "cropLeft", "cropRight"].forEach((id) => {
        document.getElementById(id).value = 0;
      });
      switchTab("editor");
      renderPreview();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function rotateImage() {
  if (!sourceImg) return;
  rotationDeg = (rotationDeg + 90) % 360;
  renderPreview();
}

function setFilter(filterName, btnEl) {
  currentFilter = filterName;
  document.querySelectorAll(".filter-chip").forEach((b) => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  renderPreview();
}

// Smart Edge Detection (Brightness gradient se document border detect karna)
function autoDetectEdges() {
  if (!sourceImg) return;
  const temp = document.createElement("canvas");
  const sw = 200, sh = Math.round((sourceImg.height / sourceImg.width) * 200);
  temp.width = sw; temp.height = sh;
  const tctx = temp.getContext("2d");
  tctx.drawImage(sourceImg, 0, 0, sw, sh);
  const data = tctx.getImageData(0, 0, sw, sh).data;

  const isBright = (x, y) => {
    const idx = (y * sw + x) * 4;
    const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    return lum > 135;
  };

  let minX = sw, maxX = 0, minY = sh, maxY = 0;
  for (let y = 2; y < sh - 2; y++) {
    for (let x = 2; x < sw - 2; x++) {
      if (isBright(x, y)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX > minX + 20 && maxY > minY + 20) {
    document.getElementById("cropLeft").value = Math.min(35, Math.floor((minX / sw) * 100));
    document.getElementById("cropRight").value = Math.min(35, Math.floor(((sw - maxX) / sw) * 100));
    document.getElementById("cropTop").value = Math.min(35, Math.floor((minY / sh) * 100));
    document.getElementById("cropBottom").value = Math.min(35, Math.floor(((sh - maxY) / sh) * 100));
    renderPreview();
    notify("Smart Edge Crop apply ho gaya");
  } else {
    notify("Manual sliders se crop adjust karein");
  }
}

function renderPreview() {
  if (!sourceImg) return;
  const canvas = document.getElementById("editorCanvas");
  const ctx = canvas.getContext("2d");

  const maxW = 1200;
  const scale = Math.min(1, maxW / Math.max(sourceImg.width, sourceImg.height));
  const rawW = Math.round(sourceImg.width * scale);
  const rawH = Math.round(sourceImg.height * scale);

  // Rotate stage
  const rotCanvas = document.createElement("canvas");
  const isOdd = rotationDeg === 90 || rotationDeg === 270;
  rotCanvas.width = isOdd ? rawH : rawW;
  rotCanvas.height = isOdd ? rawW : rawH;
  const rctx = rotCanvas.getContext("2d");
  rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
  rctx.rotate((rotationDeg * Math.PI) / 180);
  rctx.drawImage(sourceImg, -rawW / 2, -rawH / 2, rawW, rawH);

  // Crop stage
  const topPct = Number(document.getElementById("cropTop").value) / 100;
  const botPct = Number(document.getElementById("cropBottom").value) / 100;
  const leftPct = Number(document.getElementById("cropLeft").value) / 100;
  const rightPct = Number(document.getElementById("cropRight").value) / 100;

  const sx = Math.round(rotCanvas.width * leftPct);
  const sy = Math.round(rotCanvas.height * topPct);
  const cw = Math.max(50, Math.round(rotCanvas.width * (1 - leftPct - rightPct)));
  const ch = Math.max(50, Math.round(rotCanvas.height * (1 - topPct - botPct)));

  canvas.width = cw;
  canvas.height = ch;
  ctx.drawImage(rotCanvas, sx, sy, cw, ch, 0, 0, cw, ch);

  if (currentFilter !== "original") {
    applyPixelFilter(ctx, cw, ch, currentFilter);
  }
}

function applyPixelFilter(ctx, w, h, mode) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  if (mode === "denoise") {
    // 3x3 Grain/Noise removal + Contrast Sharpening
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
          // Unsharp clean contrast
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
  if (!sourceImg) return notify("Pehle koi photo scan karein");
  const canvas = document.getElementById("editorCanvas");
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

  await dbPut("docs", {
    id: "doc_" + Date.now(),
    folderId: currentFolderId,
    name: "Doc_" + new Date().toLocaleTimeString().replace(/[: ]/g, "_") + ".jpg",
    dataUrl,
    createdAt: Date.now()
  });

  notify("Document save ho gaya!");
  switchTab("docs");
  loadFolderContents();
}

// ===== 5. EXPORT JPEG & PURE-JS MULTI-PAGE PDF GENERATOR (A1-A6, LETTER, ETC.) =====
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

// 100% Offline Spec-Valid Multi-Page PDF Builder
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

  // Obj 1: Catalog
  offsets.push(length);
  pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // Obj 2: Pages
  offsets.push(length);
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => id + " 0 R").join(" ")}] /Count ${pages.length} >>\nendobj\n`);

  // Each page = 3 objects (Image, Content, Page)
  pages.forEach((p, idx) => {
    const imgId = 3 + idx * 3;
    const contentId = imgId + 1;
    const pageId = imgId + 2;

    // Image XObject
    offsets.push(length);
    pushStr(
      `${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`
    );
    pushBytes(p.bytes);
    pushStr("\nendstream\nendobj\n");

    // Fit image inside chosen PDF size with small margin
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

    // Page object
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

// ===== 6. QR CODE & BARCODE SCANNER + GENERATOR =====
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
