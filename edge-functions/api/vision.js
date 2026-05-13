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
  // 1) context.env (some deployments expose KV bindings here)
  const envHit = findKvInObject(context?.env);
  if (envHit) return envHit;
  // 2) globalThis injection (docs examples often use the bound var name directly, e.g. my_kv.get())
  try {
    // Scan a limited subset to avoid huge overhead; still good enough for typical Pages runtimes.
    for (const k of Object.getOwnPropertyNames(globalThis)) {
      // Skip obviously irrelevant builtins quickly
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
  if (env && typeof env[key] === "string" && env[key].trim()) return env[key].trim();
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
  try {
    const { request } = context;
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
    }

    const env = context?.env || {};
    const kvHit = findKvAny(context);
    const kvBound = Boolean(kvHit?.kv);
    const kvVarName = kvHit?.name || "";
    const apiKey = await (async () => {
      // Try env first, then KV (either in context.env or globalThis)
      if (typeof env.BIGMODEL_API_KEY === "string" && env.BIGMODEL_API_KEY.trim()) return env.BIGMODEL_API_KEY.trim();
      const kv = kvHit?.kv;
      if (!kv) return "";
      const v = await kv.get("BIGMODEL_API_KEY");
      return typeof v === "string" ? v.trim() : "";
    })();
    if (!apiKey) {
      return json(
        {
          error: "Missing BIGMODEL_API_KEY",
          hint: "Set env var BIGMODEL_API_KEY, or store it in a bound Pages KV namespace with key BIGMODEL_API_KEY.",
          kvBound,
          kvVarName
        },
        { status: 500 }
      );
    }

    let body = null;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

  const imageDataUrl = String(body?.imageDataUrl || "").trim();
  if (!imageDataUrl.startsWith("data:image/")) {
    return badRequest("Missing/invalid field: imageDataUrl (data:image/*;base64,...)");
  }

  const cityHint = typeof body?.cityHint === "string" ? body.cityHint.trim() : "";
  const interestHint = typeof body?.interestHint === "string" ? body.interestHint.trim() : "";

    const modelFromKv = await (async () => {
      if (typeof env.BIGMODEL_VISION_MODEL === "string" && env.BIGMODEL_VISION_MODEL.trim()) return env.BIGMODEL_VISION_MODEL.trim();
      const kv = kvHit?.kv;
      if (!kv) return "";
      const v = await kv.get("BIGMODEL_VISION_MODEL");
      return typeof v === "string" ? v.trim() : "";
    })();
    const model = String(modelFromKv || body?.model || "glm-4.6v").trim();

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
    "- title：<=26字，概括整张截图主题（可为并列主题合并）。",
    "- city：从内容判断城市；没有把握填“未知”。",
    "- interests：整张截图层面的 1~4 个兴趣标签（与 categoryTags 可重叠）；无把握用 [\"未分类\"]。",
    "- places：从截图中抽取的**每一个**独立地点/门店/景点/路口兴趣点；一张图里提到几条路、几家店就要输出多少个元素。",
    "- categoryTags：该地点的类型标签（如：美食餐厅、咖啡甜品、旅游景点、酒店民宿、购物、拍照机位、交通攻略等），1~4 个。",
    "- name：店名/景点名/地标名；不确定可空字符串。",
    "- road：路名/街巷名；无则空字符串。",
    "- district：区/县；无则空字符串。",
    "- addressHint：便于地图检索的地址片段（门牌/商场楼层/附近地标）；无则空字符串。",
    "- note：短备注（人均、排队、营业时间摘要等）；无则空字符串。",
    "- rawQuote：支持该地点的 OCR 原文一句（<=80字）；无则空字符串。",
    "- confidence：0~1 的整体置信度。",
    "你可能会得到这些提示：",
    `- cityHint: ${cityHint || "(none)"}`,
    `- interestHint: ${interestHint || "(none)"}`
  ].join("\n");

  const userText = [
    "请对这张截图做 OCR，并按规则输出 JSON。",
    "注意：只输出 JSON。"
  ].join("\n");

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
            "Edge Functions may timeout on slow upstream networks. Consider switching this endpoint to Cloud Functions, or set BIGMODEL_TIMEOUT_MS higher (if allowed) and reduce image size.",
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

  return json(out);
  } catch (e) {
    return json(
      {
        error: "Unhandled exception",
        message: String(e?.message || e),
        name: e?.name || "Error"
      },
      { status: 500 }
    );
  }
}

