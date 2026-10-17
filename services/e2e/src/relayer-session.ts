/** Disposable-localnet relayer with a real persistent journal and an optional lost-reply drill. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Connection, Keypair } from "@solana/web3.js";
import { POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import { buildServer } from "@ghostlink/relayer/server";
import { RelayerJournal } from "@ghostlink/relayer/journal";

export async function startRelayerFixture(connection: Connection, payer: Keypair, port = 0) {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-relayer-e2e-")), path = join(dir, "relayer.db"), key = randomBytes(32);
  const scope = { genesisHash: await connection.getGenesisHash(), payer: payer.publicKey.toBase58(), pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() };
  let armed = false, hidden = false;
  const packets: string[] = [];
  const transport = new Proxy(connection, { get(target, prop) {
    if (prop === "sendRawTransaction") return async (...args: Parameters<Connection["sendRawTransaction"]>) => {
      packets.push(Buffer.from(args[0]).toString("base64"));
      const signature = await target.sendRawTransaction(...args);
      if (armed) { armed = false; hidden = true; throw new Error("synthetic accepted reply lost"); }
      return signature;
    };
    if (prop === "getSignatureStatuses") return async (...args: Parameters<Connection["getSignatureStatuses"]>) => {
      if (hidden) throw new Error("synthetic receipt outage");
      return target.getSignatureStatuses(...args);
    };
    const value = Reflect.get(target, prop, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  let journal = new RelayerJournal(path, key, scope), server = buildServer({ connection: transport, payer, journal, minWalletLamports: 1n });
  async function listen() {
    server.listen(port, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert(address && typeof address !== "string"); port = address.port;
    const deadline = Date.now() + 20_000;
    while (!server.operations.snapshot().ready && Date.now() < deadline) await delay(100);
    assert(server.operations.snapshot().ready, "relayer did not establish advancing chain and funding readiness");
    return `http://127.0.0.1:${port}`;
  }
  const url = await listen();
  async function stop() {
    server.drain(); assert.equal(server.active, 0); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const deadline = Date.now() + 15_000;
    while (!server.operations.idle && Date.now() < deadline) await delay(50);
    assert(server.operations.idle, "relayer probe did not drain"); server.operations.stop(); journal.close();
  }
  return { url,
    arm() { armed = true; hidden = false; packets.length = 0; },
    async restart() { await stop(); hidden = false; journal = new RelayerJournal(path, key, scope); server = buildServer({ connection: transport, payer, journal, minWalletLamports: 1n }); return listen(); },
    spent: () => journal.spent(),
    assertSinglePacket() { assert.equal(new Set(packets).size, 1); },
    async close() { await stop(); key.fill(0); rmSync(dir, { recursive: true, force: true }); },
  };
}
