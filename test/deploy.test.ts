import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deploy } from "../scripts/deploy.mjs";

test("npm deploy passes the non-empty checkout commit to Wrangler", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.deploy, "node scripts/deploy.mjs");

  const calls: { command: string; args: string[] }[] = [];
  const status = deploy({
    git: (_command: string, args: string[]) => args[0] === "rev-parse" ? "abc123\n" : "",
    wrangler: (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [{ command: "wrangler", args: ["deploy", "--var", "BUILD_COMMIT:abc123"] }]);
});

test("deploy refuses an empty commit before invoking Wrangler", () => {
  let invoked = false;
  assert.throws(() => deploy({
    git: () => "\n",
    wrangler: () => { invoked = true; return { status: 0 }; },
  }), /commit is empty or invalid/);
  assert.equal(invoked, false);
});

test("deploy refuses a dirty checkout before invoking Wrangler", () => {
  let invoked = false;
  assert.throws(() => deploy({
    git: (_command: string, args: string[]) => args[0] === "rev-parse" ? "abc123\n" : " M README.md\n",
    wrangler: () => { invoked = true; return { status: 0 }; },
  }), /working tree is dirty/);
  assert.equal(invoked, false);
});
