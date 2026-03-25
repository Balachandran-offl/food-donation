import hre from "hardhat";

async function main() {
  const foodDonation = await hre.viem.deployContract("FoodDonation");
  console.log("Contract deployed to:", foodDonation.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
