// Pack only public libraries and test them in a consumer outside the monorepo.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "artifacts", "sdk");
const pnpm = process.env.npm_execpath;
if (!pnpm || !/pnpm/i.test(pnpm)) throw new Error("Run through pnpm: pnpm pack:sdk or pnpm test:package");
const run = (args, cwd = root) => execFileSync(process.execPath, [pnpm, ...args], { cwd, stdio: "inherit" });
mkdirSync(destination, { recursive: true });
const includeBot = process.argv.includes("--bot");
const folders = ["packages/common", "packages/sdk", ...(includeBot ? ["services/shared", "packages/bot"] : [])];
const tarballs = [], packageOverrides = {};
for (const relative of folders) {
  const folder = join(root, relative);
  const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  run(["pack", "--pack-destination", destination], folder);
  const tarball = join(destination, `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`);
  // pnpm's allowlisted package contents must not accidentally ship workspace files.
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split(/\r?\n/);
  for (const file of files) {
    if (!/^package\/(dist\/[^\s]+\.(?:js|d\.ts)|fixtures\/[^\s]+\.json|package\.json|README\.md|LICENSE)$/.test(file)) {
      throw new Error(`Unexpected packed file: ${file}`);
    }
  }
  tarballs.push(tarball);
  packageOverrides[pkg.name] = `file:${tarball.replaceAll("\\", "/")}`;
}
writeFileSync(join(destination, "SHA256SUMS"), tarballs.map(path => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${path.split(/[\\/]/).pop()}`).join("\n") + "\n");

if (process.argv.includes("--test")) {
  const consumer = mkdtempSync(join(tmpdir(), "ghostlink-sdk-consumer-"));
  // Until registry publication, resolve the SDK's versioned common dependency
  // to the reviewed companion archive, including under pnpm's strict resolver.
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "ghostlink-install-check", private: true, type: "module",
    pnpm: { overrides: { ...JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pnpm.overrides, ...packageOverrides } },
  }));
  run(["add", "--ignore-scripts", ...tarballs], consumer);
  writeFileSync(join(consumer, "check.mjs"), `
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { GhostLink, softwareSession, sessionPublicKey, derivePocket, signIntent } from '@ghostlink/sdk';
import { intentHash } from '@ghostlink/common';
const bot = softwareSession();
const publicKey = sessionPublicKey(0, bot.key32);
assert.equal('sign' in publicKey, false);
const pocket = derivePocket(1n, new Uint8Array(32).fill(1));
const signed = await signIntent(pocket, bot, {
  nonce: 1n, inMint: new Uint8Array(32).fill(2), inMax: 100n,
  outMint: new Uint8Array(32).fill(3), outMin: 90n, deadlineSlot: 1000n,
});
const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey.key32),
]) });
assert.equal(verify(null, intentHash(signed.intent), key, signed.signature.signature), true);
await assert.rejects(GhostLink.init({ cluster: 'mainnet-beta', indexer: 'https://example.invalid' }), /no verified devnet or mainnet/);
console.log('Installed SDK: ESM import, public delegation and real intent signature verified. No network transaction sent.');
`);
  execFileSync(process.execPath, [join(consumer, "check.mjs")], { cwd: consumer, stdio: "inherit" });
  if (includeBot) {
    writeFileSync(join(consumer, "bot.mjs"), `
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BotKeyStore, BotOnboarding, createBotAuthorizationServer, verifyTelegramInitData } from '@ghostlink/bot';
const key = randomBytes(32);
const path = join(process.cwd(), 'consumer.sqlite');
const store = new BotKeyStore(path, key);
store.close();
const reopened = new BotKeyStore(path, key);
assert.equal(JSON.stringify(reopened), '{}');
reopened.close(); key.fill(0);
assert.equal(typeof BotOnboarding, 'function');
assert.equal(typeof BotOnboarding.prototype.prepareIntent, 'function');
assert.equal(typeof BotOnboarding.prototype.orderStatus, 'function');
assert.equal(typeof BotOnboarding.prototype.cancelOrder, 'function');
assert.equal(typeof createBotAuthorizationServer, 'function');
assert.throws(() => verifyTelegramInitData('forged', '12345:' + 'a'.repeat(32)));
console.log('Installed bot package: dependencies, encrypted database restart and authentication boundary verified.');
`);
    execFileSync(process.execPath, [join(consumer, "bot.mjs")], { cwd: consumer, stdio: "inherit" });
    execFileSync(process.execPath, ["-e", "import('@ghostlink/bot').then(bot => { if (typeof bot.BotKeyStore !== 'function') process.exit(1); });"], { cwd: consumer, stdio: "inherit" });
  }
  writeFileSync(join(consumer, "check.cjs"), "import('@ghostlink/sdk').then(sdk => { if (typeof sdk.GhostLink !== 'function') process.exit(1); console.log('CommonJS dynamic import verified'); });\n");
  execFileSync(process.execPath, [join(consumer, "check.cjs")], { cwd: consumer, stdio: "inherit" });
  writeFileSync(join(consumer, "check.mts"), `
import { GhostLink, sessionPublicKey, type SessionAuthorizationParams, type SessionPublicKey } from '@ghostlink/sdk';
const authorize = (client: GhostLink, params: SessionAuthorizationParams) => client.authorizeSession(params);
const key: SessionPublicKey = sessionPublicKey(0, new Uint8Array(32));
void authorize; void key;
${includeBot ? "import { BotOnboarding, type BotOnboardingOptions, type BotConsent, type BotIntentParams, type BotOrderStatus } from '@ghostlink/bot';\nconst initBot = (options: BotOnboardingOptions) => new BotOnboarding(options);\nconst prepare = (m: BotOnboarding, c: BotConsent, requestKey: string, params: BotIntentParams) => m.prepareIntent(c.id, c, { requestKey, params });\nconst status = (m: BotOnboarding, c: BotConsent, requestKey: string): BotOrderStatus => m.orderStatus(c.id, c, requestKey);\nvoid initBot; void prepare; void status;" : ""}
`);
  const require = createRequire(join(root, "packages", "sdk", "package.json"));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "check.mts"], { cwd: consumer, stdio: "inherit" });
  console.log(`Isolated consumer and type declarations verified: ${consumer}`);
}
console.log(`SDK archives and checksums: ${destination}`);
