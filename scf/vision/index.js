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

function json(statusCode, data, extraHeaders = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return {
    isBase64Encoded: false,
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
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
  const method = getHttpMethod(event);

  if (method === "OPTIONS") return json(204, "");
  if (method === "GET") {
    return json(200, {
      ok: true,
      service: "img_love/vision",
      hint: "POST JSON：{ imageDataUrl, cityHint?, interestHint?, model? }；需配置 BIGMODEL_API_KEY"
    });
  }
  if (method !== "POST") {
    return json(405, { error: "Method Not Allowed", method: method || "(empty)" }, { Allow: "GET,POST,OPTIONS" });
  }

  const apiKey = process.env.BIGMODEL_API_KEY;
  if (!apiKey) return json(500, { error: "Missing env: BIGMODEL_API_KEY" });

  const bodyStr = getBodyString(event);
  let body = null;
  if (bodyStr) {
    try {
      body = JSON.parse(bodyStr);
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
  } else if (event?.body && typeof event.body === "object") {
    body = event.body;
  } else {
    return json(400, { error: "Missing request body" });
  }

  const imageDataUrl = String(body?.imageDataUrl || "").trim();
  if (!imageDataUrl.startsWith("data:image/")) {
    return json(400, { error: "Missing/invalid field: imageDataUrl (data:image/*;base64,...)" });
  }

  const cityHint = typeof body?.cityHint === "string" ? body.cityHint.trim() : "";
  const interestHint = typeof body?.interestHint === "string" ? body.interestHint.trim() : "";
  const model = String(process.env.BIGMODEL_VISION_MODEL || body?.model || DEFAULT_VISION_MODEL).trim();

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
}

/** 控制台「执行方法」填 main_handler 或 main 均可 */
const main_handler = async (event) => handleVision(event);
const main = main_handler;

exports.main_handler = main_handler;
exports.main = main;
