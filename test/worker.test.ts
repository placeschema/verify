import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildGrantEventUnsigned } from "@placeschema/protocol";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { handle as rawHandle, isKnownOrigin, type Env } from "../src/verify.ts";

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

async function withRelay(events: unknown[], run: (requests: unknown[]) => Promise<void>, down = false, registry?: (id: string, init?: RequestInit) => Promise<Response>) {
  const real = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (registry && String(_url).startsWith("https://registrar.test/grants/")) {
      return registry(String(_url).slice("https://registrar.test/grants/".length), init);
    }
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
  env = { STASH_RELAY: "wss://relay.test/", REGISTRAR_URL: "https://registrar.test" };
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
  assert.equal((await call("/v1/version")).body.service, "placeschema");
  assert.equal((await call("/v1/health")).body.status, "ok");
});

test("openapi.json documents every route", async () => {
  const spec = (await call("/openapi.json")).body;
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(Object.keys(spec.paths).sort(), ["/openapi.json", "/v1/health", "/v1/look", "/v1/places", "/v1/player", "/v1/stash", "/v1/verify-grant", "/v1/verify-place", "/v1/version"]);
  for (const p of ["/v1/stash", "/v1/verify-grant", "/v1/verify-place", "/v1/player", "/v1/places", "/v1/look"]) assert.equal((await call(p, undefined)).status, 405, p);
  for (const [p, want] of [["/openapi.json", 200], ["/v1/version", 200], ["/v1/health", 200], ["/nope", 404], ["/v1/stash", 405]] as const) {
    const res = await handle(new Request(`https://x${p}`, { method: "HEAD" }));
    assert.equal(res.status, want, `HEAD ${p}`);
    assert.equal(await res.text(), "", `HEAD ${p} has no body`);
  }
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

test("verify-place accepts the Hub, Forge and try worlds only", () => {
  for (const ok of ["https://hub.placeschema.com", "https://forge.placeschema.com", "https://demo.try.placeschema.com", "https://a-1.try.placeschema.com"]) {
    assert.ok(isKnownOrigin(ok), ok);
  }
  for (const no of [
    "https://shop.placeschema.com", "https://voxel.placeschema.com", "https://liminal.placeschema.com", "https://zombie.placeschema.com",
    "http://demo.try.placeschema.com", "https://demo.try.placeschema.com:8443", "https://a.b.try.placeschema.com",
    "https://-x.try.placeschema.com", "https://try.placeschema.com", "https://demo.try.placeschema.com.evil.example",
  ]) {
    assert.ok(!isKnownOrigin(no), no);
  }
});

test("an unknown origin is a 422 that lists what is accepted", async () => {
  const r = await call("/v1/verify-place", { url: "https://shop.placeschema.com" });
  assert.equal(r.status, 422);
  assert.deepEqual(r.body.known, ["https://hub.placeschema.com", "https://forge.placeschema.com", "https://<slug>.try.placeschema.com"]);
  // The handler normalises with new URL().origin before matching.
  for (const url of ["https://hub.placeschema.com./", "https://evil.example\\@hub.placeschema.com/", "https://hub.placeschema.com@evil.example/", "https://hub.placeschema.com:8443/"]) {
    assert.equal((await call("/v1/verify-place", { url })).status, 422, url);
  }
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
  try {
    for (const url of ["https://HUB.placeschema.com:443/x", "https://u:p@Demo.try.placeschema.com/"]) {
      assert.notEqual((await call("/v1/verify-place", { url })).status, 422, url);
    }
  } finally {
    globalThis.fetch = real;
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

test("stash verifies a consignment receipt by registrar grant id", async () => {
  const sk = generateSecretKey();
  const key = getPublicKey(sk);
  const signed = finalizeEvent(buildGrantEventUnsigned(template as any, key, 1_700_000_003), minterSk);
  const fetched: string[] = [];
  await withRelay([receipt(sk, signed.id, "deposited", 100)], async () => {
    const result = await call("/v1/stash", { holder: key });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.problems, []);
    assert.deepEqual(result.body.items[0], { grant: signed.id, status: "deposited", verified: true, minter: getPublicKey(minterSk), author: "A", license: "CC0-1.0" });
    assert.deepEqual(fetched, [signed.id]);
  }, false, async (id, init) => {
    fetched.push(id);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).get("cookie"), null);
    assert.ok(init?.signal);
    return new Response(JSON.stringify({ ok: true, grant: signed }));
  });
});

test("stash registrar failures leave receipts unverified and report a problem", async () => {
  const sk = generateSecretKey();
  const key = getPublicKey(sk);
  const own = finalizeEvent(buildGrantEventUnsigned(template as any, key, 1_700_000_004), minterSk);
  const other = finalizeEvent(buildGrantEventUnsigned(template as any, getPublicKey(generateSecretKey()), 1_700_000_005), minterSk);
  const forged = { ...own, content: own.content.replace("Test Item", "Fake Item") };
  const cases: [string, string, (id: string, init?: RequestInit) => Promise<Response>][] = [
    ["404", own.id, async () => new Response(JSON.stringify({ ok: false }), { status: 404 })],
    ["202 retry", own.id, async () => new Response(JSON.stringify({ ok: false, retry: true }), { status: 202 })],
    ["wrong holder", other.id, async () => new Response(JSON.stringify({ ok: true, grant: other }))],
    ["invalid signature", own.id, async () => new Response(JSON.stringify({ ok: true, grant: forged }))],
    ["timeout", own.id, async () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["over-cap body", own.id, async () => new Response("x".repeat(16_385))],
    ["malformed", own.id, async () => new Response("not json")],
    ["redirect", own.id, async () => new Response("", { status: 302 })],
  ];
  for (const [name, id, response] of cases) {
    await withRelay([receipt(sk, id, "deposited", 100)], async () => {
      const result = await call("/v1/stash", { holder: key });
      assert.equal(result.status, 200, name);
      assert.equal(result.body.items[0].verified, false, name);
      assert.equal(result.body.problems.length, 1, name);
      assert.match(result.body.problems[0], /grant/, name);
      if (name === "wrong holder") assert.match(result.body.problems[0], /different key/);
    }, false, response);
  }
});

test("stash fetches at most 20 newest eligible ids concurrently and supplied grants skip fetch", async () => {
  const sk = generateSecretKey();
  const key = getPublicKey(sk);
  const signed = finalizeEvent(buildGrantEventUnsigned(template as any, key, 1_700_000_006), minterSk);
  const ids = Array.from({ length: 23 }, (_, n) => n.toString(16).padStart(64, "0"));
  const events = [receipt(sk, signed.id, "deposited", 200), ...ids.map((id, n) => receipt(sk, id, "deposited", 100 + n)), receipt(sk, "not-hex", "deposited", 99)];
  const fetched: string[] = [];
  let active = 0;
  let peak = 0;
  await withRelay(events, async () => {
    const result = await call("/v1/stash", { holder: key, grants: [signed] });
    assert.equal(result.status, 200);
    assert.equal(result.body.items.find((item: any) => item.grant === signed.id).verified, true);
    assert.equal(result.body.items.find((item: any) => item.grant === "not-hex").verified, false);
    assert.equal(fetched.length, 20);
    assert.ok(!fetched.includes(signed.id));
    assert.deepEqual(fetched, ids.slice(-20).reverse());
    assert.ok(peak > 1);
  }, false, async (id) => {
    fetched.push(id);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return new Response("", { status: 404 });
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

/** Run with a mocked registrar: `answer` gets each requested URL. */
async function withRegistrar(answer: (url: URL) => Promise<Response>, run: (urls: URL[]) => Promise<void>) {
  const real = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    const url = new URL(String(u));
    urls.push(url);
    assert.equal(url.origin, "https://registrar.test");
    return answer(url);
  }) as typeof fetch;
  env = { REGISTRAR_URL: "https://registrar.test/" };
  try { await run(urls); }
  finally { globalThis.fetch = real; env = {}; }
}
const upstreamFailures: [string, () => Promise<Response>, number][] = [
  ["timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }, 504],
  ["offline", async () => { throw new TypeError("fetch failed"); }, 502],
  ["500", async () => new Response("no", { status: 500 }), 502],
  ["redirect", async () => new Response("", { status: 302 }), 502],
  ["over-cap body", async () => new Response("x".repeat(300_000)), 502],
];

test("player resolves a name or a pubkey through NIP-05", async () => {
  const nip = (names: Record<string, string>) => new Response(JSON.stringify({ names, relays: { [holder]: ["wss://nostr.placeschema.com/"] } }));
  await withRegistrar(async (url) => url.pathname === "/whoami" ? new Response(JSON.stringify({ ok: true, name: "seth" })) : nip({ seth: holder }), async (urls) => {
    const byName = await call("/v1/player", { name: "Seth" });
    assert.equal(byName.status, 200, JSON.stringify(byName.body));
    assert.deepEqual(byName.body, { pubkey: holder, name: "seth", verified: true, profile: { relays: ["wss://nostr.placeschema.com/"] } });
    assert.equal(urls[0].pathname, "/.well-known/nostr.json");
    assert.equal(urls[0].searchParams.get("name"), "seth");
    const byKey = await call("/v1/player", { pubkey: holder.toUpperCase() });
    assert.deepEqual(byKey.body, byName.body);
    assert.match(urls[1].searchParams.get("npub")!, /^npub1/);
  });
  await withRegistrar(async (url) => url.pathname === "/whoami" ? new Response(JSON.stringify({ ok: true, name: null })) : nip({}), async () => {
    assert.deepEqual((await call("/v1/player", { name: "nobody" })).body, { pubkey: null, name: "nobody", verified: false, profile: {} });
    assert.deepEqual((await call("/v1/player", { pubkey: holder })).body, { pubkey: holder, name: null, verified: false, profile: {} });
  });
  // a name whose NIP-05 entry names another key does not verify the key asked about
  await withRegistrar(async (url) => url.pathname === "/whoami" ? new Response(JSON.stringify({ ok: true, name: "seth" })) : nip({ seth: "a".repeat(64) }), async () => {
    assert.equal((await call("/v1/player", { pubkey: holder })).body.verified, false);
  });
});

test("player rejects bad input with 4xx and upstream failures with 502/504", async () => {
  for (const body of [{}, { name: "a", pubkey: holder }, { name: "" }, { name: "bad name" }, { name: 7 }, { pubkey: "xyz" }, null]) {
    const r = await call("/v1/player", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.error);
  }
  for (const [name, answer, want] of upstreamFailures) {
    await withRegistrar(answer, async () => {
      for (const body of [{ name: "seth" }, { pubkey: holder }]) {
        const r = await call("/v1/player", body);
        assert.equal(r.status, want, `${name} ${JSON.stringify(body)}`);
        assert.ok(r.body.error);
      }
    });
  }
  await withRegistrar(async () => new Response("not json"), async () => assert.equal((await call("/v1/player", { name: "seth" })).status, 502));
});

test("places lists a hub's worlds and which it trusts items from", async () => {
  const head = "---\nversion: 1\n---\n\n# Worlds\n\n";
  await withRegistrar(async (url) => new Response(url.searchParams.get("games") === "1"
    ? `${head}- https://forge.placeschema.com — Forge\n- https://mc.example.com — Minecraft\n\n# Not trusted\n\n- ~https://hub.placeschema.com\n- ~https://bad.example.com\n`
    : `${head}- https://hub.placeschema.com — Hub\n- https://forge.placeschema.com — Forge\n- not a line\n- http://plain.example.com\n`), async (urls) => {
    const r = await call("/v1/places", { hub: "https://hub.placeschema.com/some/path" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { hub: "https://hub.placeschema.com", worlds: [
      { origin: "https://hub.placeschema.com", name: "Hub", itemsTrusted: false },
      { origin: "https://forge.placeschema.com", name: "Forge", itemsTrusted: true },
      { origin: "https://mc.example.com", name: "Minecraft", itemsTrusted: true },
    ] });
    assert.equal(urls.length, 2);
    for (const u of urls) assert.equal(u.searchParams.get("hub"), "https://hub.placeschema.com");
  });
});

test("places rejects bad input with 4xx and upstream failures with 502/504", async () => {
  for (const body of [{}, { hub: "nope" }, { hub: "http://hub.placeschema.com" }, { hub: "https://u:p@hub.placeschema.com" }, { hub: 3 }]) {
    assert.equal((await call("/v1/places", body)).status, 400, JSON.stringify(body));
  }
  for (const [name, answer, want] of upstreamFailures) {
    await withRegistrar(answer, async () => assert.equal((await call("/v1/places", { hub: "https://hub.placeschema.com" })).status, want, name));
  }
});

test("look picks the slot and declared look for this client, never fetching", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("look must not fetch"); }) as typeof fetch;
  // The vendored 0.1.0 builder drops `look` (newer protocols sign it), so a declared look is added to the content and its id re-derived.
  const mint = ({ look, ...t }: any) => {
    const e = buildGrantEventUnsigned({ ...template, ...t } as any, holder, 1_700_000_000);
    if (look) {
      const old = e.tags.find((tag: string[]) => tag[0] === "x")![1];
      e.content = JSON.stringify({ ...JSON.parse(e.content), look });
      const x = createHash("sha256").update(e.content).digest("hex");
      e.tags = e.tags.map((tag: string[]) => tag.map((v) => v.replace(old, x)));
    }
    return finalizeEvent(e, minterSk);
  };
  const caps = { mesh: { maxBytes: 2_097_152, maxVertices: 65_536 } };
  const sha = "b".repeat(64);
  try {
    const asset = mint({ features: ["render-asset:https://cdn.example.com/sword.glb"] });
    const ok = await call("/v1/look", { grant: asset, caps, slots: ["head", "grip"] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.look, { url: "https://cdn.example.com/sword.glb", from: "render-asset", slot: "grip", mount: { slot: "grip", size: 1 }, limits: caps.mesh });
    assert.equal(ok.body.standIn, "blade.sword");
    assert.match(ok.body.reason, /^declared-not-measured/);
    const own = { look: { model: { url: "https://blossom.example.com/" + sha, sha256: sha }, by: "minter", license: "CC0-1.0" } };
    const declared = await call("/v1/look", { grant: mint({ ...own, features: ["render-asset:https://cdn.example.com/sword.glb"] }), caps: { mesh: true } });
    assert.equal(declared.body.look?.from, "look", JSON.stringify(declared.body));
    assert.equal(declared.body.look.sha256, sha);
    const cases: [object, object, string][] = [
      [{ features: [] }, caps, "no-look"],
      [{ features: ["render-asset:https://cdn.example.com/a.glb"] }, { mesh: false }, "client-no-mesh"],
      [{ look: { ...own.look, license: "LicenseRef-closed" } }, caps, "licence"],
      [{ features: ["render-asset:http://cdn.example.com/a.glb"] }, caps, "foreign-look-untrusted"],
      [{ features: ["visual:none"] }, caps, "hidden: no-visual-form"],
      [{ type: "garment.hat", anchors: ["head"], features: ["fits:human"] }, caps, "hidden: unfitted"],
    ];
    for (const [t, c, reason] of cases) {
      const r = await call("/v1/look", { grant: mint(t), caps: c });
      assert.equal(r.status, 200, reason);
      assert.equal(r.body.look, null, reason);
      assert.equal(r.body.reason, reason, JSON.stringify(r.body));
    }
    assert.equal((await call("/v1/look", { grant: asset, caps, slots: ["head"] })).body.reason, "no-compatible-slot");
    const forged = { ...asset, sig: "0".repeat(128) };
    const bad = await call("/v1/look", { grant: forged, caps });
    assert.equal(bad.status, 200);
    assert.match(bad.body.reason, /^invalid-grant/);
  } finally { globalThis.fetch = real; }
});

test("look rejects bad input with 4xx", async () => {
  for (const body of [{}, { caps: { mesh: true } }, { grant, caps: null }, { grant }, { grant, caps: { mesh: { maxBytes: 0, maxVertices: 1 } } },
    { grant, caps: { mesh: "yes" } }, { grant, caps: { mesh: true }, slots: "grip" }, { grant, caps: { mesh: true }, slots: [1] }]) {
    const r = await call("/v1/look", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.error);
  }
});
