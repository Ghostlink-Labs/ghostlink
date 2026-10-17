/**
 * Solana Actions (Blinks) for funding pockets (build plan 4.3).
 *
 * GET returns the action metadata wallets unfurl; POST returns an
 * unsigned deposit transaction for the USER's wallet to simulate and
 * sign. The destination is always recomputed from the app id — never
 * taken from the request — and must already be an opened pocket, so a
 * typo or a hostile link cannot route a deposit into a dead address.
 */
import type { Server } from "node:http";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import { hexToBytes } from "@ghostlink/common";
import {
  Router,
  HttpError,
  RateLimiter,
  clientIp,
  badRequest,
  pocketPda,
} from "@ghostlink/service-kit";

import { ActionsOperations, type OperationsOptions } from "./operations.js";
import { depositTransaction } from "./funding.js";

export interface ActionsDeps {
  connection: Connection;
  /** Public origin of this endpoint, for icon/link URLs. */
  baseUrl: string;
  /** Independently approved chain; never selected by a deposit request. */
  genesisHash: string;
  maxInFlight?: number;
  trustProxy?: boolean;
  probe?: Pick<OperationsOptions, "probeIntervalMs" | "probeTimeoutMs" | "freshnessMs" | "progressTimeoutMs" | "clock">;
}

const MAX_SOL_DEPOSIT = 1_000_000n * 1_000_000_000n;

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#555"/>' +
  '<path d="M16 32h32M32 16v32" stroke="#fff" stroke-width="4"/></svg>';

export function buildServer(deps: ActionsDeps): Server & { operations: ActionsOperations } {
  const operations = new ActionsOperations({ connection: deps.connection, genesisHash: deps.genesisHash,
    maxInFlight: deps.maxInFlight, ...deps.probe });
  const origin = new URL(deps.baseUrl);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Actions BASE_URL must be an HTTPS origin or loopback HTTP origin");
  }
  const baseUrl = origin.origin;
  const router = new Router({ errorProperty: "message" }), limiter = new RateLimiter(30, 60_000);
  const spec = {
    "x-action-version": "2.4",
    "x-blockchain-ids": `solana:${deps.genesisHash.slice(0, 32)}`,
    "cache-control": "no-store",
    "access-control-expose-headers": "x-action-version,x-blockchain-ids",
  };

  router.get("/health", async () => ({ json: { ok: true } }));
  router.get("/ready", async () => {
    const { ready, checks } = operations.snapshot();
    return { status: ready ? 200 : 503, json: { ready, checks }, headers: { "cache-control": "no-store", "retry-after": "1" } };
  });
  for (const path of ["/actions.json", "/actions/fund/:appIdHex"]) router.options(path, async () => ({ status: 204, headers: {
    ...spec, "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,content-encoding,accept-encoding,x-action-version,x-blockchain-ids,x-accept-action-version,x-accept-blockchain-ids",
  } }));

  router.get("/actions.json", async () => ({
    json: { rules: [{ pathPattern: "/actions/**", apiPath: "/actions/**" }] },
    headers: spec,
  }));

  router.get("/icon.svg", async () => ({
    text: ICON_SVG,
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
  }));

  router.get("/actions/fund/:appIdHex", async ({ params }) => {
    const appId = safeAppId(params.appIdHex);
    if (!appId) throw badRequest("bad app id");
    const pocket = pocketPda(appId).toBase58();
    return {
      headers: spec,
      json: {
        type: "action",
        disabled: !operations.snapshot().ready,
        icon: `${baseUrl}/icon.svg`,
        /** The destination, so clients can compare it with their own derivation. */
        pocket,
        title: "Fund a GhostLink pocket",
        description:
          `Deposit into pocket ${pocket}. Only deposit into a pocket you opened yourself: ` +
          "owner withdrawals return to the configured home address; authorized swaps also spend pocket funds.",
        label: "Deposit",
        links: {
          actions: [
            {
              type: "transaction",
              label: "Deposit SOL",
              href: `${baseUrl}/actions/fund/${params.appIdHex}?amount={amount}`,
              parameters: [{ name: "amount", label: "Amount in SOL", required: true }],
            },
          ],
        },
      },
    };
  });

  router.post("/actions/fund/:appIdHex", async ({ params, query, body, raw }) => {
    if (!limiter.allow(clientIp(raw, deps.trustProxy))) throw new HttpError(429, "rate limited");
    const release = operations.acquire();
    if (!release) throw new HttpError(503, "funding service not ready or busy");
    try {
      const appId = safeAppId(params.appIdHex);
      if (!appId) throw badRequest("bad app id");
      if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("account required");
      const account = (body as { account?: unknown }).account;
      let user: PublicKey;
      try { if (typeof account !== "string") throw new Error(); user = new PublicKey(account); }
      catch { throw badRequest("account must be a base58 public key"); }
      for (const name of ["mint", "rawAmount", "amount"]) if (query.getAll(name).length > 1) throw badRequest("duplicate deposit parameter");
      let mint: PublicKey | undefined;
      if (query.has("mint")) {
        try { mint = new PublicKey(query.get("mint")!); } catch { throw badRequest("mint must be a base58 public key"); }
        if (query.has("amount")) throw badRequest("token deposits require rawAmount only");
      } else if (query.has("rawAmount")) throw badRequest("rawAmount requires a mint");
      const amount = mint ? parseRawAmount(query.get("rawAmount")) : parseSolAmount(query.get("amount"));
      const tx = await depositTransaction(deps.connection, operations, user, appId, amount, mint);
      return { headers: spec, json: { type: "transaction",
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        message: `Deposit into pocket ${pocketPda(appId).toBase58()}` } };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "funding evidence unavailable; retry after checking the original request");
    } finally { release(); }
  });

  const server = Object.assign(router.server(), { operations });
  // Chain/version headers also accompany parser/router errors and preflight responses.
  server.prependListener("request", (_request, response) => {
    for (const [name, value] of Object.entries(spec)) response.setHeader(name, value);
  });
  server.once("listening", () => operations.start());
  server.once("close", () => operations.drain());
  return server;
}

function safeAppId(hex: string | undefined): Uint8Array | null {
  if (!hex || hex.length !== 64 || /[^0-9a-f]/i.test(hex)) return null;
  try {
    return hexToBytes(hex);
  } catch {
    return null;
  }
}

/** "1.25" SOL -> lamports with integer arithmetic only. */
export function parseSolAmount(text: string | null): bigint {
  const m = /^(\d{1,7})(?:\.(\d{1,9}))?$/.exec(text ?? "");
  if (!m) throw badRequest("amount must be a decimal number of SOL with at most 9 decimals");
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(9, "0"));
  const lamports = whole * 1_000_000_000n + frac;
  if (lamports <= 0n) throw badRequest("amount must be positive");
  if (lamports > MAX_SOL_DEPOSIT) throw badRequest("amount too large");
  return lamports;
}

export function parseRawAmount(text: string | null): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text ?? "")) throw badRequest("rawAmount must be a positive integer string");
  const v = BigInt(text!);
  if (v <= 0n) throw badRequest("rawAmount must be positive");
  if (v > 0xffffffffffffffffn) throw badRequest("rawAmount exceeds u64");
  return v;
}
