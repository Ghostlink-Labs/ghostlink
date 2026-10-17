import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { WebhookNotifier } from "../src/index.js";

async function endpoint(handler: RequestListener) {
  const server = createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  return { url: `http://127.0.0.1:${address.port}`,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it("refuses redirects instead of forwarding notifications to an unapproved destination", async () => {
  let forwarded = 0;
  const other = await endpoint((req, res) => { forwarded++; req.resume(); res.end(); });
  const approved = await endpoint((req, res) => { req.resume(); res.writeHead(307, { location: other.url }); res.end(); });
  try {
    await expect(new WebhookNotifier(approved.url).notify("fixture", { signature: "synthetic" })).rejects.toThrow(/notification delivery failed/);
    expect(forwarded).toBe(0);
  } finally { await approved.close(); await other.close(); }
});

it("closes an unused streaming response and keeps failed-delivery diagnostics private", async () => {
  let closed = false;
  const receiver = await endpoint((req, res) => {
    req.resume(); res.on("close", () => { closed = true; });
    res.writeHead(200); res.write("unneeded response kept open");
  });
  try {
    await new WebhookNotifier(receiver.url).notify("fixture", {});
    await expect.poll(() => closed, { timeout: 1000 }).toBe(true);
    const marker = "SYNTHETIC_WEBHOOK_SECRET";
    const notifier = new WebhookNotifier(receiver.url, (async () => { throw new Error(marker); }) as typeof fetch);
    const error = await notifier.notify("fixture", {}).catch(error => error);
    expect(String(error)).not.toContain(marker);
  } finally { await receiver.close(); }
});
