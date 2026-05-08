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
  const model = String(modelFromKv || body?.model || "glm-5.1").trim();

  const system = [
    "你是一个信息抽取与归类助手。",
    "给定一段 OCR 文本（来自用户截图），抽取结构化字段用于个人收藏归档。",
    "必须只输出 JSON（不要 Markdown，不要解释）。",
    "JSON 结构固定为：",
    '{ "title": string, "city": string, "interests": string[], "poi": string, "address": string, "confidence": number }',
    "规则：",
    "- title：尽量短（<=26字），能代表该条收藏的核心对象（店名/景点/事件）。",
    "- city：尽量从文本中判断；如果没有把握填“未知”。",
    "- interests：从文本语义判断 1~3 个标签；没有把握返回 [\"未分类\"]。",
    "- poi：店名/景点名（可为空字符串）。",
    "- address：地址（可为空字符串）。",
    "- confidence：0~1 的整体置信度。"
  ].join("\n");

  const user = `OCR文本如下（可能有错别字/换行）：\n${text}\n`;

  const payload = {
    model,
    stream: false,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };

  let upstream = null;
  try {
    upstream = await fetch(BIGMODEL_BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return serverError(`Upstream fetch failed: ${String(e?.message || e)}`);
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

  const out = {
    title: typeof parsed.title === "string" ? parsed.title.trim().slice(0, 40) : "",
    city: typeof parsed.city === "string" ? parsed.city.trim().slice(0, 12) : "未知",
    interests: Array.isArray(parsed.interests)
      ? parsed.interests.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
      : ["未分类"],
    poi: typeof parsed.poi === "string" ? parsed.poi.trim().slice(0, 40) : "",
    address: typeof parsed.address === "string" ? parsed.address.trim().slice(0, 80) : "",
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0
  };
  if (!out.interests.length) out.interests = ["未分类"];
  if (!out.city) out.city = "未知";

  return json(out);
}

