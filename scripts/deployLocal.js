// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// You can also run a script with `npx hardhat run <script>`. If you do that, Hardhat
// will compile your contracts, add the Hardhat Runtime Environment's members to the
// global scope, and execute the script.
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

//uniswap stuff
const uniswapContract = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const uniswapFactoryContract = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const uniswapAbi = require('../abis/uniswapV2router.json');
const uniswapFactoryAbi = require('../abis/uniswapV2factory.json');
const uniswapPairAbi = require('../abis/uniswapV2pair.json');
const doughAbi = require('../artifacts/contracts/Dough.sol/Dough.json');
const ovenAbi = require('../artifacts/contracts/le_oven_v2.sol/LeOvenV4.json');

const DEFAULT_RPB = 200000000000n;
const DEFAULT_RPB_LP = 400000000000n;
const DEFAULT_DECAY = 999998865n * 10n**9n;

//TODO:
// 1. deploy TLC
// 2. verify contracts
// 2. grant oven role to oven
// 3. grant admin role to TLC
// 4. renounce admin role
// 5. transfer ownership to TLC

//helper function to get uniswap tx info for buying
async function getUniswapBuyTxInfo(uniswap, buyAmountETH, tokenAddress) {
    amountsOut = await uniswap.getAmountsOut(ethers.parseEther(buyAmountETH.toString()), [uniswap.WETH(), tokenAddress]);
    amountOutMin = amountsOut[1] * 3n / 4n; //25% slippage
    deadline = ethers.MaxUint256;
    return [amountOutMin, deadline];
}

//helper function to get uniswap tx info for selling
async function getUniswapSellTxInfo(uniswap, amountTokens, tokenAddress) {
    amountsOut = await uniswap.getAmountsOut(amountTokens, [tokenAddress, uniswap.WETH()]);
    amountOutMin = amountOutMin = amountsOut[1] * 3n / 4n; //25% slippage
    deadline = ethers.MaxUint256;
    return [amountOutMin, deadline];
}

//helper function to purchase on Uniswap
async function buyOnUniswap(uniswap, tokenAddress, account, amountETH) {
    const [amountOutMin, deadline] = await getUniswapBuyTxInfo(uniswap, amountETH, tokenAddress);
    let purchaseTx = await uniswap.connect(account).swapExactETHForTokensSupportingFeeOnTransferTokens(
        amountOutMin,
        [uniswap.WETH(), tokenAddress],
        account.address,
        deadline,
        {value: ethers.parseEther(amountETH.toString())},
    );
    let receipt = await purchaseTx.wait();
    return receipt;
}

//helper function to sell on Uniswap
async function sellOnUniswap(uniswap, dough, account, amountTokens) {
    const [amountOutMin, deadline] = await getUniswapSellTxInfo(uniswap, amountTokens, dough.target);
    await dough.connect(account).approve(uniswap.target, amountTokens);
    let sellTx = await uniswap.connect(account).swapExactTokensForETHSupportingFeeOnTransferTokens(
        amountTokens,
        0,
        [dough.target, uniswap.WETH()],
        account.address,
        deadline,
    );
    let receipt = await sellTx.wait();
    return receipt;
}

//helper function to buy and add liquidity on uniswap
async function buyAndAddLiquidity(uniswap, dough, doughLP, account, amountETH) {
    const [amountOutMin, deadline] = await getUniswapBuyTxInfo(uniswap, amountETH, dough.target);
    await uniswap.connect(account).swapExactETHForTokensSupportingFeeOnTransferTokens(
        amountOutMin,
        [uniswap.WETH(), dough.target],
        account.address,
        deadline,
        {value: ethers.parseEther(amountETH.toString())},
    );
    const doughBalance = await dough.balanceOf(account.address);
    await dough.connect(account).approve(uniswap.target, doughBalance);
    await uniswap.connect(account).addLiquidityETH(
        dough.target,
        doughBalance,
        doughBalance * 3n / 4n, //75% slippage
        ethers.parseEther((amountETH / 2).toString()),
        account.address,
        deadline,
        {value: ethers.parseEther((amountETH * 2).toString())}
    )
    console.log(`LP token balance: ${await doughLP.balanceOf(account.address)}`);
}

//helper functions to deposit to Oven
async function depositToOven(oven, dough, account, amount, pledgePriceDiff) {
    await dough.connect(account).approve(oven.target, amount);
    const tx = await oven.connect(account).stakeNbake(
        amount,
        pledgePriceDiff,
        false
    );
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed;
    console.log("Dough deposited to Oven. Gas used: " + gasUsed.toString());
    return receipt;
}

async function depositLPToOven(oven, doughLP, account, amount, pledgePriceDiff) {
    await doughLP.connect(account).approve(oven.target, amount);
    const tx = await oven.connect(account).stakeNbake(
        amount,
        pledgePriceDiff,
        true
    );
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed;
    console.log("DOUGH/WETH LP tokens deposited to Oven. Gas used: " + gasUsed.toString());
    return receipt;
}

//helper function that gets current price on Uniswap
async function getCurrentPrice(pair) {
    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();
    if (token0 == '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2') {
        return parseInt(reserve0) / parseInt(reserve1);
    } else {
        return parseInt(reserve1) / parseInt(reserve0);
    }
}

//helper function that inflates price on uniswap till pledgePrice is met
async function inflatePrice(uniswap, pair, tokenAddress, account, pledgePrice, inflateAmount=0.1) {
    let currPrice = await getCurrentPrice(pair);
    // console.log(`Current price at start of inflation: ${currPrice}`);
    console.log(`Target price: ${pledgePrice}`);
    while (currPrice < pledgePrice) {
        // console.log(`Current price: ${currPrice}`);
        await buyOnUniswap(uniswap, tokenAddress, account, inflateAmount);
        currPrice = await getCurrentPrice(pair);
    }
    console.log(`Current price at end of inflation: ${currPrice}`);
    return currPrice;
}


async function main() {
    const accounts = await ethers.getSigners();
    const uniswap = await ethers.getContractAt(uniswapAbi, uniswapContract);
    const uniswapFactory = await ethers.getContractAt(uniswapFactoryAbi, uniswapFactoryContract);

    //Deploy Dough
    const dough = await ethers.deployContract("Dough");
    await dough.waitForDeployment();
    console.log(`Dough deployed to ${dough.target}`);
    //get uniswapV2 pair address
    const doughV2Pair = await dough.uniswapV2Pair();
    console.log(`Dough uniswapV2 pair address is ${doughV2Pair}`);

    await dough.connect(accounts[0]).approve(uniswap.target, await dough.balanceOf(accounts[0].address));
    await uniswap.connect(accounts[0]).addLiquidityETH(
        dough.target,
        await dough.balanceOf(accounts[0].address),
        0,
        ethers.parseEther("3"),
        accounts[0].address,
        (parseInt(Math.floor(new Date().getTime() / 1000))) + 60 * 5, //deadline
        {value: ethers.parseEther("3")}
    );
    console.log(`Dough/WETH pair created on UniswapV2 and 10 ETH in liquidity added`);
    const doughLP = await ethers.getContractAt(uniswapPairAbi, await uniswapFactory.getPair(dough.target, uniswap.WETH()));
    console.log(`Dough/WETH pair address: ${doughLP.target}`);
    console.log(`LP Token 0: ${await doughLP.token0()}`)
    console.log(`LP Token 1: ${await doughLP.token1()}`)

    //Set trading open to true on Dough
    await dough.connect(accounts[0]).fermentDough();
    console.log(`Trading open: ${await dough.fermented()}`);

    //Deploy LeOven
    const oven = await ethers.deployContract("LeOvenV4", [
        dough.target,
        doughLP.target,
        0, //400 * 1e9
        0, //800 * 1e9
        0,
    ]);
    await oven.waitForDeployment();
    console.log(`LeOven V4 deployed to ${oven.target}`);

    //Enable staking/deposits
    await oven.connect(accounts[0]).preheat(true);

    //Grant permissions
    await dough.connect(accounts[0]).grantRole(ethers.keccak256(ethers.toUtf8Bytes("OVEN_ROLE")), oven.target);
    console.log(`OVEN_ROLE granted to ${oven.target}`);

    //Exclude LeOven from fees on Dough
    await dough.connect(accounts[0]).setFeeException(oven.target, true);
    console.log(`LeOven excluded from fees on Dough`);

    //Buy some dough with accounts 1-5
    for (let i = 1; i < 6; i++) {
        await buyOnUniswap(uniswap, dough.target, accounts[i], 3);
        console.log(`Dough balance for account ${i}: ${await dough.balanceOf(accounts[i].address)}`);
        
        for (let j = 0; j < 5; j++) {
            //generate random integer between 8 and 400 for multiple
            const multiple = Math.floor(Math.random() * 72) + 8;
            //deposit to oven
            await depositToOven(oven, dough, accounts[i], (await dough.balanceOf(accounts[i].address)) / 10n, multiple);
            console.log('Dough deposited to oven for account ' + i);
        }
    }
    for (let i = 6; i < 12; i++) {
        await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[i], 6);
        console.log(`LP Token balance for account ${i}: ${await doughLP.balanceOf(accounts[i].address)}`);
        for (let j = 0; j < 5; j++) {
            //generate random integer between 8 and 400 for multiple
            const multiple = Math.floor(Math.random() * 72) + 8;
            //deposit to oven
            await depositLPToOven(oven, doughLP, accounts[i], (await doughLP.balanceOf(accounts[i].address)) / 10n, multiple);
            console.log('LP Tokens deposited to oven for account ' + i);
        }
    }
}

async function getContracts() {
    const doughAddress = "0x54287AaB4D98eA51a3B1FBceE56dAf27E04a56A6";
    const doughLPAddress = "0xb42CC5E6BB90D93FA64370D2E46fDbA1e4691095";
    const ovenAddress = "0x11632F9766Ee9d9317F95562a6bD529652ead78f";
    const dough = await ethers.getContractAt(doughAbi.abi, doughAddress);
    const doughLP = await ethers.getContractAt(uniswapPairAbi, doughLPAddress);
    const oven = await ethers.getContractAt(ovenAbi.abi, ovenAddress);
    const uniswap = await ethers.getContractAt(uniswapAbi, uniswapContract);
    return {dough, doughLP, oven, uniswap};
}

async function doStuff() {
    const {dough, doughLP, oven, uniswap} = await getContracts();
    const accounts = await ethers.getSigners();

    const currPrice = await getCurrentPrice(doughLP);
    await inflatePrice(uniswap, doughLP, dough.target, accounts[0], currPrice*100, 5);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// doStuff();
