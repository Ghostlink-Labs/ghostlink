/** Explicit fresh observer/funded-watcher provisioning; no network calls or funding. */
import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { POCKET } from "@ghostlink/service-kit";
import { CrankJournal } from "./journal.js";
import { WatcherState } from "./state.js";
import { WebhookNotifier } from "./index.js";

function main() {
  const [mode, directory, ...extra] = process.argv.slice(2), genesisHash = process.env.WATCHER_GENESIS_HASH;
  if (!["observer", "funded"].includes(mode ?? "") || !directory || extra.length || !genesisHash || new PublicKey(genesisHash).toBase58() !== genesisHash) throw new Error("mode, new directory and approved genesis required");
  if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(genesisHash)) throw new Error("V2 watcher has no verified public deployment");
  if (process.env.NOTIFY_WEBHOOK) new WebhookNotifier(process.env.NOTIFY_WEBHOOK); // URL validation only.
  const threshold = BigInt(process.env.LARGE_FILL_USD_E6 ?? "100000000").toString();
  const limits = mode === "funded" ? { maximumFeeLamports: Number(process.env.WATCHER_MAX_FEE_LAMPORTS ?? 20_000),
    totalBudgetLamports: Number(process.env.WATCHER_TOTAL_BUDGET_LAMPORTS) } : undefined;
  if (limits && (!Number.isSafeInteger(limits.maximumFeeLamports) || limits.maximumFeeLamports < 1 ||
    !Number.isSafeInteger(limits.totalBudgetLamports) || limits.totalBudgetLamports < limits.maximumFeeLamports)) throw new Error("explicit funded fee budget required");
  mkdirSync(directory, { mode: 0o700 });
  const payer = mode === "funded" ? Keypair.generate() : undefined, stateKey = randomBytes(32), crankKey = randomBytes(32);
  const scope = { genesisHash, pocketProgram: POCKET.toBase58(), payer: payer?.publicKey.toBase58() ?? null,
    receiver: createHash("sha256").update(process.env.NOTIFY_WEBHOOK ?? "console").digest("hex"), threshold };
  const write = (name: string, data: string | Uint8Array) => writeFileSync(join(directory, name), data, { flag: "wx", mode: 0o600, flush: true });
  let state: WatcherState | undefined, journal: CrankJournal | undefined;
  try {
    write("state-key", stateKey);
    state = new WatcherState(join(directory, "state.sqlite"), stateKey, scope);
    const stateId = state.instanceId; if (!stateId) throw new Error("state identity missing");
    state.close(); state = undefined;
    let journalId: string | undefined;
    if (payer && limits) {
      write("payer.json", JSON.stringify(Array.from(payer.secretKey)) + "\n"); write("crank-key", crankKey);
      journal = new CrankJournal(join(directory, "cranks.sqlite"), crankKey, { genesisHash, pocketProgram: POCKET.toBase58(), payer: payer.publicKey.toBase58() }, limits);
      journalId = journal.instanceId; if (!journalId) throw new Error("crank identity missing");
      journal.close(); journal = undefined;
    }
    write("scope.json", JSON.stringify(scope, null, 2) + "\n");
    // Written last; a partial directory without this manifest is not ready for service configuration.
    write("deployment.json", JSON.stringify({ mode, scope, stateId, ...(payer ? { journalId, limits } : {}),
      files: { state: "state.sqlite", stateKey: "state-key", scope: "scope.json",
        ...(payer ? { payer: "payer.json", journal: "cranks.sqlite", journalKey: "crank-key" } : {}) } }, null, 2) + "\n");
    if (process.platform !== "win32") for (const path of [directory, dirname(resolve(directory))]) {
      const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    console.log("Fresh watcher state initialized. Pin deployment.json in operator configuration before starting or funding.");
  } finally { state?.close(); journal?.close(); stateKey.fill(0); crankKey.fill(0); }
}
try { main(); } catch { console.error("Watcher initialization failed; use observer/funded mode, a new directory and approved development configuration. Inspect partial output before retrying."); process.exitCode = 1; }
