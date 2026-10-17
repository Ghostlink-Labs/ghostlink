import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BotKeyStore } from "../src/store.js";
import type { BotConsent } from "../src/types.js";
import { deployment, NOW } from "./helpers.js";
import { conservativePolicy, toBase58 } from "@ghostlink/common";
import { policyToDto, softwareSession } from "@ghostlink/sdk";

describe("encrypted consent persistence", () => {
  it("recovers a committed key after a process exits without closing SQLite and rejects ciphertext/payload tampering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-crash-test-"));
    const path = join(dir, "bot.sqlite");
    const key = randomBytes(32), seed = randomBytes(32);
    const consent: BotConsent = { version: 1, id: "ab".repeat(32), botId: "12345", userId: "42",
      appOrigin: "https://bot.example.com", deployment, appId: "23", pocket: toBase58(randomBytes(32)),
      home: toBase58(randomBytes(32)), policy: policyToDto(conservativePolicy()),
      sessionKeyHex: Buffer.from(softwareSession(seed).key32).toString("hex"), sessionExpirySlot: "1000", createdAt: NOW, expiresAt: NOW + 300 };
    let store: BotKeyStore | undefined;
    try {
      // Secrets travel over the child stdin, never process arguments or output.
      // The distinct nonzero exit occurs after commit, with no database close.
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { readFileSync } from 'node:fs';
        import { BotKeyStore } from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
        const p = JSON.parse(readFileSync(0, 'utf8'));
        const store = new BotKeyStore(p.path, Buffer.from(p.key, 'hex'));
        store.create('12345', '42', 'request', 'fingerprint', p.now, () => ({ consent: p.consent, seed: Buffer.from(p.seed, 'hex') }));
        store.confirm(p.consent.id, '12345', '42', p.now, 100);
        process.exit(23);
      `], { input: JSON.stringify({ path, key: key.toString("hex"), seed: seed.toString("hex"), consent, now: NOW }), encoding: "utf8", timeout: 15_000 });
      expect(child.status, child.stderr).toBe(23);
      for (const name of readdirSync(dir)) {
        const contents = readFileSync(join(dir, name));
        expect(contents.includes(seed)).toBe(false);
        expect(contents.includes(key)).toBe(false);
      }
      store = new BotKeyStore(path, key);
      expect(store.read(consent.id, "12345", "42", NOW).state).toBe("confirmed");
      await store.withSeed(consent.id, "12345", "42", async recovered => { expect(Buffer.from(recovered)).toEqual(seed); });
      const db = new DatabaseSync(path);
      try {
        // Restore the pre-order schema while retaining the original consent/key bytes.
        store.close();
        db.exec("ALTER TABLE consent DROP COLUMN observed_slot; DROP TABLE bot_orders; DROP TABLE bot_counters");
        store = new BotKeyStore(path, key);
        expect(store.read(consent.id, "12345", "42", NOW)).toMatchObject({ state: "confirmed", confirmedSlot: 100 });
        await store.withSeed(consent.id, "12345", "42", async recovered => { expect(Buffer.from(recovered)).toEqual(seed); });
        const original = db.prepare("SELECT encrypted_key FROM consent WHERE id=?").get(consent.id)!.encrypted_key as Uint8Array;
        const corrupt = Buffer.from(original); corrupt[corrupt.length - 1]! ^= 1;
        db.prepare("UPDATE consent SET encrypted_key=? WHERE id=?").run(corrupt, consent.id);
        await expect(store.withSeed(consent.id, "12345", "42", async () => true)).rejects.toThrow();
        db.prepare("UPDATE consent SET encrypted_key=?, payload=? WHERE id=?").run(original, JSON.stringify({ ...consent, home: toBase58(randomBytes(32)) }), consent.id);
        await expect(store.withSeed(consent.id, "12345", "42", async () => true)).rejects.toThrow();
      } finally { db.close(); }
    } finally { store?.close(); key.fill(0); seed.fill(0); rmSync(dir, { recursive: true, force: true }); }
  });
});
