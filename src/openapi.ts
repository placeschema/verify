// The public API reference, served at GET /openapi.json and linked from the POKT card's specs[].
const error = { type: "object", required: ["error"], properties: { error: { type: "string" } } };
const errors = {
  "400": { description: "Bad input: missing or malformed field, or a body that is not JSON.", content: { "application/json": { schema: error } } },
  "405": { description: "Wrong method; the call routes take POST with a JSON body.", content: { "application/json": { schema: error } } },
  "413": { description: "Body over 64 KB.", content: { "application/json": { schema: error } } },
  "422": { description: "The request could not be verified.", content: { "application/json": { schema: error } } },
  "429": {
    description: "Over the limit from one client IP: 600 POSTs per 60 s for the pure routes (look, verify-grant, verify-place) and 60 per 60 s for the live routes that read the registrar or relay (player, places, stash). Through POKT every relay arrives from its supplier's IP, so this is the cap per supplier (the whole service while there is one supplier).",
    headers: { "retry-after": { schema: { type: "string", example: "60" } } },
    content: { "application/json": { schema: error } },
  },
};
const hex64 = { type: "string", pattern: "^[0-9a-fA-F]{64}$" };
const live = {
  "400": { description: "Bad input, or the registrar rejected the request as bad input.", content: { "application/json": { schema: error } } },
  "503": { description: "The registrar is rate limiting; retry after `retry-after` seconds.", headers: { "retry-after": { schema: { type: "string", example: "60" } } }, content: { "application/json": { schema: error } } },
  "502": { description: "The registrar failed, redirected, or answered too large.", content: { "application/json": { schema: error } } },
  "504": { description: "The registrar timed out.", content: { "application/json": { schema: error } } },
};
const post = (summary: string, description: string, request: object, ok: object, extra: object = {}) => ({
  post: {
    summary, description,
    requestBody: { required: true, content: { "application/json": { schema: request } } },
    responses: { "200": { description: "Answered.", content: { "application/json": { schema: ok } } }, ...errors, ...extra },
  },
});

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "PlaceSchema verify",
    version: "0.1.0",
    description: "Verification and lookups for PlaceSchema players, items and places. JSON in and out; bad input is 4xx, never 5xx. Free. POKT service ID `placeschema` (Beta TestNet). Any unknown path is a 404 `{\"error\":\"not found\"}`; a POST under /v1/ may be rate limited (429) before that.",
    license: { name: "Apache-2.0", identifier: "Apache-2.0" },
  },
  servers: [{ url: "https://verify.placeschema.com" }],
  paths: {
    "/openapi.json": { get: { summary: "This reference", responses: { "200": { description: "The OpenAPI 3.1 document.", content: { "application/json": { schema: { type: "object" } } } } } } },
    "/v1/version": { get: { summary: "Identity", responses: { "200": { description: "Service identity.", content: { "application/json": { schema: {
      type: "object", required: ["service", "name", "version", "commit"],
      properties: { service: { const: "placeschema" }, name: { type: "string" }, version: { type: "string" }, commit: { type: "string", description: "Deployed commit; empty if unset." } },
    } } } } } } },
    "/v1/health": { get: { summary: "Liveness", responses: { "200": { description: "Up.", content: { "application/json": { schema: {
      type: "object", required: ["ok", "status"], properties: { ok: { const: true }, status: { const: "ok" } },
    } } } } } } },
    "/v1/verify-grant": post(
      "Is this signed item grant authentic?",
      "Pure and deterministic. Checks a kind-30080 Nostr grant event offline. `valid: true` means an authentic issuance by `minter` naming `holder`; it does not prove current possession or that the minter is trustworthy.",
      { type: "object", required: ["grant"], properties: { grant: { type: "object", description: "Signed kind-30080 event." }, holder: { ...hex64, description: "Optional; checked against the grant." } } },
      { oneOf: [
        { type: "object", required: ["valid", "holder", "minter", "item", "type", "label", "sources"], properties: {
          valid: { const: true }, holder: hex64, minter: hex64, item: { type: "string" }, type: { type: "string" }, label: { type: "string" },
          sources: { type: "array", items: { type: "object", properties: { author: { type: "string" }, license: { type: "string" } } } },
        } },
        { type: "object", required: ["valid", "reason"], properties: {
          valid: { const: false }, reason: { type: "string" }, holder: { ...hex64, description: "Present when the grant is genuine but held by a different key than `holder`." },
        } },
      ] },
    ),
    "/v1/verify-place": post(
      "Is this a live place, and what does it accept?",
      "Reads the place itself, not the registrar; limited with the pure routes (600 per 60 s). Fetches `/.well-known/placeschema.json` and `/.well-known/place.md` from the url's origin. v1 checks https://hub.placeschema.com, https://forge.placeschema.com and https://<slug>.try.placeschema.com only; any other origin is a 422 whose body lists them in `known`. Only a 404 place.md counts as absent; redirects, errors and oversize files (manifest 256 KB, place.md 32 KB) are problems. Successful results are cached 300 s per origin.",
      { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri", example: "https://hub.placeschema.com" } } },
      { type: "object", required: ["valid", "live", "origin", "problems"], properties: {
        valid: { type: "boolean" }, live: { type: "boolean" }, origin: { type: "string" }, place: { type: "string" },
        placeMd: { enum: ["ok", "absent", "error"] }, accepts: { type: "object", description: "Item types the place accepts, from its manifest." },
        problems: { type: "array", items: { type: "string" } },
      } },
      { "422": { description: "Origin not checked in v1, or the request could not be verified.", content: { "application/json": { schema: {
        type: "object", required: ["error"], properties: { error: { type: "string" }, known: { type: "array", items: { type: "string" } } },
      } } } } },
    ),
    "/v1/stash": post(
      "Which items does a key report as deposited or redeemed?",
      "Live: reads the relay and registrar; limited to 60 POSTs per 60 s per client IP, shared with `player` and `places`. Reads the holder's signed kind-30083 receipts from the relay (newest status per grant, at most 100 items). Receipts are self-reported; a grant is verified when the registrar serves it or it is passed in `grants`. Relay failure returns empty `items` with a problem, not an error.",
      { type: "object", required: ["holder"], properties: { holder: hex64, grants: { type: "array", items: { type: "object" }, description: "Signed kind-30080 grant events to verify." } } },
      { type: "object", required: ["holder", "items", "count", "problems"], properties: {
        holder: hex64, count: { type: "integer" }, problems: { type: "array", items: { type: "string" } },
        items: { type: "array", maxItems: 100, items: { type: "object", required: ["grant", "status", "verified"], properties: {
          grant: { type: "string" }, status: { enum: ["deposited", "redeemed"] }, verified: { type: "boolean" },
          minter: hex64, author: { type: "string" }, license: { type: "string" }, note: { type: "string" },
        } } },
      } },
    ),
    "/v1/player": post(
      "Who is this player?",
      "Live and cached: reads the registrar, and a 200 is cached 60 s per name or pubkey. Send exactly one of `name` or `pubkey`. Resolves through the registrar's public NIP-05 map (`/.well-known/nostr.json?name=`) and, for a pubkey, its reverse lookup (`/whoami`). `verified: true` means the name's NIP-05 entry names this key. `profile` holds only what the registrar serves publicly: the key's NIP-05 relays. Limited to 60 POSTs per 60 s per client IP, shared with `places` and `stash`.",
      { type: "object", properties: { name: { type: "string", pattern: "^[a-zA-Z0-9._-]{1,64}$" }, pubkey: hex64 } },
      { type: "object", required: ["pubkey", "name", "verified", "profile"], properties: {
        pubkey: { oneOf: [hex64, { type: "null" }] }, name: { type: ["string", "null"] }, verified: { type: "boolean" },
        profile: { type: "object", properties: { relays: { type: "array", items: { type: "string" } } } },
      } },
      live,
    ),
    "/v1/places": post(
      "Which worlds does a hub list, and whose items does it trust?",
      "Live and cached: reads the registrar, and a 200 is cached 15 s per hub. `hub` must be a public bare https origin (no path, no userinfo, no private or loopback address). Reads the registrar's hub feed (`/.well-known/worlds.md?hub=`) and its item-trust feed (`&games=1`). Each world says whether the hub trusts items from it; a world the hub denies item trust is listed only if it is also a portal. Limited to 60 POSTs per 60 s per client IP, shared with `player` and `stash`.",
      { type: "object", required: ["hub"], properties: { hub: { type: "string", format: "uri", example: "https://hub.placeschema.com" } } },
      { type: "object", required: ["hub", "worlds"], properties: {
        hub: { type: "string" },
        worlds: { type: "array", items: { type: "object", required: ["origin", "itemsTrusted"], properties: { origin: { type: "string" }, name: { type: "string" }, itemsTrusted: { type: "boolean" } } } },
      } },
      live,
    ),
    "/v1/look": post(
      "Which look should this client draw for this item?",
      "Pure and deterministic: no fetch. Verifies the grant offline and picks the slot (the item's first anchor among `slots`, or its first anchor). Then it picks the look. The item's own declared `look.model` under an open licence (CC0-1.0, CC-BY-4.0) comes first; it is returned by `sha256` for the caller to resolve on its own Blossom, and its `minterUrl` is untrusted. Without one, the item's `render-asset:` url is used if it is https, by name (no IP literal, userinfo or trailing dot), not a private host, and on a trusted origin: one in `trusted`, or by default the known PlaceSchema origins. A closed declared licence falls back to the render-asset and says `licence` only without one; a malformed `look` is ignored. The model is never fetched or converted, so `reason` starts `declared-not-measured`, and the caller checks the file against `limits` before drawing it, else `standIn` (the item type, for the game's own generic model). Otherwise `look` is null and `reason` is one of `client-no-mesh`, `no-look`, `licence`, `foreign-look-untrusted`, `no-compatible-slot`, `hidden: …` or `invalid-grant: …`.",
      { type: "object", required: ["grant", "caps"], properties: {
        grant: { type: "object", description: "Signed kind-30080 event." },
        caps: { type: "object", required: ["mesh"], properties: { mesh: { oneOf: [{ type: "boolean" }, { type: "object", required: ["maxBytes", "maxVertices"], properties: { maxBytes: { type: "integer", minimum: 1 }, maxVertices: { type: "integer", minimum: 1 } } }] }, sprite: { type: "boolean" }, cuboid: { type: "boolean" } } },
        slots: { type: "array", maxItems: 64, items: { type: "string" }, description: "The game's declared mount slots, e.g. [\"grip\"]." },
        trusted: { type: "array", maxItems: 64, items: { type: "string", example: "https://forge.placeschema.com" }, description: "Public bare https origins whose render-asset urls this game trusts. Default: the known PlaceSchema origins." },
      } },
      { type: "object", required: ["look", "standIn", "reason"], properties: {
        look: { oneOf: [{ type: "null" }, { type: "object", required: ["from", "slot", "mount", "limits"], properties: {
          from: { enum: ["look", "render-asset"] },
          url: { type: "string", description: "render-asset only: the trusted model url." },
          sha256: { type: "string", description: "look only: resolve the model by this hash on your own Blossom." },
          license: { type: "string" }, by: { enum: ["minter", "operator"] },
          minterUrl: { type: "string", description: "look only: where the minter said the model is. Untrusted; never fetch it blindly." },
          fallback: { type: "string", description: "look only: the trusted render-asset url to draw if the hash cannot be resolved." },
          slot: { type: "string" },
          mount: { type: "object", properties: { slot: { type: "string" }, size: { type: "number", description: "Longest side in world units (0.2-2.5)." } } },
          limits: { type: "object", properties: { maxBytes: { type: "integer" }, maxVertices: { type: "integer" } } },
        } }] },
        standIn: { type: ["string", "null"] }, slot: { type: "string" }, reason: { type: "string" },
      } },
    ),
  },
};
