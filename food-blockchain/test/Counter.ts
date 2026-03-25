import { expect } from "chai";
import hre from "hardhat";

describe("Counter", function () {
  async function deployCounter() {
    const counter = await hre.viem.deployContract("Counter");
    const publicClient = await hre.viem.getPublicClient();

    return { counter, publicClient };
  }

  it("Should emit the Increment event when calling inc()", async function () {
    const { counter, publicClient } = await deployCounter();

    const hash = await counter.write.inc();
    await publicClient.waitForTransactionReceipt({ hash });

    const events = await counter.getEvents.Increment();
    expect(events).to.have.lengthOf(1);
    expect(events[0].args.by).to.equal(1n);
  });

  it("Should keep the current value in sync with the increments", async function () {
    const { counter } = await deployCounter();
    let total = 0n;

    for (let i = 1n; i <= 10n; i++) {
      await counter.write.incBy([i]);
      total += i;
    }

    expect(await counter.read.x()).to.equal(total);
  });
});
