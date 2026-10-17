import assert from "node:assert/strict";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN,
  ataAddress,
  createAtaIdempotentIx,
  initializeMint2Ix,
  mintToIx,
} from "@ghostlink/service-kit";

/** Actual SPL authority changes on disposable localnet; never a production API. */
export async function exerciseRecoveryDestinations(options: {
  connection: Connection;
  payer: Keypair;
  wallet: Keypair;
  pocket: PublicKey;
  relayerUrl: string;
  send: (
    instructions: TransactionInstruction[],
    signers: Keypair[],
  ) => Promise<unknown>;
  ownerBody: () => Promise<object>;
}) {
  const { connection, payer, wallet, pocket, relayerUrl, send, ownerBody } =
    options;
  const mint = Keypair.generate(),
    homeAta = ataAddress(wallet.publicKey, mint.publicKey),
    source = ataAddress(pocket, mint.publicKey);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(82),
        space: 82,
        programId: TOKEN,
      }),
      initializeMint2Ix(mint.publicKey, 6, wallet.publicKey),
      createAtaIdempotentIx(payer.publicKey, wallet.publicKey, mint.publicKey),
      createAtaIdempotentIx(payer.publicKey, pocket, mint.publicKey),
      mintToIx(mint.publicKey, source, wallet.publicKey, 123n),
      mintToIx(mint.publicKey, homeAta, wallet.publicKey, 7n),
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: homeAta, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([6, 2, 1]), pocket.toBuffer()]),
      }),
    ],
    [mint, wallet],
  );
  assert.equal(
    (await connection.getAccountInfo(homeAta, "confirmed"))!.data
      .subarray(32, 64)
      .toString("hex"),
    pocket.toBuffer().toString("hex"),
  );
  const proof = await ownerBody();
  const post = (tokenPairs: unknown) =>
    fetch(relayerUrl + "/owner-action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...proof,
        home: wallet.publicKey.toBase58(),
        tokenPairs,
      }),
    });
  const legacy = await post([
    {
      source: source.toBase58(),
      destination: homeAta.toBase58(),
      mint: mint.publicKey.toBase58(),
    },
  ]);
  assert.equal(
    legacy.ok,
    false,
    "a destination no longer owned by home must be refused",
  );
  assert.equal(
    (await connection.getTokenAccountBalance(source)).value.amount,
    "123",
  );
  console.log(
    "✓ reproduced recovery refusal after real SPL owner change of the home's ATA",
  );
  const result = await post(
    [source, homeAta].map((address) => ({
      source: address.toBase58(),
      mint: mint.publicKey.toBase58(),
    })),
  );
  assert.equal(
    result.ok,
    true,
    `automatic safe destination failed: ${await result.clone().text()}`,
  );
  const response = (await result.json()) as {
    tokenPairs: { source: string; destination: string; mint: string }[];
  };
  assert.equal(response.tokenPairs.length, 2);
  assert.equal(
    response.tokenPairs[0]!.destination,
    response.tokenPairs[1]!.destination,
  );
  const destination = new PublicKey(response.tokenPairs[0]!.destination),
    info = await connection.getAccountInfo(destination, "confirmed");
  assert(info);
  assert(info.owner.equals(TOKEN));
  assert.equal(info.data.length, 165);
  assert.equal(
    info.data.subarray(32, 64).toString("hex"),
    wallet.publicKey.toBuffer().toString("hex"),
  );
  assert.equal(info.data.readBigUInt64LE(64), 130n);
  assert.equal(info.data.readUInt32LE(72), 0);
  assert.equal(info.data.readUInt32LE(129), 0);
  assert.equal(await connection.getAccountInfo(source), null);
  assert.equal(await connection.getAccountInfo(homeAta), null);
  const replay = await post(
    [source, homeAta].map((address) => ({
      source: address.toBase58(),
      mint: mint.publicKey.toBase58(),
    })),
  );
  assert.equal(
    replay.ok,
    false,
    "the same owner proof must not create another recovery account",
  );
  console.log(
    "✓ recovered both pocket balances into one new clean home-owned account; replay refused",
  );

  const locked: {
    mint: PublicKey;
    source: PublicKey;
    canonical: PublicKey;
    amount: bigint;
  }[] = [];
  const outsider = Keypair.generate().publicKey;
  for (const delegate of [true, false]) {
    const m = Keypair.generate(),
      s = ataAddress(pocket, m.publicKey),
      canonical = ataAddress(wallet.publicKey, m.publicKey),
      amount = delegate ? 11n : 13n;
    const authority = delegate
      ? new TransactionInstruction({
          programId: TOKEN,
          keys: [
            { pubkey: canonical, isSigner: false, isWritable: true },
            { pubkey: outsider, isSigner: false, isWritable: false },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
          ],
          data: Buffer.concat([Buffer.from([4]), Buffer.alloc(8, 255)]),
        })
      : new TransactionInstruction({
          programId: TOKEN,
          keys: [
            { pubkey: canonical, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
          ],
          data: Buffer.concat([Buffer.from([6, 3, 1]), outsider.toBuffer()]),
        });
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: m.publicKey,
          lamports: await connection.getMinimumBalanceForRentExemption(82),
          space: 82,
          programId: TOKEN,
        }),
        initializeMint2Ix(m.publicKey, 6, wallet.publicKey),
        createAtaIdempotentIx(payer.publicKey, wallet.publicKey, m.publicKey),
        createAtaIdempotentIx(payer.publicKey, pocket, m.publicKey),
        mintToIx(m.publicKey, s, wallet.publicKey, amount),
        authority,
      ],
      [m, wallet],
    );
    locked.push({ mint: m.publicKey, source: s, canonical, amount });
  }
  const request = {
    ...(await ownerBody()),
    home: wallet.publicKey.toBase58(),
    tokenPairs: locked.map((p) => ({
      source: p.source.toBase58(),
      mint: p.mint.toBase58(),
    })),
  };
  const res = await fetch(relayerUrl + "/owner-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(
    res.ok,
    true,
    `two fresh recovery accounts failed: ${await res.clone().text()}`,
  );
  const outcomes = (await res.json()) as {
    tokenPairs: { source: string; destination: string; mint: string }[];
  };
  for (const entry of locked) {
    const pair = outcomes.tokenPairs.find(
      (p) => p.source === entry.source.toBase58(),
    );
    assert(pair);
    const info = await connection.getAccountInfo(
      new PublicKey(pair.destination),
      "confirmed",
    );
    assert(info);
    assert.equal(info.data.readBigUInt64LE(64), entry.amount);
    assert.equal(info.data.readUInt32LE(72), 0);
    assert.equal(info.data.readUInt32LE(129), 0);
    assert.equal(
      info.data.subarray(32, 64).toString("hex"),
      wallet.publicKey.toBuffer().toString("hex"),
    );
    assert.notEqual(pair.destination, entry.canonical.toBase58());
    assert.equal(await connection.getAccountInfo(entry.source), null);
    assert.equal(
      (await connection.getTokenAccountBalance(entry.canonical)).value.amount,
      "0",
    );
  }
  console.log(
    "✓ real SPL delegate/close authorities avoided; two fresh destinations fit and settle atomically",
  );
}
