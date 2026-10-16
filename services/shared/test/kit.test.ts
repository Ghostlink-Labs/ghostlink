/** Byte-layout checks for the service kit against known shapes. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { hexToBytes } from "@ghostlink/common";
import { CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID } from "@ghostlink/common";
import {
  BorshWriter,
  decodeEventData,
  decodeLogs,
  disc,
  ed25519Ix,
  eventDisc,
  fillStatePda,
  frameAsProgramLogs,
  pocketPda,
  writeIntentArgs,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vectors = JSON.parse(
  readFileSync(join(root, "packages/common/fixtures/vectors.json"), "utf8"),
);

describe("instruction encoding", () => {
  it("derives the fixture pocket PDA", () => {
    const appId = hexToBytes(
      BigInt(vectors.pdas.pocket.appId).toString(16).padStart(64, "0"),
    );
    expect(pocketPda(appId).toBase58()).toBe(vectors.pdas.pocket.address);
  });

  it("IntentArgs borsh layout is 128 fixed bytes in field order", () => {
    const f = vectors.intent.fields;
    const w = new BorshWriter();
    writeIntentArgs(w, {
      nonce: BigInt(f.nonce),
      inMint: new PublicKey(hexToBytes(f.inMint)),
      inMax: BigInt(f.inMax),
      outMint: new PublicKey(hexToBytes(f.outMint)),
      outMin: BigInt(f.outMin),
      deadlineSlot: BigInt(f.deadlineSlot),
      policyHash: hexToBytes(f.policyHash),
    });
    const bytes = w.out();
    expect(bytes.length).toBe(128);
    // nonce u64 LE at the front
    expect(bytes[0]).toBe(7);
    // policy hash at the tail
    expect(Buffer.from(bytes.subarray(96)).toString("hex")).toBe(f.policyHash);
  });

  it("anchor discriminators are sha256(global:name)[..8]", () => {
    expect(Buffer.from(disc("fill_end")).toString("hex")).toHaveLength(16);
    expect(disc("fill_end")).not.toEqual(disc("fill_begin"));
  });

  it("fill state PDA uses little-endian nonce seeds", () => {
    const pocket = new PublicKey(vectors.pdas.pocket.address);
    expect(() => fillStatePda(pocket, 7n)).not.toThrow();
  });
});

describe("precompile layout", () => {
  it("builds a single-signature ed25519 instruction with self-referencing offsets", () => {
    const pk = new Uint8Array(32).fill(1);
    const sig = new Uint8Array(64).fill(2);
    const msg = new Uint8Array(32).fill(3);
    const ix = ed25519Ix(pk, sig, msg);
    const d = ix.data;
    expect(d[0]).toBe(1);
    const u16 = (i: number) => d.readUInt16LE(i);
    const pkOff = u16(6);
    const sigOff = u16(2);
    const msgOff = u16(10);
    expect(u16(4)).toBe(0xffff);
    expect(d.subarray(pkOff, pkOff + 32)).toEqual(Buffer.from(pk));
    expect(d.subarray(sigOff, sigOff + 64)).toEqual(Buffer.from(sig));
    expect(d.subarray(msgOff, msgOff + 32)).toEqual(Buffer.from(msg));
    expect(u16(12)).toBe(32);
  });
});

describe("event decode", () => {
  const registered = Buffer.concat([
    Buffer.from(eventDisc("Registered")),
    Buffer.alloc(8), // leaf index 0
    Buffer.alloc(32, 4),
    Buffer.alloc(32, 5),
    Buffer.alloc(32, 6),
    Buffer.alloc(32, 7),
  ]);
  const line = `Program data: ${registered.toString("base64")}`;

  it("round-trips a Registered event emitted by the registry at depth 1", () => {
    const events = decodeLogs(frameAsProgramLogs(REGISTRY_PROGRAM_ID, [line]));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("Registered");
  });

  it("ignores malformed payloads and unframed lines", () => {
    expect(decodeLogs(frameAsProgramLogs(REGISTRY_PROGRAM_ID, ["Program data: aGVsbG8gd29ybGQ="]))).toHaveLength(0);
    expect(decodeLogs([line])).toHaveLength(0);
  });

  it("rejects truncated events, malformed stack frames, and rolled-back transactions", () => {
    expect(decodeEventData(Buffer.concat([eventDisc("SessionRevoked"), Buffer.alloc(3)]))).toBeNull();
    expect(decodeEventData(Buffer.concat([registered, Buffer.from([0])]))).toBeNull();
    expect(decodeLogs([`Program ${REGISTRY_PROGRAM_ID} invoke [2]`, line, `Program ${REGISTRY_PROGRAM_ID} success`])).toEqual([]);
    expect(decodeLogs([`Program ${REGISTRY_PROGRAM_ID} invoke [1]`, line])).toEqual([]);
    expect(decodeLogs([`Program ${REGISTRY_PROGRAM_ID} invoke [1]`, line, `Program ${CENSUS_PROGRAM_ID} success`])).toEqual([]);
    expect(decodeLogs([...frameAsProgramLogs(REGISTRY_PROGRAM_ID, [line]),
      `Program ${POCKET_PROGRAM_ID} invoke [1]`, `Program ${POCKET_PROGRAM_ID} failed: custom program error: 0x1`])).toEqual([]);
  });

  it("refuses a byte-identical event from the wrong program or from inside a CPI", () => {
    const attacker = "Attack3r11111111111111111111111111111111111";
    expect(decodeLogs(frameAsProgramLogs(attacker, [line]))).toHaveLength(0);
    expect(decodeLogs(frameAsProgramLogs(CENSUS_PROGRAM_ID, [line]))).toHaveLength(0);
    // Registry invoked via CPI from an attacker program: depth 2.
    const nested = [
      `Program ${attacker} invoke [1]`,
      `Program ${REGISTRY_PROGRAM_ID} invoke [2]`,
      line,
      `Program ${REGISTRY_PROGRAM_ID} success`,
      `Program ${attacker} success`,
    ];
    expect(decodeLogs(nested)).toHaveLength(0);
    // The attacker's own line after a genuine registry frame closed.
    const after = [...frameAsProgramLogs(REGISTRY_PROGRAM_ID, []), ...frameAsProgramLogs(attacker, [line])];
    expect(decodeLogs(after)).toHaveLength(0);
    // Pocket events belong to the pocket program only.
    const revoked = Buffer.concat([Buffer.from(eventDisc("SessionRevoked")), Buffer.alloc(32, 1)]);
    const revokedLine = `Program data: ${revoked.toString("base64")}`;
    expect(decodeLogs(frameAsProgramLogs(POCKET_PROGRAM_ID, [revokedLine]))).toHaveLength(1);
    expect(decodeLogs(frameAsProgramLogs(REGISTRY_PROGRAM_ID, [revokedLine]))).toHaveLength(0);
  });
});
