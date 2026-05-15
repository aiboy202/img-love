const AMAP_REST_BASE = "https://restapi.amap.com";

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...headers
    }
  });
}

function badRequest(message) {
  return json({ error: message }, { status: 400 });
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

function normalizeSecretString(s) {
  if (typeof s !== "string") return "";
  return s.replace(/^\uFEFF/, "").replace(/[\r\n]/g, "").trim();
}

/** 同一项目可能绑定多个 KV；需在每一个里尝试读取高德 Key */
function collectKvNamespaces(env) {
  const out = [];
  const seen = new Set();
  if (env && typeof env === "object") {
    for (const v of Object.values(env)) {
      if (isKvNamespace(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  try {
    for (const k of Object.getOwnPropertyNames(globalThis)) {
      if (k.length > 64) continue;
      const v = globalThis[k];
      if (isKvNamespace(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

async function readAmapKeyFromOneKv(kv) {
  if (!kv) return "";
  const tryKeys = [
    "AMAP_REST_KEY",
    "AMAP_KEY",
    "amap_rest_key",
    "amap-rest-key",
    "AMAP_WEB_KEY",
    "AMAP_WEB_SERVICE_KEY",
    "GAODE_REST_KEY",
    "GAODE_KEY",
    "GD_REST_KEY",
    "gd_key",
    "amap_key",
    "AMAPKEY"
  ];
  for (const kn of tryKeys) {
    const variants = [kn, kn.toLowerCase(), kn.replace(/_/g, "-").toLowerCase()];
    for (const k of variants) {
      const raw = await kv.get(k);
      const v = normalizeSecretString(typeof raw === "string" ? raw : "");
      if (v) return v;
    }
  }
  return "";
}

/** probe 用：列出 KV 中已有键名（不含值），便于核对是否写错键名 */
async function sampleKvKeyNames(kv, maxKeys) {
  if (!kv || typeof kv.list !== "function") return [];
  const cap = Math.min(80, Math.max(1, maxKeys || 50));
  const names = [];
  try {
    let cursor;
    while (names.length < cap) {
      const page = await kv.list({ limit: Math.min(100, cap - names.length), ...(cursor ? { cursor } : {}) });
      const keys = Array.isArray(page?.keys) ? page.keys : [];
      for (const row of keys) {
        const n = row?.name;
        if (typeof n === "string" && n.trim()) names.push(n.trim());
      }
      if (page?.list_complete || !page?.cursor) break;
      cursor = page.cursor;
    }
  } catch {
    return names.slice(0, cap);
  }
  return names.slice(0, cap);
}

/** probe：不返回值，只判断 KV 里常见键是否存在 + list 是否正常 */
async function probeKvBinding(kv) {
  const out = {};
  if (!kv || typeof kv.get !== "function") {
    out.kvBindingGetMissing = true;
    return out;
  }
  try {
    const bm = await kv.get("BIGMODEL_API_KEY");
    const bm2 = await kv.get("bigmodel_api_key");
    out.bigmodelKeyPresentInKv = Boolean(
      (typeof bm === "string" && normalizeSecretString(bm)) || (typeof bm2 === "string" && normalizeSecretString(bm2))
    );
    const ak = await kv.get("AMAP_REST_KEY");
    out.amapRestKeyPresentDirectGet = typeof ak === "string" && Boolean(normalizeSecretString(ak));

    if (typeof kv.list === "function") {
      const page = await kv.list({ limit: 30 });
      out.kvListFirstPageCount = Array.isArray(page?.keys) ? page.keys.length : -1;
      out.kvListComplete = Boolean(page?.list_complete);
      out.kvListHasMore = Boolean(page?.cursor);
    } else {
      out.kvListUnsupported = true;
    }
  } catch (e) {
    out.kvProbeError = String(e?.message || e);
  }
  return out;
}

async function readAmapKey(env) {
  const fromEnv =
    normalizeSecretString(typeof env?.AMAP_REST_KEY === "string" ? env.AMAP_REST_KEY : "") ||
    normalizeSecretString(typeof env?.AMAP_KEY === "string" ? env.AMAP_KEY : "");
  if (fromEnv) return fromEnv;
  for (const kv of collectKvNamespaces(env)) {
    const v = await readAmapKeyFromOneKv(kv);
    if (v) return v;
  }
  return "";
}

async function fetchJson(url) {
  const res = await fetch(url, { method: "GET" });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, status: res.status, data };
  }
  return { ok: true, status: res.status, data };
}

function buildUrl(path, params) {
  const u = new URL(path, AMAP_REST_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function parseLngLat(s) {
  if (!s || typeof s !== "string") return null;
  const parts = s.split(",").map((x) => Number(String(x).trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return { lng: parts[0], lat: parts[1] };
}

function hasValidAmapLocation(loc) {
  return parseLngLat(String(loc || "").trim()) != null;
}

function mergePolylines(steps) {
  const out = [];
  if (!Array.isArray(steps)) return out;
  for (const st of steps) {
    const pl = st?.polyline;
    if (!pl || typeof pl !== "string") continue;
    for (const chunk of pl.split(";")) {
      const p = parseLngLat(chunk);
      if (p) out.push(p);
    }
  }
  return out;
}

/** 关键字检索的 city：高德对「盐城」常比「盐城市」更稳 */
function normalizeAmapTextCity(city) {
  let c = String(city || "")
    .trim()
    .replace(/^(全部|未知)$/u, "");
  if (!c) return "";
  if (/市$/u.test(c)) {
    const s = c.replace(/市$/u, "").trim();
    if (s.length >= 2) return s.slice(0, 24);
  }
  return c.slice(0, 24);
}

function parseBizExtObject(p) {
  const raw = p?.biz_ext;
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** 同名多结果时：评分优先，其次有电话、人均略高（作弱代理「人气」；高德未提供开业年限） */
function rankPoisForDefaultPick(pois) {
  const scored = (pois || []).map((p, idx) => {
    const biz = parseBizExtObject(p) || {};
    const r = Number(String(biz.rating ?? biz.star ?? "").trim());
    const rating = Number.isFinite(r) ? r : -1;
    const cost = Number(String(biz.cost ?? "").trim());
    const costN = Number.isFinite(cost) ? cost : 0;
    const hasTel = String(p?.tel || "").trim().length > 5 ? 1 : 0;
    return { p, rating, hasTel, costN, idx };
  });
  scored.sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (b.hasTel !== a.hasTel) return b.hasTel - a.hasTel;
    if (b.costN !== a.costN) return b.costN - a.costN;
    return a.idx - b.idx;
  });
  return scored.map((x) => x.p);
}

function mapPoiForClient(p) {
  const biz = parseBizExtObject(p) || {};
  const r = Number(String(biz.rating ?? "").trim());
  const out = {
    id: String(p?.id || "").trim(),
    name: String(p?.name || "").trim(),
    address: String(p?.address || "").trim(),
    cityname: String(p?.cityname || "").trim(),
    adname: String(p?.adname || "").trim(),
    typecode: String(p?.typecode || "").trim(),
    location: String(p?.location || "").trim()
  };
  if (Number.isFinite(r)) out.rating = r;
  return out;
}

export default async function onRequest(context) {
  const { request } = context;
  const env = context?.env || {};

  if (request.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400"
      }
    });
  }

  if (request.method === "GET") {
    const urlObj = new URL(request.url);
    let probe = null;
    if (urlObj.searchParams.get("probe") === "1") {
      const kvs = collectKvNamespaces(env);
      const k = await readAmapKey(env);
      let kvKeyNamesSample = [];
      let kvListError = null;
      let bindingProbe = null;
      if (!k && kvs.length) {
        bindingProbe = {
          bigmodelInEnv: Boolean(normalizeSecretString(typeof env?.BIGMODEL_API_KEY === "string" ? env.BIGMODEL_API_KEY : "")),
          amapInEnv: Boolean(normalizeSecretString(typeof env?.AMAP_REST_KEY === "string" ? env.AMAP_REST_KEY : "")),
          kvNamespacesProbed: kvs.length,
          bigmodelKeyPresentInAnyKv: false,
          amapRestKeyPresentDirectGetInAnyKv: false,
          kvListFirstPageCountMax: -1,
          kvListUnsupportedEverywhere: true
        };
        for (const kv of kvs) {
          const p = await probeKvBinding(kv);
          if (p.bigmodelKeyPresentInKv) bindingProbe.bigmodelKeyPresentInAnyKv = true;
          if (p.amapRestKeyPresentDirectGet) bindingProbe.amapRestKeyPresentDirectGetInAnyKv = true;
          if (typeof p.kvListFirstPageCount === "number" && p.kvListFirstPageCount >= 0) {
            bindingProbe.kvListFirstPageCountMax = Math.max(bindingProbe.kvListFirstPageCountMax, p.kvListFirstPageCount);
          }
          if (!p.kvListUnsupported) bindingProbe.kvListUnsupportedEverywhere = false;
          if (p.kvProbeError && !bindingProbe.kvProbeError) bindingProbe.kvProbeError = p.kvProbeError;
          if (p.kvBindingGetMissing) bindingProbe.someKvBindingInvalid = true;
        }
        try {
          const seen = new Set();
          for (const kv of kvs) {
            const chunk = await sampleKvKeyNames(kv, 50);
            for (const n of chunk) {
              if (seen.has(n)) continue;
              seen.add(n);
              kvKeyNamesSample.push(n);
              if (kvKeyNamesSample.length >= 60) break;
            }
            if (kvKeyNamesSample.length >= 60) break;
          }
        } catch (e) {
          kvListError = String(e?.message || e);
        }
      }
      let fixHint =
        "未在 KV 中读到高德 Key。请在当前 Worker 已绑定的 KV 命名空间里新增键名 **AMAP_REST_KEY**（值=高德开放平台「Web服务」Key，不要引号、不要换行）。也可在 Pages/Worker「环境变量」里直接添加 AMAP_REST_KEY（不必经 KV）。";
      if (!k && bindingProbe) {
        if (bindingProbe.bigmodelInEnv && !bindingProbe.bigmodelKeyPresentInAnyKv && bindingProbe.kvListFirstPageCountMax === 0) {
          fixHint +=
            " 当前探测：BIGMODEL_API_KEY 在环境变量、所有已绑定 KV 的 list 首屏键数均为 0——该 KV 很可能**从未写入**，或写在了**控制台里另一个 KV 命名空间**（与 Worker 绑定的不一致）。请在 Workers/Pages → 本项目的 KV 绑定里点开**同一 ID** 的命名空间核对。";
        }
        if (bindingProbe.bigmodelKeyPresentInAnyKv && bindingProbe.kvListFirstPageCountMax === 0 && !bindingProbe.kvListUnsupportedEverywhere) {
          fixHint +=
            " 当前探测：KV.get 能读到 BIGMODEL_API_KEY，但 list 首屏键数为 0（少见）；仍请在控制台核对并新增 AMAP_REST_KEY。";
        }
        if (bindingProbe.amapRestKeyPresentDirectGetInAnyKv) {
          fixHint =
            "探测到某命名空间内 AMAP_REST_KEY 可读，但聚合读取未成功（不应发生）；请重新部署最新 amap.js 或反馈。";
        }
      }
      probe = {
        amapKeyLoaded: Boolean(k),
        amapKeyCharLength: k ? k.length : 0,
        kvBindingCount: kvs.length,
        envHasAMAP_REST_KEY: Boolean(normalizeSecretString(typeof env?.AMAP_REST_KEY === "string" ? env.AMAP_REST_KEY : "")),
        ...(!k
          ? {
              fixHint,
              triedKeyNames:
                "AMAP_REST_KEY, AMAP_KEY, AMAP_WEB_SERVICE_KEY, GAODE_KEY, amap_key 等（代码内已做多组变体尝试）"
            }
          : {}),
        ...(!k && bindingProbe ? { bindingProbe } : {}),
        ...(!k && kvs.length ? { kvKeyNamesSample } : {}),
        ...(kvListError ? { kvListError } : {})
      };
    }
    return json({
      ok: true,
      service: "img_love/amap",
      hint: "浏览器 POST JSON 到此路径；服务端需配置 AMAP_REST_KEY（高德「Web 服务」Key）。resolvePlaces 会去掉城市名末尾「市」再检索，并在无结果时放宽 citylimit。",
      selftest: "GET 加 ?probe=1 可检查 Worker 是否读到 Key（不返回 Key 内容）。KV 中键名建议 AMAP_REST_KEY；勿混入换行。",
      cors: "本接口 GET/POST/OPTIONS 均返回 Access-Control-Allow-Origin: *，便于静态页跨域调用。",
      gateway: [
        "若经 API 网关转发：须对 OPTIONS 与错误响应（4xx/5xx）同样返回 CORS 头，否则浏览器会报 Failed to fetch。",
        "与高德官方 JS 的 /_AMapService 代理无关；后者用于 _AMapSecurityConfig.serviceHost，见 https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode"
      ],
      actions: [
        "resolvePlaces — body: { action, city, queries: [{ refId, keywords }] }",
        "routeDriving — body: { action, origin, destination, waypoints? }",
        "placeText — body: { action, keywords, city?, offset? }",
        "regeo — body: { action, location }"
      ],
      ...(probe ? { probe } : {})
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "GET,POST,OPTIONS" } });
  }

  const key = await readAmapKey(env);
  if (!key) {
    return json(
      {
        error: "Missing AMAP_REST_KEY",
        hint: "在高德开放平台创建「Web 服务」类型 Key，配置为环境变量 AMAP_REST_KEY（或 AMAP_KEY / KV）。勿与 JS API Key 混用。"
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

  const action = String(body?.action || "").trim();
  if (!action) return badRequest("Missing field: action");

  try {
    if (action === "placeText") {
      const keywords = String(body?.keywords || "").trim().slice(0, 96);
      const city = String(body?.city || "").trim().slice(0, 24);
      if (!keywords) return badRequest("Missing field: keywords");
      const url = buildUrl("/v3/place/text", {
        key,
        keywords,
        city: city && city !== "未知" && city !== "全部" ? city : "",
        citylimit: city && city !== "未知" && city !== "全部" ? "true" : "false",
        offset: Math.min(10, Math.max(1, Number(body?.offset) || 5)),
        page: 1,
        extensions: "base"
      });
      const { ok, data } = await fetchJson(url);
      if (!ok) return json({ error: "Amap HTTP error", details: data }, { status: 502 });
      if (String(data?.status) !== "1") {
        return json({ error: data?.info || "Amap business error", infocode: data?.infocode, raw: data }, { status: 502 });
      }
      const pois = Array.isArray(data?.pois)
        ? data.pois.map((p) => ({
            id: String(p?.id || ""),
            name: String(p?.name || "").trim(),
            address: String(p?.address || "").trim(),
            cityname: String(p?.cityname || "").trim(),
            adname: String(p?.adname || "").trim(),
            typecode: String(p?.typecode || "").trim(),
            location: String(p?.location || "").trim()
          }))
        : [];
      return json({ ok: true, pois });
    }

    if (action === "resolvePlaces") {
      const rawCtxCity = String(body?.city || "").trim().slice(0, 24);
      const queries = Array.isArray(body?.queries) ? body.queries : [];
      if (!queries.length) return badRequest("Missing field: queries");
      if (queries.length > 20) return badRequest("Too many queries (max 20)");

      const normCtx = normalizeAmapTextCity(rawCtxCity);
      const rawOk = rawCtxCity && rawCtxCity !== "未知" && rawCtxCity !== "全部";

      const results = [];
      for (const q of queries) {
        const refId = String(q?.refId || "").trim().slice(0, 64);
        const keywords = String(q?.keywords || "").trim().slice(0, 96);
        if (!keywords) {
          results.push({ refId, ok: false, reason: "empty_keywords" });
          continue;
        }

        const attempts = [];
        if (normCtx) attempts.push({ city: normCtx, citylimit: true, tag: "city_norm" });
        if (rawOk && rawCtxCity !== normCtx) attempts.push({ city: rawCtxCity, citylimit: true, tag: "city_raw" });
        if (normCtx || rawOk) attempts.push({ city: normCtx || rawCtxCity, citylimit: false, tag: "citylimit_off" });
        attempts.push({ city: "", citylimit: false, tag: "no_city" });

        let best = null;
        let lastFail = null;
        for (const att of attempts) {
          const url = buildUrl("/v3/place/text", {
            key,
            keywords,
            city: att.city || "",
            citylimit: att.citylimit ? "true" : "false",
            offset: 10,
            page: 1,
            extensions: "all"
          });
          const { ok, data } = await fetchJson(url);
          if (!ok) {
            lastFail = { reason: "http", details: data };
            continue;
          }
          if (String(data?.status) !== "1") {
            lastFail = { reason: "amap", info: data?.info, infocode: data?.infocode };
            continue;
          }
          const list = Array.isArray(data?.pois) ? data.pois : [];
          if (!list.length) {
            lastFail = { reason: "no_results", tryTag: att.tag };
            continue;
          }
          const withLoc = list.filter((p) => hasValidAmapLocation(p?.location));
          const usable = withLoc.length ? withLoc : list;
          if (!usable.some((p) => hasValidAmapLocation(p?.location))) {
            lastFail = { reason: "no_valid_location", tryTag: att.tag, poiCount: list.length };
            continue;
          }
          best = usable;
          break;
        }

        if (!best || !best.length) {
          results.push({ refId, ok: false, ...(lastFail || { reason: "no_results" }) });
          continue;
        }

        const ranked = rankPoisForDefaultPick(best);
        const pois = ranked.slice(0, 3).map(mapPoiForClient).filter((p) => hasValidAmapLocation(p.location));
        if (!pois.length) {
          results.push({ refId, ok: false, reason: "no_valid_location_after_map" });
          continue;
        }
        const first = pois[0];
        results.push({
          refId,
          ok: true,
          pick: {
            id: String(first?.id || "").trim(),
            name: String(first?.name || "").trim(),
            address: String(first?.address || "").trim(),
            cityname: String(first?.cityname || "").trim(),
            adname: String(first?.adname || "").trim(),
            typecode: String(first?.typecode || "").trim(),
            location: String(first?.location || "").trim(),
            ...(typeof first?.rating === "number" ? { rating: first.rating } : {})
          },
          pois
        });
      }
      return json({ ok: true, results });
    }

    if (action === "routeDriving") {
      const origin = String(body?.origin || "").trim();
      const destination = String(body?.destination || "").trim();
      const waypoints = typeof body?.waypoints === "string" ? body.waypoints.trim() : "";
      if (!origin || !destination) return badRequest("Missing origin/destination (lng,lat)");
      const url = buildUrl("/v3/direction/driving", {
        key,
        origin,
        destination,
        ...(waypoints ? { waypoints } : {}),
        extensions: "all"
      });
      const { ok, data } = await fetchJson(url);
      if (!ok) return json({ error: "Amap HTTP error", details: data }, { status: 502 });
      if (String(data?.status) !== "1") {
        return json({ error: data?.info || "route error", infocode: data?.infocode, raw: data }, { status: 502 });
      }
      const route = data?.route?.paths?.[0];
      if (!route) return json({ error: "No route path", raw: data }, { status: 502 });
      const steps = route?.steps || [];
      const path = mergePolylines(steps);
      return json({
        ok: true,
        distance: Number(route?.distance) || 0,
        duration: Number(route?.duration) || 0,
        tolls: Number(route?.tolls) || 0,
        path
      });
    }

    if (action === "regeo") {
      const location = String(body?.location || "").trim();
      if (!location) return badRequest("Missing location (lng,lat)");
      const url = buildUrl("/v3/geocode/regeo", {
        key,
        location,
        radius: 200,
        extensions: "base"
      });
      const { ok, data } = await fetchJson(url);
      if (!ok) return json({ error: "Amap HTTP error", details: data }, { status: 502 });
      if (String(data?.status) !== "1") {
        return json({ error: data?.info || "regeo error", infocode: data?.infocode, raw: data }, { status: 502 });
      }
      const comp = data?.regeocode?.addressComponent || {};
      const city = String(comp.city || comp.province || "").trim();
      return json({ ok: true, city: city || "", formatted: String(data?.regeocode?.formatted_address || "").trim() });
    }

    return badRequest(`Unknown action: ${action}`);
  } catch (e) {
    return json({ error: "Unhandled exception", message: String(e?.message || e) }, { status: 500 });
  }
}
