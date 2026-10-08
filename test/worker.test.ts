import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGrantEventUnsigned } from "@placeschema/protocol";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { handle as rawHandle, type Env } from "../src/verify.ts";

let env: Env = {};
const handle = (r: Request) => rawHandle(r, env);

const minterSk = generateSecretKey();
const holder = getPublicKey(generateSecretKey());
const template = {
  type: "blade.sword", label: "Test Item", features: [], palette: ["#000000"], style_hint: "",
  dimensions: { l: 1, w: 0.1, h: 0.05 }, anchors: ["grip"], affordances: ["hold"],
  minter: getPublicKey(minterSk),
  sources: [{ name: "Sword", author: "A", license: "CC0-1.0", url: "https://example.com/sword" }],
};
const grant = finalizeEvent(buildGrantEventUnsigned(template as any, holder, 1_700_000_000), minterSk);

function receipt(sk: Uint8Array, grantId: string, status: "deposited" | "redeemed", created_at: number) {
  return finalizeEvent({ kind: 30083, created_at, tags: [["d", grantId], ["status", status]], content: "" }, sk);
}

async function withRelay(events: unknown[], run: (requests: unknown[]) => Promise<void>, down = false) {
  const real = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    assert.equal(String(_url), "https://relay.test/");
    assert.equal(new Headers(init?.headers).get("upgrade"), "websocket");
    if (down) throw new Error("offline");
    const listeners = new Map<string, ((event: any) => void)[]>();
    const socket = {
      accept() {}, close() {},
      addEventListener(name: string, fn: (event: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
      send(raw: string) {
        requests.push(JSON.parse(raw));
        queueMicrotask(() => {
          for (const ev of events) for (const fn of listeners.get("message") ?? []) fn({ data: JSON.stringify(["EVENT", "stash", ev]) });
          for (const fn of listeners.get("message") ?? []) fn({ data: JSON.stringify(["EOSE", "stash"]) });
        });
      },
    };
    return { webSocket: socket } as unknown as Response;
  }) as typeof fetch;
  env = { STASH_RELAY: "wss://relay.test/" };
  try { await run(requests); }
  finally { globalThis.fetch = real; env = {}; }
}

const call = async (path: string, body?: unknown, raw?: string) => {
  const init = body === undefined && raw === undefined ? {} : { method: "POST", body: raw ?? JSON.stringify(body) };
  const res = await handle(new Request(`https://x${path}`, init));
  return { status: res.status, body: await res.json() as any };
};

test("probes", async () => {
  assert.equal((await call("/v1/version")).body.version, "0.1.0");
  assert.equal((await call("/v1/health")).body.ok, true);
});

test("verify-grant: genuine, wrong holder, forged", async () => {
  const ok = await call("/v1/verify-grant", { grant, holder });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.valid, true, JSON.stringify(ok.body));
  assert.equal(ok.body.sources[0].license, "CC0-1.0");
  assert.equal((await call("/v1/verify-grant", { grant, holder: "0".repeat(64) })).body.valid, false);
  const forged = { ...grant, content: grant.content.replace("Test Item", "Rare Item") };
  assert.equal((await call("/v1/verify-grant", { grant: forged })).body.valid, false);
});

test("bad input is 4xx, never 5xx", async () => {
  for (const [path, body, raw] of [
    ["/v1/verify-grant", {}], ["/v1/verify-grant", { grant: "x" }], ["/v1/verify-grant", undefined, "{not json"],
    ["/v1/verify-place", { url: "nope" }], ["/v1/verify-place", { url: "https://evil.example" }], ["/nope", {}],
  ] as const) {
    const { status } = await call(path, body, raw);
    assert.ok(status >= 400 && status < 500, `${path} ${status}`);
  }
});

const manifest = JSON.stringify({ place: "Forge", id: "forge", accepts: {}, prohibited: [], style_context: "viewer" });
async function place(md: () => Response, man: () => Response = () => new Response(manifest)) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string) => (String(u).endsWith("placeschema.json") ? man() : md())) as typeof fetch;
  try {
    return await call("/v1/verify-place", { url: "https://forge.placeschema.com" });
  } finally {
    globalThis.fetch = real;
  }
}

test("verify-place fails closed: only a 404 place.md is absent", async () => {
  const absent = await place(() => new Response("no", { status: 404 }));
  assert.equal(absent.body.valid, true);
  assert.equal(absent.body.placeMd, "absent");
  const big = await place(() => new Response("x".repeat(40_000)));
  assert.equal(big.body.valid, false); // over the 32 KB place.md cap
  assert.match(big.body.problems.join(" "), /place\.md: too large/);
  for (const md of [() => new Response("boom", { status: 500 }), () => new Response("", { status: 302, headers: { location: "https://evil.example" } }), () => new Response("x".repeat(300_000))]) {
    const r = await place(md);
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, false, JSON.stringify(r.body));
    assert.match(r.body.problems.join(" "), /place\.md: /);
  }
  const r = await place(() => new Response("garbage"));
  assert.equal(r.body.valid, false);
  const m = await place(() => new Response("no", { status: 404 }), () => new Response("boom", { status: 503 }));
  assert.equal(m.body.valid, false);
  assert.match(m.body.problems[0], /placeschema\.json: could not be read \(503\)/);
});

test("request bodies are capped in bytes without buffering", async () => {
  assert.equal((await call("/v1/verify-grant", undefined, JSON.stringify({ pad: "é".repeat(40_000) }))).status, 413); // 80 KB of bytes, 40 K characters
  const res = await handle(new Request("https://x/v1/verify-grant", { method: "POST", headers: { "content-length": "999999" }, body: "{}" }));
  assert.equal(res.status, 413);
});

test("holder input is validated and normalised", async () => {
  assert.equal((await call("/v1/verify-grant", { grant, holder: "nothex" })).status, 400);
  assert.equal((await call("/v1/verify-grant", { grant, holder: holder.toUpperCase() })).body.valid, true);
  const ok = await call("/v1/verify-grant", { grant, holder });
  assert.equal(ok.body.holder, holder);
  assert.equal(ok.body.minter, getPublicKey(minterSk));
});

const post = (path = "/v1/verify-grant", ip = "1.2.3.4") =>
  handle(new Request(`https://x${path}`, { method: "POST", headers: { "cf-connecting-ip": ip }, body: "{}" }));

test("rate limit: 429 over the limit, per IP, probes never limited", async () => {
  const seen: string[] = [];
  const counts = new Map<string, number>();
  env = { LIMITER: { limit: async ({ key }) => (seen.push(key), counts.set(key, (counts.get(key) ?? 0) + 1), { success: counts.get(key)! <= 2 }) } };
  try {
    assert.equal((await post()).status, 400);
    assert.equal((await post()).status, 400);
    const res = await post();
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: "rate limited" });
    assert.ok(res.headers.get("retry-after"));
    assert.equal((await post("/v1/verify-grant", "5.6.7.8")).status, 400); // other IP unaffected
    assert.deepEqual([...new Set(seen)], ["1.2.3.4", "5.6.7.8"]);
    assert.equal((await call("/v1/version")).status, 200);
    assert.equal((await call("/v1/health")).status, 200);
    assert.equal(counts.size, 2); // GET probes never touched the limiter
  } finally {
    env = {};
  }
});

test("rate limiter failure fails open", async () => {
  env = { LIMITER: { limit: async () => { throw new Error("down"); } } };
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal((await post()).status, 400);
    assert.equal((await post()).status, 400);
  } finally {
    console.error = err;
    env = {};
  }
});

test("version includes commit", async () => {
  assert.equal((await call("/v1/version")).body.commit, "");
  env = { BUILD_COMMIT: "abc1234" };
  try {
    assert.equal((await call("/v1/version")).body.commit, "abc1234");
  } finally {
    env = {};
  }
});

test("stash verifies receipt signatures, collapses newest status, and returns empty unknown holders", async () => {
  const sk = generateSecretKey();
  const key = getPublicKey(sk);
  const older = receipt(sk, "item-a", "deposited", 100);
  const newer = receipt(sk, "item-a", "redeemed", 101);
  const other = receipt(sk, "item-b", "deposited", 102);
  const forged = { ...receipt(sk, "item-c", "deposited", 103), content: "tampered" };
  const differentAuthor = receipt(generateSecretKey(), "item-d", "deposited", 104);
  await withRelay([older, newer, other, forged, differentAuthor], async (requests) => {
    const result = await call("/v1/stash", { holder: key.toUpperCase() });
    assert.equal(result.status, 200);
    assert.equal(result.body.holder, key);
    assert.equal(result.body.count, 2);
    assert.deepEqual(result.body.items.map((item: any) => [item.grant, item.status]), [["item-b", "deposited"], ["item-a", "redeemed"]]);
    assert.deepEqual(result.body.items[0].verified, false);
    assert.equal(result.body.items[0].note, "self-reported by the holder; grant not verified");
    assert.deepEqual(requests[0], ["REQ", "stash", { kinds: [30083], authors: [key], limit: 256 }]);
    const empty = await call("/v1/stash", { holder: getPublicKey(generateSecretKey()) });
    assert.equal(empty.body.count, 0);
    assert.deepEqual(empty.body.items, []);
  });
});

test("stash rejects bad holder and reports relay failure without 5xx", async () => {
  assert.deepEqual(await call("/v1/stash", { holder: "bad" }), { status: 400, body: { error: "holder must be a 64-hex pubkey string" } });
  await withRelay([], async () => {
    const result = await call("/v1/stash", { holder });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items, []);
    assert.equal(result.body.count, 0);
    assert.match(result.body.problems.join(" "), /relay unavailable.*offline/);
  }, true);
});

test("stash verifies supplied grants and rejects grants for a different holder", async () => {
  const otherHolder = getPublicKey(generateSecretKey());
  const otherGrant = finalizeEvent(buildGrantEventUnsigned(template as any, otherHolder, 1_700_000_001), minterSk);
  const sk = generateSecretKey();
  const key = getPublicKey(sk);
  const ownGrant = finalizeEvent(buildGrantEventUnsigned(template as any, key, 1_700_000_002), minterSk);
  await withRelay([receipt(sk, ownGrant.id, "deposited", 100)], async () => {
    const result = await call("/v1/stash", { holder: key, grants: [ownGrant, otherGrant] });
    assert.equal(result.body.items[0].verified, true);
    assert.equal(result.body.items[0].minter, getPublicKey(minterSk));
    assert.equal(result.body.items[0].author, "A");
    assert.equal(result.body.items[0].license, "CC0-1.0");
    assert.match(result.body.problems.join(" "), /different key/);
  });
});

test("stash caps response at 100 items", async () => {
  const sk = generateSecretKey();
  const key = getPublicKey(sk);
  const events = Array.from({ length: 110 }, (_, n) => receipt(sk, `item-${n}`, "deposited", 100 + n));
  await withRelay(events, async () => {
    const result = await call("/v1/stash", { holder: key });
    assert.equal(result.body.count, 100);
    assert.equal(result.body.items.length, 100);
    assert.equal(result.body.items[0].grant, "item-109");
  });
});

test("verify-place caches successes so a repeat does not refetch", async () => {
  const store = new Map<string, Response>();
  (globalThis as any).caches = {
    default: {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => void store.set(r.url, res),
    },
  };
  let fetches = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string) => (fetches++, String(u).endsWith("placeschema.json") ? new Response(manifest) : new Response("no", { status: 404 }))) as typeof fetch;
  try {
    const a = await call("/v1/verify-place", { url: "https://forge.placeschema.com" });
    const n = fetches;
    const b = await call("/v1/verify-place", { url: "https://forge.placeschema.com/other/path" });
    assert.equal(a.body.valid, true);
    assert.deepEqual(b.body, a.body);
    assert.equal(fetches, n);
  } finally {
    globalThis.fetch = real;
    delete (globalThis as any).caches;
  }
});
