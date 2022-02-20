import { expect } from "chai";
import expectRevert from "../shared/helpers/expectRevert";

import { ethers, network } from "hardhat";

import { compressDouble, compressSingle } from "zerocompress";

import Fixture from "../shared/helpers/Fixture";
import TokenHelper from "../shared/helpers/TokenHelper";

import { BigNumber } from "ethers";
import { parseEther } from "@ethersproject/units";
import deployAndRunPrecompileCostEstimator from "../shared/helpers/deployAndRunPrecompileCostEstimator";
// import splitHex256 from "../shared/helpers/splitHex256";
import { defaultDeployerAddress } from "../shared/helpers/deployDeployer";
import { solidityPack } from "ethers/lib/utils";
const utils = ethers.utils;

describe("WalletActions", async function () {
  if (`${process.env.DEPLOYER_DEPLOYMENT}` === "true") {
    console.log("Skipping non-deployer tests.");
    return;
  }

  this.beforeAll(async function () {
    // deploy the deployer contract for the transient hardhat network
    if (network.name === "hardhat") {
      // fund deployer wallet address
      const fundedSigner = (await ethers.getSigners())[0];
      await (
        await fundedSigner.sendTransaction({
          to: defaultDeployerAddress(),
          value: utils.parseEther("1"),
        })
      ).wait();

      // deploy the precompile contract (via deployer)
      console.log("PCE:", await deployAndRunPrecompileCostEstimator());
    }
  });

  let fx: Fixture;
  let th: TokenHelper;
  beforeEach(async function () {
    if (network.name === "rinkarby") {
      fx = await Fixture.create(Fixture.DEFAULT_BLS_ACCOUNTS_LENGTH);
    } else {
      fx = await Fixture.create();
    }
  });

  it("should register new wallet", async function () {
    const wallet = await fx.lazyBlsWallets[0]();
    expect(fx.verificationGateway.address).to.equal(
      fx.verificationGateway.address,
    );

    const BLSWallet = await ethers.getContractFactory("BLSWallet");
    const TransparentUpgradeableProxy = await ethers.getContractFactory(
      "TransparentUpgradeableProxy",
    );
    const proxyAdminAddress = await fx.verificationGateway.walletProxyAdmin();
    const blsWalletLogicAddress = await fx.verificationGateway.blsWalletLogic();

    const initFunctionParams = BLSWallet.interface.encodeFunctionData(
      "initialize",
      [fx.verificationGateway.address],
    );

    const calculatedAddress = ethers.utils.getCreate2Address(
      fx.verificationGateway.address,
      fx.blsWalletSigner.getPublicKeyHash(wallet.privateKey),
      ethers.utils.solidityKeccak256(
        ["bytes", "bytes"],
        [
          TransparentUpgradeableProxy.bytecode,
          ethers.utils.defaultAbiCoder.encode(
            ["address", "address", "bytes"],
            [blsWalletLogicAddress, proxyAdminAddress, initFunctionParams],
          ),
        ],
      ),
    );

    // TODO: Better to check against address calculated by VerificationGateway
    expect(calculatedAddress).to.equal(wallet.address);
  });

  it("should receive ETH", async function () {
    const wallet = await fx.lazyBlsWallets[0]();

    const walletBalanceBefore = await fx.provider.getBalance(wallet.address);

    const ethToTransfer = utils.parseEther("0.0001");

    await fx.signers[0].sendTransaction({
      to: wallet.address,
      value: ethToTransfer,
    });

    const walletBalanceAfter = await fx.provider.getBalance(wallet.address);
    expect(walletBalanceAfter.sub(walletBalanceBefore)).to.equal(ethToTransfer);
  });

  it("should send ETH (empty call)", async function () {
    // send money to sender bls wallet
    const sendWallet = await fx.lazyBlsWallets[0]();
    const recvWallet = await fx.lazyBlsWallets[1]();
    const ethToTransfer = utils.parseEther("0.0001");
    await fx.signers[0].sendTransaction({
      to: sendWallet.address,
      value: ethToTransfer,
    });

    const senderBalanceBefore = await fx.provider.getBalance(
      sendWallet.address,
    );
    const receiverBalanceBefore = await fx.provider.getBalance(
      recvWallet.address,
    );

    const tx = sendWallet.sign({
      nonce: await sendWallet.Nonce(),
      actions: [
        {
          ethValue: ethToTransfer,
          // TODO: Does wallet contract need to exist?
          contractAddress: recvWallet.walletContract.address,
          encodedFunction: "0x",
        },
      ],
    });

    await fx.verificationGateway.processBundle(
      fx.blsWalletSigner.aggregate([tx]),
    );

    const senderBalanceAfter = await fx.provider.getBalance(sendWallet.address);
    const receiverBalanceAfter = await fx.provider.getBalance(
      recvWallet.address,
    );

    expect(senderBalanceBefore.sub(senderBalanceAfter)).to.equal(ethToTransfer);
    expect(receiverBalanceAfter.sub(receiverBalanceBefore)).to.equal(
      ethToTransfer,
    );
  });

  it("should send ETH with function call", async function () {
    // send money to sender bls wallet
    const sendWallet = await fx.lazyBlsWallets[0]();
    const ethToTransfer = utils.parseEther("0.001");
    await fx.signers[0].sendTransaction({
      to: sendWallet.address,
      value: ethToTransfer,
    });

    const MockAuction = await ethers.getContractFactory("MockAuction");
    const mockAuction = await MockAuction.deploy();
    await mockAuction.deployed();

    expect(await fx.provider.getBalance(sendWallet.address)).to.equal(
      ethToTransfer,
    );
    expect(await fx.provider.getBalance(mockAuction.address)).to.equal(0);

    await fx.verificationGateway.processBundle(
      fx.blsWalletSigner.aggregate([
        sendWallet.sign({
          nonce: BigNumber.from(1),
          actions: [
            {
              ethValue: ethToTransfer,
              contractAddress: mockAuction.address,
              encodedFunction:
                mockAuction.interface.encodeFunctionData("buyItNow"),
            },
          ],
        }),
      ]),
    );

    expect(await fx.provider.getBalance(sendWallet.address)).to.equal(0);
    expect(await fx.provider.getBalance(mockAuction.address)).to.equal(
      ethToTransfer,
    );
  });

  it("should check signature", async function () {
    const wallet = await fx.lazyBlsWallets[0]();

    const tx = wallet.sign({
      nonce: await wallet.Nonce(),
      actions: [
        {
          ethValue: BigNumber.from(0),
          contractAddress: fx.verificationGateway.address,
          encodedFunction: fx.verificationGateway.interface.encodeFunctionData(
            "walletFromHash",
            [fx.blsWalletSigner.getPublicKeyHash(wallet.privateKey)],
          ),
        },
      ],
    });

    await fx.verificationGateway.callStatic.verify(tx);

    tx.operations[0].actions[0].ethValue = parseEther("1");
    await expectRevert(fx.verificationGateway.callStatic.verify(tx));
  });

  it("should process individual calls", async function () {
    th = new TokenHelper(fx);
    const wallets = await th.walletTokenSetup();

    // check each wallet has start amount
    for (let i = 0; i < wallets.length; i++) {
      const walletBalance = await th.testToken.balanceOf(wallets[i].address);
      expect(walletBalance).to.equal(th.userStartAmount);
    }
    // bls transfer each wallet's balance to first wallet
    for (let i = 0; i < wallets.length; i++) {
      await th.transferFrom(
        await wallets[i].Nonce(),
        wallets[i],
        wallets[0].address,
        th.userStartAmount,
      );
    }

    // check first wallet full and others empty
    const totalAmount = th.userStartAmount.mul(wallets.length);
    for (let i = 0; i < wallets.length; i++) {
      const walletBalance = await th.testToken.balanceOf(wallets[i].address);
      expect(walletBalance).to.equal(i === 0 ? totalAmount : 0);
    }
  });

  it("should airdrop (multicall)", async function () {
    th = new TokenHelper(fx);

    const wallets = await fx.createBLSWallets();
    const testToken = await TokenHelper.deployTestToken();

    // send all to first address
    const totalAmount = th.userStartAmount.mul(wallets.length);
    await (
      await testToken
        .connect(fx.signers[0])
        .transfer(wallets[0].address, totalAmount)
    ).wait();

    const nonce = await wallets[0].Nonce();

    const tx = wallets[0].sign({
      nonce,
      actions: wallets.map((recvWallet) => ({
        ethValue: BigNumber.from(0),
        contractAddress: testToken.address,
        encodedFunction: testToken.interface.encodeFunctionData("transfer", [
          recvWallet.address,
          th.userStartAmount.toString(),
        ]),
      })),
    });

    const _tx = await fx.blsExpander.blsCallMultiSameCallerContractFunction(
      tx.senderPublicKeys[0],
      nonce,
      tx.signature,
      testToken.address,
      testToken.interface.getSighash("transfer"),
      tx.operations[0].actions.map(
        (action) =>
          `0x${solidityPack(["bytes"], [action.encodedFunction]).slice(10)}`,
      ),
    );
    console.log(_tx);
    await _tx.wait();

    for (let i = 0; i < wallets.length; i++) {
      const walletBalance = await testToken.balanceOf(wallets[i].address);
      expect(walletBalance).to.equal(th.userStartAmount);
    }
  });

  it("should airdrop (multicall) (compression)", async function () {
    const [user] = await ethers.getSigners();
    th = new TokenHelper(fx);

    const wallets = await fx.createBLSWallets();
    const testToken = await TokenHelper.deployTestToken();

    // send all to first address
    const totalAmount = th.userStartAmount.mul(wallets.length);
    await (
      await testToken
        .connect(fx.signers[0])
        .transfer(wallets[0].address, totalAmount)
    ).wait();

    const nonce = await wallets[0].Nonce();

    const tx = wallets[0].sign({
      nonce,
      actions: wallets.map((recvWallet) => ({
        ethValue: BigNumber.from(0),
        contractAddress: testToken.address,
        encodedFunction: testToken.interface.encodeFunctionData("transfer", [
          recvWallet.address,
          th.userStartAmount.toString(),
        ]),
      })),
    });

    const Decompressor = await ethers.getContractFactory("Decompressor");
    const decompressor = await Decompressor.deploy();
    await decompressor.deployed();

    await (
      await decompressor.connect(user).registerReceiver(fx.blsExpander.address)
    ).wait();
    const receiverIndex = await decompressor.receiversByAddress(
      fx.blsExpander.address,
    );

    const compressedData = compressSingle(
      receiverIndex,
      0,
      [
        tx.senderPublicKeys[0],
        nonce.toString(),
        tx.signature,
        testToken.address,
        testToken.interface.getSighash("transfer"),
        tx.operations[0].actions.map(
          (action) =>
            `0x${solidityPack(["bytes"], [action.encodedFunction]).slice(10)}`,
        ),
      ],
      ["uint[4]", "uint", "uint[2]", "address", "bytes4", "bytes[]"],
    );
    const _tx = await decompressor
      .connect(user)
      .decompressSingleBitCall(compressedData);
    console.log(_tx);
    await _tx.wait();

    for (let i = 0; i < wallets.length; i++) {
      const walletBalance = await testToken.balanceOf(wallets[i].address);
      expect(walletBalance).to.equal(th.userStartAmount);
    }
  });

  // TODO: update with approve and transfer actions to tx.origin
  // it('should check token reward', async function() {
  //   // Construct 2 transactions:
  //   //  - one sending ETH to between wallet 1 and wallet 2
  //   //  - one sending tokens from rewarderAddress to rewardRecipient
  //   // Use blsCallMultiCheckRewardIncrease function to check reward amount

  //   // prepare bls signers, wallets, eth and token balances
  //   const rewarder = await fx.lazyBlsWallets[0]();
  //   const wallet1 = await fx.lazyBlsWallets[1]();
  //   const wallet2 = await fx.lazyBlsWallets[2]();

  //   let ethToTransfer = utils.parseEther("0.0001");
  //   await fx.signers[0].sendTransaction({
  //     to: wallet1.address,
  //     value: ethToTransfer
  //   });
  //   th = new TokenHelper(fx);
  //   let testToken = await TokenHelper.deployTestToken();
  //   await(await testToken.connect(fx.signers[0]).transfer(
  //     rewarder.address,
  //     th.userStartAmount
  //   )).wait();

  //   // prepare and sign eth transfer tx (from wallet 1 to 2)
  //   const tx1 = wallet1.sign({
  //     nonce: BigNumber.from(1),
  //     atomic: true,
  //     actions: [
  //       {
  //         ethValue: ethToTransfer,
  //         contractAddress: wallet2.walletContract.address,
  //         encodedFunction: "0x",
  //       },
  //     ],
  //   });

  //   // prepare and sign token transfer to origin tx (reward)
  //   let rewardTokenAddress = testToken.address;
  //   let rewardAmountRequired = th.userStartAmount.div(4); // arbitrary reward amount
  //   let rewardAmountToSend = rewardAmountRequired.mul(2); // send double reward

  //   const tx2 = rewarder.sign({
  //     nonce: BigNumber.from(1),
  //     atomic: true,
  //     actions: [
  //       {
  //         ethValue: BigNumber.from(0),
  //         contractAddress: fx.verificationGateway.contract.address,
  //         encodedFunction: fx.verificationGateway.contract.interface.encodeFunctionData(
  //           "transferToOrigin",
  //           [rewardAmountToSend, testToken.address],
  //         ),
  //       },
  //     ],
  //   });

  //   // shouldn't be able to directly call transferToOrigin
  //   expectRevert(
  //     fx.verificationGateway.contract.transferToOrigin(rewardAmountToSend, testToken.address)
  //   );

  //   const aggTx = fx.blsWalletSigner.aggregate([tx1, tx2]);

  //   // callStatic to return correct increase
  //   let rewardIncrease = await fx.blsExpander.callStatic.blsCallMultiCheckRewardIncrease(
  //     rewardTokenAddress,
  //     rewardAmountRequired,
  //     aggTx.subTransactions.map(tx => splitHex256(tx.publicKey)),
  //     splitHex256(aggTx.signature),
  //     aggTx.subTransactions.map(tx => ({
  //       nonce: tx.nonce,
  //       atomic: tx.atomic,
  //       actions: tx.actions,
  //     })),
  //   );
  //   expect(rewardIncrease).to.equal(rewardAmountToSend);

  //   // exception when required more than rewarded
  //   await expectRevert(fx.blsExpander.callStatic.blsCallMultiCheckRewardIncrease(
  //     rewardTokenAddress,
  //     rewardAmountToSend.add(1), //require more than amount sent
  //     aggTx.subTransactions.map(tx => splitHex256(tx.publicKey)),
  //     splitHex256(aggTx.signature),
  //     aggTx.subTransactions.map(tx => ({
  //       nonce: tx.nonce,
  //       atomic: tx.atomic,
  //       actions: tx.actions,
  //     })),
  //   ));

  //   // rewardRecipient balance increased after actioning transfer
  //   let balanceBefore = await testToken.balanceOf(fx.addresses[0]);
  //   await (await fx.blsExpander.blsCallMultiCheckRewardIncrease(
  //     rewardTokenAddress,
  //     rewardAmountRequired,
  //     aggTx.subTransactions.map(tx => splitHex256(tx.publicKey)),
  //     splitHex256(aggTx.signature),
  //     aggTx.subTransactions.map(tx => ({
  //       nonce: tx.nonce,
  //       atomic: tx.atomic,
  //       actions: tx.actions,
  //     })),
  //   )).wait();
  //   let balanceAfter = await testToken.balanceOf(fx.addresses[0]);
  //   expect(balanceAfter.sub(balanceBefore)).to.equal(rewardAmountToSend);
  // })
});
