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

async function readAmapKey(env) {
  if (typeof env?.AMAP_REST_KEY === "string" && env.AMAP_REST_KEY.trim()) return env.AMAP_REST_KEY.trim();
  if (typeof env?.AMAP_KEY === "string" && env.AMAP_KEY.trim()) return env.AMAP_KEY.trim();
  const kv = findKvAny({ env })?.kv;
  if (!kv) return "";
  const v =
    (await kv.get("AMAP_REST_KEY")) ||
    (await kv.get("AMAP_KEY")) ||
    (await kv.get("amap_rest_key"));
  return typeof v === "string" ? v.trim() : "";
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
    return json({
      ok: true,
      service: "img_love/amap",
      hint: "浏览器 POST JSON 到此路径；服务端需配置 AMAP_REST_KEY（高德「Web 服务」Key）。",
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
      ]
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
      const city = String(body?.city || "").trim().slice(0, 24);
      const queries = Array.isArray(body?.queries) ? body.queries : [];
      if (!queries.length) return badRequest("Missing field: queries");
      if (queries.length > 20) return badRequest("Too many queries (max 20)");

      const results = [];
      for (const q of queries) {
        const refId = String(q?.refId || "").trim().slice(0, 64);
        const keywords = String(q?.keywords || "").trim().slice(0, 96);
        if (!keywords) {
          results.push({ refId, ok: false, reason: "empty_keywords" });
          continue;
        }
        const url = buildUrl("/v3/place/text", {
          key,
          keywords,
          city: city && city !== "未知" && city !== "全部" ? city : "",
          citylimit: city && city !== "未知" && city !== "全部" ? "true" : "false",
          offset: 3,
          page: 1,
          extensions: "base"
        });
        const { ok, data } = await fetchJson(url);
        if (!ok) {
          results.push({ refId, ok: false, reason: "http", details: data });
          continue;
        }
        if (String(data?.status) !== "1") {
          results.push({ refId, ok: false, reason: "amap", info: data?.info, infocode: data?.infocode });
          continue;
        }
        const top = Array.isArray(data?.pois) ? data.pois.slice(0, 3) : [];
        if (!top.length) {
          results.push({ refId, ok: false, reason: "no_results" });
          continue;
        }
        const pois = top.map((p) => ({
          id: String(p?.id || "").trim(),
          name: String(p?.name || "").trim(),
          address: String(p?.address || "").trim(),
          cityname: String(p?.cityname || "").trim(),
          adname: String(p?.adname || "").trim(),
          typecode: String(p?.typecode || "").trim(),
          location: String(p?.location || "").trim()
        }));
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
            location: String(first?.location || "").trim()
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
