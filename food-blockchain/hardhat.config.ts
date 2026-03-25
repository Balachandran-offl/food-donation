import "@nomicfoundation/hardhat-toolbox-viem";
import type { HardhatUserConfig } from "hardhat/config";

const sepoliaPrivateKey = process.env.SEPOLIA_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: "0.8.28",
  networks: {
    localhost: {},
    sepolia: {
      url: "https://sepolia.infura.io/v3/88c8d6642fdc4a4aa948371303c3f0b9",
      accounts: sepoliaPrivateKey ? [sepoliaPrivateKey] : [],
    },
  },
};

export default config;
