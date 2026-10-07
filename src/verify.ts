import { parsePlaceTemplate, validateCapabilities, verifyGrantEvent } from "@placeschema/protocol";

export const VERSION = "0.1.0";

// ponytail: fixed allowlist; outsider URLs wait for PS265's fetch protection.
export const KNOWN_ORIGINS = new Set([
  "https://hub.placeschema.com",
  "https://shop.placeschema.com",
  "https://forge.placeschema.com",
  "https://voxel.placeschema.com",
]);

const MAX_BODY = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bad = (error: string, status = 400) => json({ error }, status);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Is `grant` (a signed 30080 Nostr event) genuine, and who holds it? Offline, deterministic. */
export function verifyGrantRequest(body: any) {
  if (!body?.grant || typeof body.grant !== "object") return { status: 400, body: { error: "grant (a signed kind-30080 event) is required" } };
  const v = verifyGrantEvent(body.grant);
  if (!v.ok) return { status: 200, body: { valid: false, reason: v.reason } };
  if (typeof body.holder === "string" && body.holder !== v.holder) {
    return { status: 200, body: { valid: false, reason: "grant is held by a different key", holder: v.holder } };
  }
  const t = v.template;
  return {
    status: 200,
    body: { valid: true, holder: v.holder, minter: v.minter, item: v.x, type: t.type, label: t.label, sources: t.sources ?? [] },
  };
}

async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual" });
  if (!res.ok) return null;
  const text = await res.text();
  return text.length > 256 * 1024 ? null : text;
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
  try {
    const manifest = await fetchText(`${origin}/.well-known/placeschema.json`);
    if (manifest === null) problems.push("placeschema.json: not served");
    else {
      try {
        const caps = validateCapabilities(JSON.parse(manifest));
        accepts = caps.accepts;
        place = caps.place;
      } catch (e) {
        problems.push(`placeschema.json: ${message(e)}`);
      }
    }
    const md = await fetchText(`${origin}/.well-known/place.md`);
    if (md !== null) {
      try {
        parsePlaceTemplate(md);
      } catch (e) {
        problems.push(`place.md: ${message(e)}`);
      }
    }
  } catch (e) {
    return { status: 200, body: { valid: false, live: false, origin, problems: [`unreachable: ${message(e)}`] } };
  }
  return { status: 200, body: { valid: problems.length === 0, live: true, origin, place, accepts, problems } };
}

export async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/v1/version") return json({ name: "placeschema-verify", version: VERSION });
    if (req.method === "GET" && pathname === "/v1/health") return json({ ok: true });
    const route = { "/v1/verify-grant": verifyGrantRequest, "/v1/verify-place": verifyPlaceRequest }[pathname];
    if (!route) return bad("not found", 404);
    if (req.method !== "POST") return bad("use POST with a JSON body", 405);
    const text = await req.text();
    if (text.length > MAX_BODY) return bad("body too large", 413);
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
      return bad(message(e), 422); // never 5xx on caller input
    }
}
