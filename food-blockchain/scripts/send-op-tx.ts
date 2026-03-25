import hre from "hardhat";

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const [senderClient] = await hre.viem.getWalletClients();

  console.log("Sending transaction using the local Hardhat network");
  console.log("Sending 1 wei from", senderClient.account.address, "to itself");

  const hash = await senderClient.sendTransaction({
    account: senderClient.account,
    to: senderClient.account.address,
    value: 1n,
  });

  await publicClient.waitForTransactionReceipt({ hash });

  console.log("Transaction sent successfully");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
