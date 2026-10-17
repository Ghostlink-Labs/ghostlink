/** Local operator CLI. Scope contains public IDs; no payer signing key is loaded. */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRpcPool, loadRpcEndpoints } from "@ghostlink/service-kit/rpc";
import { RelayerJournal, type RelayerScope } from "./journal.js";
import { reconcileRetainedRelayerOperations } from "./reconciliation.js";

async function main() {
  const [command, destination, extra, ...rest] = process.argv.slice(2);
  if (!destination || rest.length || !["backup", "restore", "inspect", "reconcile", "rotate"].includes(command ?? "") ||
    (command === "restore" ? !extra : command !== "inspect" && command !== "reconcile" && extra !== undefined)) {
    throw new Error("invalid maintenance command");
  }
  const scopePath = process.env.RELAYER_MAINTENANCE_SCOPE_PATH, keyPath = process.env.RELAYER_JOURNAL_KEY_PATH;
  if (!scopePath || !keyPath) throw new Error("maintenance scope and storage key required");
  const scope = JSON.parse(readFileSync(scopePath, "utf8")) as RelayerScope;
  const key = readFileSync(keyPath);
  let journal: RelayerJournal | undefined;
  try {
    if (command === "restore") {
      RelayerJournal.restoreBackup(destination, extra!, key, scope);
      console.log("Snapshot restored in quarantine; paid submissions remain disabled."); return;
    }
    const path = process.env.RELAYER_JOURNAL_PATH;
    if (!path || !statSync(path).isFile()) throw new Error("existing relayer journal required");
    journal = RelayerJournal.openForMaintenance(path, key, scope);
    if (command === "backup") await journal.backupTo(destination);
    else if (command === "rotate") {
      const nextKey = readFileSync(destination);
      try { journal.rotateKey(nextKey); } finally { nextKey.fill(0); }
    } else {
      let report: unknown;
      if (command === "inspect") {
        const page = journal.page(extra);
        report = { scope: journal.scope, recoveryId: journal.recoveryId, nextCursor: page.nextCursor,
          records: page.records.map(r => ({ requestIdHex: r.id, digest: r.digest, receipt: r.observation, chargedAt: r.chargedAt,
            feeLamports: r.packet?.feeLamports, rentLamports: r.packet?.rentLamports })),
          historyCompleteness: "not-established", paidResumptionAllowed: false };
      } else {
        const rpc = createRpcPool({ genesisHash: scope.genesisHash, endpoints: loadRpcEndpoints(process.env.RPC_ENDPOINTS_PATH, process.env.RPC_URL) });
        try { report = await reconcileRetainedRelayerOperations(rpc.connection, journal, extra); } finally { rpc.close(); }
      }
      writeFileSync(destination, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    }
    console.log("Relayer maintenance completed; inspect the private output and recovery gates before cutover.");
  } finally { journal?.close(); key.fill(0); }
}
void main().catch(() => { console.error("Relayer maintenance failed; check command, scope, paths, key and approved history provider."); process.exitCode = 1; });
