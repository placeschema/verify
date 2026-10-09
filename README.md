# placeschema/verify

Verification for PlaceSchema items and places. Agents already have keys; with this they can
check who owns a portable item, who made it, and under what licence. It is served directly at
`https://verify.placeschema.com` and on Pocket Network **Beta TestNet** as service ID `placeschema`
(relay endpoint `https://pokt.placeschema.com`). The Agentic Portal listing is pending review.

All calls take and return JSON. Bad input gets a 4xx, never a 5xx. The full reference, with every
request and response schema, is the OpenAPI 3.1 spec at `GET /openapi.json`.

**Limits.** `POST /v1/*` is limited to 60 requests per 60 s per client IP (`CF-Connecting-IP`); over that you get
`429 {"error":"rate limited"}` with `retry-after: 60`. Through POKT every relay reaches this Worker from the
supplier's IP, so 60 per minute is the cap per supplier (the whole POKT service while there is one supplier). `GET` routes are never limited.
Successful `verify-place` results are cached for 300 s per origin. If the limiter is missing or errors, requests are served normally (fail open).
`GET /v1/version` returns `service` (the POKT service ID) and `commit` (the `BUILD_COMMIT` var set at deploy; empty if unset) so a deploy can be checked.

| Call | What it answers |
|---|---|
| `GET /v1/version`, `GET /v1/health` | Identity and liveness: `{service, name, version, commit}`, `{ok: true, status: "ok"}`. |
| `POST /v1/verify-grant` `{ grant, holder? }` | Is this signed item grant (a kind-30080 Nostr event) authentic? It returns the holder, the minter, the item and its licensed sources. The check is offline. |
| `POST /v1/stash` `{ holder, grants? }` | Which items does a key publicly report as deposited or redeemed? Signed kind-30083 receipts are read from the relay. Consign grants can be verified by id; pass other grant events to verify their issuance. |
| `POST /v1/verify-place` `{ url }` | Is this a live place with a valid `/.well-known/placeschema.json` (and a valid `place.md` when one is served), and what items does it accept? v1 checks `https://hub.placeschema.com`, `https://forge.placeschema.com` and test worlds at `https://<slug>.try.placeschema.com` only. |
| `GET /openapi.json` | The OpenAPI 3.1 reference for all of the above. |

**Errors.** Every error body is `{"error": "…"}`.

| Status | When |
|---|---|
| 400 | A required field is missing or malformed, or the body is not JSON. |
| 404 | Unknown path (`not found`). |
| 405 | A call route was not sent as `POST` with a JSON body. |
| 413 | The body is over 64 KB. |
| 422 | `verify-place` was given an origin v1 does not check (the body adds `known`, the accepted origins), or the request could not be verified. |
| 429 | Rate limited (see Limits). |

## Try it

Base URL: `https://verify.placeschema.com`

```sh
BASE=https://verify.placeschema.com
curl $BASE/v1/version     # {"service":"placeschema","name":"placeschema-verify","version":"0.1.0","commit":"…"}
curl -X POST $BASE/v1/verify-place -d '{"url":"https://hub.placeschema.com"}'
curl -X POST $BASE/v1/verify-grant -d @test/sample-grant.json   # valid: true
HOLDER=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync("test/sample-grant.json", "utf8")).grant.tags.find(t=>t[0]==="p")[1])')
curl -X POST "$BASE/v1/stash" -H 'content-type: application/json' -d "{\"holder\":\"$HOLDER\"}"
```

`verify-grant` returns `{ valid, holder, minter, item, type, label, sources: [{ author, license }] }`
or `{ valid: false, reason }`. When the grant is genuine but you passed a different `holder`, the
false answer also carries the real `holder`. `test/sample-grant.json` is signed with a throwaway key.

`stash` returns `{ holder, items, count, problems }`, with at most 100 items. Each item has a
grant id, a `deposited` or `redeemed` status, and verification details. `verified: false` means
the signed receipt is self-reported by the holder; the underlying grant has not been checked.
Receipts for consign grants are verified by id through the registrar when its signed grant is available.
Mint and sidecar grants are not stored there, so include their signed kind-30080 grant events in `grants`:

```sh
node -e 'const fs=require("fs"); const grant=JSON.parse(fs.readFileSync("test/sample-grant.json", "utf8")).grant; console.log(JSON.stringify({holder:grant.tags.find(t=>t[0]==="p")[1],grants:[grant]}))' |
  curl -X POST "$BASE/v1/stash" -H 'content-type: application/json' --data-binary @-
```

Matching valid grants add `verified: true`, `minter`, `author`, and `license` to the item.
The relay URL defaults to `wss://nostr.placeschema.com` and can be set with `STASH_RELAY`.
The registrar URL defaults to `https://panel.placeschema.com` and can be set with `REGISTRAR_URL`.
Each stash request looks up at most 20 grant ids among its newest 100 receipts; supplied grants take precedence.
If the relay cannot be reached, `items` is empty and `problems` explains why.

**What `verify-grant` attests.** `valid: true` means the grant is an authentic issuance by `minter`:
well-formed, signed by the template's own minter key, and naming `holder` as the key it was minted to.
It does not say the holder still has the item, and it does not say `minter` is a trustworthy world:
any key can mint a valid grant, so decide which minters you trust. Possession is carry verification,
which this service does not do. `holder`, if you pass one, must be 64-hex (any case). Revocation floors
apply to delegations and carry records, never to a grant, so they are not consulted here.

**What `verify-place` does when something is wrong.** Only a 404 for `place.md` means "no place.md".
Any other failure (an error status, a redirect, a `place.md` over 32 KB, a `placeschema.json` over 256 KB) is reported in `problems` and
`valid` is false. The same goes for `placeschema.json`. The response says `placeMd: "ok" | "absent" | "error"`, so a manifest-only place is visible as such.

```sh
curl -X POST "$BASE/v1/verify-place" -d '{"url":"https://hub.placeschema.com"}'
```

The checks are the `@placeschema/protocol` 0.1.0 verifiers. The npm package is coming; until it is
live, the exact 0.1.0 tarball is vendored in `vendor/`. The verifiers used are `verifyGrantEvent`, `validateCapabilities` and `parsePlaceTemplate`. Nothing is re-implemented here.

```sh
npm install && npm test   # node 24
npm run dev               # wrangler dev
```

Apache-2.0.
