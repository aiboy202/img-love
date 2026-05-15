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

function safeJsonParse(s) {
  if (typeof s !== "string") return null;
  let t = s.trim();
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

/** 模型仍把「土菜馆」等当 name 或漏拆时，从 text 里按便签清单规则捞店名 */
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
  if (!out.length) {
    const shopRe = /[\u4e00-\u9fa5]{2,14}(?:店|馆|餐厅|酒楼|面馆|小吃|火锅|烧烤|咖啡|奶茶|料理|食堂)/g;
    let m;
    while ((m = shopRe.exec(text)) !== null) {
      const t = m[0].trim();
      if (!isUsablePoiName(t)) continue;
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
  if (goodRows.length >= 3 && goodRows.every((p) => String(p?.name || "").trim().length >= 2)) return places;

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
    "你是截图 OCR + 地点结构化助手。第一优先级：把图中**所有可见汉字**抄进 text（保留换行），text 禁止为空。",
    "第二优先级：从 text 抽取可地图搜索的 POI 到 places。只输出 JSON（无 Markdown）。",
    "JSON：{ title, city, interests, text, confidence, places[] }；Place={ categoryTags, name, road, district, addressHint, note, rawQuote }。",
    "手写便签/菜单：逐行抄录；店名/码头/景点各一条 places；「川菜、凉菜」等栏目词仅进 categoryTags。",
    "title≤26 字；city 无把握填「未知」；interests 1~4 个。",
    `- cityHint: ${cityHint || "(none)"}`,
    `- interestHint: ${interestHint || "(none)"}`
  ].join("\n");

  const userText = ["请逐字抄录图中可见中文到 text，再输出 places。只输出 JSON。"].join("\n");

  const payload = {
    model,
    stream: false,
    temperature: 0.22,
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

  const content = extractBigModelMessageContent(raw?.choices?.[0]?.message);
  const parsed = content ? safeJsonParse(content) : null;
  if (!parsed || typeof parsed !== "object") {
    return json({ error: "Model output is not valid JSON", model, content }, { status: 502 });
  }

  let textRaw = typeof parsed.text === "string" ? parsed.text : "";
  if (!textRaw.trim() && typeof content === "string" && content.length > 20 && content.length < 20000) {
    textRaw = content;
  }
  let text = textRaw.length > 12000 ? textRaw.slice(0, 12000) : textRaw;
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

  if (!String(text || "").trim()) {
    const bits = [];
    for (const pl of places) {
      if (pl.name) bits.push(String(pl.name).trim());
      if (pl.rawQuote) bits.push(String(pl.rawQuote).trim());
    }
    if (bits.length) text = [...new Set(bits.filter(Boolean))].join("\n").slice(0, 12000);
  }

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

