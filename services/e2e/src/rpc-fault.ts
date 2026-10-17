/** Disposable local-validator HTTP fault injection; never a production proxy. */
import { createServer } from "node:http";
import { once } from "node:events";
import type { Connection } from "@solana/web3.js";
import { createRpcPool } from "@ghostlink/service-kit/rpc";

export async function startRpcFaultFixture(upstream: Connection) {
  const url = new URL(upstream.rpcEndpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("RPC fault drill requires loopback");
  const genesisHash = await upstream.getGenesisHash();
  if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(genesisHash)) throw new Error("RPC fault drill refuses public genesis");
  let armed = false, dropped = false, secondaryStatus = 0, outage = false;
  const sent: { provider: number; body: string }[] = [];
  const servers = [0, 1].map(index => createServer(async (req, res) => {
    try {
      if (outage) { req.resume(); res.writeHead(503); res.end(); return; }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 256 * 1024) throw new Error("oversized test request");
      }
      const request = JSON.parse(body);
      if (request.method === "sendTransaction") sent.push({ provider: index, body });
      if (index === 1 && request.method === "getSignatureStatuses") secondaryStatus++;
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(3000) });
      const result = await response.text();
      if (armed && !dropped && index === 0 && request.method === "sendTransaction") {
        const reply = JSON.parse(result);
        if (typeof reply.result !== "string") throw new Error("fault boundary did not reach accepted send");
        dropped = true; res.destroy(); return;
      }
      res.writeHead(response.status, { "content-type": "application/json" }); res.end(result);
    } catch { if (!res.destroyed) { res.writeHead(502); res.end(); } }
  }));
  const closeServers = async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
  try {
    const endpoints = [];
    for (const server of servers) {
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw new Error("no fault proxy address");
      endpoints.push({ url: `http://127.0.0.1:${address.port}` });
    }
    const pool = createRpcPool({ genesisHash, endpoints });
    return { connection: pool.connection, arm: () => { armed = true; }, outage: (value: boolean) => { outage = value; },
      assertRecovered() {
        if (!dropped || !secondaryStatus || sent.length < 2 || sent[0]!.provider !== 0 || sent[1]!.provider !== 1 || sent[0]!.body !== sent[1]!.body) {
          throw new Error("RPC failover did not preserve the accepted transaction and reconcile through the fallback");
        }
      },
      async close() { pool.close(); await closeServers(); },
    };
  } catch (e) { await closeServers(); throw e; }
}
