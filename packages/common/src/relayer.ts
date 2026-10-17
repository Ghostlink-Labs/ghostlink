import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "./field.js";
import type { RegisterRequest, SnapshotRequest, OpenSessionRequest, OwnerActionRequest } from "./api.js";

export type RelayerRoute = "/register" | "/snapshot" | "/open-session" | "/owner-action";
export interface RelayerRequests {
  "/register": RegisterRequest; "/snapshot": SnapshotRequest; "/open-session": OpenSessionRequest; "/owner-action": OwnerActionRequest;
}
export interface RelayerReceipt {
  requestIdHex: string;
  state: "preparing" | "pending" | "confirmed" | "finalized" | "failed" | "unknown";
  signature?: string; slot?: number; confirmationStatus?: "confirmed" | "finalized";
  reason?: string;
  tokenPairs?: { source: string; destination: string; mint: string }[];
}
/** Exact JSON identity, including proof bytes. Re-proving or editing a body is a different operation. */
export function relayerRequestDigest(route: RelayerRoute, request: object): string {
  if (!["/register", "/snapshot", "/open-session", "/owner-action"].includes(route)) throw new Error("invalid relayer route");
  function canonical(value: unknown, depth = 0): unknown {
    if (depth > 16) throw new Error("relayer request nesting exceeds limit");
    if (value === null || typeof value === "string" || typeof value === "boolean" || value === undefined) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key], depth + 1)]));
    }
    throw new Error("relayer request must contain JSON values");
  }
  const { requestIdHex: _id, ...body } = request as Record<string, unknown>;
  const bytes = new TextEncoder().encode(JSON.stringify(["ghostlink:relayer:v1", route, canonical(body)]));
  if (bytes.length > 60_000) throw new Error("relayer request exceeds size limit");
  return bytesToHex(sha256(bytes));
}
