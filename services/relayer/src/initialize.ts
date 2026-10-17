/** Explicit fresh-payer provisioning. Never adopts an existing payer or overwrites state. */
import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import { RelayerJournal } from "./journal.js";

function main() {
  const [directory, ...extra] = process.argv.slice(2), genesisHash = process.env.RELAYER_GENESIS_HASH;
  if (!directory || extra.length || !genesisHash || new PublicKey(genesisHash).toBase58() !== genesisHash) throw new Error("new directory and approved genesis required");
  if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(genesisHash)) throw new Error("V2 relayer has no verified public deployment");
  mkdirSync(directory, { mode: 0o700 }); // Exclusive new directory; never recurse or overwrite.
  const payer = Keypair.generate(), key = randomBytes(32);
  const scope = { genesisHash, payer: payer.publicKey.toBase58(), pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() };
  let journal: RelayerJournal | undefined;
  try {
    writeFileSync(join(directory, "payer.json"), JSON.stringify(Array.from(payer.secretKey)) + "\n", { flag: "wx", mode: 0o600, flush: true });
    writeFileSync(join(directory, "storage-key"), key, { flag: "wx", mode: 0o600, flush: true });
    journal = new RelayerJournal(join(directory, "journal.sqlite"), key, scope);
    const journalId = journal.instanceId;
    if (!journalId) throw new Error("journal identity lost during initialization");
    journal.close(); journal = undefined;
    writeFileSync(join(directory, "scope.json"), JSON.stringify(scope, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    // Written last: absent deployment.json means provisioning did not finish.
    writeFileSync(join(directory, "deployment.json"), JSON.stringify({ scope, journalId,
      files: { payer: "payer.json", storageKey: "storage-key", journal: "journal.sqlite", scope: "scope.json" } }, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    if (process.platform !== "win32") for (const path of [directory, dirname(resolve(directory))]) {
      const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    console.log("Fresh payer and journal initialized. Pin deployment.json in operator configuration before funding the payer.");
  } finally { journal?.close(); key.fill(0); }
}
try { main(); } catch { console.error("Relayer initialization failed; use a new directory and an approved development genesis. Inspect partial output before retrying."); process.exitCode = 1; }
