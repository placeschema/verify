# placeschema/verify

Verification for [PlaceSchema](https://placeschema.com) items and places, served on the
[Pocket Network Agentic Portal](https://agent.pocket.network). Agents already have keys; with
this they can check who owns a portable item, who made it, and under what licence.

All calls take and return JSON. Bad input gets a 4xx, never a 5xx.

**Limits.** `POST /v1/*` is limited to 60 requests per 60 s per client IP (`CF-Connecting-IP`); over that you get
`429 {"error":"rate limited"}` with `retry-after: 60`. `GET /v1/version` and `/v1/health` are never limited.
Successful `verify-place` results are cached for 300 s per origin. If the limiter is missing or errors, requests are served normally (fail open).
`GET /v1/version` returns `service` (the POKT service ID) and `commit` (the `BUILD_COMMIT` var set at deploy; empty if unset) so a deploy can be checked.

| Call | What it answers |
|---|---|
| `GET /v1/version`, `GET /v1/health` | Identity and liveness: `{service, name, version, commit}`, `{ok: true, status: "ok"}`. |
| `POST /v1/verify-grant` `{ grant, holder? }` | Is this signed item grant (a kind-30080 Nostr event) authentic? It returns the holder, the minter, the item and its licensed sources. The check is offline. |
| `POST /v1/verify-place` `{ url }` | Is this a live place with a valid `/.well-known/placeschema.json` (and a valid `place.md` when one is served), and what items does it accept? v1 checks known PlaceSchema origins only. |

## Try it

Base URL: `https://placeschema-verify.lively-voice-30ac.workers.dev`

```sh
BASE=https://placeschema-verify.lively-voice-30ac.workers.dev
curl $BASE/v1/version     # {"service":"placeschema-verify","name":"placeschema-verify","version":"0.1.0","commit":"…"}
curl -X POST $BASE/v1/verify-place -d '{"url":"https://forge.placeschema.com"}'
curl -X POST $BASE/v1/verify-grant -d @test/sample-grant.json   # valid: true
```

`verify-grant` returns `{ valid, holder, minter, item, type, label, sources: [{ author, license }] }`
or `{ valid: false, reason }`. `test/sample-grant.json` is signed with a throwaway key.

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
curl -X POST "$BASE/v1/verify-place" -d '{"url":"https://forge.placeschema.com"}'
```

The checks are the `@placeschema/protocol` 0.1.0 verifiers. The npm package is coming; until it is
live, the exact 0.1.0 tarball is vendored in `vendor/`. The verifiers used are `verifyGrantEvent`, `validateCapabilities` and `parsePlaceTemplate`. Nothing is re-implemented here.

```sh
npm install && npm test   # node 24
npm run dev               # wrangler dev
```

Apache-2.0.
