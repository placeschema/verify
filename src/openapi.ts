// The public API reference, served at GET /openapi.json and linked from the POKT card's specs[].
const error = { type: "object", required: ["error"], properties: { error: { type: "string" } } };
const errors = {
  "400": { description: "Bad input: missing or malformed field, or a body that is not JSON.", content: { "application/json": { schema: error } } },
  "405": { description: "Wrong method; the call routes take POST with a JSON body.", content: { "application/json": { schema: error } } },
  "413": { description: "Body over 64 KB.", content: { "application/json": { schema: error } } },
  "422": { description: "The request could not be verified.", content: { "application/json": { schema: error } } },
  "429": {
    description: "Over 60 POST requests in 60 s from one client IP. Through POKT every relay arrives from its supplier's IP, so this is the cap per supplier (the whole service while there is one supplier).",
    headers: { "retry-after": { schema: { type: "string", example: "60" } } },
    content: { "application/json": { schema: error } },
  },
};
const hex64 = { type: "string", pattern: "^[0-9a-fA-F]{64}$" };
const post = (summary: string, description: string, request: object, ok: object, extra: object = {}) => ({
  post: {
    summary, description,
    requestBody: { required: true, content: { "application/json": { schema: request } } },
    responses: { "200": { description: "Answered. Read `valid`, or `items` for stash.", content: { "application/json": { schema: ok } } }, ...errors, ...extra },
  },
});

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "PlaceSchema verify",
    version: "0.1.0",
    description: "Verification for PlaceSchema items and places. JSON in and out; bad input is 4xx, never 5xx. Free. POKT service ID `placeschema` (Beta TestNet). Any unknown path is a 404 `{\"error\":\"not found\"}`; a POST under /v1/ may be rate limited (429) before that.",
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
      "Checks a kind-30080 Nostr grant event offline. `valid: true` means an authentic issuance by `minter` naming `holder`; it does not prove current possession or that the minter is trustworthy.",
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
      "Fetches `/.well-known/placeschema.json` and `/.well-known/place.md` from the url's origin. v1 checks https://hub.placeschema.com, https://forge.placeschema.com and https://<slug>.try.placeschema.com only; any other origin is a 422 whose body lists them in `known`. Only a 404 place.md counts as absent; redirects, errors and oversize files (manifest 256 KB, place.md 32 KB) are problems. Successful results are cached 300 s per origin.",
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
      "Reads the holder's signed kind-30083 receipts from the relay (newest status per grant, at most 100 items). Receipts are self-reported; a grant is verified when the registrar serves it or it is passed in `grants`. Relay failure returns empty `items` with a problem, not an error.",
      { type: "object", required: ["holder"], properties: { holder: hex64, grants: { type: "array", items: { type: "object" }, description: "Signed kind-30080 grant events to verify." } } },
      { type: "object", required: ["holder", "items", "count", "problems"], properties: {
        holder: hex64, count: { type: "integer" }, problems: { type: "array", items: { type: "string" } },
        items: { type: "array", maxItems: 100, items: { type: "object", required: ["grant", "status", "verified"], properties: {
          grant: { type: "string" }, status: { enum: ["deposited", "redeemed"] }, verified: { type: "boolean" },
          minter: hex64, author: { type: "string" }, license: { type: "string" }, note: { type: "string" },
        } } },
      } },
    ),
  },
};
