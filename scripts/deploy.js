// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// You can also run a script with `npx hardhat run <script>`. If you do that, Hardhat
// will compile your contracts, add the Hardhat Runtime Environment's members to the
// global scope, and execute the script.
const { ethers } = require("hardhat");

//TODO:
// 1. deploy TLC
// 2. verify contracts
// 2. grant oven role to oven
// 3. grant admin role to TLC
// 4. renounce admin role
// 5. transfer ownership to TLC


async function main() {
  const accounts = await ethers.getSigners();

  // //Deploy Dough
  // const dough = await ethers.deployContract("Dough");
  // await dough.waitForDeployment();
  // console.log(`Dough deployed to ${dough.target}`);
  // //get uniswapV2 pair address
  // const doughV2Pair = await dough.uniswapV2Pair();
  // console.log(`Dough uniswapV2 pair address is ${doughV2Pair}`);

  //Deploy LeOven
//   const oven = await ethers.deployContract("LeOvenV4", [
//     "0xFc116eA24F002F600e363bdce4b91715fe5e0392",
//     "0xb5B3245e2dcFCA6474e3B8588e6baFEE9B683496",
//     0n,
//     0n,
//     0n,
//   ]);
//   await oven.waitForDeployment();
//   console.log(`LeOven V4.0 deployed to ${oven.target}`);

  // //Deploy Timelock controller
  // const timelock = await ethers.deployContract("TimelockController", [
  //   60 * 60 * 24, //1 day
  //   [accounts[0].address],
  //   [accounts[0].address],
  //   accounts[0].address,
  // ]);
  // await timelock.waitForDeployment();
  // console.log(`Timelock controller deployed to ${timelock.target}`);

  // //Grant oven role to Le Oven
  // await dough.connect(accounts[0]).grantRole(ethers.keccak256(ethers.toUtf8Bytes("OVEN_ROLE")), "0x5E1707515d30E91459E12A6FC6d885558b5DAD9e");
	// console.log(`OVEN_ROLE granted to 0x5E1707515d30E91459E12A6FC6d885558b5DAD9e`);

  const dough = await ethers.getContractAt("Dough", "0xFc116eA24F002F600e363bdce4b91715fe5e0392");
  console.log(dough.target);
  const timelock = await ethers.getContractAt("TimelockController", "0xA590F0515eA6BCcf2a06C786FAF1C971b2663c2D");
  console.log(timelock.target);
  const oven = await ethers.getContractAt("LeOvenV4", "0xf46997fe33D626BFF2784F416D887B3C9a98D309");
  console.log(oven.target);

  //Grant admin role to TLC
  // await dough.connect(accounts[0]).grantRole(ethers.ZeroHash, "0xA590F0515eA6BCcf2a06C786FAF1C971b2663c2D");
  // await dough.connect(accounts[0]).renounceRole(ethers.ZeroHash, accounts[0].address);
  // console.log(`DEFAULT_ADMIN_ROLE granted to 0xA590F0515eA6BCcf2a06C786FAF1C971b2663c2D`);

  //Transfer ownership to TLC
  // await dough.connect(accounts[0]).transferOwnership("0xA590F0515eA6BCcf2a06C786FAF1C971b2663c2D");

  // //check roles
  // console.log(`OWNER: ${await dough.owner()}`);
  // console.log(`OVEN_ROLE: ${await dough.getRoleMemberCount(ethers.keccak256(ethers.toUtf8Bytes("OVEN_ROLE")))}`);
  // console.log(`DEFAULT_ADMIN_ROLE: ${await dough.getRoleMemberCount(ethers.ZeroHash)}`);
  // console.log(`Account 0 has DEFAULT_ADMIN_ROLE: ${await dough.hasRole(ethers.ZeroHash, accounts[0].address)}`);
  // console.log(`Timelock controller has DEFAULT_ADMIN_ROLE: ${await dough.hasRole(ethers.ZeroHash, "0xA590F0515eA6BCcf2a06C786FAF1C971b2663c2D")}`);

  // schedule tx on timelock to update taxes to 2/2
  // let predecessor = ethers.encodeBytes32String("");
//   let predecessor = "0x761f7bcb15391af3cf7c30b2d16e5476b5b74e06b7cb51b6a549937602213a64";
//   let data = new ethers.Interface(['function setTaxInfo(uint32 _burnTaxBuy, uint32 _burnTaxSell, uint32 _rewardTaxBuy, uint32 _rewardTaxSell, uint32 _developmentTaxBuy, uint32 _developmentTaxSell)']).encodeFunctionData('setTaxInfo', [40, 40, 0, 0, 10, 10]);
// 	let salt = ethers.hexlify(ethers.randomBytes(32));
//   let tx = await timelock.connect(accounts[0]).schedule(
//     dough.target,
//     0,
//     data,
//     predecessor,
//     salt,
//     60 * 60 * 24,
//   );
//   console.log(`Transaction scheduled: ${tx.hash}`);

//   let predecessor = "0x60e2a2a5ca876d46c9e24a5393109f8751eb39a8531f0f29bbe36ef88366db43";
//   let data = new ethers.Interface(['function grantRole(bytes32 role, address account)']).encodeFunctionData('grantRole', ["0x9349919b30781f92932102d65ec1fc728680b41ffc1b98020a604df428efec20", "0xf46997fe33D626BFF2784F416D887B3C9a98D309"]);
//   let salt = ethers.hexlify(ethers.randomBytes(32));
//   let tx = await timelock.connect(accounts[0]).schedule(
//     dough.target,
//     0,
//     data,
//     predecessor,
//     salt,
//     60 * 60 * 24,
//   );
//   console.log(`Transaction scheduled: ${tx.hash}`);

//   let predecessor = "0x60e2a2a5ca876d46c9e24a5393109f8751eb39a8531f0f29bbe36ef88366db43";
//   let data = new ethers.Interface(['function setFeeException(address account, bool isExcluded)']).encodeFunctionData('setFeeException', [oven.target, true]);
//   let salt = ethers.hexlify(ethers.randomBytes(32));
//   let tx = await timelock.connect(accounts[0]).schedule(
//     dough.target,
//     0,
//     data,
//     predecessor,
//     salt,
//     60 * 60 * 24,
//   );
//   console.log(`Transaction scheduled: ${tx.hash}`);

//   let predecessor = "0x38af5937079d5502f0f8ee55f8d6db9efcec92b1a9b36e72edbeb071b55f0318";
//   let data = new ethers.Interface(['function setFeeException(address account, bool isExcluded)']).encodeFunctionData('setFeeException', [oven.target, true]);
//   let salt = ethers.hexlify(ethers.randomBytes(32));
//   let tx = await timelock.connect(accounts[0]).schedule(
//     dough.target,
//     0,
//     data,
//     predecessor,
//     salt,
//     60 * 60 * 24,
//   );
//   console.log(`Transaction scheduled: ${tx.hash}`);

//   let predecessor = "0x0000000000000000000000000000000000000000000000000000000000000000";
//   let data = new ethers.Interface(['function updateDelay(uint256 newDelay)']).encodeFunctionData('updateDelay', [1]);
//   let salt = ethers.hexlify(ethers.randomBytes(32));
//   let tx = await timelock.connect(accounts[0]).schedule(
//     timelock.target,
//     0,
//     data,
//     predecessor,
//     salt,
//     60 * 60 * 24,
//   );
//   console.log(`Transaction scheduled: ${tx.hash}`);

//get tax info
let taxInfo = await dough.taxInfo();
console.log(taxInfo);

//check if oven has oven role
let hasRole = await dough.hasRole(ethers.keccak256(ethers.toUtf8Bytes("OVEN_ROLE")), oven.target);
console.log(hasRole);

//check netcirculating supply
let netCirculatingSupply = await oven.netCirculatingDough();
console.log(netCirculatingSupply);

//check total supply
let totalSupply = await dough.totalSupply();
console.log(totalSupply);

//   let tx = await timelock.connect(accounts[0]).cancel("0xcdcd942eeac933ad97dcb207f09273e20684c3baa01ecb850a5071a0841d5069");
//   console.log(`Transaction cancelled: ${tx.hash}`);


  // //execute scheduled txn
  // let tx = await timelock.connect(accounts[0]).execute(
  //   dough.target,
  //   0,
  //   data,
  //   predecessor,
  //   "0x7bcfa4c47874835f0569f010359498771134bdb23f3efb1496bf9fb1287e31af",
  // );
  // console.log(`Transaction executed: ${tx.hash}`);

  //taxes after
  // console.log(`Dough taxes after ${await dough.getTaxInfo()}`);

  // //sign message
  // let message = "[Etherscan.io 06/03/2024 22:37:35] I, hereby verify that I am the owner/creator of the address [0xfc116ea24f002f600e363bdce4b91715fe5e0392]";
  // let flatSig = await accounts[0].signMessage(message);
  // console.log(flatSig);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
