/** Durable ordered observations and at-least-once notification delivery. */
import { createHash, randomBytes } from "node:crypto";
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { EncryptedSqlite } from "@ghostlink/service-kit/storage";

export interface WatchScope { genesisHash: string; pocketProgram: string; payer: string | null; receiver: string; threshold: string }
export interface WatchSnapshot { cursor?: string; pending: [string, string][] }
export interface WatchScan { upperSlot: number; until?: string; before?: string; previousSlot?: number; done: boolean; remaining: number }
export interface Observation { signature: string; slot: number; failed: boolean }
export interface Alert { subject: string; body: Record<string, unknown> }
export interface Delivery { signature: string; pending: [string, string][]; alerts: Alert[]; next: number }
const slot = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid watcher slot"); };

export class WatcherState {
  readonly scope: Readonly<WatchScope>;
  #storage: EncryptedSqlite;
  #namespace: string;
  #openedInstanceId!: string;
  #token = randomBytes(32).toString("hex");
  #closed = false;
  constructor(path: string, key: Uint8Array, scope: WatchScope, private readonly clock = Date.now, private readonly maximum = 1_000_000, expectedId?: string) {
    this.scope = Object.freeze({ genesisHash: scope.genesisHash, pocketProgram: scope.pocketProgram, payer: scope.payer,
      receiver: scope.receiver, threshold: scope.threshold });
    for (const id of [scope.genesisHash, scope.pocketProgram, ...(scope.payer ? [scope.payer] : [])]) if (new PublicKey(id).toBase58() !== id) throw new Error("invalid watcher scope");
    if (!scope.receiver || scope.receiver.length > 128 || !/^(0|[1-9][0-9]{0,19})$/.test(scope.threshold) || BigInt(scope.threshold) > 0xffffffffffffffffn ||
      !Number.isSafeInteger(maximum) || maximum < 1) throw new Error("invalid watcher configuration");
    this.#namespace = "ghostlink:watcher-state:v1:" + createHash("sha256").update(JSON.stringify(this.scope)).digest("hex");
    this.#storage = new EncryptedSqlite(path, key, this.#namespace, { existing: expectedId !== undefined });
    try {
      if (this.#storage.recoveryId) throw new Error("restored watcher state requires independently reconciled history");
      this.#storage.transaction(() => {
        if (expectedId !== undefined) {
          this.#storage.db.prepare("SELECT name,data FROM state LIMIT 0").all();
          this.#storage.db.prepare("SELECT sequence,signature,slot,failed,data FROM observations LIMIT 0").all();
          this.#storage.db.prepare("SELECT signature FROM scanned LIMIT 0").all();
        } else {
          this.#storage.db.exec(`CREATE TABLE IF NOT EXISTS state (name TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS observations (sequence INTEGER PRIMARY KEY, signature TEXT NOT NULL UNIQUE, slot INTEGER NOT NULL, failed INTEGER NOT NULL, data BLOB NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS scanned (signature TEXT PRIMARY KEY) STRICT;`);
          if (!this.instanceId) {
            this.#storage.db.prepare("INSERT INTO metadata VALUES ('watcher-instance-v1', ?)")
              .run(this.#storage.seal(Buffer.from(randomBytes(32).toString("hex")), this.#namespace + ":instance:v1"));
            if (!this.#get<WatchSnapshot>("snapshot")) this.#put("snapshot", { pending: [] });
            if (this.#get<number>("through") === undefined) this.#put("through", 0);
          }
        }
        const id = this.instanceId;
        if (!id || (expectedId !== undefined && id !== expectedId)) throw new Error("watcher state identity mismatch");
        if (!this.#get<WatchSnapshot>("snapshot")) throw new Error("watcher snapshot is missing");
        const through = this.#get<number>("through"); if (through === undefined) throw new Error("watcher progress floor is missing"); slot(through);
        this.#openedInstanceId = id; // Validate the pin before acquiring or changing the lease.
        const lease = this.#get<{ token: string; until: number }>("lease");
        if (lease && lease.until > this.clock()) throw new Error("watcher state is already owned by another worker");
        this.#put("lease", { token: this.#token, until: this.clock() + 90_000 });
      });
    } catch (error) { this.#storage.close(); throw error; }
  }
  get instanceId(): string | undefined {
    const row = this.#storage.db.prepare("SELECT value FROM metadata WHERE name='watcher-instance-v1'").get();
    if (!row) return;
    const plain = this.#storage.open(row.value as Uint8Array, this.#namespace + ":instance:v1");
    try { const id = plain.toString(); if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid watcher state identity"); return id; }
    finally { plain.fill(0); }
  }
  static openExisting(path: string, key: Uint8Array, scope: WatchScope, expectedId: string, clock = Date.now): WatcherState {
    if (typeof expectedId !== "string" || !/^[0-9a-f]{64}$/.test(expectedId)) throw new Error("expected watcher state identity required");
    return new WatcherState(path, key, scope, clock, 1_000_000, expectedId);
  }
  #get<T>(name: string): T | undefined {
    const row = this.#storage.db.prepare("SELECT data FROM state WHERE name=?").get(name); if (!row) return;
    return this.#decode(row.data as Uint8Array, name);
  }
  #decode<T>(bytes: Uint8Array, id: string): T {
    const plain = this.#storage.open(bytes, `${this.#namespace}:${id}`);
    try { return JSON.parse(plain.toString()) as T; } finally { plain.fill(0); }
  }
  #encode(value: unknown, id: string): Uint8Array {
    const plain = Buffer.from(JSON.stringify(value));
    try {
      if (plain.length > 16 * 1024 * 1024) throw new Error("watcher state exceeds storage envelope");
      return this.#storage.seal(plain, `${this.#namespace}:${id}`);
    } finally { plain.fill(0); }
  }
  #put(name: string, value: unknown): void {
    this.#storage.db.prepare("INSERT INTO state VALUES (?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data").run(name, this.#encode(value, name));
  }
  assertOwned(): void {
    if (this.instanceId !== this.#openedInstanceId || this.#storage.recoveryId) throw new Error("watcher state identity or restore state changed");
    const lease = this.#get<{ token: string; until: number }>("lease"), now = this.clock();
    if (!Number.isSafeInteger(now) || !lease || lease.token !== this.#token || lease.until <= now) throw new Error("watcher state ownership lost");
  }
  renew(): void { this.#storage.transaction(() => { this.assertOwned(); this.#put("lease", { token: this.#token, until: this.clock() + 90_000 }); }); }
  close(): void {
    if (this.#closed) return;
    try { this.#storage.transaction(() => { if (this.#get<{ token: string }>("lease")?.token === this.#token) this.#storage.db.prepare("DELETE FROM state WHERE name='lease'").run(); }); }
    finally { this.#closed = true; this.#storage.close(); }
  }
  snapshot(): WatchSnapshot {
    this.assertOwned(); const snapshot = this.#get<WatchSnapshot>("snapshot");
    if (!snapshot) throw new Error("watcher snapshot is missing"); return snapshot;
  }
  scan(): WatchScan | undefined { this.assertOwned(); return this.#get<WatchScan>("scan"); }
  delivery(): Delivery | undefined { this.assertOwned(); return this.#get<Delivery>("delivery"); }
  count(): number { this.assertOwned(); return Number(this.#storage.db.prepare("SELECT COUNT(*) AS n FROM observations").get()!.n); }
  through(): number {
    this.assertOwned(); const through = this.#get<number>("through");
    if (through === undefined) throw new Error("watcher progress floor is missing"); slot(through); return through;
  }
  begin(upperSlot: number): void {
    this.#storage.transaction(() => {
      this.assertOwned(); slot(upperSlot);
      if (this.scan() || this.count() || this.delivery()) throw new Error("watcher scan already active");
      if (upperSlot < this.through()) throw new Error("watcher chain head regressed");
      this.#put("scan", { upperSlot, until: this.snapshot().cursor, done: false, remaining: 0 } satisfies WatchScan);
    });
  }
  page(before: string | undefined, page: ConfirmedSignatureInfo[], limit: number): void {
    this.#storage.transaction(() => {
      this.assertOwned(); const scan = this.scan();
      if (!scan || scan.done || scan.before !== before || !Array.isArray(page) || page.length > limit) throw new Error("watcher page boundary changed");
      let previousSlot = scan.previousSlot, reached = false;
      let count = this.count(), seenCount = Number(this.#storage.db.prepare("SELECT COUNT(*) AS n FROM scanned").get()!.n);
      for (const info of page) {
        slot(info.slot);
        if (typeof info.signature !== "string" || !info.signature.length || info.signature.length > 128 || info.err === undefined ||
          info.signature === before || (previousSlot !== undefined && info.slot > previousSlot)) throw new Error("invalid watcher history");
        if (info.signature === scan.until) { reached = true; break; }
        if (this.#storage.db.prepare("SELECT 1 FROM scanned WHERE signature=?").get(info.signature)) throw new Error("repeated watcher history");
        if (seenCount++ >= this.maximum * 2) throw new Error("watcher scan capacity exhausted");
        this.#storage.db.prepare("INSERT INTO scanned VALUES (?)").run(info.signature);
        if (info.slot <= scan.upperSlot) {
          if (count++ >= this.maximum) throw new Error("watcher queue capacity exhausted");
          const observation: Observation = { signature: info.signature, slot: info.slot, failed: info.err !== null };
          this.#storage.db.prepare("INSERT INTO observations VALUES (?,?,?,?,?)").run(scan.remaining, info.signature, info.slot, observation.failed ? 1 : 0,
            this.#encode(observation, `observation:${scan.remaining}:${info.signature}`));
          scan.remaining++;
        }
        previousSlot = info.slot;
      }
      if (!reached && page.length < limit && scan.until) throw new Error("saved watcher cursor missing from provider history");
      scan.previousSlot = previousSlot; scan.before = page.at(-1)?.signature ?? before; scan.done = reached || page.length < limit;
      this.#put("scan", scan);
    });
  }
  oldest(): Observation | undefined {
    this.assertOwned(); const scan = this.scan(); if (!scan?.done || !scan.remaining) return;
    const row = this.#storage.db.prepare("SELECT signature,slot,failed,data FROM observations WHERE sequence=?").get(scan.remaining - 1);
    if (!row) throw new Error("watcher observation history is missing");
    const observation = this.#decode<Observation>(row.data as Uint8Array, `observation:${scan.remaining - 1}:${row.signature}`);
    if (observation.signature !== row.signature || observation.slot !== row.slot || observation.failed !== Boolean(row.failed)) throw new Error("watcher observation metadata changed");
    return observation;
  }
  prepare(observation: Observation, pending: [string, string][], alerts: Alert[]): Delivery {
    return this.#storage.transaction(() => {
      this.assertOwned(); const first = this.oldest();
      if (!first || first.signature !== observation.signature || first.slot !== observation.slot || first.failed !== observation.failed) throw new Error("watcher observation changed");
      const prior = this.delivery(); if (prior) { if (prior.signature !== first.signature) throw new Error("watcher delivery changed"); return prior; }
      if (alerts.length > 256 || pending.length > 100_000) throw new Error("watcher event capacity exhausted");
      const record: Delivery = { signature: first.signature, pending, next: 0, alerts: alerts.map((alert, index) => {
        const eventId = createHash("sha256").update(JSON.stringify([this.#namespace, first.signature, index, alert])).digest("hex");
        return { subject: alert.subject, body: { ...alert.body, eventId, signature: first.signature, observedSlot: first.slot,
          observedCommitment: "confirmed", genesisHash: this.scope.genesisHash, pocketProgram: this.scope.pocketProgram } };
      }) };
      this.#put("delivery", record); return structuredClone(record);
    });
  }
  acknowledge(eventId: string): void {
    this.#storage.transaction(() => {
      this.assertOwned(); const record = this.delivery();
      if (!record || record.alerts[record.next]?.body.eventId !== eventId) throw new Error("watcher acknowledgment changed");
      record.next++; this.#put("delivery", record);
    });
  }
  complete(signature: string): void {
    this.#storage.transaction(() => {
      this.assertOwned(); const record = this.delivery();
      if (!record || record.signature !== signature || record.next !== record.alerts.length || this.oldest()?.signature !== signature) throw new Error("watcher delivery is incomplete");
      this.#put("snapshot", { cursor: signature, pending: record.pending });
      const scan = this.scan()!; scan.remaining--; this.#put("scan", scan);
      this.#storage.db.prepare("DELETE FROM observations WHERE signature=?").run(signature);
      this.#storage.db.prepare("DELETE FROM state WHERE name='delivery'").run();
    });
  }
  finish(): boolean {
    return this.#storage.transaction(() => {
      this.assertOwned(); const scan = this.scan(); if (!scan?.done || scan.remaining || this.count() || this.delivery()) return false;
      this.#put("through", scan.upperSlot); this.#storage.db.prepare("DELETE FROM state WHERE name='scan'").run(); this.#storage.db.prepare("DELETE FROM scanned").run(); return true;
    });
  }
}
