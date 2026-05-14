const BIGMODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function badRequest(message) {
  return json({ error: message }, { status: 400 });
}

function serverError(message) {
  return json({ error: message }, { status: 500 });
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
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

function expandPlacesByNameEnumeration(places) {
  const out = [];
  for (const pl of places) {
    const name = typeof pl.name === "string" ? pl.name.trim() : "";
    if (!name) continue;
    if (!PLACE_NAME_ENUM_SPLIT.test(name)) {
      if (!PLACE_SECTION_HEADERS.has(name)) out.push({ ...pl, name: name.slice(0, 80) });
      continue;
    }
    const parts = name
      .split(PLACE_NAME_ENUM_SPLIT)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && !PLACE_SECTION_HEADERS.has(s));
    if (parts.length <= 1) {
      const single = parts[0] || name;
      if (!PLACE_SECTION_HEADERS.has(single)) out.push({ ...pl, name: single.slice(0, 80) });
      continue;
    }
    for (const seg of parts) {
      out.push({ ...pl, name: seg.slice(0, 80) });
    }
  }
  return out;
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

function reEscapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferVenueNamesFromGuideBlob(text) {
  if (!text || typeof text !== "string") return [];
  let s = text.slice(0, 6000);
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
  return out;
}

function recoverPlacesFromTextWhenModelWeak(places, text, interests) {
  const inferred = inferVenueNamesFromGuideBlob(text);
  if (inferred.length < 2) return places;

  const goodRows = places.filter((p) => isUsablePoiName(p?.name));
  if (goodRows.length >= 3) return places;

  const tagsBase = interests.filter((x) => x && x !== "未分类").slice(0, 4);
  const ct = tagsBase.length ? tagsBase : ["美食"];

  if (goodRows.length === 0) {
    return inferred.slice(0, 24).map((name) => ({
      categoryTags: [...ct].slice(0, 6),
      name: name.slice(0, 80),
      road: "",
      district: "",
      addressHint: "",
      note: "",
      rawQuote: ""
    }));
  }

  const have = new Set(goodRows.map((p) => String(p.name || "").trim()));
  const merged = goodRows.map((p) => ({ ...p }));
  for (const nm of inferred) {
    if (merged.length >= 24) break;
    if (have.has(nm)) continue;
    merged.push({
      categoryTags: [...ct].slice(0, 6),
      name: nm.slice(0, 80),
      road: "",
      district: "",
      addressHint: "",
      note: "",
      rawQuote: ""
    });
    have.add(nm);
  }
  return merged.length > goodRows.length ? merged : places;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(url, init, { timeoutMs = 45_000, retries = 2, backoffMs = 600 } = {}) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
    }
  }
  throw lastErr || new Error("fetch failed");
}

function isKvNamespace(v) {
  return (
    v &&
    typeof v === "object" &&
    typeof v.get === "function" &&
    typeof v.put === "function" &&
    typeof v.delete === "function" &&
    typeof v.list === "function"
  );
}

function findKvInObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj)) {
    if (isKvNamespace(v)) return { name: k, kv: v };
  }
  return null;
}

function findKvAny(context) {
  const envHit = findKvInObject(context?.env);
  if (envHit) return envHit;
  try {
    for (const k of Object.getOwnPropertyNames(globalThis)) {
      if (k.length > 64) continue;
      const v = globalThis[k];
      if (isKvNamespace(v)) return { name: k, kv: v };
    }
  } catch {
    // ignore
  }
  return null;
}

async function readSecret(env, key) {
  // 1) try env var
  if (env && typeof env[key] === "string" && env[key].trim()) return env[key].trim();
  // 2) try KV (keys are often stored as BIGMODEL_API_KEY / BIGMODEL_MODEL etc.)
  const hit = findKvAny({ env });
  const kv = hit?.kv;
  if (!kv) return "";
  const v =
    (await kv.get(key)) ??
    (await kv.get(key.toLowerCase())) ??
    (await kv.get(key.replace(/_/g, "-").toLowerCase()));
  return typeof v === "string" ? v.trim() : "";
}

export default async function onRequest(context) {
  const { request } = context;

  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  // EdgeOne Pages Functions provides env vars on context.env (per docs).
  const env = context?.env || {};
  const kvHit = findKvAny(context);
  const apiKey = await (async () => {
    if (typeof env.BIGMODEL_API_KEY === "string" && env.BIGMODEL_API_KEY.trim()) return env.BIGMODEL_API_KEY.trim();
    const kv = kvHit?.kv;
    if (!kv) return "";
    const v = await kv.get("BIGMODEL_API_KEY");
    return typeof v === "string" ? v.trim() : "";
  })();
  if (!apiKey) {
    return serverError(
      "Missing BIGMODEL_API_KEY (set as env var, or store it in Pages KV and bind the namespace to this project)."
    );
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const text = String(body?.text || "").trim();
  if (!text) return badRequest("Missing field: text");

  const modelFromKv = await (async () => {
    if (typeof env.BIGMODEL_MODEL === "string" && env.BIGMODEL_MODEL.trim()) return env.BIGMODEL_MODEL.trim();
    const kv = kvHit?.kv;
    if (!kv) return "";
    const v = await kv.get("BIGMODEL_MODEL");
    return typeof v === "string" ? v.trim() : "";
  })();
  const model = String(modelFromKv || body?.model || "glm-4.5-air").trim();

  const system = [
    "你是「旅行/探店/本地生活」文本的结构化理解助手，不是 OCR 复读机。",
    "给定一段来自截图的 OCR 文本（可能有噪声、错别字、话题标签堆叠），你要做**语义理解、信息提炼与过滤**，输出 JSON。",
    "必须只输出 JSON（不要 Markdown，不要解释）。",
    "JSON 结构固定为：",
    '{ "title": string, "city": string, "interests": string[], "confidence": number, "places": Place[] }',
    "Place = { categoryTags[], name, road, district, addressHint, note, rawQuote }。",
    "- text 字段不要出现在 JSON 中（本接口输入已是 text）；若模型误输出 text 字段将被忽略。",
    "places：只输出**可地图检索的 POI**；路名进 road/addressHint；同一店合并；rawQuote 仅一句<=80字。",
    "**严禁**把「土菜馆、简餐、川菜和鱼」等仅为**分类/栏目**的词作为任意 place 的 **name**；它们只能进 categoryTags。",
    "若 OCR 为「分类标题 + 多店名」清单：分类只进 categoryTags；**每个店名单独一条 places**；同一行顿号/逗号并列多名必须拆成多条。",
    "interests：全文 1~4 个标签；categoryTags：单点类型。"
  ].join("\n");

  const user = [
    "请对下列 OCR 文本去噪提炼，并输出 places/title/city/interests/confidence 的 JSON。",
    "OCR文本如下：\n",
    text,
    "\n"
  ].join("");

  const payload = {
    model,
    stream: false,
    temperature: 0.28,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };

  let upstream = null;
  try {
    const timeoutMs = Number(env.BIGMODEL_TIMEOUT_MS || 60_000);
    upstream = await fetchWithRetry(
      BIGMODEL_BASE_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      },
      { timeoutMs, retries: 2, backoffMs: 800 }
    );
  } catch (e) {
    return json(
      {
        error: "Upstream fetch failed",
        message: String(e?.message || e),
        hint:
          "Edge Functions may timeout on slow upstream networks. Consider switching this endpoint to Cloud Functions, or set BIGMODEL_TIMEOUT_MS higher (if allowed).",
        model
      },
      { status: 504 }
    );
  }

  let raw = null;
  try {
    raw = await upstream.json();
  } catch {
    return serverError(`Upstream non-JSON response (status ${upstream.status})`);
  }

  if (!upstream.ok) {
    return json({ error: "Upstream error", status: upstream.status, details: raw }, { status: 502 });
  }

  const content = raw?.choices?.[0]?.message?.content;
  const parsed = typeof content === "string" ? safeJsonParse(content) : null;
  if (!parsed || typeof parsed !== "object") {
    return json({ error: "Model output is not valid JSON", model, content }, { status: 502 });
  }

  let city = typeof parsed.city === "string" ? parsed.city.trim().slice(0, 12) : "未知";
  if (!city) city = "未知";

  let interests = Array.isArray(parsed.interests)
    ? parsed.interests.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
    : ["未分类"];
  if (!interests.length) interests = ["未分类"];

  const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;

  let places = Array.isArray(parsed.places) ? parsed.places : [];
  places = places
    .filter((p) => p && typeof p === "object")
    .map((p) => {
      const categoryTags = Array.isArray(p.categoryTags)
        ? p.categoryTags.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
        : [];
      return {
        categoryTags,
        name: typeof p.name === "string" ? p.name.trim().slice(0, 80) : "",
        road: typeof p.road === "string" ? p.road.trim().slice(0, 60) : "",
        district: typeof p.district === "string" ? p.district.trim().slice(0, 40) : "",
        addressHint: typeof p.addressHint === "string" ? p.addressHint.trim().slice(0, 120) : "",
        note: typeof p.note === "string" ? p.note.trim().slice(0, 120) : "",
        rawQuote: typeof p.rawQuote === "string" ? p.rawQuote.trim().slice(0, 120) : ""
      };
    });

  const legacyPoi = typeof parsed.poi === "string" ? parsed.poi.trim().slice(0, 80) : "";
  const legacyAddress = typeof parsed.address === "string" ? parsed.address.trim().slice(0, 120) : "";
  const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 40) : "";

  if (!places.length) {
    places.push({
      categoryTags: interests.filter((x) => x && x !== "未分类").length ? interests.slice(0, 4) : ["未分类"],
      name: legacyPoi || title,
      road: "",
      district: "",
      addressHint: legacyAddress,
      note: "",
      rawQuote: ""
    });
  }

  places = expandPlacesByNameEnumeration(places).slice(0, 24);
  places = recoverPlacesFromTextWhenModelWeak(places, text, interests).slice(0, 24);

  const tagSet = new Set(interests);
  for (const pl of places) for (const t of pl.categoryTags) if (t) tagSet.add(t);
  interests = Array.from(tagSet).slice(0, 8);
  if (!interests.length) interests = ["未分类"];

  const out = {
    title: title || (places[0]?.name ? String(places[0].name).slice(0, 40) : "文本收藏"),
    city,
    interests,
    confidence,
    places,
    poi: legacyPoi || (typeof places[0]?.name === "string" ? places[0].name : ""),
    address: legacyAddress || (typeof places[0]?.addressHint === "string" ? places[0].addressHint : "")
  };

  return json(out);
}

