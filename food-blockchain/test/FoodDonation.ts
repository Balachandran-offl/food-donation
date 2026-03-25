import { expect } from "chai";
import hre from "hardhat";

describe("FoodDonation", function () {
  async function deployFoodDonation() {
    const foodDonation = await hre.viem.deployContract("FoodDonation");
    const publicClient = await hre.viem.getPublicClient();
    const [donor, receiver, otherReceiver] = await hre.viem.getWalletClients();

    return { foodDonation, publicClient, donor, receiver, otherReceiver };
  }

  it("stores the request hash through request, approval, and completion", async function () {
    const { foodDonation, publicClient, donor, receiver } = await deployFoodDonation();
    const donationHash = `0x${"11".repeat(32)}` as `0x${string}`;
    const pendingRequestHash = `0x${"22".repeat(32)}` as `0x${string}`;
    const acceptedRequestHash = `0x${"33".repeat(32)}` as `0x${string}`;
    const completedRequestHash = `0x${"44".repeat(32)}` as `0x${string}`;

    const addHash = await foodDonation.write.addDonation([donationHash], {
      account: donor.account
    });
    await publicClient.waitForTransactionReceipt({ hash: addHash });

    const requestHash = await foodDonation.write.requestClaim([1n, pendingRequestHash], {
      account: receiver.account
    });
    await publicClient.waitForTransactionReceipt({ hash: requestHash });

    let donation = await foodDonation.read.getDonation([1n]);
    expect(donation.receiver).to.equal(receiver.account.address);
    expect(donation.requestHash).to.equal(pendingRequestHash);
    expect(Number(donation.requestStatus)).to.equal(1);
    expect(donation.claimed).to.equal(false);

    const reviewHash = await foodDonation.write.reviewClaimRequest(
      [1n, true, acceptedRequestHash],
      {
        account: donor.account
      }
    );
    await publicClient.waitForTransactionReceipt({ hash: reviewHash });

    donation = await foodDonation.read.getDonation([1n]);
    expect(donation.requestHash).to.equal(acceptedRequestHash);
    expect(Number(donation.requestStatus)).to.equal(2);
    expect(donation.claimed).to.equal(true);

    const completeHash = await foodDonation.write.completeDelivery([1n, completedRequestHash], {
      account: donor.account
    });
    await publicClient.waitForTransactionReceipt({ hash: completeHash });

    donation = await foodDonation.read.getDonation([1n]);
    expect(donation.requestHash).to.equal(completedRequestHash);
    expect(donation.completed).to.equal(true);
  });

  it("allows a new receiver request after the donor rejects the previous one", async function () {
    const { foodDonation, publicClient, donor, receiver, otherReceiver } =
      await deployFoodDonation();
    const donationHash = `0x${"55".repeat(32)}` as `0x${string}`;
    const firstPendingHash = `0x${"66".repeat(32)}` as `0x${string}`;
    const rejectedHash = `0x${"77".repeat(32)}` as `0x${string}`;
    const secondPendingHash = `0x${"88".repeat(32)}` as `0x${string}`;

    const addHash = await foodDonation.write.addDonation([donationHash], {
      account: donor.account
    });
    await publicClient.waitForTransactionReceipt({ hash: addHash });

    const firstRequestHash = await foodDonation.write.requestClaim([1n, firstPendingHash], {
      account: receiver.account
    });
    await publicClient.waitForTransactionReceipt({ hash: firstRequestHash });

    const rejectTxHash = await foodDonation.write.reviewClaimRequest([1n, false, rejectedHash], {
      account: donor.account
    });
    await publicClient.waitForTransactionReceipt({ hash: rejectTxHash });

    let donation = await foodDonation.read.getDonation([1n]);
    expect(Number(donation.requestStatus)).to.equal(3);
    expect(donation.claimed).to.equal(false);
    expect(donation.receiver).to.equal(receiver.account.address);

    const secondRequestTxHash = await foodDonation.write.requestClaim([1n, secondPendingHash], {
      account: otherReceiver.account
    });
    await publicClient.waitForTransactionReceipt({ hash: secondRequestTxHash });

    donation = await foodDonation.read.getDonation([1n]);
    expect(Number(donation.requestStatus)).to.equal(1);
    expect(donation.claimed).to.equal(false);
    expect(donation.receiver).to.equal(otherReceiver.account.address);
    expect(donation.requestHash).to.equal(secondPendingHash);
  });
});
