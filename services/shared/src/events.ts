/**
 * Anchor event decoding from transaction logs. Events arrive as
 * "Program data: <base64>" lines whose payload is an 8-byte event
 * discriminator (sha256("event:<Name>")[..8]) followed by borsh fields.
 *
 * Discriminators are public, so any program can emit a byte-identical
 * line. `decodeLogs` therefore tracks the invoke/success framing and
 * attributes each line to the program that was executing, accepting an
 * event only when its rightful program emitted it at the top level.
 */
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import { CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID } from "@ghostlink/common";

export function eventDisc(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`event:${name}`)).subarray(0, 8);
}

class Reader {
  private off = 0;
  constructor(private readonly buf: Uint8Array) {}

  private take(length: number): Uint8Array {
    if (this.off + length > this.buf.length) throw new Error("truncated event");
    const out = this.buf.subarray(this.off, this.off + length);
    this.off += length;
    return out;
  }

  get done(): boolean { return this.off === this.buf.length; }

  u64(): bigint {
    let v = 0n;
    const bytes = this.take(8);
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
    return v;
  }

  bytes32(): Uint8Array {
    return this.take(32);
  }

  pubkey(): string {
    return bs58.encode(this.bytes32());
  }

  bool(): boolean {
    const value = this.take(1)[0];
    if (value !== 0 && value !== 1) throw new Error("invalid event boolean");
    return value === 1;
  }

  tradeMode(): 0 | 1 | 2 {
    const value = this.take(1)[0];
    if (value !== 0 && value !== 1 && value !== 2) throw new Error("invalid event trade mode");
    return value;
  }
}

export interface RegisteredEvent {
  kind: "Registered";
  leafIndex: bigint;
  leaf: Uint8Array;
  root: Uint8Array;
  wallet: string;
  commitment: Uint8Array;
}

export interface SnapshotTakenEvent {
  kind: "SnapshotTaken";
  leafIndex: bigint;
  leaf: Uint8Array;
  root: Uint8Array;
  wallet: string;
  mint: string;
  amount: bigint;
  slot: bigint;
}

export interface SessionOpenedEvent {
  kind: "SessionOpened";
  pocket: string;
  appId: Uint8Array;
  created: boolean;
  sessionExpirySlot: bigint;
}

export interface FilledEvent {
  kind: "Filled";
  pocket: string;
  intentHash: Uint8Array;
  inMint: string;
  inMax: bigint;
  outMint: string;
  outReceived: bigint;
  inValueUsdE6: bigint;
  mode: 0 | 1 | 2;
  releasedCostUsdE6: bigint;
}

export interface ChangeProposedEvent {
  kind: "ChangeProposed";
  pocket: string;
  executableAfterSlot: bigint;
}

export interface SweptHomeEvent {
  kind: "SweptHome";
  pocket: string;
  home: string;
}

export interface SessionRevokedEvent {
  kind: "SessionRevoked";
  pocket: string;
}

export interface ChangeExecutedEvent {
  kind: "ChangeExecuted";
  pocket: string;
}

export interface ChangeCanceledEvent {
  kind: "ChangeCanceled";
  pocket: string;
}

export type GhostLinkEvent =
  | RegisteredEvent
  | SnapshotTakenEvent
  | SessionOpenedEvent
  | FilledEvent
  | ChangeProposedEvent
  | SweptHomeEvent
  | SessionRevokedEvent
  | ChangeExecutedEvent
  | ChangeCanceledEvent;

const DISCS: [string, (r: Reader) => GhostLinkEvent][] = [
  [
    "Registered",
    (r) => ({
      kind: "Registered",
      leafIndex: r.u64(),
      leaf: r.bytes32(),
      root: r.bytes32(),
      wallet: r.pubkey(),
      commitment: r.bytes32(),
    }),
  ],
  [
    "SnapshotTaken",
    (r) => ({
      kind: "SnapshotTaken",
      leafIndex: r.u64(),
      leaf: r.bytes32(),
      root: r.bytes32(),
      wallet: r.pubkey(),
      mint: r.pubkey(),
      amount: r.u64(),
      slot: r.u64(),
    }),
  ],
  [
    "SessionOpened",
    (r) => ({
      kind: "SessionOpened",
      pocket: r.pubkey(),
      appId: r.bytes32(),
      created: r.bool(),
      sessionExpirySlot: r.u64(),
    }),
  ],
  [
    "Filled",
    (r) => ({
      kind: "Filled",
      pocket: r.pubkey(),
      intentHash: r.bytes32(),
      inMint: r.pubkey(),
      inMax: r.u64(),
      outMint: r.pubkey(),
      outReceived: r.u64(),
      inValueUsdE6: r.u64(),
      mode: r.tradeMode(),
      releasedCostUsdE6: r.u64(),
    }),
  ],
  [
    "ChangeProposed",
    (r) => ({
      kind: "ChangeProposed",
      pocket: r.pubkey(),
      executableAfterSlot: r.u64(),
    }),
  ],
  [
    "SweptHome",
    (r) => ({ kind: "SweptHome", pocket: r.pubkey(), home: r.pubkey() }),
  ],
  ["SessionRevoked", (r) => ({ kind: "SessionRevoked", pocket: r.pubkey() })],
  ["ChangeExecuted", (r) => ({ kind: "ChangeExecuted", pocket: r.pubkey() })],
  ["ChangeCanceled", (r) => ({ kind: "ChangeCanceled", pocket: r.pubkey() })],
];

const discTable = DISCS.map(([name, parse]) => ({ disc: eventDisc(name), parse }));

export function decodeEventData(payload: Uint8Array): GhostLinkEvent | null {
  if (payload.length < 8) return null;
  for (const { disc, parse } of discTable) {
    if (disc.every((b, i) => payload[i] === b)) {
      try {
        const reader = new Reader(payload.subarray(8));
        const event = parse(reader);
        return reader.done ? event : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The only program allowed to emit each event, and only at depth 1. */
export const EVENT_EMITTER: Record<GhostLinkEvent["kind"], string> = {
  Registered: REGISTRY_PROGRAM_ID,
  SnapshotTaken: CENSUS_PROGRAM_ID,
  SessionOpened: POCKET_PROGRAM_ID,
  Filled: POCKET_PROGRAM_ID,
  ChangeProposed: POCKET_PROGRAM_ID,
  SweptHome: POCKET_PROGRAM_ID,
  SessionRevoked: POCKET_PROGRAM_ID,
  ChangeExecuted: POCKET_PROGRAM_ID,
  ChangeCanceled: POCKET_PROGRAM_ID,
};

const INVOKE = /^Program (\S+) invoke \[(\d+)\]$/;
const FINISH = /^Program (\S+) (success$|failed:.*$)/;
const DATA = /^Program data: (.+)$/;

/**
 * Scans a transaction's log lines for GhostLink events, keeping track of
 * which program is executing. Lines outside any invoke frame, inside a
 * CPI (depth > 1) or emitted by a foreign program are ignored.
 */
export function decodeLogs(logs: string[]): GhostLinkEvent[] {
  const out: GhostLinkEvent[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    if (typeof line !== "string") return [];
    const invoke = INVOKE.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1) return [];
      stack.push(invoke[1]!);
      continue;
    }
    const finish = FINISH.exec(line);
    if (finish) {
      if (stack[stack.length - 1] !== finish[1]) return [];
      // Failure of a top-level instruction rolls back the entire transaction,
      // including events emitted by earlier successful instructions.
      if (stack.length === 1 && finish[2] !== "success") return [];
      stack.pop();
      continue;
    }
    const m = DATA.exec(line);
    if (!m) continue;
    if (stack.length !== 1) continue;
    const emitter = stack[0]!;
    try {
      const ev = decodeEventData(Uint8Array.from(Buffer.from(m[1]!, "base64")));
      if (ev && EVENT_EMITTER[ev.kind] === emitter) out.push(ev);
    } catch {
      // malformed payload: not ours
    }
  }
  return stack.length === 0 ? out : [];
}

/** Wraps event lines in the invoke/success frame a real transaction has (tests, simulations). */
export function frameAsProgramLogs(programId: string, lines: string[]): string[] {
  return [`Program ${programId} invoke [1]`, ...lines, `Program ${programId} success`];
}
