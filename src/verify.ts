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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });
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

type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };
export type Env = { LIMITER?: Limiter; LIVE_LIMITER?: Limiter; BUILD_COMMIT?: string; STASH_RELAY?: string; REGISTRAR_URL?: string };

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

/** The receipt's marker: `["e", <grant>, <relay hint>, "redeemed" | "deposited"]`, as open-place
 *  world-kit/src/game-tickets.ts `receiptTemplate` and adapters/sidecar/src/receipt.ts (cfa96a4ba) write it. */
function receiptMarker(ev: Receipt, grant: string): string | undefined {
  return ev.tags.find((tag) => tag[0] === "e" && tag[1] === grant)?.[3];
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
  const grants = new Map<string, { type: string; label: string; minter: string; author: string; license: string }>();
  const suppliedIds = new Set<string>();
  if (body.grants !== undefined && !Array.isArray(body.grants)) return { status: 400, body: { error: "grants must be an array" } };
  const addGrant = (event: any): string | undefined => {
    const verdict = verifyGrantEvent(event);
    if (!verdict.ok) return `invalid grant: ${verdict.reason}`;
    if (verdict.holder !== holder) return `grant ${verdict.id} is held by a different key`;
    const source = verdict.template.sources?.[0];
    grants.set(verdict.id, { type: verdict.template.type, label: verdict.template.label, minter: verdict.minter, author: source?.author ?? "", license: source?.license ?? "" });
  };
  for (const supplied of body.grants ?? []) {
    if (typeof supplied?.id === "string" && HEX64.test(supplied.id)) suppliedIds.add(supplied.id);
    const problem = addGrant(supplied);
    if (problem) problems.push(problem);
  }
  let receipts: Receipt[];
  try { receipts = await readStashReceipts(holder, env.STASH_RELAY ?? "wss://nostr.placeschema.com"); }
  catch (e) {
    const timedOut = message(e) === "relay timed out";
    return { status: timedOut ? 504 : 502, body: { error: timedOut ? "relay timed out" : `relay unavailable: ${message(e)}` } };
  }
  const newest = new Map<string, Receipt>();
  for (const ev of receipts) {
    const grant = receiptTag(ev, "d");
    const status = grant && receiptMarker(ev, grant);
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
      ? { grant, status: receiptMarker(ev, grant), verified: true, ...checked }
      : { grant, status: receiptMarker(ev, grant), verified: false, note: STASH_NOTE };
  });
  return { status: 200, body: { holder, items, count: items.length, problems } };
}

type Out = { status: number; body: any; headers?: Record<string, string> };
const registrar = (env: Env) => (env.REGISTRAR_URL ?? REGISTRAR_URL).replace(/\/$/, "");

/** GET from the registrar: the text, or the error to answer with. Its 400 is the caller's (400) and its 429 a 503 with
 *  `retry-after`; a timeout is 504; any other failure, redirect or oversize body is 502. */
async function upstream(url: string, max = MAX_REGISTRAR_BODY): Promise<{ text: string } | Out> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual", credentials: "omit" });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 400) return { status: 400, body: { error: "the registrar rejected this request" } };
      if (res.status === 429) {
        const after = res.headers.get("retry-after") ?? "";
        return { status: 503, body: { error: "the registrar is rate limiting; retry later" }, headers: { "retry-after": /^\d{1,5}$/.test(after) ? after : "60" } };
      }
      return { status: 502, body: { error: `registrar returned ${res.status}` } };
    }
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

/** Serve a 200 from `caches.default` for `seconds`, else run and store it. No cache (tests, local) just runs. */
async function cached(key: string, seconds: number, run: () => Promise<Out>, keep = (o: Out) => o.status === 200): Promise<Out> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const req = new Request(`https://cache.invalid/${key}`);
  if (cache) {
    try {
      const hit = await cache.match(req);
      if (hit) return { status: 200, body: await hit.json() };
    } catch {}
  }
  const out = await run();
  if (cache && keep(out)) {
    try { await cache.put(req, new Response(JSON.stringify(out.body), { headers: { "cache-control": `max-age=${seconds}` } })); } catch {}
  }
  return out;
}

// Ported from open-place 66a0ba435d9 pack/discovery/src/hosts.ts (isBlockedHost) and participation-lane.ts (bareHttpsOrigin).
function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}
function ipv4MappedBytes(rest: string): number[] | null {
  const dotted = ipv4(rest);
  if (dotted) return dotted;
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!m) return null;
  const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}
function isBlockedIpv4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 100 && b >= 64 && b <= 127);
}
/** IP literals and `localhost` that are not global unicast. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  const o = ipv4(h);
  if (o) return isBlockedIpv4(o);
  if (h.includes(":")) {
    if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
    if (h.startsWith("::ffff:")) {
      const mapped = ipv4MappedBytes(h.slice(7));
      return mapped !== null && isBlockedIpv4(mapped);
    }
  }
  return false;
}
/** A public bare HTTPS origin, as given (`https://host[:port]`, nothing after), or undefined. */
export function bareHttpsOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 1024 || !/^https:\/\/[^/?#\\\s]+$/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol !== "https:" || url.username || url.password || isBlockedHost(url.hostname) ? undefined : url.origin;
  } catch { return undefined; }
}

const NAME = /^[a-z0-9._-]{1,64}$/;
const PLAYER_CACHE_SECONDS = 60;
const PLACES_CACHE_SECONDS = 15;

/** Who is this player? A name or pubkey resolved through the registrar's public NIP-05 map and `/whoami`: live registrar state, cached 60 s. */
export async function playerRequest(body: any, env: Env = {}): Promise<Out> {
  const hasName = body?.name !== undefined, hasKey = body?.pubkey !== undefined;
  if (hasName === hasKey) return { status: 400, body: { error: "send exactly one of name or pubkey" } };
  if (hasName && (typeof body.name !== "string" || !NAME.test(body.name.toLowerCase()))) return { status: 400, body: { error: "name must be 1-64 of a-z 0-9 . _ -" } };
  if (hasKey && (typeof body.pubkey !== "string" || !HEX64.test(body.pubkey.toLowerCase()))) return { status: 400, body: { error: "pubkey must be a 64-hex pubkey string" } };
  const base = registrar(env);
  const asked: string | null = hasName ? body.name.toLowerCase() : null;
  const pubkey: string | null = hasKey ? body.pubkey.toLowerCase() : null;
  return cached(`player?${pubkey ? `pubkey=${pubkey}` : `name=${asked}`}&r=${encodeURIComponent(base)}`, PLAYER_CACHE_SECONDS, async () => {
    let name = asked;
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
  });
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

/** Which worlds does this hub list, and which does it trust items from? Live registrar state, cached 15 s per hub. */
export async function placesRequest(body: any, env: Env = {}): Promise<Out> {
  const hub = bareHttpsOrigin(body?.hub);
  if (!hub) return { status: 400, body: { error: "hub must be a public bare https origin, like https://hub.placeschema.com" } };
  const url = `${registrar(env)}/.well-known/worlds.md?hub=${encodeURIComponent(hub)}`;
  return cached(`places?u=${encodeURIComponent(url)}`, PLACES_CACHE_SECONDS, async () => {
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
  });
}

// Ported from open-place 66a0ba435d9 (PLACE-1136): tools/look-plan/src/caps.ts (ClientCaps, limitsFor),
// adapters/sidecar/src/{sidecar.ts parseCaps, look.ts hiddenReason + itemLook, server.ts lookSource + carried} and
// protocol/src/template.ts (validateLook, hashedUrl, LICENSE_ID). Selection only: planLook needs the model bytes, and the
// Worker never downloads or converts one, so it returns the declared candidate with this client's limits. limitsFor's
// engine bound is the game's own, so here the client's caps are the limits.
const OPEN_LOOK_LICENSES = new Set(["CC0-1.0", "CC-BY-4.0"]);
const LICENSE_ID = /^(LicenseRef-[A-Za-z0-9.-]+|(?!LicenseRef-)[A-Za-z0-9][A-Za-z0-9.+-]*)$/;
const MAX_APPEARANCE_URL = 512;
const MAX_LICENSE_LEN = 64;
const MAX_TRUSTED = 64;
type Hashed = { url: string; sha256: string };
type Look = { model?: Hashed; texture?: Hashed; by: "minter" | "operator"; license: string };
function hashedUrl(v: any): Hashed | undefined {
  if (!v || typeof v !== "object" || typeof v.url !== "string" || !v.url || v.url.length > MAX_APPEARANCE_URL) return undefined;
  let protocol = "";
  try { protocol = new URL(v.url).protocol; } catch {}
  if (protocol !== "https:" && protocol !== "http:") return undefined;
  return typeof v.sha256 === "string" && HEX64.test(v.sha256) ? { url: v.url, sha256: v.sha256 } : undefined;
}
/** The item's declared look, or undefined when absent or malformed (a malformed look is treated as none). */
function validLook(l: any): Look | undefined {
  if (!l || typeof l !== "object" || (l.model === undefined) === (l.texture === undefined)) return undefined;
  if (l.by !== "minter" && l.by !== "operator") return undefined;
  if (typeof l.license !== "string" || !l.license || l.license.length > MAX_LICENSE_LEN || !LICENSE_ID.test(l.license)) return undefined;
  const art = l.model !== undefined ? { model: hashedUrl(l.model) } : { texture: hashedUrl(l.texture) };
  return art.model || art.texture ? { ...art, by: l.by, license: l.license } : undefined;
}
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
/** A carried `render-asset:` is attacker-chosen: https, by name (no IP literal, userinfo or trailing dot), on a trusted origin. */
function carried(url: string, isTrusted: (origin: string) => boolean): { url: string } | { refused: string } {
  try {
    const u = new URL(url);
    const ip = /^[\d.]+$|^\[/.test(u.hostname);
    if (u.protocol === "https:" && !u.username && !u.password && !u.hostname.endsWith(".") && !ip && !isBlockedHost(u.hostname) && isTrusted(u.origin)) return { url };
  } catch { /* malformed carried asset */ }
  return { refused: "foreign-look-untrusted" };
}

/** Which look should this client draw for this grant, and on which of the game's slots? Pure: no fetch. */
export function lookRequest(body: any): Out {
  if (!body?.grant || typeof body.grant !== "object") return { status: 400, body: { error: "grant (a signed kind-30080 event) is required" } };
  const caps = parseCaps(body.caps);
  if (!caps) return { status: 400, body: { error: "caps must be {mesh: false | true | {maxBytes, maxVertices}, sprite?, cuboid?}" } };
  if (body.slots !== undefined && (!Array.isArray(body.slots) || body.slots.length > 64 || body.slots.some((s: unknown) => typeof s !== "string"))) {
    return { status: 400, body: { error: "slots must be an array of at most 64 strings" } };
  }
  let trusted: Set<string> | undefined;
  if (body.trusted !== undefined) {
    const origins = Array.isArray(body.trusted) && body.trusted.length <= MAX_TRUSTED ? body.trusted.map(bareHttpsOrigin) : [undefined];
    if (origins.includes(undefined)) return { status: 400, body: { error: `trusted must be an array of at most ${MAX_TRUSTED} public bare https origins` } };
    trusted = new Set(origins);
  }
  const isTrusted = (origin: string) => (trusted ? trusted.has(origin) : isKnownOrigin(origin));
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
  const d = t.dimensions ?? {};
  const size = Math.min(2.5, Math.max(0.2, Number(d.l) || 0, Number(d.w) || 0, Number(d.h) || 0));
  const drawn = (look: object, reason: string) => ({ status: 200, body: { look: { ...look, slot, mount: { slot, size }, limits: caps.mesh }, standIn, reason } });
  // The item's own look first; without an open one, its carried render-asset; a closed look with neither says `licence`.
  const asset = features.find((f) => f.startsWith("render-asset:"))?.slice("render-asset:".length);
  const otherwise = asset === undefined ? undefined : carried(asset, isTrusted);
  const look = validLook(t.look);
  if (look?.model && OPEN_LOOK_LICENSES.has(look.license)) {
    return drawn(
      { from: "look", sha256: look.model.sha256, license: look.license, by: look.by, minterUrl: look.model.url, ...(otherwise && "url" in otherwise ? { fallback: otherwise.url } : {}) },
      "declared-not-measured: resolve the model by sha256 on your own Blossom (minterUrl is untrusted); check its bytes and vertices against limits, else draw fallback or standIn",
    );
  }
  if (!otherwise) return generic(look?.model ? "licence" : "no-look");
  if ("refused" in otherwise) return generic(otherwise.refused);
  return drawn({ from: "render-asset", url: otherwise.url }, "declared-not-measured: the model was not fetched; check its bytes and vertices against limits, else draw standIn");
}

const CACHE_SECONDS = 300;
const warned = new Set<string>();

/** Fail open: a broken or missing limiter must never turn into a 5xx or a block. */
async function limited(req: Request, limiter: Env["LIMITER"], name: string): Promise<boolean> {
  if (!limiter) {
    if (!warned.has(name)) (warned.add(name), console.error(`${name} binding missing; rate limiting is off`));
    return false;
  }
  try {
    return !(await limiter.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" })).success;
  } catch (e) {
    if (!warned.has(name)) (warned.add(name), console.error(`${name} failed; failing open`, e));
    return false;
  }
}

/** Cache successful verify-place results per origin (the only part of the url that is fetched). */
async function cachedPlace(body: any): Promise<Out> {
  let origin: string;
  try { origin = new URL(body?.url).origin; } catch { return verifyPlaceRequest(body); }
  // Key stays "verify-place" on purpose: /v1/place and the old alias must share one cache entry.
  return cached(`verify-place?o=${encodeURIComponent(origin)}`, CACHE_SECONDS, () => verifyPlaceRequest(body), (o) => o.status === 200 && o.body?.valid === true);
}

/** Routes that read live upstream state (registrar, relay); they share the stricter LIVE_LIMITER. */
const LIVE = new Set(["/v1/player", "/v1/places", "/v1/stash"]);

/** Old names kept as aliases (the on-chain card's health probe uses /v1/verify-place). */
const ALIAS: Record<string, string> = { "/v1/verify-grant": "/v1/grant", "/v1/verify-place": "/v1/place" };

export async function handle(req: Request, env: Env = {}): Promise<Response> {
    // HEAD is GET without the body; link checkers such as the POKT audit probe spec URLs with it.
    if (req.method === "HEAD") {
      const res = await handle(new Request(req.url, { method: "GET", headers: req.headers }), env);
      return new Response(null, { status: res.status, headers: res.headers });
    }
    const raw = new URL(req.url).pathname;
    const pathname = ALIAS[raw] ?? raw; // old names route through the same handler, limiter group and cache
    if (req.method === "GET" && pathname === "/v1/version") return json({ service: "placeschema", name: "placeschema-verify", version: VERSION, commit: env.BUILD_COMMIT ?? "" });
    if (req.method === "GET" && pathname === "/v1/health") return json({ ok: true, status: "ok" });
    if (req.method === "GET" && pathname === "/openapi.json") return json(OPENAPI);
    if (req.method === "POST" && pathname.startsWith("/v1/")
      && (await (LIVE.has(pathname) ? limited(req, env.LIVE_LIMITER, "LIVE_LIMITER") : limited(req, env.LIMITER, "LIMITER")))) {
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
    }
    const route = {
      "/v1/grant": verifyGrantRequest, "/v1/place": cachedPlace, "/v1/stash": (body: any) => stashRequest(body, env),
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
      const out: Out = await route(body);
      return json(out.body, out.status, out.headers);
    } catch (e) {
      console.error("verify failed", e);
      return bad("could not verify this request", 422); // never 5xx on caller input, and never echo internals
    }
}
