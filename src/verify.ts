import { categoryOf, parsePlaceTemplate, validateCapabilities, verifyGrantEvent } from "@placeschema/protocol";
import { npubEncode } from "nostr-tools/nip19";
import { verifyEvent } from "nostr-tools/pure";
import { OPENAPI } from "./openapi.ts";

export const VERSION = "0.1.0";

// ponytail: fixed allowlist plus our own test-world subdomains; outsider URLs wait for PS265's fetch protection.
export const KNOWN_ORIGINS = new Set(["https://hub.placeschema.com", "https://forge.placeschema.com"]);
// Test worlds are published by anyone but served from our domain; every fetch is size-, time- and redirect-capped.
const TRY_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.try\.placeschema\.com$/;
export const TRY_PATTERN = "https://<slug>.try.placeschema.com";
export const isKnownOrigin = (origin: string) => KNOWN_ORIGINS.has(origin) || TRY_ORIGIN.test(origin);

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
  if (!isKnownOrigin(origin)) {
    return { status: 422, body: { error: "only known PlaceSchema origins are checked in v1", known: [...KNOWN_ORIGINS, TRY_PATTERN] } };
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

export type Env = { LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> }; BUILD_COMMIT?: string; STASH_RELAY?: string; REGISTRAR_URL?: string };

const STASH_KIND = 30083;
const STASH_TIMEOUT_MS = 7_000;
const STASH_NOTE = "self-reported by the holder; grant not verified";
const REGISTRAR_URL = "https://panel.placeschema.com";
const MAX_REGISTRAR_FETCHES = 20;
const MAX_REGISTRAR_BODY = 16 * 1024;
type Receipt = { id: string; kind: number; pubkey: string; created_at: number; tags: string[][]; content: string; sig: string };

function receiptTag(ev: Receipt, name: string): string | undefined {
  return ev.tags.find((tag) => tag[0] === name && typeof tag[1] === "string")?.[1];
}

/** A relay response is untrusted; only signed receipts from the requested holder can enter the result. */
async function readStashReceipts(holder: string, relay: string): Promise<Receipt[]> {
  const url = new URL(relay);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("invalid relay URL");
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const controller = new AbortController();
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<Receipt[]>(async (resolve, reject) => {
        try {
          const response = await fetch(url.toString(), { headers: { Upgrade: "websocket" }, signal: controller.signal });
          socket = (response as Response & { webSocket?: WebSocket }).webSocket;
          if (!socket) throw new Error("relay did not accept WebSocket");
          socket.accept();
          const receipts: Receipt[] = [];
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(receipts);
          };
          socket.addEventListener("message", (event) => {
            try {
              const frame = JSON.parse(String(event.data));
              if (frame[0] === "EOSE") return finish();
              if (frame[0] !== "EVENT" || frame[1] !== "stash") return;
              const ev = frame[2] as Receipt;
              if (receipts.length < 256 && ev?.kind === STASH_KIND && ev.pubkey === holder && verifyEvent(ev)) receipts.push(ev);
              if (receipts.length === 256) finish();
            } catch { /* Ignore malformed relay frames. */ }
          });
          socket.addEventListener("error", () => finish(new Error("relay WebSocket error")));
          socket.addEventListener("close", () => finish(new Error("relay closed before EOSE")));
          socket.send(JSON.stringify(["REQ", "stash", { kinds: [STASH_KIND], authors: [holder], limit: 256 }]));
        } catch (e) { reject(e); }
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("relay timed out")); }, STASH_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    try { socket?.close(); } catch {}
  }
}

/** List a holder's signed receipts and check matching grants supplied or served by the registrar. */
export async function stashRequest(body: any, env: Env = {}) {
  if (typeof body?.holder !== "string" || !HEX64.test(body.holder.toLowerCase())) {
    return { status: 400, body: { error: "holder must be a 64-hex pubkey string" } };
  }
  const holder = body.holder.toLowerCase();
  const problems: string[] = [];
  const grants = new Map<string, { minter: string; author: string; license: string }>();
  const suppliedIds = new Set<string>();
  if (body.grants !== undefined && !Array.isArray(body.grants)) return { status: 400, body: { error: "grants must be an array" } };
  const addGrant = (event: any): string | undefined => {
    const verdict = verifyGrantEvent(event);
    if (!verdict.ok) return `invalid grant: ${verdict.reason}`;
    if (verdict.holder !== holder) return `grant ${verdict.id} is held by a different key`;
    const source = verdict.template.sources?.[0];
    grants.set(verdict.id, { minter: verdict.minter, author: source?.author ?? "", license: source?.license ?? "" });
  };
  for (const supplied of body.grants ?? []) {
    if (typeof supplied?.id === "string" && HEX64.test(supplied.id)) suppliedIds.add(supplied.id);
    const problem = addGrant(supplied);
    if (problem) problems.push(problem);
  }
  let receipts: Receipt[];
  try { receipts = await readStashReceipts(holder, env.STASH_RELAY ?? "wss://nostr.placeschema.com"); }
  catch (e) { return { status: 200, body: { holder, items: [], count: 0, problems: [...problems, `relay unavailable: ${message(e)}`] } }; }
  const newest = new Map<string, Receipt>();
  for (const ev of receipts) {
    const grant = receiptTag(ev, "d");
    const status = receiptTag(ev, "status");
    if (!grant || (status !== "redeemed" && status !== "deposited")) continue;
    const previous = newest.get(grant);
    if (!previous || ev.created_at > previous.created_at || (ev.created_at === previous.created_at && ev.id > previous.id)) newest.set(grant, ev);
  }
  const selected = [...newest.entries()].sort((a, b) => b[1].created_at - a[1].created_at || b[1].id.localeCompare(a[1].id)).slice(0, 100);
  const candidates = selected.filter(([id]) => HEX64.test(id) && !suppliedIds.has(id)).slice(0, MAX_REGISTRAR_FETCHES);
  await Promise.all(candidates.map(async ([id]) => {
    try {
      const response = await fetch(`${(env.REGISTRAR_URL ?? REGISTRAR_URL).replace(/\/$/, "")}/grants/${id}`, {
        signal: AbortSignal.timeout(3_000), redirect: "manual", credentials: "omit",
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        problems.push(`grant ${id}: registrar returned ${response.status}`);
        return;
      }
      const text = await readCapped(response.body, MAX_REGISTRAR_BODY);
      if (text === null) { problems.push(`grant ${id}: registrar response too large`); return; }
      const payload = JSON.parse(text);
      const event = payload?.grant ?? payload;
      if (event?.id !== id) { problems.push(`grant ${id}: registrar id mismatch`); return; }
      const problem = addGrant(event);
      if (problem) problems.push(`grant ${id}: ${problem}`);
    } catch {
      problems.push(`grant ${id}: registrar lookup failed`);
    }
  }));
  const items = selected.map(([grant, ev]) => {
    const checked = grants.get(grant);
    return checked
      ? { grant, status: receiptTag(ev, "status"), verified: true, ...checked }
      : { grant, status: receiptTag(ev, "status"), verified: false, note: STASH_NOTE };
  });
  return { status: 200, body: { holder, items, count: items.length, problems } };
}

type Out = { status: number; body: any };
const registrar = (env: Env) => (env.REGISTRAR_URL ?? REGISTRAR_URL).replace(/\/$/, "");

/** GET from the registrar: the text, or the 502/504 to answer with. A timeout is 504; any other failure, redirect or oversize body is 502. */
async function upstream(url: string, max = MAX_REGISTRAR_BODY): Promise<{ text: string } | Out> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual", credentials: "omit" });
    if (res.status !== 200) return (await res.body?.cancel().catch(() => {}), { status: 502, body: { error: `registrar returned ${res.status}` } });
    const text = await readCapped(res.body, max);
    return text === null ? { status: 502, body: { error: "registrar response too large" } } : { text };
  } catch (e) {
    return (e as Error)?.name === "TimeoutError" ? { status: 504, body: { error: "registrar timed out" } } : { status: 502, body: { error: "registrar unreachable" } };
  }
}
async function upstreamJson(url: string): Promise<{ json: any } | Out> {
  const r = await upstream(url);
  if (!("text" in r)) return r;
  try { return { json: JSON.parse(r.text) }; } catch { return { status: 502, body: { error: "registrar returned invalid JSON" } }; }
}

const NAME = /^[a-z0-9._-]{1,64}$/;

/** Who is this player? A name or pubkey resolved through the registrar's public NIP-05 map and `/whoami`: live registrar state. */
export async function playerRequest(body: any, env: Env = {}): Promise<Out> {
  const hasName = body?.name !== undefined, hasKey = body?.pubkey !== undefined;
  if (hasName === hasKey) return { status: 400, body: { error: "send exactly one of name or pubkey" } };
  if (hasName && (typeof body.name !== "string" || !NAME.test(body.name.toLowerCase()))) return { status: 400, body: { error: "name must be 1-64 of a-z 0-9 . _ -" } };
  if (hasKey && (typeof body.pubkey !== "string" || !HEX64.test(body.pubkey.toLowerCase()))) return { status: 400, body: { error: "pubkey must be a 64-hex pubkey string" } };
  const base = registrar(env);
  let name: string | null = hasName ? body.name.toLowerCase() : null;
  const pubkey: string | null = hasKey ? body.pubkey.toLowerCase() : null;
  if (pubkey) {
    const who = await upstreamJson(`${base}/whoami?npub=${npubEncode(pubkey)}`);
    if (!("json" in who)) return who;
    name = typeof who.json?.name === "string" && NAME.test(who.json.name) ? who.json.name : null;
    if (!name) return { status: 200, body: { pubkey, name: null, verified: false, profile: {} } };
  }
  // NIP-05 forward lookup: the name's key, which must match the pubkey asked about.
  const nip = await upstreamJson(`${base}/.well-known/nostr.json?name=${encodeURIComponent(name!)}`);
  if (!("json" in nip)) return nip;
  const found = nip.json?.names?.[name!];
  const key = typeof found === "string" && HEX64.test(found) ? found : null;
  const verified = key !== null && (pubkey === null || key === pubkey);
  const relays = verified && Array.isArray(nip.json?.relays?.[key!]) ? nip.json.relays[key!].filter((r: unknown) => typeof r === "string").slice(0, 16) : [];
  return { status: 200, body: { pubkey: pubkey ?? key, name, verified, profile: verified ? { relays } : {} } };
}

/** The `- https://origin — Name` lines of a worlds.md feed (open-place tools/name-registry/src/world-catalog.ts `renderWorldCatalog`); `- ~origin` is a denial. */
function parseWorldsMd(text: string) {
  const out = new Map<string, { name?: string; denied: boolean }>();
  for (const line of text.split("\n")) {
    const m = /^- (~?)(https:\/\/\S+?)(?: — (.+?))?\s*$/.exec(line);
    if (!m) continue;
    try { if (new URL(m[2]).origin !== m[2]) continue; } catch { continue; }
    out.set(m[2], { ...(m[3] ? { name: m[3].slice(0, 80) } : {}), denied: m[1] === "~" });
    if (out.size >= 512) break;
  }
  return out;
}

/** Which worlds does this hub list, and which does it trust items from? Live registrar state. */
export async function placesRequest(body: any, env: Env = {}): Promise<Out> {
  let hub: string;
  try {
    const u = new URL(body?.hub);
    if (u.protocol !== "https:" || u.username || u.password) throw new Error();
    hub = u.origin;
  } catch {
    return { status: 400, body: { error: "hub must be an https origin" } };
  }
  const url = `${registrar(env)}/.well-known/worlds.md?hub=${encodeURIComponent(hub)}`;
  const [rings, trust] = await Promise.all([upstream(url, MAX_FETCHED), upstream(`${url}&games=1`, MAX_FETCHED)]);
  if (!("text" in rings)) return rings;
  if (!("text" in trust)) return trust;
  const listed = parseWorldsMd(rings.text), items = parseWorldsMd(trust.text);
  const worlds = [...new Set([...listed.keys(), ...items.keys()])]
    .filter((o) => !items.get(o)?.denied || listed.has(o))
    .map((origin) => {
      const name = listed.get(origin)?.name ?? items.get(origin)?.name;
      return { origin, ...(name ? { name } : {}), itemsTrusted: items.get(origin)?.denied === false };
    });
  return { status: 200, body: { hub, worlds } };
}

// Ported from open-place 66a0ba435d9 (PLACE-1136): tools/look-plan/src/caps.ts (ClientCaps, limitsFor) and
// adapters/sidecar/src/{sidecar.ts parseCaps, look.ts hiddenReason + itemLook, server.ts lookSource}. Selection only:
// planLook needs the model bytes, and the Worker never downloads or converts one, so it returns the declared candidate
// with this client's limits. limitsFor's engine bound is the game's own, so here the client's caps are the limits.
const OPEN_LOOK_LICENSES = new Set(["CC0-1.0", "CC-BY-4.0"]);
type Caps = { mesh: false | { maxBytes: number; maxVertices: number }; sprite: boolean; cuboid: boolean };
function parseCaps(raw: any): Caps | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const pos = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  let mesh: Caps["mesh"] = false;
  if (raw.mesh && typeof raw.mesh === "object") {
    if (!pos(raw.mesh.maxBytes) || !pos(raw.mesh.maxVertices)) return undefined;
    mesh = { maxBytes: raw.mesh.maxBytes, maxVertices: raw.mesh.maxVertices };
  } else if (raw.mesh === true) mesh = { maxBytes: Number.MAX_SAFE_INTEGER, maxVertices: Number.MAX_SAFE_INTEGER };
  else if (raw.mesh !== false) return undefined;
  return { mesh, sprite: raw.sprite === true, cuboid: raw.cuboid === true };
}

/** Which look should this client draw for this grant, and on which of the game's slots? */
export function lookRequest(body: any): Out {
  if (!body?.grant || typeof body.grant !== "object") return { status: 400, body: { error: "grant (a signed kind-30080 event) is required" } };
  const caps = parseCaps(body.caps);
  if (!caps) return { status: 400, body: { error: "caps must be {mesh: false | true | {maxBytes, maxVertices}, sprite?, cuboid?}" } };
  if (body.slots !== undefined && (!Array.isArray(body.slots) || body.slots.length > 64 || body.slots.some((s: unknown) => typeof s !== "string"))) {
    return { status: 400, body: { error: "slots must be an array of at most 64 strings" } };
  }
  const v = verifyGrantEvent(body.grant);
  if (!v.ok) return { status: 200, body: { look: null, standIn: null, reason: `invalid-grant: ${v.reason}` } };
  // The content is signed and hashed into the grant, so `look` (dropped by the vendored 0.1.0 validator) is still authentic.
  const t: any = { ...JSON.parse(body.grant.content), ...v.template };
  const anchors: string[] = Array.isArray(t.anchors) ? t.anchors : [];
  const slot = body.slots ? anchors.find((a) => body.slots.includes(a)) : anchors[0];
  if (!slot) return { status: 200, body: { look: null, standIn: null, reason: "no-compatible-slot" } };
  const features: string[] = Array.isArray(t.features) ? t.features.filter((f: unknown) => typeof f === "string") : [];
  const cat = categoryOf(t.type ?? "");
  const held = cat === "blade" || cat === "weapon" || anchors.some((a) => a === "grip" || a === "offhand");
  if (features.includes("visual:none")) return { status: 200, body: { look: null, standIn: null, slot, reason: "hidden: no-visual-form" } };
  if (!held && features.some((f) => f.startsWith("fits:"))) return { status: 200, body: { look: null, standIn: null, slot, reason: "hidden: unfitted" } };
  const standIn = /^[a-z0-9._-]{1,64}$/.test(t.type) ? t.type : "item";
  const generic = (reason: string) => ({ status: 200, body: { look: null, standIn, slot, reason } });
  if (!caps.mesh) return generic("client-no-mesh");
  const own = t.look?.model;
  let candidate: { url: string; sha256?: string; from: "look" | "render-asset" } | undefined;
  if (own && typeof own.url === "string" && typeof own.sha256 === "string") {
    if (!OPEN_LOOK_LICENSES.has(t.look.license)) return generic("licence");
    candidate = { url: own.url, sha256: own.sha256, from: "look" };
  } else {
    const asset = features.find((f) => f.startsWith("render-asset:"))?.slice("render-asset:".length);
    if (asset) candidate = { url: asset, from: "render-asset" };
  }
  if (!candidate) return generic("no-look");
  try { if (new URL(candidate.url).protocol !== "https:") return generic("foreign-look-untrusted"); } catch { return generic("foreign-look-untrusted"); }
  const d = t.dimensions ?? {};
  const size = Math.min(2.5, Math.max(0.2, Number(d.l) || 0, Number(d.w) || 0, Number(d.h) || 0));
  return {
    status: 200,
    body: {
      look: { ...candidate, slot, mount: { slot, size }, limits: caps.mesh },
      standIn,
      reason: "declared-not-measured: the model was not fetched; check its sha256, bytes and vertices against limits, else draw standIn",
    },
  };
}

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
    // HEAD is GET without the body; link checkers such as the POKT audit probe spec URLs with it.
    if (req.method === "HEAD") {
      const res = await handle(new Request(req.url, { method: "GET", headers: req.headers }), env);
      return new Response(null, { status: res.status, headers: res.headers });
    }
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/v1/version") return json({ service: "placeschema", name: "placeschema-verify", version: VERSION, commit: env.BUILD_COMMIT ?? "" });
    if (req.method === "GET" && pathname === "/v1/health") return json({ ok: true, status: "ok" });
    if (req.method === "GET" && pathname === "/openapi.json") return json(OPENAPI);
    if (req.method === "POST" && pathname.startsWith("/v1/") && (await limited(req, env))) {
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
    }
    const route = {
      "/v1/verify-grant": verifyGrantRequest, "/v1/verify-place": cachedPlace, "/v1/stash": (body: any) => stashRequest(body, env),
      "/v1/player": (body: any) => playerRequest(body, env), "/v1/places": (body: any) => placesRequest(body, env), "/v1/look": lookRequest,
    }[pathname];
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
