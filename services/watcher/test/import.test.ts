import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("does not start the watcher when another application's index.js imports it", () => {
  const directory = mkdtempSync(join(tmpdir(), "ghostlink-watcher-import-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(directory, "index.js"), `import { Watcher } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)}; console.log(typeof Watcher);`);
    const child = spawnSync(process.execPath, [join(directory, "index.js")], {
      timeout: 2000, encoding: "utf8", windowsHide: true,
      env: { ...process.env, RPC_URL: "http://127.0.0.1:1", NOTIFY_WEBHOOK: "", GHOSTLINK_WATCHER_KEYPAIR: "", WATCHER_GENESIS_HASH: "" },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("function");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
