import { parsePlaceTemplate, validateCapabilities, verifyGrantEvent } from "@placeschema/protocol";

export const VERSION = "0.1.0";

// ponytail: fixed allowlist; outsider URLs wait for PS265's fetch protection.
export const KNOWN_ORIGINS = new Set([
  "https://hub.placeschema.com",
  "https://shop.placeschema.com",
  "https://forge.placeschema.com",
  "https://voxel.placeschema.com",
]);

const MAX_BODY = 64 * 1024; // bytes
const MAX_FETCHED = 256 * 1024; // bytes
// ponytail: place.md heading regex in the protocol parser is quadratic (PLACE-769); 32 KB bounds it until it is fixed upstream.
const MAX_PLACE_MD = 32 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const HEX64 = /^[0-9a-f]{64}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bad = (error: string, status = 400) => json({ error }, status);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Read a body as text, stopping as soon as it passes `max` bytes. `null` = too large. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) (all.set(c, at), (at += c.byteLength));
  return new TextDecoder().decode(all);
}

/** Is `grant` (a signed 30080 Nostr event) genuine, and who holds it? Offline, deterministic. */
export function verifyGrantRequest(body: any) {
  if (!body?.grant || typeof body.grant !== "object") return { status: 400, body: { error: "grant (a signed kind-30080 event) is required" } };
  const v = verifyGrantEvent(body.grant);
  if (body.holder !== undefined && typeof body.holder !== "string") return { status: 400, body: { error: "holder must be a 64-hex pubkey string" } };
  if (typeof body.holder === "string" && !HEX64.test(body.holder.toLowerCase())) {
    return { status: 400, body: { error: "holder must be a 64-hex pubkey string" } };
  }
  if (!v.ok) return { status: 200, body: { valid: false, reason: v.reason } };
  if (typeof body.holder === "string" && body.holder.toLowerCase() !== v.holder) {
    return { status: 200, body: { valid: false, reason: "grant is held by a different key", holder: v.holder } };
  }
  const t = v.template;
  return {
    status: 200,
    body: { valid: true, holder: v.holder, minter: v.minter, item: v.x, type: t.type, label: t.label, sources: t.sources ?? [] },
  };
}

type Fetched = { ok: true; text: string } | { ok: false; absent: boolean; why: string };

/** Fail closed: only a plain 404 is "absent"; any other failure, a redirect or an oversize body is an error. */
async function fetchText(url: string, max = MAX_FETCHED): Promise<Fetched> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual" });
  if (res.status === 404) return (await res.body?.cancel().catch(() => {}), { ok: false, absent: true, why: "not served" });
  if (!res.ok) return (await res.body?.cancel().catch(() => {}), { ok: false, absent: false, why: `could not be read (${res.status})` });
  const text = await readCapped(res.body, max);
  if (text === null) return { ok: false, absent: false, why: "too large" };
  return { ok: true, text };
}

/** Is `url` a live place with a valid manifest and place.md, and what does it accept? */
export async function verifyPlaceRequest(body: any) {
  let origin: string;
  try {
    origin = new URL(body?.url).origin;
  } catch {
    return { status: 400, body: { error: "url is required" } };
  }
  if (!KNOWN_ORIGINS.has(origin)) {
    return { status: 422, body: { error: "only known PlaceSchema origins are checked in v1", known: [...KNOWN_ORIGINS] } };
  }
  const problems: string[] = [];
  let accepts: unknown;
  let place: string | undefined;
  let placeMd: "ok" | "absent" | "error" = "error";
  try {
    const [manifest, md] = await Promise.all([
      fetchText(`${origin}/.well-known/placeschema.json`),
      fetchText(`${origin}/.well-known/place.md`, MAX_PLACE_MD),
    ]);
    if (!manifest.ok) problems.push(`placeschema.json: ${manifest.why}`);
    else {
      try {
        const caps = validateCapabilities(JSON.parse(manifest.text));
        accepts = caps.accepts;
        place = caps.place;
      } catch (e) {
        problems.push(`placeschema.json: ${message(e)}`);
      }
    }
    placeMd = md.ok ? "ok" : md.absent ? "absent" : "error";
    if (md.ok) {
      try {
        parsePlaceTemplate(md.text);
      } catch (e) {
        problems.push(`place.md: ${message(e)}`);
      }
    } else if (!md.absent) problems.push(`place.md: ${md.why}`); // a missing place.md is allowed; a broken one is not
  } catch (e) {
    return { status: 200, body: { valid: false, live: false, origin, problems: ["unreachable"] } };
  }
  return { status: 200, body: { valid: problems.length === 0, live: true, origin, place, placeMd, accepts, problems } };
}

export type Env = { LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> }; BUILD_COMMIT?: string };

const CACHE_SECONDS = 300;
let warned = false;

/** Fail open: a broken or missing limiter must never turn into a 5xx or a block. */
async function limited(req: Request, env: Env): Promise<boolean> {
  if (!env.LIMITER) {
    if (!warned) (warned = true, console.error("LIMITER binding missing; rate limiting is off"));
    return false;
  }
  try {
    return !(await env.LIMITER.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" })).success;
  } catch (e) {
    if (!warned) (warned = true, console.error("rate limiter failed; failing open", e));
    return false;
  }
}

/** Cache successful verify-place results per origin (the only part of the url that is fetched). */
async function cachedPlace(body: any): Promise<{ status: number; body: any }> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  let key: Request | undefined;
  try {
    key = new Request(`https://cache.invalid/verify-place?o=${encodeURIComponent(new URL(body?.url).origin)}`);
  } catch {}
  if (cache && key) {
    try {
      const hit = await cache.match(key);
      if (hit) return { status: 200, body: await hit.json() };
    } catch {}
  }
  const out = await verifyPlaceRequest(body);
  if (cache && key && out.status === 200 && (out.body as any).valid === true) {
    try {
      await cache.put(key, new Response(JSON.stringify(out.body), { headers: { "cache-control": `max-age=${CACHE_SECONDS}` } }));
    } catch {}
  }
  return out;
}

export async function handle(req: Request, env: Env = {}): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/v1/version") return json({ service: "placeschema", name: "placeschema-verify", version: VERSION, commit: env.BUILD_COMMIT ?? "" });
    if (req.method === "GET" && pathname === "/v1/health") return json({ ok: true, status: "ok" });
    if (req.method === "POST" && pathname.startsWith("/v1/") && (await limited(req, env))) {
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
    }
    const route = { "/v1/verify-grant": verifyGrantRequest, "/v1/verify-place": cachedPlace }[pathname];
    if (!route) return bad("not found", 404);
    if (req.method !== "POST") return bad("use POST with a JSON body", 405);
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY) return bad("body too large", 413);
    const text = await readCapped(req.body, MAX_BODY);
    if (text === null) return bad("body too large", 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return bad("body must be JSON");
    }
    try {
      const out = await route(body);
      return json(out.body, out.status);
    } catch (e) {
      console.error("verify failed", e);
      return bad("could not verify this request", 422); // never 5xx on caller input, and never echo internals
    }
}
