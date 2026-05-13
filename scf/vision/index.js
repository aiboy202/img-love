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
    "你是一个截图信息抽取与归类助手。",
    "输入是一张截图图片。你需要先识别图片中的文字（OCR），再理解文字意思，并输出结构化 JSON。",
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
    "规则：",
    "- text：尽量完整的 OCR 文本（可包含换行）。",
    "- title：<=26字，概括整张截图主题。",
    "- city：从内容判断城市；没有把握填“未知”。",
    "- interests：整张截图层面的 1~4 个兴趣标签；无把握用 [\"未分类\"]。",
    "- places：每一个独立地点/门店/景点；多店多路必须拆成多个元素。",
    "- categoryTags：该地点类型标签（美食餐厅/咖啡甜品/旅游景点/酒店民宿/购物/拍照机位/交通攻略等），1~4 个。",
    "- name/road/district/addressHint/note/rawQuote：无则空字符串。",
    "- confidence：0~1。",
    "你可能会得到这些提示：",
    `- cityHint: ${cityHint || "(none)"}`,
    `- interestHint: ${interestHint || "(none)"}`
  ].join("\n");

  const userText = ["请对这张截图做 OCR，并按规则输出 JSON。", "注意：只输出 JSON。"].join("\n");

  const payload = {
    model,
    stream: false,
    temperature: 0.2,
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

  const content = raw?.choices?.[0]?.message?.content;
  let parsed = null;
  try {
    parsed = typeof content === "string" ? JSON.parse(content) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    return json(502, { error: "Model output is not valid JSON", content }, event);
  }

  const text = typeof parsed.text === "string" ? parsed.text : "";
  const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 40) : "";
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
    })
    .slice(0, 24);

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
