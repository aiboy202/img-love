const APP_VERSION = "pwa-mvp-0.1";

const DEFAULT_SETTINGS = {
  ocrLang: "chi_sim",
  classifierMode: "rules",
  currentCity: "全部"
};

const INTERESTS = [
  "全部",
  "旅游景点",
  "美食餐厅",
  "咖啡甜品",
  "酒店民宿",
  "购物",
  "亲子",
  "户外徒步",
  "垂钓",
  "运动健身",
  "拍照机位",
  "交通攻略"
];

const CITY_CANDIDATES = [
  "全部",
  "北京",
  "上海",
  "广州",
  "深圳",
  "成都",
  "重庆",
  "杭州",
  "南京",
  "苏州",
  "武汉",
  "西安",
  "长沙",
  "青岛",
  "厦门",
  "昆明",
  "大理",
  "丽江",
  "三亚",
  "贵阳",
  "哈尔滨",
  "沈阳",
  "大连",
  "天津",
  "郑州",
  "济南",
  "福州",
  "泉州",
  "合肥",
  "南昌",
  "南宁",
  "拉萨",
  "乌鲁木齐",
  "呼和浩特"
];

const DB_NAME = "img-love";
const DB_VERSION = 2;

function openDBFallback(name, version, { upgrade } = {}) {
  const promisifyRequest = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  const txDone = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Transaction error"));
      tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    });

  const wrapStore = (store) => ({
    get: (key) => promisifyRequest(store.get(key)),
    put: (value, key) => promisifyRequest(store.put(value, key)),
    delete: (key) => promisifyRequest(store.delete(key)),
    clear: () => promisifyRequest(store.clear())
  });

  const getAllCompat = (store) => {
    if (store.getAll) return promisifyRequest(store.getAll());
    return new Promise((resolve, reject) => {
      const out = [];
      const req = store.openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        out.push(cursor.value);
        cursor.continue();
      };
    });
  };

  const wrapTx = (tx) => ({
    objectStore: (name) => wrapStore(tx.objectStore(name)),
    get done() {
      return txDone(tx);
    }
  });

  const wrapDb = (db) => ({
    get: async (storeName, key) => {
      const tx = db.transaction([storeName], "readonly");
      const store = tx.objectStore(storeName);
      const v = await promisifyRequest(store.get(key));
      await txDone(tx);
      return v;
    },
    put: async (storeName, value, key) => {
      const tx = db.transaction([storeName], "readwrite");
      const store = tx.objectStore(storeName);
      await promisifyRequest(store.put(value, key));
      await txDone(tx);
    },
    delete: async (storeName, key) => {
      const tx = db.transaction([storeName], "readwrite");
      const store = tx.objectStore(storeName);
      await promisifyRequest(store.delete(key));
      await txDone(tx);
    },
    getAll: async (storeName) => {
      const tx = db.transaction([storeName], "readonly");
      const store = tx.objectStore(storeName);
      const v = await getAllCompat(store);
      await txDone(tx);
      return v;
    },
    transaction: (storeNames, mode) => wrapTx(db.transaction(storeNames, mode))
  });

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      if (typeof upgrade === "function") upgrade(req.result);
    };
    req.onsuccess = () => resolve(wrapDb(req.result));
    req.onerror = () => reject(req.error);
  });
}

if (!globalThis.idb?.openDB) {
  globalThis.idb = { openDB: openDBFallback };
}

function assertDeps() {
  const missing = [];
  if (!globalThis.Tesseract) missing.push("tesseract.js");
  if (missing.length) {
    alert(`关键依赖加载失败：${missing.join(", ")}。\n可能是网络或浏览器限制导致 CDN 资源未加载。\n请刷新重试或更换网络/浏览器。`);
    throw new Error(`Missing deps: ${missing.join(", ")}`);
  }
}

assertDeps();

const dbPromise = globalThis.idb.openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    let store = null;
    if (db.objectStoreNames.contains("items")) {
      store = db.transaction.objectStore("items");
    } else {
      store = db.createObjectStore("items", { keyPath: "id" });
    }

    if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt");
    if (!store.indexNames.contains("city")) store.createIndex("city", "city");
    if (!store.indexNames.contains("primaryInterest")) store.createIndex("primaryInterest", "primaryInterest");

    if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
  }
});

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function clampText(s, n = 180) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function safeParseJSON(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function kvGet(key, fallback) {
  const db = await dbPromise;
  const v = await db.get("kv", key);
  return v === undefined ? fallback : v;
}

async function kvSet(key, value) {
  const db = await dbPromise;
  await db.put("kv", value, key);
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fileHash(file) {
  const buf = await file.arrayBuffer();
  return sha256Hex(buf);
}

async function semanticExtract(text) {
  const res = await fetch("/api/semantic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error(`语义接口失败：HTTP ${res.status}`);
  return await res.json();
}

async function visionExtract(imageDataUrl, { cityHint, interestHint } = {}) {
  const res = await fetch("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageDataUrl, cityHint, interestHint })
  });
  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data?.error ? `：${data.error}` : "";
      if (data?.details) detail += `\n${JSON.stringify(data.details).slice(0, 1200)}`;
    } catch {
      try {
        const t = await res.text();
        detail = t ? `\n${t.slice(0, 1200)}` : "";
      } catch {
        // ignore
      }
    }
    throw new Error(`视觉识别接口失败：HTTP ${res.status}${detail}`);
  }
  return await res.json();
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("加载图片失败"));
    };
    img.src = url;
  });
}

async function fileToJpegDataUrl(file, { maxDim = 1280, quality = 0.72 } = {}) {
  const img = await loadImageFromFile(file);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 不可用");
  ctx.drawImage(img, 0, 0, tw, th);

  return canvas.toDataURL("image/jpeg", quality);
}

async function fileToJpegDataUrlUnderLimit(file, { byteLimit = 900_000 } = {}) {
  // Edge Functions request body size is ~1MB; keep payload comfortably below that.
  // Note: dataURL is base64 text; length roughly correlates with bytes.
  const attempts = [
    { maxDim: 1280, quality: 0.72 },
    { maxDim: 1152, quality: 0.68 },
    { maxDim: 1024, quality: 0.62 },
    { maxDim: 960, quality: 0.58 },
    { maxDim: 896, quality: 0.54 }
  ];

  let last = "";
  for (const a of attempts) {
    const d = await fileToJpegDataUrl(file, a);
    last = d;
    // Approx bytes for UTF-8 of ASCII string
    if (d.length <= byteLimit) return d;
  }
  return last;
}

async function getSettings() {
  const stored = await kvGet("settings", null);
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

async function setSettings(next) {
  await kvSet("settings", next);
}

async function listItems() {
  const db = await dbPromise;
  const items = await db.getAll("items");
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}

async function putItem(item) {
  const db = await dbPromise;
  await db.put("items", item);
}

async function deleteItem(id) {
  const db = await dbPromise;
  await db.delete("items", id);
}

async function clearAll() {
  const db = await dbPromise;
  const tx = db.transaction(["items", "kv"], "readwrite");
  await tx.objectStore("items").clear();
  // keep settings? user asked clear data - we'll clear all including settings.
  await tx.objectStore("kv").clear();
  await tx.done;
}

function detectCityFromText(text) {
  const t = (text || "").replace(/\s+/g, "");
  // Prefer explicit “xx市/xx区/xx路”等上下文
  const hit = CITY_CANDIDATES.find((c) => c !== "全部" && t.includes(c));
  if (hit) return hit;

  // Common patterns
  const m = t.match(/([一-龥]{2,4})(市|区|县)/);
  if (m && m[1] && m[1].length <= 4) return m[1];

  return "未知";
}

function tokenize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function classifyInterests(text) {
  const t = tokenize(text);
  const hits = new Set();

  const rules = [
    ["美食餐厅", ["人均", "菜单", "招牌", "必点", "排队", "营业时间", "餐厅", "火锅", "烧烤", "小吃", "米其林", "大众点评"]],
    ["咖啡甜品", ["咖啡", "latte", "拿铁", "美式", "dirty", "甜品", "蛋糕", "面包", "brunch"]],
    ["旅游景点", ["景区", "门票", "开放时间", "博物馆", "公园", "古镇", "寺", "塔", "山", "湖", "海", "观景", "打卡"]],
    ["酒店民宿", ["酒店", "民宿", "入住", "退房", "前台", "房型", "早餐", "押金", "wifi"]],
    ["购物", ["商场", "折扣", "专柜", "旗舰店", "免税", "奥莱", "购物"]],
    ["亲子", ["亲子", "儿童", "宝宝", "乐园", "动物园", "海洋馆"]],
    ["户外徒步", ["徒步", "露营", "登山", "路线", "里程", "海拔", "补给", "营地"]],
    ["垂钓", ["垂钓", "钓鱼", "饵料", "鱼竿", "鱼线", "钓点", "水库", "野钓", "台钓"]],
    ["运动健身", ["健身", "训练", "瑜伽", "普拉提", "拳击", "球馆"]],
    ["拍照机位", ["机位", "拍照", "出片", "滤镜", "日落", "日出", "观景台"]],
    ["交通攻略", ["地铁", "公交", "打车", "机场", "车站", "高铁", "路线", "换乘", "停车"]]
  ];

  for (const [interest, keys] of rules) {
    if (keys.some((k) => t.includes(k))) hits.add(interest);
  }

  return hits.size ? Array.from(hits) : ["未分类"];
}

function guessTitleFromText(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "未命名";

  const firstLine = t.split("\n").map((x) => x.trim()).find(Boolean);
  if (firstLine && firstLine.length <= 26) return firstLine;

  // Try extract from patterns: “店名/景点名” often before "人均/地址"
  const m = t.match(/([一-龥A-Za-z0-9·（）()]{2,20})(?:\s*(人均|地址|营业时间|推荐|必点))/);
  if (m && m[1]) return m[1].trim();

  return clampText(t, 20) || "未命名";
}

function buildAmapSearchUrl(city, keyword) {
  const q = encodeURIComponent(keyword || "");
  const c = encodeURIComponent(city && city !== "未知" ? city : "");
  // AMap "search" style deep link (web) - works without API keys.
  return `https://www.amap.com/search?query=${q}&city=${c}`;
}

function buildAmapRouteUrl(keyword) {
  const q = encodeURIComponent(keyword || "");
  // Web route - uses current location in browser/app.
  return `https://www.amap.com/dir?to=${q}`;
}

function buildDianpingSearchUrl(city, keyword) {
  const q = encodeURIComponent(`${city && city !== "未知" ? city + " " : ""}${keyword || ""}`.trim());
  return `https://www.dianping.com/search/keyword/0/0_${q}`;
}

let importCancelled = false;

function withTimeout(promise, ms, label = "操作") {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}分${String(r).padStart(2, "0")}秒` : `${r}秒`;
}

function normalizeTesseractStatus(status) {
  const s = String(status || "").toLowerCase();
  if (!s) return "";
  if (s.includes("loading tesseract core")) return "加载 OCR 引擎";
  if (s.includes("initializing tesseract")) return "初始化 OCR";
  if (s.includes("loading language")) return "下载/加载语言包";
  if (s.includes("initializing api")) return "初始化语言";
  if (s.includes("recognizing text")) return "识别文字中";
  return String(status);
}

const TESSERACT_CDN = {
  workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
  corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
  langPath: "https://tessdata.projectnaptha.com/4.0.0"
};

async function ocrImage(file, { lang, onProgress, startedAt } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const opts = TESSERACT_CDN;
    // Use worker mode to control core/lang asset locations.
    const createWorker = globalThis.Tesseract?.createWorker;
    if (typeof createWorker !== "function") {
      throw new Error("Tesseract.createWorker 不可用（tesseract.js 未正确加载）");
    }

    const worker = await withTimeout(
      createWorker({
        workerPath: opts.workerPath,
        corePath: opts.corePath,
        langPath: opts.langPath,
        logger: (m) => {
          if (typeof onProgress === "function") {
            const p = typeof m?.progress === "number" ? m.progress : null;
            if (p !== null) onProgress(p, m, startedAt);
          }
        }
      }),
      120_000,
      "初始化 OCR"
    );

    try {
      await withTimeout(worker.load(), 180_000, "加载 OCR 引擎");
      await withTimeout(worker.loadLanguage(lang), 600_000, "下载/加载 OCR 语言包");
      await withTimeout(worker.initialize(lang), 180_000, "初始化 OCR 语言");
      const res = await withTimeout(worker.recognize(url), 600_000, "OCR");
      return res?.data?.text || "";
    } finally {
      // Always terminate to free memory.
      try {
        await worker.terminate();
      } catch {
        // ignore
      }
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

// UI
const els = {
  btnInstall: document.getElementById("btnInstall"),
  btnSettings: document.getElementById("btnSettings"),
  settingsDialog: document.getElementById("settingsDialog"),
  ocrLang: document.getElementById("ocrLang"),
  classifierMode: document.getElementById("classifierMode"),
  btnSaveSettings: document.getElementById("btnSaveSettings"),

  citySelect: document.getElementById("citySelect"),
  btnLocate: document.getElementById("btnLocate"),

  fileInput: document.getElementById("fileInput"),
  btnImport: document.getElementById("btnImport"),
  progressCard: document.getElementById("progressCard"),
  progressText: document.getElementById("progressText"),
  progressBar: document.getElementById("progressBar"),
  btnCancel: document.getElementById("btnCancel"),

  stats: document.getElementById("stats"),
  searchInput: document.getElementById("searchInput"),
  btnClear: document.getElementById("btnClear"),
  interestChips: document.getElementById("interestChips"),
  groups: document.getElementById("groups"),
  emptyState: document.getElementById("emptyState"),

  itemTemplate: document.getElementById("itemTemplate"),
  editTemplate: document.getElementById("editTemplate"),
  editDialog: document.getElementById("editDialog")
};

let deferredPrompt = null;
let state = {
  settings: { ...DEFAULT_SETTINGS },
  items: [],
  activeInterest: "全部",
  search: ""
};

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderCitySelect() {
  const cities = Array.from(new Set([state.settings.currentCity, ...CITY_CANDIDATES, "未知"])).filter(Boolean);
  els.citySelect.innerHTML = "";
  for (const c of cities) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === state.settings.currentCity) opt.selected = true;
    els.citySelect.appendChild(opt);
  }
}

function renderInterestChips() {
  els.interestChips.innerHTML = "";
  const all = new Set(INTERESTS);
  // include dynamic tags from items
  for (const it of state.items) {
    for (const tag of it.interests || []) all.add(tag);
  }
  for (const name of Array.from(all)) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.dataset.active = String(state.activeInterest === name);
    chip.textContent = name;
    chip.addEventListener("click", () => {
      state.activeInterest = name;
      render();
    });
    els.interestChips.appendChild(chip);
  }
}

function filterItems() {
  const city = state.settings.currentCity;
  const interest = state.activeInterest;
  const q = (state.search || "").trim().toLowerCase();

  return state.items.filter((it) => {
    if (city && city !== "全部" && it.city !== city) return false;
    if (interest && interest !== "全部") {
      const tags = it.interests || [];
      if (!tags.includes(interest)) return false;
    }
    if (q) {
      const hay = `${it.title || ""}\n${it.text || ""}\n${it.city || ""}\n${(it.interests || []).join(",")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function groupByCity(items) {
  const map = new Map();
  for (const it of items) {
    const c = it.city || "未知";
    if (!map.has(c)) map.set(c, []);
    map.get(c).push(it);
  }
  const entries = Array.from(map.entries());
  // Put current city first when selecting "全部"
  entries.sort((a, b) => b[1].length - a[1].length);
  if (state.settings.currentCity && state.settings.currentCity !== "全部") {
    entries.sort((a, b) => (a[0] === state.settings.currentCity ? -1 : b[0] === state.settings.currentCity ? 1 : 0));
  }
  return entries;
}

function createTag(text) {
  const span = document.createElement("span");
  span.className = "tag";
  span.textContent = text;
  return span;
}

function renderItems() {
  const visible = filterItems();
  els.groups.innerHTML = "";

  els.emptyState.hidden = state.items.length !== 0;

  if (visible.length === 0 && state.items.length > 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `<div class="empty-title">没有匹配结果</div><div class="empty-desc">尝试切换城市/标签或搜索关键字。</div>`;
    els.groups.appendChild(div);
    return;
  }

  const groups = groupByCity(visible);
  for (const [city, items] of groups) {
    const group = document.createElement("div");
    group.className = "group";
    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML = `<div class="group-title">${city}</div><div class="muted">${items.length} 条</div>`;
    const body = document.createElement("div");
    body.className = "group-body";

    for (const it of items) {
      const node = els.itemTemplate.content.firstElementChild.cloneNode(true);
      const img = node.querySelector(".thumb");
      const title = node.querySelector(".item-title");
      const meta = node.querySelector(".item-meta");
      const tags = node.querySelector(".tags");
      const text = node.querySelector(".item-text");

      img.src = it.imageDataUrl;
      img.alt = it.title || "截图";
      title.textContent = it.title || "未命名";
      meta.textContent = `${formatDate(it.createdAt)} · ${it.source || "截图"}`;
      tags.innerHTML = "";
      tags.appendChild(createTag(it.city || "未知"));
      for (const tag of it.interests || []) tags.appendChild(createTag(tag));
      text.textContent = clampText(it.text || "", 220);

      node.querySelector(".action-route").addEventListener("click", () => {
        const keyword = it.title || it.poi || it.city || "目的地";
        window.open(buildAmapRouteUrl(`${keyword}`), "_blank", "noopener,noreferrer");
      });
      node.querySelector(".action-dianping").addEventListener("click", () => {
        const keyword = it.title || it.poi || "";
        window.open(buildDianpingSearchUrl(it.city || state.settings.currentCity, keyword), "_blank", "noopener,noreferrer");
      });
      node.querySelector(".action-delete").addEventListener("click", async () => {
        if (!confirm("确定删除这条收藏吗？")) return;
        await deleteItem(it.id);
        await refresh();
      });
      node.querySelector(".action-edit").addEventListener("click", () => openEditDialog(it));

      body.appendChild(node);
    }

    group.appendChild(head);
    group.appendChild(body);
    els.groups.appendChild(group);
  }
}

function renderStats() {
  const total = state.items.length;
  const city = state.settings.currentCity;
  const visible = filterItems().length;
  els.stats.textContent = `共 ${total} 条 · 当前视图 ${visible} 条 · 版本 ${APP_VERSION}`;
}

function render() {
  renderCitySelect();
  renderInterestChips();
  renderStats();
  renderItems();
}

async function refresh() {
  state.items = await listItems();
  render();
}

function setProgress(phase, i, n) {
  const pct = n ? Math.round((i / n) * 100) : 0;
  els.progressText.textContent = `${phase}（${i}/${n}）`;
  els.progressBar.style.width = `${pct}%`;
}

function showProgress(show) {
  els.progressCard.hidden = !show;
  if (!show) {
    els.progressBar.style.width = "0%";
    els.progressText.textContent = "";
  }
}

async function importFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (list.length === 0) {
    alert("请先选择要导入的截图图片。");
    return;
  }

  importCancelled = false;
  showProgress(true);
  setProgress("准备中", 0, list.length);

  for (let idx = 0; idx < list.length; idx++) {
    if (importCancelled) break;
    const file = list[idx];
    setProgress("OCR 识别中", idx + 1, list.length);

    // De-dup: hash the original file bytes before OCR (fast fail).
    let imageHash = "";
    try {
      imageHash = await withTimeout(fileHash(file), 10_000, "计算图片指纹");
      const existingId = await kvGet(`imgHash:${imageHash}`, null);
      if (existingId) {
        els.progressText.textContent = `检测到重复图片，已跳过（${idx + 1}/${list.length}）`;
        continue;
      }
    } catch {
      // Hash failure shouldn't block import; continue without de-dup.
      imageHash = "";
    }

    let text = "";
    let ai = null;
    try {
      // High-cost / high-quality mode: use BigModel vision to do OCR + semantic in one pass.
      setProgress("AI 识别中", idx + 1, list.length);
      els.progressBar.style.width = "10%";

      const visionImage = await withTimeout(fileToJpegDataUrlUnderLimit(file), 60_000, "压缩图片");
      els.progressBar.style.width = "25%";

      ai = await withTimeout(
        visionExtract(visionImage, {
          cityHint: state.settings.currentCity && state.settings.currentCity !== "全部" ? state.settings.currentCity : "",
          interestHint: state.activeInterest && state.activeInterest !== "全部" ? state.activeInterest : ""
        }),
        180_000,
        "AI 识别"
      );
      els.progressBar.style.width = "85%";

      text = typeof ai?.text === "string" ? ai.text : "";
    } catch (e) {
      showProgress(false);
      const msg = String(e?.message || e || "未知错误");
      alert(
        `AI 识别失败：${msg}\n\n建议排查：\n1) Edge 按 F12 → Network，确认 /api/vision 是否返回 200。\n2) EdgeOne Functions 是否已配置 BIGMODEL_API_KEY。\n3) 若返回 502，查看 details 里的上游错误信息。`
      );
      throw e;
    }

    const imageDataUrl = await fileToDataUrl(file);
    const createdAt = Date.now();

    let interests = ["未分类"];
    let city = "未知";
    let poi = "";
    let address = "";
    let title = guessTitleFromText(text);

    // Apply AI fields (from /api/vision)
    if (typeof ai?.title === "string" && ai.title.trim()) title = ai.title.trim();
    if (typeof ai?.city === "string" && ai.city.trim()) city = ai.city.trim();
    if (Array.isArray(ai?.interests) && ai.interests.length) interests = ai.interests;
    if (typeof ai?.poi === "string") poi = ai.poi.trim();
    if (typeof ai?.address === "string") address = ai.address.trim();

    if (!interests?.length) interests = ["未分类"];
    if (!city) city = "未知";
    const primaryInterest = interests?.[0] || "未分类";

    const item = {
      id: uid(),
      createdAt,
      title,
      text,
      city,
      interests,
      primaryInterest,
      poi,
      address,
      aiConfidence: typeof ai?.confidence === "number" ? ai.confidence : 0,
      source: "截图",
      imageDataUrl,
      imageHash
    };

    await putItem(item);
    if (imageHash) await kvSet(`imgHash:${imageHash}`, item.id);
  }

  showProgress(false);
  await refresh();
  if (importCancelled) {
    alert("已取消导入。已处理的截图会保留在本机。");
  }
}

function openEditDialog(item) {
  els.editDialog.innerHTML = "";
  const form = els.editTemplate.content.firstElementChild.cloneNode(true);
  form.city.value = item.city || "";
  form.interests.value = (item.interests || []).join(", ");
  form.title.value = item.title || "";
  form.text.value = item.text || "";

  form.addEventListener("close", () => {});

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const city = (form.city.value || "").trim() || "未知";
    const interests = (form.interests.value || "")
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const title = (form.title.value || "").trim() || "未命名";
    const text = form.text.value || "";

    await putItem({
      ...item,
      city,
      interests: interests.length ? interests : ["未分类"],
      primaryInterest: interests[0] || item.primaryInterest || "未分类",
      title,
      text
    });
    els.editDialog.close();
    await refresh();
  });

  els.editDialog.appendChild(form);
  els.editDialog.showModal();
}

async function inferCityFromGeolocation() {
  if (!("geolocation" in navigator)) {
    alert("当前浏览器不支持定位。");
    return;
  }

  els.btnLocate.disabled = true;
  els.btnLocate.textContent = "定位中…";
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 8000 });
    });
    const { latitude, longitude } = pos.coords;
    // Without calling external APIs (to keep mainland access + privacy),
    // we can't reverse geocode to city reliably. So we just open AMap and suggest.
    window.open(`https://www.amap.com/regeo?lnglat=${longitude},${latitude}`, "_blank", "noopener,noreferrer");
    alert("我已在新页面打开高德的逆地理入口。你可以查看城市后在这里手动选择。下一阶段可接入高德逆地理 API 自动回填。");
  } catch {
    alert("定位失败。请检查浏览器权限或网络。");
  } finally {
    els.btnLocate.disabled = false;
    els.btnLocate.textContent = "用定位推断";
  }
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/sw.js");
    } catch {
      // ignore
    }
  });
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    els.btnInstall.hidden = false;
  });
  els.btnInstall.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    els.btnInstall.hidden = true;
  });
}

async function boot() {
  registerSW();
  setupInstallPrompt();

  state.settings = await getSettings();
  renderCitySelect();
  els.ocrLang.value = state.settings.ocrLang;
  els.classifierMode.value = state.settings.classifierMode;

  els.btnSettings.addEventListener("click", () => els.settingsDialog.showModal());
  els.btnSaveSettings.addEventListener("click", async () => {
    const next = {
      ...state.settings,
      ocrLang: els.ocrLang.value,
      classifierMode: els.classifierMode.value
    };
    state.settings = next;
    await setSettings(next);
    await refresh();
  });

  els.citySelect.addEventListener("change", async () => {
    state.settings.currentCity = els.citySelect.value;
    await setSettings(state.settings);
    render();
  });
  els.btnLocate.addEventListener("click", inferCityFromGeolocation);

  els.btnImport.addEventListener("click", async () => importFiles(els.fileInput.files));
  els.btnCancel.addEventListener("click", () => {
    importCancelled = true;
  });

  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value || "";
    render();
  });

  els.btnClear.addEventListener("click", async () => {
    if (!confirm("确定清空本机数据吗？这会删除所有已导入截图与设置。")) return;
    await clearAll();
    state.settings = { ...DEFAULT_SETTINGS };
    await setSettings(state.settings);
    state.activeInterest = "全部";
    state.search = "";
    els.searchInput.value = "";
    els.ocrLang.value = state.settings.ocrLang;
    els.classifierMode.value = state.settings.classifierMode;
    await refresh();
  });

  await refresh();
}

boot();
