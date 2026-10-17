/**
 * Wire types shared by the SDK and the off-chain services. Everything is
 * JSON-safe: byte arrays travel as lowercase hex, field elements as
 * decimal strings, amounts/slots as decimal strings.
 */

export type TreeName = "registry" | "census";

/** GET /roots/:tree */
export interface RootsResponse {
  tree: TreeName;
  /** Most recent root last; all as decimal field elements. */
  roots: string[];
  nextIndex: number;
}

/** GET /leaves/:tree?from=&limit= — a page of leaves, for building witnesses locally. */
export interface LeavesResponse {
  tree: TreeName;
  from: number;
  /** Decimal field elements in append order. */
  leaves: string[];
  nextIndex: number;
}

/** GET /path/:tree/:leafIndex */
export interface PathResponse {
  tree: TreeName;
  index: number;
  siblings: string[];
  /** The root this path hashes to (decimal). */
  root: string;
}

/** GET /census/latest?wallet=<base58>&mint=<base58> */
export interface CensusLatestResponse {
  leafIndex: number;
  wallet: string;
  mint: string;
  amount: string;
  slot: string;
}

/** GET /registry/binding/:wallet */
export interface BindingResponse {
  leafIndex: number;
  commitment: string; // hex32
  slot: string;
}

/** POST /register */
export interface RegisterRequest {
  walletPubkey: string; // base58
  messageHex: string;
  signatureHex: string;
  commitmentHex: string;
}

/** POST /snapshot */
export interface SnapshotRequest {
  wallet: string; // base58
  /** Token account to snapshot, or the wallet itself for native SOL. */
  holding: string; // base58
}

/** POST /open-session */
export interface OpenSessionRequest {
  proofAHex: string;
  proofBHex: string;
  proofCHex: string;
  registryRootHex: string;
  censusRootHex: string;
  domainHashHex: string;
  appIdHex: string;
  mint: string; // base58
  threshold: string;
  minSlot: string;
  claimHoldings: boolean;
  sessionKind: 0 | 1;
  sessionKeyHex: string; // 33 bytes
  sessionExpirySlot: string;
  home: string; // base58
  /** Required at pocket creation. */
  policy?: PolicyDto;
}

export interface PolicyDto {
  dailyCapUsdE6: string;
  maxSlippageBps: number;
  bigActionThresholdUsdE6: string;
  noOracleCapUsdE6: string;
  sessionMaxSlots: string;
  allowedOutMints: string[]; // base58
  oracleFeeds: { mint: string; feedIdHex: string; decimals: number }[];
  speculative?: {
    dailyBuyCapUsdE6: string;
    maxCostExposureUsdE6: string;
    maxPositions: number;
    baseMints: string[];
  };
}

/** POST /intent (to the solver) */
export interface IntentRequest {
  pocket: string; // base58
  nonce: string;
  inMint: string;
  inMax: string;
  outMint: string;
  outMin: string;
  deadlineSlot: string;
  policyHashHex: string;
  sessionKind: 0 | 1;
  /** 64-byte session signature over SHA-256 of the canonical bytes. */
  signatureHex: string;
  /** The signing key: 32 bytes (ed25519) or 33 (p256), hex. */
  sessionKeyHex: string;
  webauthn?: { authenticatorDataHex: string; clientDataJsonUtf8: string };
}

export interface TxResponse {
  signature: string;
}

/** Submission is not settlement. Only confirmed/finalized states establish success. */
export interface IntentSubmission {
  intentHashHex: string;
  state: "preparing" | "pending" | "confirmed" | "finalized" | "failed" | "expired" | "unknown";
  signature?: string;
  slot?: number;
  confirmationStatus?: "confirmed" | "finalized";
  reason?: string;
  chainError?: unknown;
}

/** Owner-proof-authorized relayer calls (sweep, changes, revoke). */
export interface OwnerActionRequest {
  pocket: string; // base58
  action: "sweep" | "revoke" | "propose" | "cancel";
  /** Sweep: must match the current on-chain recovery home. */
  home?: string;
  /** Sweep: omit destination to select/create a clean account owned by home. Explicit destinations are never substituted. */
  tokenPairs?: { source: string; destination?: string; mint?: string }[];
  /** borsh-encoded Change for propose, hex; omitted otherwise. */
  changeHex?: string;
  proofAHex: string;
  proofBHex: string;
  proofCHex: string;
  registryRootHex: string;
}
