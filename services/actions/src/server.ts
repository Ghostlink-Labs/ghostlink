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
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { hexToBytes } from "@ghostlink/common";
import {
  Router,
  ataAddress,
  badRequest,
  createAtaIdempotentIx,
  isPocketAccount,
  pocketPda,
  splTransferIx,
} from "@ghostlink/service-kit";

export interface ActionsDeps {
  connection: Connection;
  /** Public origin of this endpoint, for icon/link URLs. */
  baseUrl: string;
  /** Which chain the transactions are for; sets the X-Blockchain-Ids header. */
  cluster?: "devnet" | "mainnet-beta";
}

/** CAIP-2 ids the Actions spec expects in X-Blockchain-Ids. */
const BLOCKCHAIN_IDS = {
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MAX_SOL_DEPOSIT = 1_000_000n * 1_000_000_000n;

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#555"/>' +
  '<path d="M16 32h32M32 16v32" stroke="#fff" stroke-width="4"/></svg>';

export function buildServer(deps: ActionsDeps): Server {
  const router = new Router();
  const spec = {
    "x-action-version": "2.4",
    "x-blockchain-ids": BLOCKCHAIN_IDS[deps.cluster ?? "devnet"],
    "access-control-expose-headers": "x-action-version,x-blockchain-ids",
  };

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
        icon: `${deps.baseUrl}/icon.svg`,
        /** The destination, so clients can compare it with their own derivation. */
        pocket,
        title: "Fund a GhostLink pocket",
        description:
          `Deposit into pocket ${pocket}. Only deposit into a pocket you opened yourself: ` +
          "a pocket can only ever send funds to the home address its owner chose.",
        label: "Deposit",
        links: {
          actions: [
            {
              type: "transaction",
              label: "Deposit SOL",
              href: `${deps.baseUrl}/actions/fund/${params.appIdHex}?amount={amount}`,
              parameters: [{ name: "amount", label: "Amount in SOL", required: true }],
            },
          ],
        },
      },
    };
  });

  router.post("/actions/fund/:appIdHex", async ({ params, query, body }) => {
    const appId = safeAppId(params.appIdHex);
    if (!appId) throw badRequest("bad app id");
    const req = body as { account?: string } | undefined;
    let user: PublicKey;
    try {
      user = new PublicKey(req?.account ?? "");
    } catch {
      throw badRequest("account must be a base58 public key");
    }
    const pocket = pocketPda(appId);
    if (!isPocketAccount(await deps.connection.getAccountInfo(pocket, "confirmed"), appId)) {
      throw badRequest("no pocket is open for this app id; sign in to the app first");
    }

    const mintParam = query.get("mint");
    const tx = new Transaction();
    if (mintParam) {
      // SPL deposit: user's ATA -> the pocket's ATA (created if missing).
      let mint: PublicKey;
      try {
        mint = new PublicKey(mintParam);
      } catch {
        throw badRequest("mint must be a base58 public key");
      }
      const mintInfo = await deps.connection.getAccountInfo(mint, "confirmed");
      if (!mintInfo || !mintInfo.owner.equals(TOKEN_PROGRAM)) {
        throw badRequest("mint must be an SPL Token mint (Token-2022 is not supported in v1)");
      }
      const amount = parseRawAmount(query.get("rawAmount"));
      tx.add(
        createAtaIdempotentIx(user, pocket, mint),
        splTransferIx(ataAddress(user, mint), ataAddress(pocket, mint), user, amount),
      );
    } else {
      const lamports = parseSolAmount(query.get("amount"));
      tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: pocket, lamports }));
    }

    tx.feePayer = user;
    tx.recentBlockhash = (await deps.connection.getLatestBlockhash()).blockhash;
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return {
      headers: spec,
      json: {
        type: "transaction",
        transaction: serialized.toString("base64"),
        message: `Deposit into pocket ${pocket.toBase58()}`,
      },
    };
  });

  return router.server();
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
