// Tencent Cloud SCF (Node.js) — HTTP / API 网关 / 函数 URL 触发
//
// 智谱 OpenAPI：https://open.bigmodel.cn/api/paas/v4/chat/completions
// 环境变量：
//   - BIGMODEL_API_KEY（必填）
//   - BIGMODEL_VISION_MODEL（可选；默认 glm-4.6v，见下方说明）
//   - BIGMODEL_TIMEOUT_MS（可选，默认 60000）
//
// 说明：glm-4.5-air 为纯文本模型，无法接受截图里的 image_url。
// 截图 OCR 请使用多模态模型（默认 glm-4.6v，也可 glm-5v-turbo 等）。

const BIGMODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_VISION_MODEL = "glm-4.6v";

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
    // 勿丢弃 name 为空的行：模型常返回占位对象；若 continue 会把 [ { name: "" } ] 展成 []，后续无法从 text 救回
    if (!name) {
      out.push({ ...pl, name: "" });
      continue;
    }
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

function isPlaceholderPoiName(n) {
  const t = typeof n === "string" ? n.trim() : "";
  return !t || /^(未分类|未知|未命名|截图收藏?|未命名地点)$/.test(t);
}

function isUsablePoiName(n) {
  const t = typeof n === "string" ? n.trim() : "";
  if (isPlaceholderPoiName(t)) return false;
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

/** 智谱 message.content 可能是 string 或 [{ type, text }] 数组 */
function extractBigModelMessageContent(message) {
  const c = message?.content;
  if (typeof c === "string" && c.trim()) return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && part.type === "text" && part.text) return String(part.text);
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim()) {
    return message.reasoning_content.trim();
  }
  return "";
}

/** 智谱偶发 Markdown 代码块或前后废话，需从 content 中抠出 JSON */
function safeModelJsonParse(content) {
  if (typeof content !== "string") return null;
  let t = content.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  }
  const tryOne = (x) => {
    try {
      const o = JSON.parse(x);
      return o && typeof o === "object" ? o : null;
    } catch {
      return null;
    }
  };
  let o = tryOne(t);
  if (o) return o;
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return tryOne(t.slice(a, b + 1));
  return null;
}

function inferVenueNamesFromGuideBlob(text) {
  if (!text || typeof text !== "string") return [];
  let s = text.slice(0, 6000);
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
  if (!out.length) {
    for (const chunk of s.split(/[，,。；;！!？?\n、：:]+/).map((x) => x.trim()).filter(Boolean)) {
      if (chunk.length < 2 || chunk.length > 48) continue;
      if (!isUsablePoiName(chunk)) continue;
      if (seen.has(chunk)) continue;
      seen.add(chunk);
      out.push(chunk.slice(0, 80));
      if (out.length >= 24) break;
    }
  }
  if (!out.length) {
    const geoRe = /[\u4e00-\u9fa5]{1,12}(?:镇|县|区|市|山|乡|村|岛|湖|湾|港|站|岭|谷|景区|国家公园)/g;
    let m;
    while ((m = geoRe.exec(text)) !== null) {
      const t = m[0].trim();
      if (t.length < 2 || t.length > 20) continue;
      if (PLACE_SECTION_HEADERS.has(t) || GENERIC_NON_POI_NAMES.has(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 24) break;
    }
  }
  return out;
}

function recoverPlacesFromTextWhenModelWeak(places, text, interests) {
  const inferred = inferVenueNamesFromGuideBlob(text);
  if (inferred.length === 0) return places;

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

/** 部分触发器把整段 event 序列化成字符串传入 */
function normalizeEvent(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

/** 从腾讯云多种 HTTP 触发器 event 中取请求方法（大小写不敏感） */
function getHttpMethod(event) {
  const m =
    event?.httpMethod ||
    event?.requestContext?.http?.method ||
    event?.requestContext?.request?.httpMethod ||
    event?.requestContext?.httpMethod ||
    event?.RequestContext?.Http?.Method;
  return typeof m === "string" ? m.toUpperCase() : "";
}

/** 少数接入未带 httpMethod；有 JSON body 时按 POST 处理 */
function inferHttpMethod(event, bodyStr) {
  const direct = getHttpMethod(event);
  if (direct) return direct;
  if (event?.body && typeof event.body === "object" && String(event.body?.imageDataUrl || "").startsWith("data:image/")) {
    return "POST";
  }
  if (bodyStr && /^\s*\{/.test(bodyStr)) return "POST";
  return "";
}

/** 预检时回显浏览器请求的 Header，避免 Allow-Headers 不匹配导致浏览器报 Failed to fetch */
function corsHeaders(event) {
  const h = event?.headers || event?.header;
  let allowHeaders = "Content-Type, Authorization";
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h)) {
      if (String(k).toLowerCase() === "access-control-request-headers" && v != null && String(v).trim()) {
        allowHeaders = String(v).trim();
        break;
      }
    }
  }
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Max-Age": "86400"
  };
}

/** 取原始 body 字符串；兼容 isBase64Encoded */
function getBodyString(event) {
  let raw = event?.body;
  if (raw == null) return "";
  if (typeof raw === "object") return "";
  if (typeof raw !== "string") return "";
  if (event?.isBase64Encoded) {
    try {
      return Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return raw;
    }
  }
  return raw;
}

/** @param {object|null} event 原始 HTTP event（用于 CORS 预检回显 Header）；可传 null */
function json(statusCode, data, event = null, extraHeaders = {}) {
  const cors = corsHeaders(event || {});
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return {
    isBase64Encoded: false,
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors,
      ...extraHeaders
    },
    body: statusCode === 204 ? "" : body
  };
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

async function handleVision(event) {
  const bodyStrEarly = getBodyString(event);
  const method = inferHttpMethod(event, bodyStrEarly);

  if (method === "OPTIONS") return json(204, "", event);
  if (method === "GET") {
    return json(
      200,
      {
        ok: true,
        service: "img_love/vision",
        revision: "2026-05-15-content-array-geo",
        hint: "POST JSON：{ imageDataUrl, cityHint?, interestHint?, model? }；需配置 BIGMODEL_API_KEY"
      },
      event
    );
  }
  if (method !== "POST") {
    return json(405, { error: "Method Not Allowed", method: method || "(empty)" }, event, { Allow: "GET,POST,OPTIONS" });
  }

  const apiKey = process.env.BIGMODEL_API_KEY;
  if (!apiKey) return json(500, { error: "Missing env: BIGMODEL_API_KEY" }, event);

  const bodyStr = bodyStrEarly || getBodyString(event);
  let body = null;
  if (bodyStr) {
    try {
      body = JSON.parse(bodyStr);
    } catch {
      return json(400, { error: "Invalid JSON body" }, event);
    }
  } else if (event?.body && typeof event.body === "object") {
    body = event.body;
  } else {
    return json(400, { error: "Missing request body" }, event);
  }

  const imageDataUrl = String(body?.imageDataUrl || "").trim();
  if (!imageDataUrl.startsWith("data:image/")) {
    return json(400, { error: "Missing/invalid field: imageDataUrl (data:image/*;base64,...)" }, event);
  }

  const cityHint = typeof body?.cityHint === "string" ? body.cityHint.trim() : "";
  const interestHint = typeof body?.interestHint === "string" ? body.interestHint.trim() : "";
  const model = String(process.env.BIGMODEL_VISION_MODEL || body?.model || DEFAULT_VISION_MODEL).trim();

  const system = [
    "你是「旅行/探店/本地生活」截图的结构化理解助手，不是简单 OCR 抄写员。",
    "输入是一张截图（常见：抖音/小红书/大众点评/地图/备忘录）。你要结合**版面、字号、位置条、地图钉、话题标签**与正文，做**语义理解、信息提炼与噪声过滤**，再输出 JSON。",
    "必须只输出 JSON（不要 Markdown，不要解释）。",
    "JSON 结构固定为：",
    '{ "title": string, "city": string, "interests": string[], "text": string, "confidence": number, "places": Place[] }',
    "其中 Place = {",
    '  "categoryTags": string[],',
    '  "name": string,',
    '  "road": string,',
    '  "district": string,',
    '  "addressHint": string,',
    '  "note": string,',
    '  "rawQuote": string',
    "}",
    "【提炼与过滤】",
    "- text：**禁止**输出空字符串。手写/备忘录/编号清单必须把图中**可见店名或标题行**逐行写入 text（可轻度去噪），否则无法地图检索；约 1200 字内。",
    "- title：<=26 字，具体主题，避免“截图/抖音”等空泛词。",
    "- city：综合判断；无把握填“未知”。",
    "- interests：1~4 个；无把握 [\"未分类\"]。",
    "【places】",
    "- 每条对应可地图检索的命名实体；路名写入 road/addressHint，不要单独当一条路一个 place。",
    "- **严禁**把「土菜馆、简餐、川菜和鱼」等**仅为分类/栏目**的词作为任意 place 的 **name**；它们只能进 categoryTags。",
    "- **便利贴/清单「分类 + 多店」**：分类词只进 categoryTags；**每个店名单独一条**；顿号/逗号并列多名必须拆成多条，勿只保留第一个。",
    "- 同一店合并一条；rawQuote 仅一句<=80字。",
    "- confidence：0~1。",
    "你可能会得到这些提示：",
    `- cityHint: ${cityHint || "(none)"}`,
    `- interestHint: ${interestHint || "(none)"}`
  ].join("\n");

  const userText = [
    "请阅读整张截图：判断类型（含分类便签清单）→去噪提炼→输出 JSON。",
    "若为「分类 + 多店名」：每个店名各一条 places；分类进 categoryTags。",
    "注意：只输出 JSON；text 在提炼的同时须保留清单中的**逐行可见文字**（无空格的长中文行可整行保留），不得整段留空。"
  ].join("\n");

  const payload = {
    model,
    stream: false,
    temperature: 0.28,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl } },
          { type: "text", text: userText }
        ]
      }
    ]
  };

  const timeoutMs = Number(process.env.BIGMODEL_TIMEOUT_MS || 60_000);
  let upstream = null;
  try {
    upstream = await fetchWithTimeout(
      BIGMODEL_BASE_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      },
      timeoutMs
    );
  } catch (e) {
    return json(504, { error: "Upstream fetch failed", message: String(e?.message || e), model }, event);
  }

  let raw = null;
  try {
    raw = await upstream.json();
  } catch {
    return json(502, { error: "Upstream non-JSON response", status: upstream.status }, event);
  }

  if (!upstream.ok) return json(502, { error: "Upstream error", status: upstream.status, details: raw }, event);

  const content = extractBigModelMessageContent(raw?.choices?.[0]?.message);
  const parsed = safeModelJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    return json(502, { error: "Model output is not valid JSON", content }, event);
  }

  const textRaw = typeof parsed.text === "string" ? parsed.text : "";
  const text = textRaw.length > 12000 ? textRaw.slice(0, 12000) : textRaw;
  const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 40) : "";
  let city = typeof parsed.city === "string" ? parsed.city.trim().slice(0, 12) : "";
  if (!city || city === "未知" || city === "全部") {
    if (cityHint && cityHint !== "未知" && cityHint !== "全部") city = cityHint.slice(0, 12);
  }
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

  if (!places.length) {
    const firstLine =
      typeof text === "string"
        ? text
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length >= 2 && l.length <= 80) || ""
        : "";
    const tags = interests.filter((x) => x && x !== "未分类" && x !== "未知");
    places.push({
      categoryTags: tags.length ? tags.slice(0, 4) : ["未分类"],
      name: legacyPoi || title || firstLine,
      road: "",
      district: "",
      addressHint: legacyAddress,
      note: "",
      rawQuote: firstLine && !legacyPoi && !title ? firstLine.slice(0, 120) : ""
    });
  }

  const allNamesMissing = places.length > 0 && places.every((p) => !String(p?.name || "").trim());
  if (allNamesMissing) {
    const inferred2 = inferVenueNamesFromGuideBlob(text);
    const tags0 =
      Array.isArray(places[0]?.categoryTags) && places[0].categoryTags.length
        ? places[0].categoryTags
        : interests.filter((x) => x && x !== "未分类" && x !== "未知").length
          ? interests.slice(0, 4)
          : ["未分类"];
    if (inferred2.length) {
      places = inferred2.slice(0, 24).map((name) => ({
        categoryTags: [...tags0].slice(0, 6),
        name: name.slice(0, 80),
        road: "",
        district: "",
        addressHint: "",
        note: "",
        rawQuote: ""
      }));
    } else {
      const rq = String(places[0]?.rawQuote || "").trim();
      const ah = String(places[0]?.addressHint || "").trim();
      if (rq) places = [{ ...places[0], name: rq.slice(0, 80) }];
      else if (ah) places = [{ ...places[0], name: ah.slice(0, 80) }];
      else {
        const salvageLine =
          typeof text === "string"
            ? text
                .split(/\r?\n/)
                .map((l) => l.trim())
                .find((l) => l.length >= 2 && l.length <= 80) || ""
            : "";
        if (salvageLine) places = [{ ...places[0], name: salvageLine.slice(0, 80) }];
        else {
          const lp = String(legacyPoi || "").trim();
          if (lp) places = [{ ...places[0], name: lp.slice(0, 80) }];
        }
      }
    }
  }

  const tagSet = new Set(interests);
  for (const pl of places) for (const t of pl.categoryTags) if (t) tagSet.add(t);
  interests = Array.from(tagSet).slice(0, 8);
  if (!interests.length) interests = ["未分类"];

  const out = {
    title: title || (places[0]?.name ? String(places[0].name).slice(0, 40) : "截图收藏"),
    city,
    interests,
    text,
    confidence,
    places,
    poi: legacyPoi || (typeof places[0]?.name === "string" ? places[0].name : ""),
    address: legacyAddress || (typeof places[0]?.addressHint === "string" ? places[0].addressHint : "")
  };

  return json(200, out, event);
}

/** 控制台「执行方法」填 main_handler 或 main 均可 */
const main_handler = async (rawEvent) => {
  const event = normalizeEvent(rawEvent);
  try {
    return await handleVision(event);
  } catch (e) {
    return json(500, { error: "Unhandled exception", message: String(e?.message || e) }, event);
  }
};
const main = main_handler;

exports.main_handler = main_handler;
exports.main = main;
