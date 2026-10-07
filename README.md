# placeschema/verify

Verification for [PlaceSchema](https://placeschema.com) items and places, served on the
[Pocket Network Agentic Portal](https://agent.pocket.network). Agents already have keys; with
this they can check who owns a portable item, who made it, and under what licence.

All calls take and return JSON. Bad input gets a 4xx, never a 5xx.

| Call | What it answers |
|---|---|
| `GET /v1/version`, `GET /v1/health` | Liveness. |
| `POST /v1/verify-grant` `{ grant, holder? }` | Is this signed item grant (a kind-30080 Nostr event) genuine? It returns the holder, the minter, the item and its licensed sources. The check is offline. |
| `POST /v1/verify-place` `{ url }` | Is this a live place with a valid `/.well-known/placeschema.json` (and a valid `place.md` when one is served), and what items does it accept? v1 checks known PlaceSchema origins only. |

```sh
curl -X POST "$BASE/v1/verify-place" -d '{"url":"https://forge.placeschema.com"}'
```

The checks are the published [`@placeschema/protocol`](https://www.npmjs.com/package/@placeschema/protocol)
verifiers (`verifyGrantEvent`, `validateCapabilities`, `parsePlaceTemplate`). Nothing is re-implemented here.

```sh
npm install && npm test   # node 24
npm run dev               # wrangler dev
```

Apache-2.0.
