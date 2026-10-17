import { bytesToHex, relayerRequestDigest, type RelayerReceipt, type RelayerRequests, type RelayerRoute } from "@ghostlink/common";

export interface PreparedRelayerOperation<R extends RelayerRoute = RelayerRoute> {
  route: R; requestIdHex: string; digestHex: string; request: RelayerRequests[R];
}
/** Save this complete object in the caller's encrypted durable store BEFORE sending. Never regenerate it to retry. */
export function prepareRelayerOperation<R extends RelayerRoute>(route: R, request: RelayerRequests[R], requestIdHex?: string): PreparedRelayerOperation<R> {
  const digestHex = relayerRequestDigest(route, request);
  const id = requestIdHex ?? bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid relayer request ID");
  return { route, requestIdHex: id, digestHex, request: JSON.parse(JSON.stringify(request)) as RelayerRequests[R] };
}

export class RelayerOperationPendingError extends Error {
  constructor(readonly operation: PreparedRelayerOperation, readonly receipt?: RelayerReceipt) {
    super("Relayer operation is not confirmed; retain this operation and reconcile before retrying");
    this.name = "RelayerOperationPendingError";
  }
}

/** Receipts are provider evidence; independently verify chain effects before granting bot authority. */
export class RelayerClient {
  constructor(private readonly endpoint: string, private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  #check(value: unknown, id: string): RelayerReceipt {
    const receipt = value as RelayerReceipt;
    if (!receipt || receipt.requestIdHex !== id || !["preparing", "pending", "confirmed", "finalized", "failed", "unknown"].includes(receipt.state)) throw new Error("invalid relayer receipt");
    if ((!['preparing', 'unknown'].includes(receipt.state) || receipt.signature !== undefined) &&
      (typeof receipt.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(receipt.signature))) throw new Error("missing relayer transaction identity");
    if (["confirmed", "finalized", "failed"].includes(receipt.state) && (!Number.isSafeInteger(receipt.slot) || receipt.slot! < 0 ||
      !["confirmed", "finalized"].includes(receipt.confirmationStatus ?? ""))) throw new Error("missing relayer confirmation evidence");
    if (["confirmed", "finalized"].includes(receipt.state) && receipt.state !== receipt.confirmationStatus) throw new Error("inconsistent relayer confirmation evidence");
    return receipt;
  }
  async submit(operation: PreparedRelayerOperation): Promise<RelayerReceipt> {
    if (!/^[0-9a-f]{64}$/.test(operation.requestIdHex) || relayerRequestDigest(operation.route, operation.request) !== operation.digestHex) throw new Error("relayer operation was mutated");
    // Snapshot mutable caller data before yielding so a later mutation cannot replace the submitted request.
    const saved = JSON.parse(JSON.stringify(operation)) as PreparedRelayerOperation;
    const id = saved.requestIdHex, url = `${this.endpoint}${saved.route}`;
    const body = JSON.stringify({ ...saved.request, requestIdHex: id });
    let response: Response;
    try { response = await this.fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body }); }
    catch { throw new RelayerOperationPendingError(saved); }
    if (response.status >= 500 && response.status !== 502) throw new RelayerOperationPendingError(saved);
    if (!response.ok && response.status !== 502) throw new Error(`relayer submission: HTTP ${response.status}`);
    try { return this.#check(await response.json(), id); }
    catch { throw new RelayerOperationPendingError(saved); }
  }
  async status(requestIdHex: string): Promise<RelayerReceipt> {
    if (!/^[0-9a-f]{64}$/.test(requestIdHex)) throw new Error("invalid relayer request ID");
    const response = await this.fetchFn(`${this.endpoint}/submissions/${requestIdHex}`);
    if (!response.ok) throw new Error(`relayer status: HTTP ${response.status}`);
    return this.#check(await response.json(), requestIdHex);
  }
}
export type { RelayerReceipt, RelayerRoute, RelayerRequests };
