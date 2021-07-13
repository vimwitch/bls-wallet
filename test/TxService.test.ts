import { assertEquals } from "./deps.ts";

import Fixture from "./helpers/Fixture.ts";
import Range from "./helpers/Range.ts";

Fixture.test("adds valid transaction", async (fx) => {
  const txService = await fx.createTxService();

  const blsSigner = fx.createBlsSigner();
  const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

  const tx = await fx.createTxData({
    blsSigner,
    contract: fx.walletService.erc20,
    method: "mint",
    args: [blsWallet.address, "3"],
    nonceOffset: 0,
  });

  assertEquals(await txService.txTable.count(), 0n);

  const failures = await txService.add(tx);
  assertEquals(failures, []);

  assertEquals(await txService.txTable.count(), 1n);
});

Fixture.test("rejects transaction with invalid signature", async (fx) => {
  const txService = await fx.createTxService();

  const blsSigner = fx.createBlsSigner();
  const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

  const tx = await fx.createTxData({
    blsSigner,
    contract: fx.walletService.erc20,
    method: "mint",
    args: [blsWallet.address, "3"],
    nonceOffset: 0,
  });

  // Make the signature invalid
  tx.signature = [
    "0x",
    tx.signature[2] === "0" ? "1" : "0",
    tx.signature.slice(3),
  ].join("");

  assertEquals(await txService.txTable.count(), 0n);

  const failures = await txService.add(tx);
  assertEquals(failures.map((f) => f.type), ["invalid-signature"]);

  // Transaction table remains empty
  assertEquals(await txService.txTable.count(), 0n);
});

Fixture.test("rejects transaction with nonce from the past", async (fx) => {
  const txService = await fx.createTxService();

  const blsSigner = fx.createBlsSigner();
  const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

  const tx = await fx.createTxData({
    blsSigner,
    contract: fx.walletService.erc20,
    method: "mint",
    args: [blsWallet.address, "3"],
    nonceOffset: -1,
  });

  // createTxData would have correctly set nonce 1 if we hadn't used offset -1.
  // (a transaction with nonce 0 occurs when creating the wallet)
  assertEquals(tx.nonce, 0);

  assertEquals(await txService.txTable.count(), 0n);

  const failures = await txService.add(tx);
  assertEquals(failures.map((f) => f.type), ["duplicate-nonce"]);

  // Transaction table remains empty
  assertEquals(await txService.txTable.count(), 0n);
});

Fixture.test(
  "rejects transaction with invalid signature and nonce from the past",
  async (fx) => {
    const txService = await fx.createTxService();

    const blsSigner = fx.createBlsSigner();
    const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

    const tx = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
      nonceOffset: -1,
    });

    // createTxData would have correctly set nonce 1 if we hadn't used offset -1.
    // (a transaction with nonce 0 occurs when creating the wallet)
    assertEquals(tx.nonce, 0);

    // Make the signature invalid
    tx.signature = [
      "0x",
      tx.signature[2] === "0" ? "1" : "0",
      tx.signature.slice(3),
    ].join("");

    assertEquals(await txService.txTable.count(), 0n);

    const failures = await txService.add(tx);

    assertEquals(
      failures.map((f) => f.type).sort(),
      ["duplicate-nonce", "invalid-signature"],
    );

    // Transaction table remains empty
    assertEquals(await txService.txTable.count(), 0n);
  },
);

Fixture.test("adds tx with future nonce to pendingTxs", async (fx) => {
  const txService = await fx.createTxService();

  const blsSigner = fx.createBlsSigner();
  const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

  const tx = await fx.createTxData({
    blsSigner,
    contract: fx.walletService.erc20,
    method: "mint",
    args: [blsWallet.address, "3"],
    nonceOffset: 1,
  });

  assertEquals(await txService.txTable.count(), 0n);
  assertEquals(await txService.pendingTxTable.count(), 0n);

  const failures = await txService.add(tx);
  assertEquals(failures, []);

  assertEquals(await txService.txTable.count(), 0n);
  assertEquals(await txService.pendingTxTable.count(), 1n);
});

Fixture.test(
  "filling the nonce gap adds the eligible pending tx to the end of main txs",
  async (fx) => {
    const txService = await fx.createTxService();

    const blsSigner = fx.createBlsSigner("other");
    const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

    assertEquals(await fx.allTxs(txService), {
      main: [],
      pending: [],
    });

    // Add tx in the future
    const txB = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
      nonceOffset: 1,
    });

    const failuresB = await txService.add(txB);
    assertEquals(failuresB, []);

    const otherBlsSigner = fx.createBlsSigner("ba");
    const otherBlsWallet = await fx.getOrCreateBlsWallet(otherBlsSigner);

    // This tx is ready, so it should get to go first even though the tx above
    // was added first.
    const otherTx = await fx.createTxData({
      blsSigner: otherBlsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [otherBlsWallet.address, "3"],
    });

    const otherFailures = await txService.add(otherTx);
    assertEquals(otherFailures, []);

    assertEquals(await fx.allTxs(txService), {
      main: [{ ...otherTx, txId: 1 }],
      pending: [{ ...txB, txId: 1 }],
    });

    // Add txA, which makes txB ready
    const txA = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
    });

    const failuresA = await txService.add(txA);
    assertEquals(failuresA, []);

    assertEquals(await fx.allTxs(txService), {
      main: [
        { ...otherTx, txId: 1 },
        { ...txA, txId: 2 },

        // Note that txB had id 1 when it was pending, and it gets a new id here
        { ...txB, txId: 3 },
      ],
      pending: [],
    });
  },
);

Fixture.test(
  "when pending txs reach maxPendingTxs, the oldest ones are dropped",
  async (fx) => {
    const txService = await fx.createTxService({
      maxPendingTxs: 3,
      pendingBatchSize: 100,
    });

    const blsSigner = fx.createBlsSigner();
    const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

    const futureTxs = await Promise.all(
      Range(5).map((i) =>
        fx.createTxData({
          blsSigner,
          contract: fx.walletService.erc20,
          method: "mint",
          args: [blsWallet.address, "3"],
          nonceOffset: i + 1,
        })
      ),
    );

    for (const tx of futureTxs) {
      await txService.add(tx);
    }

    assertEquals(await fx.allTxs(txService), {
      main: [],
      pending: [
        // futureTxs[0] and futureTxs[1] should have been dropped
        { ...futureTxs[2], txId: 3 },
        { ...futureTxs[3], txId: 4 },
        { ...futureTxs[4], txId: 5 },
      ],
    });
  },
);

Fixture.test(
  "reusing a nonce from main txs (unsubmitted) fails with duplicate-nonce",
  async (fx) => {
    const txService = await fx.createTxService();

    const blsSigner = fx.createBlsSigner();
    const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

    const tx = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
    });

    const failures = await txService.add(tx);
    assertEquals(failures, []);

    const txDuplicateNonce = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "5"],
      // because the previous tx isn't on chain, the default nonce offset of
      // zero should conflict
    });

    const failuresDuplicateNonce = await txService.add(txDuplicateNonce);

    assertEquals(
      failuresDuplicateNonce.map((f) => f.type),
      ["duplicate-nonce"],
    );

    assertEquals(await fx.allTxs(txService), {
      main: [{ ...tx, txId: 1 }],
      pending: [],
    });
  },
);

Fixture.test(
  "filling the nonce gap adds multiple eligible pending txs",
  async (fx) => {
    const txService = await fx.createTxService();

    const blsSigner = fx.createBlsSigner("other");
    const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

    assertEquals(await fx.allTxs(txService), {
      main: [],
      pending: [],
    });

    // Add multiple txs in the future (and out of order)
    const tx3 = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
      nonceOffset: 2,
    });

    const failures3 = await txService.add(tx3);
    assertEquals(failures3, []);

    const tx2 = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
      nonceOffset: 1,
    });

    const failures2 = await txService.add(tx2);
    assertEquals(failures2, []);

    assertEquals(await fx.allTxs(txService), {
      main: [],
      pending: [
        { ...tx3, txId: 1 },
        { ...tx2, txId: 2 },
      ],
    });

    // Add tx1, which makes earlier txs ready
    const tx1 = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
    });

    const failures1 = await txService.add(tx1);
    assertEquals(failures1, []);

    assertEquals(await fx.allTxs(txService), {
      main: [
        { ...tx1, txId: 1 },
        { ...tx2, txId: 2 },
        { ...tx3, txId: 3 },
      ],
      pending: [],
    });
  },
);

Fixture.test(
  "filling the nonce gap adds eligible pending tx but stops at the next gap",
  async (fx) => {
    const txService = await fx.createTxService();

    const blsSigner = fx.createBlsSigner("other");
    const blsWallet = await fx.getOrCreateBlsWallet(blsSigner);

    assertEquals(await fx.allTxs(txService), {
      main: [],
      pending: [],
    });

    // Add multiple txs in the future (and out of order)
    const tx4 = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
      nonceOffset: 3,
    });

    const failures4 = await txService.add(tx4);
    assertEquals(failures4, []);

    const tx2 = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
      nonceOffset: 1,
    });

    const failures2 = await txService.add(tx2);
    assertEquals(failures2, []);

    assertEquals(await fx.allTxs(txService), {
      main: [],
      pending: [
        { ...tx4, txId: 1 },
        { ...tx2, txId: 2 },
      ],
    });

    // Add tx1, which makes earlier txs ready
    const tx1 = await fx.createTxData({
      blsSigner,
      contract: fx.walletService.erc20,
      method: "mint",
      args: [blsWallet.address, "3"],
    });

    const failures1 = await txService.add(tx1);
    assertEquals(failures1, []);

    assertEquals(await fx.allTxs(txService), {
      main: [
        { ...tx1, txId: 1 },
        { ...tx2, txId: 2 },
      ],
      pending: [
        { ...tx4, txId: 1 },
      ],
    });
  },
);
