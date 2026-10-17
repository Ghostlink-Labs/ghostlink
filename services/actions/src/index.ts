/** Hosted deposit builder: approved chain, bounded HTTP RPC and private operations. No signing keys. */
import type { Server } from "node:http";
import { createRpcPool, loadRpcEndpoints } from "@ghostlink/service-kit/rpc";
import { buildServer } from "./server.js";
import { operatorServer, validateGenesis } from "./operations.js";

async function main() {
  const genesisHash = process.env.ACTIONS_GENESIS_HASH;
  if (!genesisHash) throw new Error("approved Actions genesis required");
  validateGenesis(genesisHash);
  // A legacy public-chain label is not a verified migration for the V2 candidate.
  if (process.env.CLUSTER && process.env.CLUSTER !== "localnet") throw new Error("unverified Actions cluster configuration");
  const port = Number(process.env.PORT ?? 8790), operationsPort = Number(process.env.OPERATIONS_PORT ?? 18790);
  for (const n of [port, operationsPort]) if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("invalid Actions port");
  if (port === operationsPort) throw new Error("Actions ports must differ");
  const rpc = createRpcPool({ genesisHash, endpoints: loadRpcEndpoints(process.env.RPC_ENDPOINTS_PATH, process.env.RPC_URL) });
  let server: ReturnType<typeof buildServer> | undefined, operator: Server | undefined;
  try {
    await rpc.connection.getGenesisHash();
    server = buildServer({ connection: rpc.connection, genesisHash, baseUrl: process.env.BASE_URL ?? `http://localhost:${port}`,
      maxInFlight: Number(process.env.ACTIONS_MAX_IN_FLIGHT ?? 8), trustProxy: process.env.TRUST_PROXY === "1" });
    operator = operatorServer(server.operations, rpc.status);
    await new Promise<void>((resolve, reject) => { operator!.once("error", reject); operator!.listen(operationsPort, "127.0.0.1", resolve); });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(port, resolve); });
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true; server!.operations.drain();
      let closed = false; server!.close(() => { closed = true; });
      const deadline = setTimeout(() => { server!.closeAllConnections(); operator!.closeAllConnections(); rpc.close(); process.exit(1); }, 30_000);
      deadline.unref();
      const wait = setInterval(() => {
        if (!closed || !server!.operations.idle) return;
        clearInterval(wait); clearTimeout(deadline); server!.operations.stop(); operator!.close(); rpc.close();
      }, 50);
    };
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    console.log(`ghostlink actions on :${port}`);
  } catch (error) { server?.operations.stop(); server?.close(); operator?.close(); rpc.close(); throw error; }
}
void main().catch(() => { console.error("Actions startup failed; check approved configuration and dependencies"); process.exitCode = 1; });
