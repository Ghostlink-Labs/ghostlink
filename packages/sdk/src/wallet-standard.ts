/**
 * Wallet Standard facade (build plan, section 8).
 *
 * Registers GhostLink with `standard:connect` and a custom
 * `ghostlink:signIn` feature returning a proof and a signed challenge.
 * Consumers must implement GhostLink verification; a pocket is a PDA,
 * so it cannot return the Ed25519 signature required by `solana:signIn`.
 * Transaction-signing features are deliberately absent.
 *
 * Implemented against the standard's wire shape (plain objects + the
 * `wallet-standard:register-wallet` event) with no dependency on the
 * reference packages.
 */
import { loginChallengeDigest, pocketPda, toBase58 } from "@ghostlink/common";
import type { GhostLinkSession } from "./ghostlink.js";
import type { SessionKind, SessionSignature } from "./session.js";
export { loginChallengeDigest };

// Neutral placeholder; product artwork is not distributed with the SDK.
const GHOSTLINK_ICON =
  "data:image/svg+xml;base64," +
  (typeof btoa !== "undefined"
    ? btoa(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#555"/><path d="M8 16h16M16 8v16" stroke="#fff" stroke-width="2"/></svg>`,
      )
    : "");

export interface WalletStandardAccount {
  address: string;
  publicKey: Uint8Array;
  chains: string[];
  features: string[];
}

export interface GhostLinkWalletOptions {
  /** Runs the GhostLink login flow and resolves with the session. */
  login: () => Promise<GhostLinkSession>;
  chain?: "solana:mainnet" | "solana:devnet" | "solana:localnet";
  name?: string;
}

export interface GhostLinkSignInOutput {
  account: WalletStandardAccount;
  /** Pass this and publicSignals to @ghostlink/verify. */
  proof: object;
  publicSignals: string[];
  session: { kind: SessionKind; key32: Uint8Array; key33: Uint8Array; expirySlot: bigint };
  /** Verify over loginChallengeDigest(serverNonce), then consume the nonce. */
  challengeSignature: SessionSignature;
}

/** Builds the wallet object; exported separately for tests. */
export function createGhostLinkWallet(options: GhostLinkWalletOptions) {
  const chain = options.chain ?? "solana:devnet";
  let accounts: WalletStandardAccount[] = [];
  let connecting: Promise<GhostLinkSession> | undefined;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  function emit(event: string, ...args: unknown[]) {
    for (const cb of listeners.get(event) ?? []) cb(...args);
  }

  function accountFor(session: GhostLinkSession): WalletStandardAccount {
    const pocket = pocketPda(session.appId).address;
    return { address: toBase58(pocket), publicKey: pocket, chains: [chain], features: ["ghostlink:signIn"] };
  }

  async function login(): Promise<GhostLinkSession> {
    if (connecting) return connecting;
    connecting = (async () => {
      const session = await options.login();
      accounts = [accountFor(session)];
      emit("change", { accounts });
      return session;
    })();
    try {
      return await connecting;
    } finally {
      connecting = undefined;
    }
  }

  async function connect(): Promise<{ accounts: WalletStandardAccount[] }> {
    if (accounts.length === 0) await login();
    return { accounts };
  }

  return {
    version: "1.0.0" as const,
    name: options.name ?? "GhostLink",
    icon: GHOSTLINK_ICON as `data:image/svg+xml;base64,${string}`,
    chains: [chain],
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": { version: "1.0.0", connect },
      "standard:events": {
        version: "1.0.0",
        on(event: string, cb: (...args: unknown[]) => void) {
          const set = listeners.get(event) ?? new Set();
          set.add(cb);
          listeners.set(event, set);
          return () => set.delete(cb);
        },
      },
      "ghostlink:signIn": {
        version: "1.0.0",
        /**
         * The challenge must come from the app's backend. The backend
         * verifies both the login proof/session binding AND this signature,
         * and consumes its challenge exactly once before issuing a cookie.
         */
        async signIn(input: { challenge: Uint8Array }): Promise<GhostLinkSignInOutput> {
          const digest = loginChallengeDigest(input?.challenge);
          // Refresh the proof/session for every login; connect may have
          // happened long before, and its session may already have expired.
          const session = await login();
          const challengeSignature = await session.signer.sign(digest);
          return {
            account: accountFor(session),
            proof: session.proof.snarkjsProof,
            publicSignals: session.proof.publicSignals,
            session: { kind: session.signer.kind, key32: session.signer.key32, key33: session.signer.key33, expirySlot: session.expirySlot },
            challengeSignature,
          };
        },
      },
      // No solana:signTransaction, by design.
    },
  };
}

/**
 * Announces the wallet to the page per the Wallet Standard handshake.
 * Returns a function that stops answering future app-ready events.
 */
export function registerGhostLinkWallet(options: GhostLinkWalletOptions): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wallet = createGhostLinkWallet(options);
  const callback = ({ register }: { register: (w: unknown) => unknown }) => register(wallet);
  try {
    window.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", { detail: callback }),
    );
  } catch {
    // older runtimes: ignore
  }
  const onReady = ((event: CustomEvent) => {
    (event.detail as { register: (w: unknown) => unknown }).register(wallet);
  }) as EventListener;
  window.addEventListener("wallet-standard:app-ready", onReady);
  return () => window.removeEventListener("wallet-standard:app-ready", onReady);
}
