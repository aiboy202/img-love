const APP_VERSION = "pwa-mvp-0.2-amap-v3";

const DEFAULT_SETTINGS = {
  ocrLang: "chi_sim",
  classifierMode: "rules",
  currentCity: "全部",
  amapJsKey: "",
  amapSecurityCode: "",
  // 高德 JS API 代理：填 https://你的域名/_AMapService（与 AMAP_API_URL 无关，见设置页说明）
  amapServiceHost: ""
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
const DB_VERSION = 3;

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
    req.onupgradeneeded = (ev) => {
      if (typeof upgrade === "function") upgrade(ev.target.result, ev.oldVersion, ev.newVersion, ev.target.transaction);
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
  upgrade(db, oldVersion, newVersion, tx) {
    let store = null;
    if (!db.objectStoreNames.contains("items")) {
      store = db.createObjectStore("items", { keyPath: "id" });
    } else {
      store = tx.objectStore("items");
    }

    if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt");
    if (!store.indexNames.contains("city")) store.createIndex("city", "city");
    if (!store.indexNames.contains("primaryInterest")) store.createIndex("primaryInterest", "primaryInterest");

    if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");

    if (oldVersion < 3 && db.objectStoreNames.contains("items") && tx) {
      const st = tx.objectStore("items");
      st.openCursor().onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) return;
        const it = cursor.value;
        if (!Array.isArray(it.places) || it.places.length === 0) {
          const legacyPoi = typeof it.poi === "string" ? it.poi.trim() : "";
          const legacyAddr = typeof it.address === "string" ? it.address.trim() : "";
          const tags = Array.isArray(it.interests) && it.interests.length ? it.interests : ["未分类"];
          it.places = [
            {
              id: `mig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
              categoryTags: tags,
              name: legacyPoi || (it.title || "").trim(),
              road: "",
              district: "",
              addressHint: legacyAddr,
              note: "",
              rawQuote: "",
              amap: null,
              resolveStatus: legacyPoi || legacyAddr ? "pending" : "empty"
            }
          ];
        }
        cursor.update(it);
        cursor.continue();
      };
    }
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
  let url =
    (globalThis.__APP_CONFIG__ && typeof globalThis.__APP_CONFIG__.VISION_API_URL === "string" && globalThis.__APP_CONFIG__.VISION_API_URL.trim()) ||
    "/api/vision";
  // 腾讯云「函数 URL / tencentscf.com」一般根路径即函数，不要再拼 /api/vision。
  const isTencentScfUrl = /^https?:\/\//i.test(url) && /\.tencentscf\.com\b/i.test(url);
  if (
    url.startsWith("http") &&
    !isTencentScfUrl &&
    !url.includes("/api/") &&
    !url.endsWith("/vision") &&
    !url.endsWith("/api/vision")
  ) {
    url = url.replace(/\/+$/, "") + "/api/vision";
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageDataUrl, cityHint, interestHint })
    });
  } catch (e) {
    const u = (() => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();
    const host = u ? u.host : url;
    const isCrossOrigin = u && u.origin !== globalThis.location?.origin;
    throw new Error(
      `网络请求失败（${String(e?.message || e)}）。` +
        (isCrossOrigin
          ? `当前页：${globalThis.location?.origin || ""}，接口：${host}。请在浏览器 F12 → Network 查看该请求是否被 CORS 拦截；若在腾讯云 API 网关上托管，需在网关上开启/放行 CORS，或确保函数返回含 Access-Control-Allow-Origin。`
          : `请 F12 → Network 查看 ${url} 是否连通。`)
    );
  }
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

/**
 * 浏览器调用的「自建高德 Web 服务代理」完整 URL（与高德 JS API 的 _AMapSecurityConfig.serviceHost 不是同一概念）。
 * __APP_CONFIG__.AMAP_API_URL：
 * - 留空：同域相对路径 `/api/amap`（EdgeOne / Vercel 与 Pages Functions 同部署时常用）
 * - `https://api.example.com`：自动拼为 `https://api.example.com/api/amap`
 * - `https://api.example.com/api/amap` 或任意非根 path：原样使用（便于自定义网关路径）
 * - `https://*.tencentscf.com` 且 path 为 `/`：云函数 URL 根触发，不自动追加（需在函数内实现 amap 或填带 path 的完整 URL）
 */
function getAmapApiBase() {
  const raw = (globalThis.__APP_CONFIG__?.AMAP_API_URL || "").trim();
  if (!raw) return "/api/amap";

  const base = raw.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return "/api/amap";

  try {
    const u = new URL(base);
    const isTencentScf = /\.tencentscf\.com$/i.test(u.hostname);
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (path !== "/") return base;
    if (isTencentScf) return base;
    return `${base}/api/amap`;
  } catch {
    return "/api/amap";
  }
}

async function amapRest(payload) {
  const base = getAmapApiBase();
  const res = await fetch(base, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `高德代理 HTTP ${res.status}`);
  return data;
}

function buildPlaceSearchKeyword(city, place) {
  let c = String(city || "").trim();
  if (!c || c === "未知" || c === "全部") c = "";
  else if (/市$/u.test(c)) {
    const w = c.replace(/市$/u, "").trim();
    if (w.length >= 2) c = w;
  }
  const parts = [
    c,
    place?.district || "",
    place?.road || "",
    place?.name || "",
    place?.rawQuote || "",
    place?.addressHint || "",
    place?.note || ""
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const q = parts.join(" ").replace(/\s+/g, " ").trim();
  return q.slice(0, 96);
}

function formatAmapResolveFailure(r) {
  if (!r) return "无匹配条目（请检查 /api/amap 是否部署、Network 是否 200）";
  if (r.ok === false) {
    const bits = [r.reason, r.info, r.infocode, r.tryTag, r.status].filter((x) => x != null && String(x).trim() !== "");
    return bits.length ? bits.map(String).join(" · ").slice(0, 320) : "高德返回失败";
  }
  if (!r.pick?.location) return "高德有结果但缺少坐标（location）";
  return "未知原因";
}

function parseLngLatStr(s) {
  if (!s || typeof s !== "string") return null;
  const [a, b] = s.split(",").map((x) => Number(String(x).trim()));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { lng: a, lat: b };
}

function haversineMeters(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistanceM(m) {
  if (m == null || !Number.isFinite(m)) return "";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

const PLACE_NAME_ENUM_SPLIT = /[、，,;；\/|｜\r\n]+/;
const PLACE_SECTION_HEADERS = new Set(
  [
    "土菜馆",
    "川菜",
    "川菜和鱼",
    "简餐",
    "火锅",
    "烧烤",
    "日料",
    "日料店",
    "西餐",
    "咖啡",
    "咖啡店",
    "甜品",
    "甜品店",
    "小吃",
    "快餐",
    "面食",
    "海鲜",
    "汤锅",
    "自助",
    "早茶",
    "茶饮",
    "轻食",
    "茶餐厅",
    "韩料",
    "泰餐",
    "酒吧",
    "本地菜",
    "家常菜"
  ].map((s) => s.trim())
);

function reEscapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GENERIC_NON_POI_NAMES = new Set(
  ["美食推荐", "餐厅推荐", "本地美食", "美食", "餐厅", "推荐", "攻略", "指南", "探店", "打卡", "必吃", "网红店"].map((s) => s.trim())
);

function isUsablePoiName(n) {
  const t = typeof n === "string" ? n.trim() : "";
  if (t.length < 2 || t.length > 28) return false;
  if (PLACE_SECTION_HEADERS.has(t)) return false;
  if (GENERIC_NON_POI_NAMES.has(t)) return false;
  if (/^\d+$/.test(t)) return false;
  if (/(美食|吃货)(推荐|攻略)$/.test(t)) return false;
  if (/^.+市(美食|吃货)?(推荐|攻略)?$/.test(t) && t.length <= 12) return false;
  return true;
}

function inferVenueNamesFromGuideBlob(text) {
  if (!text || typeof text !== "string") return [];
  let s = text.slice(0, 6000);
  // 手写/笔记类「1. xxx」「2、xxx」行首编号，去掉后再分词，便于抽出店名
  s = s
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d{1,3}\s*[\.\、．。:：\)）\]]\s*/, "").trim())
    .filter(Boolean)
    .join("\n");
  s = s.replace(/感兴趣的可以截图|展开+|共\d+人推荐\S*|美食指南|本地人去的馆子/gi, " ");
  s = s.replace(/>\s*\d+/g, " ");
  s = s.replace(/[@#＠]\w*/g, " ");
  const headersSorted = Array.from(PLACE_SECTION_HEADERS).sort((a, b) => b.length - a.length);
  for (const h of headersSorted) {
    if (h.length < 2) continue;
    const re = new RegExp(`(?:^|[\\s\u3000])${reEscapeForRegex(h)}(?=[\\s\u3000]|$)`, "g");
    s = s.replace(re, " ");
  }
  s = s.replace(/[|｜>《》【】···.]+/g, " ");
  s = s.replace(/[、，,;；\s\u3000]+/g, " ").trim();
  const rawParts = s.split(/\s+/).map((x) => x.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (let t of rawParts) {
    t = t.replace(/^@\S+/, "").trim();
    if (!isUsablePoiName(t)) continue;
    if (/^(盐城市|盐城|北京市|上海市|天津市|重庆市|广州市|深圳市|杭州市|苏州市|南京市|成都市|武汉市|西安市)$/.test(t)) continue;
    if (/推荐|指南|截图|关注|粉丝|点赞|主页|直播/.test(t) && t.length < 12) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  // 本地 OCR 常为「整行中文无空格」，按行兜底（略宽于 isUsablePoiName 分词）
  if (!out.length) {
    for (const rawLine of text.split(/\r?\n/)) {
      const u = rawLine.replace(/^\s*\d{1,3}\s*[\.\、．。:：\)）\]]\s*/, "").trim();
      if (u.length < 2 || u.length > 48) continue;
      if (PLACE_SECTION_HEADERS.has(u) || GENERIC_NON_POI_NAMES.has(u)) continue;
      if (/^(未分类|未知|未命名)$/.test(u)) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u.slice(0, 80));
      if (out.length >= 24) break;
    }
  }
  return out;
}

function recoverPlacesFromVisionTextForClient(places, text, interests) {
  const inferred = inferVenueNamesFromGuideBlob(text);
  // 原先要求 ≥2 条才恢复，单店/短笔记会一直「检索词不足」
  if (inferred.length === 0) return places;

  const goodRows = places.filter((p) => isUsablePoiName(p?.name));
  if (goodRows.length >= 3) return places;

  const tagsBase = interests.filter((x) => x && x !== "未分类").slice(0, 4);
  const ct = tagsBase.length ? tagsBase : ["美食"];

  if (goodRows.length === 0) {
    return inferred.slice(0, 24).map((name) => ({
      id: uid(),
      categoryTags: [...ct].slice(0, 8),
      name: name.slice(0, 80),
      road: "",
      district: "",
      addressHint: "",
      note: "",
      rawQuote: "",
      amap: null,
      resolveStatus: "pending"
    }));
  }

  const have = new Set(goodRows.map((p) => String(p.name || "").trim()));
  const merged = goodRows.map((p) => ({ ...p }));
  for (const nm of inferred) {
    if (merged.length >= 24) break;
    if (have.has(nm)) continue;
    merged.push({
      id: uid(),
      categoryTags: [...ct].slice(0, 8),
      name: nm.slice(0, 80),
      road: "",
      district: "",
      addressHint: "",
      note: "",
      rawQuote: "",
      amap: null,
      resolveStatus: "pending"
    });
    have.add(nm);
  }
  return merged.length > goodRows.length ? merged : places;
}

/** 与 vision/semantic 接口一致：顿号并列店名拆条；分类词单行不入列 */
function expandPlacesByNameEnumerationForItem(places) {
  const flat = [];
  for (const pl of places) {
    const name = typeof pl.name === "string" ? pl.name.trim() : "";
    if (!name) {
      flat.push(pl);
      continue;
    }
    if (!PLACE_NAME_ENUM_SPLIT.test(name)) {
      if (!PLACE_SECTION_HEADERS.has(name)) flat.push(pl);
      continue;
    }
    const parts = name
      .split(PLACE_NAME_ENUM_SPLIT)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && !PLACE_SECTION_HEADERS.has(s));
    if (parts.length <= 1) {
      const single = parts[0] || name;
      if (PLACE_SECTION_HEADERS.has(single)) continue;
      if (parts.length === 1 && single !== name) flat.push({ ...pl, id: uid(), name: single.slice(0, 80) });
      else flat.push(pl);
      continue;
    }
    for (const seg of parts) {
      flat.push({ ...pl, id: uid(), name: seg.slice(0, 80) });
    }
  }
  return flat.slice(0, 24);
}

function placesFromVisionPayload(ai, fallbackCity) {
  let city = typeof ai?.city === "string" && ai.city.trim() ? ai.city.trim() : "";
  const fb = typeof fallbackCity === "string" ? fallbackCity.trim() : "";
  // 模型常返回「未知」占位；若用户在设置里选了城市，应参与高德检索
  if (!city || city === "未知" || city === "全部") {
    if (fb && fb !== "未知" && fb !== "全部") city = fb;
  }
  if (!city) city = "未知";
  const raw = Array.isArray(ai?.places) ? ai.places : [];
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const categoryTags = Array.isArray(p.categoryTags)
      ? p.categoryTags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [];
    out.push({
      id: uid(),
      categoryTags: categoryTags.length ? categoryTags : ["未分类"],
      name: typeof p.name === "string" ? p.name.trim() : "",
      road: typeof p.road === "string" ? p.road.trim() : "",
      district: typeof p.district === "string" ? p.district.trim() : "",
      addressHint: typeof p.addressHint === "string" ? p.addressHint.trim() : "",
      note: typeof p.note === "string" ? p.note.trim() : "",
      rawQuote: typeof p.rawQuote === "string" ? p.rawQuote.trim() : "",
      amap: null,
      resolveStatus: "pending"
    });
  }
  if (!out.length) {
    const poi = typeof ai?.poi === "string" ? ai.poi.trim() : "";
    const addr = typeof ai?.address === "string" ? ai.address.trim() : "";
    out.push({
      id: uid(),
      categoryTags: Array.isArray(ai?.interests) && ai.interests.length ? ai.interests.map((x) => String(x).trim()).filter(Boolean) : ["未分类"],
      name: poi,
      road: "",
      district: "",
      addressHint: addr,
      note: "",
      rawQuote: "",
      amap: null,
      resolveStatus: poi || addr ? "pending" : "empty"
    });
  }
  const interests = Array.isArray(ai?.interests) ? ai.interests.map((x) => String(x).trim()).filter(Boolean) : [];
  let places = expandPlacesByNameEnumerationForItem(out);
  places = recoverPlacesFromVisionTextForClient(places, typeof ai?.text === "string" ? ai.text : "", interests);
  for (const pl of places) {
    const kw = buildPlaceSearchKeyword(city, pl);
    if (!kw) pl.resolveStatus = "empty";
  }
  return { city, places };
}

function ensureItemPlacesShape(it) {
  if (!it || typeof it !== "object") return it;
  if (Array.isArray(it.places) && it.places.length) return it;
  const legacyPoi = typeof it.poi === "string" ? it.poi.trim() : "";
  const legacyAddr = typeof it.address === "string" ? it.address.trim() : "";
  const tags = Array.isArray(it.interests) && it.interests.length ? it.interests : ["未分类"];
  it.places = [
    {
      id: uid(),
      categoryTags: tags,
      name: legacyPoi || (it.title || "").trim(),
      road: "",
      district: "",
      addressHint: legacyAddr,
      note: "",
      rawQuote: "",
      amap: null,
      resolveStatus: legacyPoi || legacyAddr ? "pending" : "empty"
    }
  ];
  return it;
}

async function resolvePlacesAmap(item) {
  ensureItemPlacesShape(item);
  const city = item.city || "未知";
  const pending = item.places.filter((p) => p && p.resolveStatus === "pending");
  if (!pending.length) return item;

  const queries = [];
  for (const pl of pending) {
    const keywords = buildPlaceSearchKeyword(city, pl);
    if (!keywords) {
      pl.resolveStatus = "empty";
      continue;
    }
    queries.push({ refId: pl.id, keywords });
  }
  if (!queries.length) return item;

  try {
    const batchSize = 12;
    for (let i = 0; i < queries.length; i += batchSize) {
      const chunk = queries.slice(i, i + batchSize);
      const data = await amapRest({ action: "resolvePlaces", city, queries: chunk });
      const results = Array.isArray(data?.results) ? data.results : [];
      const chunkIds = new Set(chunk.map((q) => q.refId));
      const byId = new Map(results.map((r) => [r.refId, r]));
      for (const pl of pending) {
        if (!chunkIds.has(pl.id)) continue;
        const r = byId.get(pl.id);
        if (r && r.ok && r.pick && r.pick.location) {
          // keep top candidates for UI confirmation
          pl.candidates = Array.isArray(r.pois) ? r.pois : [];
          pl.amap = {
            id: r.pick.id,
            name: r.pick.name,
            address: r.pick.address,
            location: r.pick.location,
            typecode: r.pick.typecode
          };
          pl.amapRestError = "";
          // mark as suggested until user confirms in map sidebar
          pl.resolveStatus = "suggested";
        } else {
          pl.amap = null;
          pl.resolveStatus = "fail";
          pl.amapRestError = formatAmapResolveFailure(r);
        }
      }
    }
    for (const pl of pending) {
      if (pl.resolveStatus === "pending") {
        pl.resolveStatus = "fail";
        pl.amap = null;
        pl.amapRestError = pl.amapRestError || "未返回结果（可能未进本轮 batch）";
      }
    }
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 320);
    for (const pl of pending) {
      if (pl.resolveStatus === "pending") {
        pl.resolveStatus = "fail";
        pl.amap = null;
        pl.amapRestError = msg;
      }
    }
  }
  return item;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.dataset.src = src;
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load: " + src));
    document.head.appendChild(s);
  });
}

const mapRuntime = {
  map: null,
  cluster: null,
  markers: [],
  polyline: null,
  userLngLat: null,
  AMap: null
};

function destroyMapRuntime() {
  try {
    mapRuntime.cluster?.setMap?.(null);
  } catch {
    // ignore
  }
  mapRuntime.cluster = null;
  try {
    mapRuntime.polyline?.setMap?.(null);
  } catch {
    // ignore
  }
  mapRuntime.polyline = null;
  for (const m of mapRuntime.markers) {
    try {
      m.setMap(null);
    } catch {
      // ignore
    }
  }
  mapRuntime.markers = [];
  try {
    mapRuntime.map?.destroy?.();
  } catch {
    // ignore
  }
  mapRuntime.map = null;
  mapRuntime.AMap = null;
}

/**
 * 高德要求：在加载 https://webapi.amap.com/maps 脚本之前设置 window._AMapSecurityConfig。
 * 参见 https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode
 * - 生产推荐：Nginx 等代理 `/_AMapService` → restapi，query 带 jscode；此处只设 serviceHost。
 * - 便捷开发：明文 securityJsCode（勿提交到公开仓库）。
 */
async function ensureAmapJsLoaded(settings) {
  const key = (settings?.amapJsKey || "").trim();
  if (!key) throw new Error("请先在设置中填写「高德 JS API Key」");
  const serviceHost = (settings?.amapServiceHost || "").trim().replace(/\/+$/, "");
  const sec = (settings?.amapSecurityCode || "").trim();
  try {
    delete globalThis._AMapSecurityConfig;
  } catch {
    globalThis._AMapSecurityConfig = undefined;
  }
  if (serviceHost) {
    globalThis._AMapSecurityConfig = { serviceHost };
    if (!/_AMapService$/i.test(serviceHost)) {
      console.warn(
        "[img_love] amapServiceHost 应以 /_AMapService 结尾（高德固定前缀）。示例：https://你的域名/_AMapService — 文档：https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode"
      );
    }
  } else if (sec) {
    globalThis._AMapSecurityConfig = { securityJsCode: sec };
  } else {
    console.warn(
      "[img_love] 未配置 serviceHost 或 securityJsCode；2021-12-02 后申请的 JS API Key 可能无法加载地图。参见 https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode"
    );
  }
  const src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=${encodeURIComponent(plugins)}`;
  await loadScriptOnce(src);
  if (!globalThis.AMap) throw new Error("高德 JS API 未就绪");
  mapRuntime.AMap = globalThis.AMap;
  return globalThis.AMap;
}

function collectFlatPoints(items, { city } = {}) {
  const pts = [];
  for (const it of items) {
    ensureItemPlacesShape(it);
    if (city && city !== "全部" && it.city !== city) continue;
    for (const pl of it.places || []) {
      const loc = parseLngLatStr(pl?.amap?.location);
      if (!loc) continue;
      const label = pl?.amap?.name || pl?.name || it.title || "地点";
      const sub = pl?.amap?.address || [pl?.road, pl?.addressHint].filter(Boolean).join(" · ");
      pts.push({
        itemId: it.id,
        placeId: pl.id,
        city: it.city,
        label,
        sub,
        lng: loc.lng,
        lat: loc.lat,
        tags: pl.categoryTags || [],
        loc,
        confirmed: pl.resolveStatus === "ok"
      });
    }
  }
  return pts;
}

function orderPointsNearestNeighbor(points, startLngLat) {
  if (!points.length) return [];
  const rest = points.slice();
  const out = [];
  if (startLngLat) {
    rest.sort((a, b) => (haversineMeters(startLngLat, a.loc) || 0) - (haversineMeters(startLngLat, b.loc) || 0));
    out.push(rest.shift());
  } else {
    out.push(rest.shift());
  }
  let cur = out[0].loc;
  while (rest.length) {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const d = haversineMeters(cur, rest[i].loc) ?? Infinity;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    const next = rest.splice(bestI, 1)[0];
    out.push(next);
    cur = next.loc;
  }
  return out;
}

function collectPlaceRows(items, city) {
  const rows = [];
  for (const it of items) {
    ensureItemPlacesShape(it);
    if (city && city !== "全部" && it.city !== city) continue;
    for (const pl of it.places || []) {
      const loc = parseLngLatStr(pl?.amap?.location);
      rows.push({
        itemId: it.id,
        placeId: pl.id,
        itemTitle: it.title,
        city: it.city,
        label: pl?.amap?.name || pl?.name || "(未命名地点)",
        sub: pl?.amap?.address || [pl?.district, pl?.road, pl?.addressHint].filter(Boolean).join(" · "),
        tags: pl.categoryTags || [],
        resolveStatus: pl.resolveStatus,
        loc,
        kw: buildPlaceSearchKeyword(it.city, pl)
      });
    }
  }
  return rows;
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

function buildAmapDirToLngLat(lng, lat, name) {
  const base = `https://www.amap.com/dir?to=${encodeURIComponent(`${lng},${lat}`)}`;
  if (name) return `${base}&toname=${encodeURIComponent(name)}`;
  return base;
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
  editDialog: document.getElementById("editDialog"),

  btnMap: document.getElementById("btnMap"),
  mapDialog: document.getElementById("mapDialog"),
  mapClose: document.getElementById("mapClose"),
  mapCitySelect: document.getElementById("mapCitySelect"),
  mapContainer: document.getElementById("mapContainer"),
  mapPointList: document.getElementById("mapPointList"),
  mapLocate: document.getElementById("mapLocate"),
  mapFit: document.getElementById("mapFit"),
  mapClearRoute: document.getElementById("mapClearRoute"),
  mapRouteOrder: document.getElementById("mapRouteOrder"),
  mapRouteNN: document.getElementById("mapRouteNN"),
  mapRouteMeta: document.getElementById("mapRouteMeta"),

  amapJsKey: document.getElementById("amapJsKey"),
  amapSecurityCode: document.getElementById("amapSecurityCode"),
  amapServiceHost: document.getElementById("amapServiceHost")
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
    ensureItemPlacesShape(it);
    for (const pl of it.places || []) {
      for (const t of pl.categoryTags || []) {
        if (t) all.add(t);
      }
    }
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
    ensureItemPlacesShape(it);
    if (city && city !== "全部" && it.city !== city) return false;
    if (interest && interest !== "全部") {
      const tags = it.interests || [];
      const placeTags = (it.places || []).flatMap((p) => p.categoryTags || []);
      const merged = new Set([...tags, ...placeTags]);
      if (!merged.has(interest)) return false;
    }
    if (q) {
      const placeBits = (it.places || [])
        .map(
          (p) =>
            `${p?.name || ""}\n${p?.road || ""}\n${p?.addressHint || ""}\n${p?.note || ""}\n${(p?.amap?.name || "")}\n${(p?.amap?.address || "")}\n${(p?.categoryTags || []).join(",")}`
        )
        .join("\n");
      const hay = `${it.title || ""}\n${it.text || ""}\n${it.city || ""}\n${(it.interests || []).join(",")}\n${placeBits}`.toLowerCase();
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
      ensureItemPlacesShape(it);
      tags.innerHTML = "";
      tags.appendChild(createTag(it.city || "未知"));
      for (const tag of it.interests || []) tags.appendChild(createTag(tag));
      text.textContent = clampText(it.text || "", 220);

      const placesWrap = node.querySelector(".places-wrap");
      placesWrap.innerHTML = "";
      for (const pl of it.places || []) {
        const row = document.createElement("div");
        row.className = "place-row";
        const prowTop = document.createElement("div");
        prowTop.className = "place-row-top";
        const nameEl = document.createElement("div");
        nameEl.className = "place-name";
        nameEl.textContent = pl.amap?.name || pl.name || "(未命名地点)";
        const st = document.createElement("div");
        st.className = "place-status";
        const stKey = pl.resolveStatus === "ok" ? "ok" : pl.resolveStatus === "fail" ? "fail" : pl.resolveStatus === "empty" ? "empty" : "pending";
        st.dataset.st = stKey;
        st.textContent =
          pl.resolveStatus === "ok" ? "已定位" : pl.resolveStatus === "fail" ? "未匹配到POI" : pl.resolveStatus === "empty" ? "检索词不足" : "待解析";
        if (pl.resolveStatus === "fail" && pl.amapRestError) st.title = pl.amapRestError;
        prowTop.appendChild(nameEl);
        prowTop.appendChild(st);
        row.appendChild(prowTop);

        const metaEl = document.createElement("div");
        metaEl.className = "place-meta";
        metaEl.textContent = [pl.amap?.address, pl.road, pl.addressHint, pl.note].filter(Boolean).join(" · ").slice(0, 220);
        row.appendChild(metaEl);

        const pt = document.createElement("div");
        pt.className = "place-tags";
        for (const t of pl.categoryTags || []) {
          const span = document.createElement("span");
          span.className = "place-tag";
          span.textContent = t;
          pt.appendChild(span);
        }
        row.appendChild(pt);

        const pa = document.createElement("div");
        pa.className = "place-actions";
        const btnR = document.createElement("button");
        btnR.type = "button";
        btnR.className = "btn btn-ghost";
        btnR.textContent = "路线";
        btnR.addEventListener("click", () => {
          const loc = parseLngLatStr(pl.amap?.location);
          if (loc) window.open(buildAmapDirToLngLat(loc.lng, loc.lat, pl.amap?.name || pl.name), "_blank", "noopener,noreferrer");
          else window.open(buildAmapRouteUrl(buildPlaceSearchKeyword(it.city, pl)), "_blank", "noopener,noreferrer");
        });
        const btnD = document.createElement("button");
        btnD.type = "button";
        btnD.className = "btn btn-ghost";
        btnD.textContent = "点评";
        btnD.addEventListener("click", () => {
          const kw = pl.amap?.name || pl.name || it.title;
          window.open(buildDianpingSearchUrl(it.city || state.settings.currentCity, kw), "_blank", "noopener,noreferrer");
        });
        pa.appendChild(btnR);
        pa.appendChild(btnD);
        row.appendChild(pa);
        placesWrap.appendChild(row);
      }

      node.querySelector(".action-map-item").addEventListener("click", () => openMapExplorer({ focusItemId: it.id }));
      node.querySelector(".action-reresolve").addEventListener("click", async () => {
        ensureItemPlacesShape(it);
        for (const p of it.places) {
          const kw = buildPlaceSearchKeyword(it.city, p);
          p.resolveStatus = kw ? "pending" : "empty";
          p.amap = null;
        }
        await resolvePlacesAmap(it);
        await putItem(it);
        await refresh();
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
  for (const it of state.items) {
    if (!Array.isArray(it.places) || it.places.length === 0) {
      ensureItemPlacesShape(it);
      await putItem(it);
    }
  }
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
      // 后续若触发本地 OCR 补全，会覆盖 text
    } catch (e) {
      showProgress(false);
      const msg = String(e?.message || e || "未知错误");
      alert(
        `AI 识别失败：${msg}\n\n建议排查：\n1) F12 → Network：看 VISION 请求是红色还是 OPTIONS 失败（多为跨域/CORS）。\n2) 用浏览器直接打开云函数 URL，应能看到 JSON 健康说明（GET）。\n3) 腾讯云 API 网关需在控制台配置 CORS，或确认后端错误响应也带 Access-Control-Allow-Origin。\n4) 使用 /api/vision 时：EdgeOne 是否已配置 BIGMODEL_API_KEY；502 时看响应 body 里 details。`
      );
      throw e;
    }

    const imageDataUrl = await fileToDataUrl(file);
    const createdAt = Date.now();

    let interests = ["未分类"];
    let city = "未知";
    let poi = "";
    let address = "";

    if (typeof ai?.city === "string" && ai.city.trim()) city = ai.city.trim();
    if (Array.isArray(ai?.interests) && ai.interests.length) interests = ai.interests;
    if (typeof ai?.poi === "string") poi = ai.poi.trim();
    if (typeof ai?.address === "string") address = ai.address.trim();

    if (!interests?.length) interests = ["未分类"];
    if (!city) city = "未知";

    const hintCity = state.settings.currentCity && state.settings.currentCity !== "全部" ? state.settings.currentCity : city;
    const workAi = ai && typeof ai === "object" ? { ...ai } : {};
    let { city: parsedCity, places } = placesFromVisionPayload(workAi, hintCity);
    city = parsedCity || city;

    let kwCity = city;
    if (!kwCity || kwCity === "未知" || kwCity === "全部") {
      if (hintCity && hintCity !== "未知" && hintCity !== "全部") kwCity = hintCity;
    }
    const visionUselessForSearch =
      !places.length || places.every((pl) => pl && typeof pl === "object" && !buildPlaceSearchKeyword(kwCity, pl));
    if (visionUselessForSearch) {
      try {
        setProgress("本地 OCR 补全中", idx + 1, list.length);
        const ocrText = await ocrImage(file, { lang: state.settings.ocrLang || "chi_sim" });
        const ot = String(ocrText || "").trim();
        if (ot) {
          workAi.text = [typeof workAi.text === "string" ? workAi.text : "", ocrText].filter((x) => String(x || "").trim()).join("\n\n");
          const r2 = placesFromVisionPayload(workAi, hintCity);
          places = r2.places;
          if (r2.city && r2.city !== "未知" && r2.city !== "全部") city = r2.city;
        }
      } catch (e) {
        console.warn("本地 OCR 补全失败", e);
      }
    }

    text = typeof workAi.text === "string" ? workAi.text : text;
    const title =
      typeof ai?.title === "string" && ai.title.trim() ? ai.title.trim() : guessTitleFromText(text);

    const primaryInterest =
      (places[0]?.categoryTags?.[0] && places[0].categoryTags[0] !== "未分类" ? places[0].categoryTags[0] : null) ||
      interests?.[0] ||
      "未分类";

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
      places,
      aiConfidence: typeof ai?.confidence === "number" ? ai.confidence : 0,
      source: "截图",
      imageDataUrl,
      imageHash
    };

    setProgress("高德对齐坐标", idx + 1, list.length);
    try {
      await resolvePlacesAmap(item);
    } catch {
      // 保留条目，子点标记为 fail / pending
    }

    await putItem(item);
    if (imageHash) await kvSet(`imgHash:${imageHash}`, item.id);
  }

  showProgress(false);
  await refresh();
  if (importCancelled) {
    alert("已取消导入。已处理的截图会保留在本机。");
  }
}

let mapExplorerFocusItemId = null;

function getMapFilterCity() {
  const v = els.mapCitySelect?.value;
  return v || state.settings.currentCity || "全部";
}

function renderMapCitySelectOptions() {
  if (!els.mapCitySelect) return;
  const set = new Set(CITY_CANDIDATES.filter((c) => c !== "全部"));
  for (const it of state.items) {
    if (it.city) set.add(it.city);
  }
  const cities = ["全部", ...Array.from(set)];
  els.mapCitySelect.innerHTML = "";
  const preferred = mapExplorerFocusItemId
    ? state.items.find((x) => x.id === mapExplorerFocusItemId)?.city
    : state.settings.currentCity;
  for (const c of cities) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    els.mapCitySelect.appendChild(opt);
  }
  if (preferred && cities.includes(preferred)) els.mapCitySelect.value = preferred;
  else if (state.settings.currentCity && cities.includes(state.settings.currentCity)) els.mapCitySelect.value = state.settings.currentCity;
  else els.mapCitySelect.value = "全部";
}

function destroyRouteOverlay() {
  try {
    mapRuntime.polyline?.setMap?.(null);
  } catch {
    // ignore
  }
  mapRuntime.polyline = null;
}

function renderMapSidebarList() {
  if (!els.mapPointList) return;
  const c = getMapFilterCity();
  const rows = collectPlaceRows(state.items, c);
  els.mapPointList.innerHTML = "";
  const user = mapRuntime.userLngLat;
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "map-point-row";
    row.dataset.itemId = r.itemId;
    row.dataset.placeId = r.placeId;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    // route planning only for confirmed points
    cb.disabled = !r.loc || r.resolveStatus !== "ok";
    const main = document.createElement("div");
    main.className = "map-point-main";
    const t = document.createElement("div");
    t.className = "map-point-title";
    const st =
      r.resolveStatus === "ok"
        ? "已确认"
        : r.resolveStatus === "suggested"
          ? "待确认"
          : r.resolveStatus === "fail"
            ? "未匹配"
            : r.resolveStatus === "empty"
              ? "信息不足"
              : "待解析";
    t.textContent = `${r.label} · ${st}`;
    const s = document.createElement("div");
    s.className = "map-point-sub";
    s.textContent = [r.city, r.sub].filter(Boolean).join(" · ");
    main.appendChild(t);
    main.appendChild(s);
    if (user && r.loc) {
      const d = document.createElement("div");
      d.className = "map-point-dist";
      const m = haversineMeters(user, r.loc);
      d.textContent = m != null ? `距我约 ${formatDistanceM(m)}` : "";
      main.appendChild(d);
    }
    row.appendChild(cb);
    row.appendChild(main);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "8px";
    actions.style.alignItems = "center";

    if (r.resolveStatus === "suggested" || r.resolveStatus === "fail") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-ghost";
      btn.textContent = r.resolveStatus === "suggested" ? "确认/改选" : "重新匹配";
      btn.addEventListener("click", async () => {
        const it = state.items.find((x) => x.id === r.itemId);
        if (!it) return;
        ensureItemPlacesShape(it);
        const pl = (it.places || []).find((p) => p.id === r.placeId);
        if (!pl) return;

        // if no candidates yet, retry resolve
        if (!Array.isArray(pl.candidates) || pl.candidates.length === 0 || r.resolveStatus === "fail") {
          pl.resolveStatus = "pending";
          pl.amap = null;
          await resolvePlacesAmap(it);
          await putItem(it);
          await refresh();
        }

        const candidates = Array.isArray(pl.candidates) ? pl.candidates : [];
        if (!candidates.length) {
          alert("没有候选结果。你可以编辑 OCR 文本/地点关键词后再试，或减少无关文字。");
          return;
        }

        const lines = candidates
          .slice(0, 3)
          .map((p, idx) => `${idx + 1}. ${p.name}${p.address ? "｜" + p.address : ""}`)
          .join("\n");
        const ans = prompt(`请选择候选 POI（输入 1-3），取消则不变：\n\n${lines}`, "1");
        if (!ans) return;
        const n = Number(String(ans).trim());
        if (!Number.isFinite(n) || n < 1 || n > Math.min(3, candidates.length)) return;
        const pick = candidates[n - 1];
        pl.amap = {
          id: pick.id,
          name: pick.name,
          address: pick.address,
          location: pick.location,
          typecode: pick.typecode,
          cityname: pick.cityname,
          adname: pick.adname
        };
        pl.resolveStatus = "ok";
        pl.amapRestError = "";

        // city override: prefer POI city if available
        const poiCity = String(pick.cityname || "").replace(/市$/u, "").trim();
        if (poiCity) it.city = poiCity;
        await putItem(it);
        await refresh();
        try {
          rebuildMapMarkers();
          renderMapSidebarList();
        } catch {
          // ignore
        }
      });
      actions.appendChild(btn);
    }

    if (r.loc) {
      const nav = document.createElement("button");
      nav.type = "button";
      nav.className = "btn btn-ghost";
      nav.textContent = "导航";
      nav.addEventListener("click", () => {
        const it = state.items.find((x) => x.id === r.itemId);
        if (!it) return;
        ensureItemPlacesShape(it);
        const pl = (it.places || []).find((p) => p.id === r.placeId);
        const loc = parseLngLatStr(pl?.amap?.location);
        const name = pl?.amap?.name || pl?.name || it.title || "目的地";
        if (loc) {
          // Prefer AMap app URI, fallback to web
          const uri = `amapuri://route/plan/?dlat=${encodeURIComponent(String(loc.lat))}&dlon=${encodeURIComponent(
            String(loc.lng)
          )}&dname=${encodeURIComponent(name)}&dev=0&t=0`;
          const web = buildAmapDirToLngLat(loc.lng, loc.lat, name);
          // Try open app; if blocked or not installed, user can use web button from browser UI/back
          window.location.href = uri;
          setTimeout(() => window.open(web, "_blank", "noopener,noreferrer"), 600);
        } else {
          window.open(buildAmapRouteUrl(buildPlaceSearchKeyword(it.city, pl)), "_blank", "noopener,noreferrer");
        }
      });
      actions.appendChild(nav);
    }

    row.appendChild(actions);
    els.mapPointList.appendChild(row);
  }
}

function rebuildMapMarkers() {
  const AMap = mapRuntime.AMap;
  const map = mapRuntime.map;
  if (!AMap || !map) return;
  try {
    mapRuntime.cluster?.setMap?.(null);
  } catch {
    // ignore
  }
  mapRuntime.cluster = null;
  for (const m of mapRuntime.markers) {
    try {
      m.setMap(null);
    } catch {
      // ignore
    }
  }
  mapRuntime.markers = [];

  const c = getMapFilterCity();
  const cityArg = c === "全部" ? "" : c;
  let pts = collectFlatPoints(state.items, { city: cityArg });
  if (mapExplorerFocusItemId) {
    pts = pts.filter((p) => p.itemId === mapExplorerFocusItemId);
  }
  if (!pts.length) {
    map.setZoomAndCenter(11, [104.065735, 30.659462]);
    return;
  }
  const markers = pts.map(
    (p) =>
      new AMap.Marker({
        position: [p.lng, p.lat],
        title: p.confirmed ? p.label : `（待确认）${p.label}`,
        extData: { ...p }
      })
  );
  mapRuntime.markers = markers;
  AMap.plugin(["AMap.MarkerCluster"], () => {
    try {
      mapRuntime.cluster = new AMap.MarkerCluster(map, markers, { gridSize: 70, maxZoom: 18 });
    } catch {
      for (const m of markers) m.setMap(map);
    }
    try {
      map.setFitView(markers, false, [56, 56, 56, 320]);
    } catch {
      // ignore
    }
  });
}

async function initMapPanel() {
  if (!els.mapContainer) throw new Error("地图容器未找到");
  destroyMapRuntime();
  els.mapContainer.innerHTML = "";
  const AMap = await ensureAmapJsLoaded(state.settings);
  mapRuntime.map = new AMap.Map(els.mapContainer, {
    zoom: 11,
    viewMode: "2D"
  });
  mapRuntime.map.addControl(new AMap.Scale());
  mapRuntime.map.addControl(new AMap.ToolBar({ liteStyle: true }));
  rebuildMapMarkers();
  renderMapSidebarList();
}

async function openMapExplorer(opts = {}) {
  mapExplorerFocusItemId = opts.focusItemId || null;
  if (!els.mapDialog) return;
  renderMapCitySelectOptions();
  if (els.mapRouteMeta) els.mapRouteMeta.textContent = "";
  els.mapDialog.showModal();
  try {
    await initMapPanel();
  } catch (e) {
    alert(String(e?.message || e));
  }
}

function getCheckedRoutePointsInDomOrder() {
  const out = [];
  const nodes = els.mapPointList?.querySelectorAll(".map-point-row") || [];
  for (const row of nodes) {
    const cb = row.querySelector('input[type="checkbox"]');
    if (!cb?.checked) continue;
    const itemId = row.dataset.itemId;
    const placeId = row.dataset.placeId;
    const it = state.items.find((x) => x.id === itemId);
    if (!it) continue;
    ensureItemPlacesShape(it);
    const pl = (it.places || []).find((p) => p.id === placeId);
    const loc = parseLngLatStr(pl?.amap?.location);
    if (!loc) continue;
    out.push({
      itemId,
      placeId,
      lng: loc.lng,
      lat: loc.lat,
      loc,
      label: pl?.amap?.name || pl?.name || ""
    });
  }
  return out;
}

async function runMapDrivingRoute(useNN) {
  if (els.mapRouteMeta) els.mapRouteMeta.textContent = "";
  let pts = getCheckedRoutePointsInDomOrder();
  if (pts.length < 2) {
    alert("请至少勾选 2 个已定位的兴趣点。");
    return;
  }
  const midMax = 16;
  if (pts.length - 2 > midMax) {
    alert(`途经点过多：驾车接口途经点最多 ${midMax} 个，请减少勾选。`);
    return;
  }
  if (useNN && mapRuntime.userLngLat) {
    pts = orderPointsNearestNeighbor(pts, mapRuntime.userLngLat);
  } else if (useNN) {
    pts = orderPointsNearestNeighbor(pts, null);
  }
  const origin = `${pts[0].lng},${pts[0].lat}`;
  const destination = `${pts[pts.length - 1].lng},${pts[pts.length - 1].lat}`;
  let waypoints = "";
  if (pts.length > 2) {
    waypoints = pts
      .slice(1, -1)
      .map((p) => `${p.lng},${p.lat}`)
      .join("|");
  }
  try {
    const data = await amapRest({
      action: "routeDriving",
      origin,
      destination,
      ...(waypoints ? { waypoints } : {})
    });
    if (!data?.ok || !Array.isArray(data.path) || data.path.length < 2) {
      if (els.mapRouteMeta) els.mapRouteMeta.textContent = "路线规划无有效路径，请尝试减少点数或检查坐标。";
      return;
    }
    destroyRouteOverlay();
    const AMap = mapRuntime.AMap;
    const pathArr = data.path.map((p) => [p.lng, p.lat]);
    mapRuntime.polyline = new AMap.Polyline({
      path: pathArr,
      strokeColor: "#4F8CFF",
      strokeWeight: 6,
      strokeOpacity: 0.92,
      lineJoin: "round",
      lineCap: "round"
    });
    mapRuntime.map.add(mapRuntime.polyline);
    try {
      mapRuntime.map.setFitView([mapRuntime.polyline], false, [72, 72, 72, 360]);
    } catch {
      // ignore
    }
    const km = (Number(data.distance) / 1000).toFixed(1);
    const min = Math.round(Number(data.duration) / 60);
    if (els.mapRouteMeta) {
      els.mapRouteMeta.textContent = `驾车约 ${km} km，预估 ${min} 分钟（仅供参考，以高德实时导航为准）。`;
    }
  } catch (e) {
    alert(`路线规划失败：${String(e?.message || e)}`);
  }
}

function openEditDialog(item) {
  els.editDialog.innerHTML = "";
  const form = els.editTemplate.content.firstElementChild.cloneNode(true);
  ensureItemPlacesShape(item);
  form.city.value = item.city || "";
  form.interests.value = (item.interests || []).join(", ");
  form.title.value = item.title || "";
  form.text.value = item.text || "";
  if (form.placesJson) {
    try {
      form.placesJson.value = JSON.stringify(item.places || [], null, 2);
    } catch {
      form.placesJson.value = "";
    }
  }

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
    let places = item.places;
    if (form.placesJson) {
      const raw = (form.placesJson.value || "").trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error("地点需为 JSON 数组");
          places = parsed.map((p) => ({
            id: typeof p?.id === "string" && p.id ? p.id : uid(),
            categoryTags: Array.isArray(p?.categoryTags) ? p.categoryTags.map((x) => String(x).trim()).filter(Boolean) : ["未分类"],
            name: typeof p?.name === "string" ? p.name : "",
            road: typeof p?.road === "string" ? p.road : "",
            district: typeof p?.district === "string" ? p.district : "",
            addressHint: typeof p?.addressHint === "string" ? p.addressHint : "",
            note: typeof p?.note === "string" ? p.note : "",
            rawQuote: typeof p?.rawQuote === "string" ? p.rawQuote : "",
            amap: p?.amap && typeof p.amap === "object" ? p.amap : null,
            resolveStatus: typeof p?.resolveStatus === "string" ? p.resolveStatus : "pending",
            amapRestError: typeof p?.amapRestError === "string" ? p.amapRestError : ""
          }));
        } catch (err) {
          alert(`地点 JSON 无效：${String(err?.message || err)}`);
          return;
        }
      }
    }
    await putItem({
      ...item,
      city,
      interests: interests.length ? interests : ["未分类"],
      primaryInterest: interests[0] || item.primaryInterest || "未分类",
      title,
      text,
      places
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
    let filled = false;
    try {
      const data = await amapRest({ action: "regeo", location: `${longitude},${latitude}` });
      if (data?.ok && data.city) {
        let c = String(data.city).replace(/市$/u, "").trim();
        if (c && c !== "未知") {
          state.settings.currentCity = c;
          await setSettings(state.settings);
          renderCitySelect();
          render();
          filled = true;
        }
      }
    } catch {
      // ignore
    }
    if (!filled) {
      window.open(`https://www.amap.com/regeo?lnglat=${longitude},${latitude}`, "_blank", "noopener,noreferrer");
      alert("已尝试用高德逆地理解析城市；若失败已打开地图页。也可在「当前城市」里手动选择。");
    }
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
  if (els.amapJsKey) els.amapJsKey.value = state.settings.amapJsKey || "";
  if (els.amapSecurityCode) els.amapSecurityCode.value = state.settings.amapSecurityCode || "";
  if (els.amapServiceHost) els.amapServiceHost.value = state.settings.amapServiceHost || "";

  els.btnSettings.addEventListener("click", () => els.settingsDialog.showModal());
  els.btnSaveSettings.addEventListener("click", async () => {
    const next = {
      ...state.settings,
      ocrLang: els.ocrLang.value,
      classifierMode: els.classifierMode.value,
      amapJsKey: (els.amapJsKey?.value || "").trim(),
      amapSecurityCode: (els.amapSecurityCode?.value || "").trim(),
      amapServiceHost: (els.amapServiceHost?.value || "").trim()
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
    if (els.amapJsKey) els.amapJsKey.value = "";
    if (els.amapSecurityCode) els.amapSecurityCode.value = "";
    if (els.amapServiceHost) els.amapServiceHost.value = "";
    await refresh();
  });

  if (els.btnMap) els.btnMap.addEventListener("click", () => openMapExplorer({}));
  if (els.mapClose) els.mapClose.addEventListener("click", () => els.mapDialog?.close());
  if (els.mapDialog) {
    els.mapDialog.addEventListener("close", () => {
      mapExplorerFocusItemId = null;
      destroyMapRuntime();
    });
  }
  if (els.mapCitySelect) {
    els.mapCitySelect.addEventListener("change", () => {
      destroyRouteOverlay();
      rebuildMapMarkers();
      renderMapSidebarList();
    });
  }
  if (els.mapFit) {
    els.mapFit.addEventListener("click", () => {
      try {
        mapRuntime.map?.setFitView?.(mapRuntime.markers, false, [56, 56, 56, 320]);
      } catch {
        // ignore
      }
    });
  }
  if (els.mapClearRoute) els.mapClearRoute.addEventListener("click", () => destroyRouteOverlay());
  if (els.mapRouteOrder) els.mapRouteOrder.addEventListener("click", () => runMapDrivingRoute(false));
  if (els.mapRouteNN) els.mapRouteNN.addEventListener("click", () => runMapDrivingRoute(true));
  if (els.mapLocate) {
    els.mapLocate.addEventListener("click", () => {
      const AMap = mapRuntime.AMap;
      const map = mapRuntime.map;
      if (!AMap || !map) {
        alert("请先打开地图并等待加载完成。");
        return;
      }
      const geo = new AMap.Geolocation({
        enableHighAccuracy: true,
        timeout: 15000,
        needAddress: false
      });
      geo.getCurrentPosition((status, res) => {
        if (status !== "complete" || !res?.position) {
          alert("定位失败，请检查浏览器定位权限。");
          return;
        }
        mapRuntime.userLngLat = { lng: res.position.lng, lat: res.position.lat };
        map.setCenter([res.position.lng, res.position.lat]);
        renderMapSidebarList();
      });
    });
  }

  await refresh();
}

boot();
