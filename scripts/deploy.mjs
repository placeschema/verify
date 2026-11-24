import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function deploy({ git = execFileSync, wrangler = spawnSync } = {}) {
  const commit = git("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]+$/i.test(commit)) {
    throw new Error("Refusing to deploy: git commit is empty or invalid");
  }
  if (git("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
    throw new Error("Refusing to deploy: working tree is dirty");
  }

  const result = wrangler("wrangler", ["deploy", "--var", `BUILD_COMMIT:${commit}`], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = deploy();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
