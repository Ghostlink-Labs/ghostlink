/** Explicit fresh archival rebuild provisioning; no network access or service startup. */
import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { CENSUS, POCKET, REGISTRY } from "@ghostlink/service-kit";
import { IndexerDatabase } from "./database.js";

function main() {
  const [directory, ...extra] = process.argv.slice(2), genesisHash = process.env.INDEXER_GENESIS_HASH;
  if (!directory || extra.length || !genesisHash || new PublicKey(genesisHash).toBase58() !== genesisHash) throw new Error("new directory and approved genesis required");
  if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(genesisHash)) throw new Error("V2 indexer has no verified public deployment");
  mkdirSync(directory, { mode: 0o700 });
  const key = randomBytes(32), scope = { genesisHash, programs: [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), commitment: "finalized" };
  const write = (name: string, data: string | Uint8Array) => writeFileSync(join(directory, name), data, { flag: "wx", mode: 0o600, flush: true });
  let database: IndexerDatabase | undefined;
  try {
    write("state-key", key);
    database = new IndexerDatabase(join(directory, "state.sqlite"), key, JSON.stringify(scope));
    const stateId = database.instanceId; if (!stateId) throw new Error("state identity missing");
    database.close(); database = undefined;
    write("scope.json", JSON.stringify(scope, null, 2) + "\n");
    // Completion manifest is last. A partial directory must never be adopted automatically.
    write("deployment.json", JSON.stringify({ stateId, scope, files: { state: "state.sqlite", stateKey: "state-key", scope: "scope.json" } }, null, 2) + "\n");
    if (process.platform !== "win32") for (const path of [directory, dirname(resolve(directory))]) {
      const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    console.log("Fresh indexer state initialized. Pin deployment.json independently; reconcile archival history before switching clients.");
  } finally { database?.close(); key.fill(0); }
}
try { main(); } catch { console.error("Indexer initialization failed; use a new directory and approved development chain. Inspect partial output before retrying."); process.exitCode = 1; }
