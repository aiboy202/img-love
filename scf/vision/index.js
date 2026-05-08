// Tencent Cloud SCF (Node.js) HTTP/API Gateway handler
// - Put your Zhipu/BigModel key in SCF env: BIGMODEL_API_KEY
// - Optional env:
//   - BIGMODEL_VISION_MODEL (default: glm-5v-turbo)
//   - BIGMODEL_TIMEOUT_MS (default: 60000)

const BIGMODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

function json(statusCode, data, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      // CORS (allow browser direct call)
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      ...extraHeaders
    },
    body: JSON.stringify(data)
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

exports.main_handler = async (event) => {
  const method = event?.httpMethod || event?.requestContext?.http?.method || event?.requestContext?.request?.httpMethod;

  if (method === "OPTIONS") return json(204, "");
  if (method !== "POST") return json(405, { error: "Method Not Allowed" }, { Allow: "POST,OPTIONS" });

  const apiKey = process.env.BIGMODEL_API_KEY;
  if (!apiKey) return json(500, { error: "Missing env: BIGMODEL_API_KEY" });

  let body = null;
  try {
    body = typeof event?.body === "string" ? JSON.parse(event.body) : event?.body;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const imageDataUrl = String(body?.imageDataUrl || "").trim();
  if (!imageDataUrl.startsWith("data:image/")) {
    return json(400, { error: "Missing/invalid field: imageDataUrl (data:image/*;base64,...)" });
  }

  const cityHint = typeof body?.cityHint === "string" ? body.cityHint.trim() : "";
  const interestHint = typeof body?.interestHint === "string" ? body.interestHint.trim() : "";
  const model = String(process.env.BIGMODEL_VISION_MODEL || body?.model || "glm-5v-turbo").trim();

  const system = [
    "你是一个截图信息抽取与归类助手。",
    "输入是一张截图图片。你需要先识别图片中的文字（OCR），再理解文字意思，并输出结构化 JSON。",
    "必须只输出 JSON（不要 Markdown，不要解释）。",
    "JSON 结构固定为：",
    '{ "title": string, "city": string, "interests": string[], "poi": string, "address": string, "text": string, "confidence": number }',
    "规则：",
    "- text：尽量完整的 OCR 文本（可包含换行）。",
    "- title：尽量短（<=26字），代表核心对象（店名/景点/事件）。",
    "- city：尽量从内容判断；如果没有把握填“未知”。",
    "- interests：从语义判断 1~3 个标签；没有把握返回 [\"未分类\"]。",
    "- poi：店名/景点名（可为空字符串）。",
    "- address：地址（可为空字符串）。",
    "- confidence：0~1 的整体置信度。",
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
    return json(504, { error: "Upstream fetch failed", message: String(e?.message || e), model });
  }

  let raw = null;
  try {
    raw = await upstream.json();
  } catch {
    return json(502, { error: "Upstream non-JSON response", status: upstream.status });
  }

  if (!upstream.ok) return json(502, { error: "Upstream error", status: upstream.status, details: raw });

  const content = raw?.choices?.[0]?.message?.content;
  let parsed = null;
  try {
    parsed = typeof content === "string" ? JSON.parse(content) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") return json(502, { error: "Model output is not valid JSON", content });

  return json(200, parsed);
};

