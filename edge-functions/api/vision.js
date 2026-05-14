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

/** 便签/清单里「土菜馆」等分类词，不作为独立 POI；顿号并列的店名则拆成多条 */
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
    "【提炼与过滤（重要）】",
    "- text：写**经提炼的正文**，不是把界面上的字逐行照抄。去掉：无意义的 UI 文案（如“点赞收藏”“关注”“展开全文”“点击查看更多”“直播中”等）、重复堆叠的 hashtag、纯表情、与地点/攻略无关的口播套话；保留：店名/景点名、地址片段、价格人均、排队/预约提示、营业时间、推荐理由、路线关键句等**对收藏与检索有用**的信息。可换行，控制在约 1200 字以内（超出可截断）。",
    "- title：<=26 字，用**具体主题**概括（例如“杭州某店｜排队与必点”），不要用“截图”“抖音”等空泛词。",
    "- city：从正文/定位条/话题/地图信息综合判断；无把握填“未知”。若与 cityHint 冲突，以截图证据为准。",
    "- interests：全文层面 1~4 个兴趣标签；与 categoryTags 可重叠；无把握用 [\"未分类\"]。",
    "【places：可检索 POI；便签清单要「拆店」】",
    "- 每个元素对应**可在地图/点评里检索的命名实体**：餐厅/咖啡馆/景点/乐园/酒店/商场内具体店铺名等。",
    "- **抖音/小红书常见「便利贴 + 分类 + 多家店」**：如「土菜馆」下列「老盐渎、华燕土菜」，**分类词只写入 categoryTags（或 interests），不要作为 name**；**每个店名必须单独一条 places**，不得只输出第一个店名。",
    "- 同一行用 **顿号、逗号、分号、换行** 并列多个店名时，必须输出**多条** places（例：「香辣川味王、谢师傅、川江鱼、本素」→ 4 条）。",
    "- 「宁精勿滥」指过滤**界面噪声/UI 套话**，不是省略便签里**已写明的真实店名**；此类截图应在 24 条上限内**尽量列全**可见店名。",
    "- 不要把**单独一条路名**当成一个 place（除非截图主旨就是该路段导航且无法落到具体 POI）。路名应写入对应 POI 的 road 或 addressHint。",
    "- 同一店/景点在正文里多次出现：合并为**一条** place，把补充信息写入 note/addressHint。",
    "- categoryTags：该地点类型 1~4 个（美食餐厅、咖啡甜品、旅游景点、酒店民宿、购物、拍照机位、交通攻略等）。",
    "- name：尽量标准店名/景点官方名；只有昵称时写昵称并在 note 说明。",
    "- road / district / addressHint：能拆则拆，便于后续地图检索。",
    "- note：人均、排队、预约、营业时间摘要、套餐关键词等短信息。",
    "- rawQuote：**一句**最能支撑该 place 的原文摘录（<=80 字），不要整段营销长文。",
    "- confidence：0~1，对「提炼是否正确、地点是否可靠」的综合自信度。",
    "你可能会得到这些提示：",
    `- cityHint: ${cityHint || "(none)"}`,
    `- interestHint: ${interestHint || "(none)"}`
  ].join("\n");

  const userText = [
    "请阅读整张截图：先判断内容类型（探店/攻略/地图/纯文字/分类便签清单），再做去噪与信息提炼，最后按 JSON 结构输出。",
    "若为「分类标题 + 多店名」清单：每个店名各一条 places；分类进 categoryTags；并列店名勿合并成一条。",
    "注意：只输出 JSON；text 必须是提炼后的正文，不是原始 OCR 全文。"
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

  const textRaw = typeof parsed.text === "string" ? parsed.text : "";
  const text = textRaw.length > 12000 ? textRaw.slice(0, 12000) : textRaw;
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

