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
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const BLOCKS_PER_DAY = 7150;
const REWARD_PER_BLOCK = 200000000000n;
const REWARD_PER_BLOCK_LP = 400000000000n;
const DEFAULT_DECAY = 999999465n * 10n**9n;

const ETH_PRICE = 3000;

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
    const lpBalance = await doughLP.balanceOf(account.address);
    console.log(`LP token balance: ${lpBalance}`);
    return {doughBalance, lpBalance};
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

//helper function to deposit to Oven
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


//helper function that calculates price and marketcap
async function calculatePriceAndMC(dough, doughLP) {
    let price = await getCurrentPrice(doughLP);
    let priceRaw = price * 1e-9 * ETH_PRICE;
    let mc = priceRaw * parseInt((await dough.totalSupply()) / 10n**9n);
    return {
        price: priceRaw,
        mc: mc
    }
}

//simulate function that runs the simulation with params
async function simulate(
    rpb,
    rpbLP,
    burnTax,
    decay,
    dailyVol,
    buyAmounts,
    buyAmountsLP
) {
    // console.log('RPB: ', rpb);
    // console.log('RPB LP: ', rpbLP);
    // console.log('Burn Tax: ', burnTax);
    // console.log('Decay: ', decay);
    // console.log('DailyVol: ', dailyVol);
    // console.log('BuyAmnts: ', buyAmounts);
    // console.log('BuyAmntsLP: ', buyAmountsLP);

    // return;

    const accounts = await ethers.getSigners();
    const uniswap = await ethers.getContractAt(uniswapAbi, uniswapContract);
    const uniswapFactory = await ethers.getContractAt(uniswapFactoryAbi, uniswapFactoryContract);

    let results = [];
    for (let i = 0; i < 1; i++) {
        console.log('\n\n BEGINNING ITERATION ' + i + '\n');
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
            ethers.MaxUint256, //deadline
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
        console.log('LeOven deploy params: ', [dough.target, doughLP.target, rpb[i], rpbLP[i], decay[i]])
        const oven = await ethers.deployContract("LeOvenV4", [
            dough.target,
            doughLP.target,
            rpb[i],
            rpbLP[i],
            decay[i],
        ]);
        await oven.waitForDeployment();
        console.log(`LeOven V4 deployed to ${oven.target}`);

        // //Check isWETHReserve0
        // console.log(`Is WETH reserve 0: ${await oven.isWETHReserve0()}`);

        //Enable staking/deposits
        await oven.connect(accounts[0]).preheat(true);

        //Grant permissions
        await dough.connect(accounts[0]).grantRole(ethers.keccak256(ethers.toUtf8Bytes("OVEN_ROLE")), oven.target);
        console.log(`OVEN_ROLE granted to ${oven.target}`);

        //Exclude LeOven from fees on Dough
        await dough.connect(accounts[0]).setFeeException(oven.target, true);
        console.log(`LeOven excluded from fees on Dough`);

        //Set burn tax
        await dough.connect(accounts[0]).setTaxInfo(
            burnTax[i][0],
            burnTax[i][1],
            0,
            0,
            0,
            0
        );
        console.log(`Burn tax set, tax info: ${await dough.getTaxInfo()}`);

        /// BEGIN SIMULATION ///

        let totalSupplyInitial = await dough.totalSupply();
        console.log(`\nTOTAL SUPPLY INITIAL: ${totalSupplyInitial}`);
        let rewardPerBlockInitial = await oven.rewardPerBlock();
        let rewardPerBlockInitialLP = await oven.rewardPerBlockLP();
        console.log(`REWARD PER BLOCK INITIAL: ${rewardPerBlockInitial}`);
        console.log(`REWARD PER BLOCK LP INITIAL: ${rewardPerBlockInitialLP}`);

        // buy 50% of supply on uniswap and deposit
        await buyOnUniswap(uniswap, dough.target, accounts[1], buyAmounts[i]);
        await buyOnUniswap(uniswap, dough.target, accounts[2], buyAmounts[i]);
        
        const balanceBefore1 = await dough.balanceOf(accounts[1]);
        const balanceBefore2 = await dough.balanceOf(accounts[2]);
        console.log(`Balance before 1: ${balanceBefore1}`);
        console.log(`Balance before 2: ${balanceBefore2}`);
        let pctSupplyStaked = parseFloat(balanceBefore1 + balanceBefore2) / parseFloat(await dough.totalSupply());
        console.log(`Percentage of supply bought: ${pctSupplyStaked}`);
        

        const lpResult1 =  await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[3], buyAmountsLP[i]);
        const lpResult2 = await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[4], buyAmountsLP[i]);
        console.log(`LP balance before 1: ${lpResult1.lpBalance}`);
        console.log(`LP balance before 2: ${lpResult2.lpBalance}`);
        let pctSupplyStakedLP = parseFloat(lpResult1.doughBalance + lpResult2.doughBalance) / parseFloat(await dough.totalSupply());
        console.log(`Percentage of supply bought (for LP): ${pctSupplyStakedLP}`);

        await inflatePrice(uniswap, doughLP, dough.target, accounts[0], (await getCurrentPrice(doughLP)) * 25, 5);

        // deposit
        await depositToOven(oven, dough, accounts[1], balanceBefore1, 17, false); //10x
        await depositLPToOven(oven, doughLP, accounts[3], lpResult1.lpBalance, 17, true); //10x
        await depositToOven(oven, dough, accounts[2], balanceBefore2, 10, false); //5x
        await depositLPToOven(oven, doughLP, accounts[4], lpResult2.lpBalance, 10, true); //100x
        
        const deposit1Info = await oven.getDepositInfo(1, false);
        const deposit2Info = await oven.getDepositInfo(2, false);
        console.log(`Deposit info 1: ${deposit1Info}`);
        console.log(`Deposit info 2: ${deposit2Info}`);

        // await depositLPToOven(oven, doughLP, accounts[3], lpResult1.lpBalance, 400, true); //10x
        // await depositLPToOven(oven, doughLP, accounts[4], lpResult2.lpBalance, 200, true); //100x
        const lpDeposit1Info = await oven.getDepositInfo(1, true);
        const lpDeposit2Info = await oven.getDepositInfo(2, true);
        console.log(`Deposit info 1 LP: ${lpDeposit1Info}`);
        console.log(`Deposit info 2 LP: ${lpDeposit2Info}`);
        

        let priceInitial = await getCurrentPrice(doughLP);
        let priceInitialRaw = priceInitial * 1e-9 * ETH_PRICE;
        let mcInitial = priceInitialRaw * parseInt((await dough.totalSupply()) / 10n**9n);
        let target = priceInitial * 5;
        console.log(`Price initial: ${priceInitialRaw}`);
        console.log(`Market cap initial: ${mcInitial}`);

        let rewardsDistributed = 0n;
        
        let rewardsAdditions = {
            1: 0n,
            2: 0n,
            3: 0n,
            4: 0n
        }
        let dailyVols = [];
        //simulate 1 year with daily volume of 8-9 ETH (30k USD)
        for (let j=0; j<365; j++) {
            console.log(`Day ${j+1}`)
            await mine(BLOCKS_PER_DAY);
            // await oven.connect(accounts[0]).forceUpdateRewards(false);
            // await oven.connect(accounts[0]).forceUpdateRewards(true);
            //30k daily volume
            // if (j > 100 && j < 220) {
            //     await buyOnUniswap(uniswap, dough.target, accounts[j % 14 + 5], dailyVol[i]);
            //     await sellOnUniswap(uniswap, dough, accounts[j % 14 + 5], (await dough.balanceOf(accounts[j % 14 + 5].address)));
            //     continue;
            // }
            // let todaysVol = 0;
            // let buyAmt = (parseInt(await ethers.provider.getBalance(accounts[j % 18].address))/1e18 - 0.1);
            // await buyOnUniswap(uniswap, dough.target, accounts[j % 18], buyAmt);
            // let balanceBefore = await ethers.provider.getBalance(accounts[j % 18].address);
            // await sellOnUniswap(uniswap, dough, accounts[j % 18], (await dough.balanceOf(accounts[j % 18].address)));
            // let balanceAfter = await ethers.provider.getBalance(accounts[j % 18].address);
            // let sellAmt = parseInt(balanceAfter - balanceBefore)/1e18;
            // todaysVol += buyAmt + sellAmt;

            // buyAmt = (parseInt(await ethers.provider.getBalance(accounts[j % 18+1].address))/1e18 - 0.1);
            // await buyOnUniswap(uniswap, dough.target, accounts[j % 18+1], (parseInt(await ethers.provider.getBalance(accounts[j % 18+1].address))/1e18 - 0.1));
            // balanceBefore = await ethers.provider.getBalance(accounts[j % 18+1].address);
            // await sellOnUniswap(uniswap, dough, accounts[j % 18+1], (await dough.balanceOf(accounts[j % 18+1].address)));
            // balanceAfter = await ethers.provider.getBalance(accounts[j % 18+1].address);
            // sellAmt = parseInt(balanceAfter - balanceBefore)/1e18;
            // todaysVol += buyAmt + sellAmt;

            // buyAmt = (parseInt(await ethers.provider.getBalance(accounts[j % 18+2].address))/1e18 - 0.1);
            // await buyOnUniswap(uniswap, dough.target, accounts[j % 18+2], (parseInt(await ethers.provider.getBalance(accounts[j % 18+2].address))/1e18 - 0.1));
            // balanceBefore = await ethers.provider.getBalance(accounts[j % 18+2].address);
            // await sellOnUniswap(uniswap, dough, accounts[j % 18+2], (await dough.balanceOf(accounts[j % 18+2].address)));
            // balanceAfter = await ethers.provider.getBalance(accounts[j % 18+2].address);
            // sellAmt = parseInt(balanceAfter - balanceBefore)/1e18;
            // todaysVol += buyAmt + sellAmt;

            // dailyVols.push(todaysVol);

            // continue;
            

            // let priceBefore = await getCurrentPrice(doughLP);
            // let priceBeforeRaw = priceBefore * 1e-9 * ETH_PRICE;
            // console.log(`Price before: ${priceBeforeRaw}`);
            await buyOnUniswap(uniswap, dough.target, accounts[j % 14 + 5], dailyVol[i]);
            let ethBalanceBefore = await ethers.provider.getBalance(accounts[j % 14 + 5].address);
            await sellOnUniswap(uniswap, dough, accounts[j % 14 + 5], (await dough.balanceOf(accounts[j % 14 + 5].address)));
            let ethBalanceAfter = await ethers.provider.getBalance(accounts[j % 14 + 5].address);

            if (j % 4 == 0) {
                try {
                    await oven.connect(accounts[1]).collectBread(1, false);
                    let rewardsClaimed1 = await dough.balanceOf(accounts[1].address);
                    console.log(`Rewards claimed 1: ${rewardsClaimed1}`);
                    rewardsAdditions[1] += rewardsClaimed1;
                    if (rewardsClaimed1 > 0n) {
                        ethBalanceBefore += await ethers.provider.getBalance(accounts[1].address);
                        await sellOnUniswap(uniswap, dough, accounts[1], (rewardsClaimed1));
                        ethBalanceAfter += await ethers.provider.getBalance(accounts[1].address);
                    }
                } catch (e) {
                    console.log(e);
                }

                try {
                    await oven.connect(accounts[2]).collectBread(2, false);
                    let rewardsClaimed2 = await dough.balanceOf(accounts[2].address);
                    console.log(`Rewards claimed 2: ${rewardsClaimed2}`);
                    rewardsAdditions[2] += rewardsClaimed2;
                    if (rewardsClaimed2 > 0n) {
                        ethBalanceBefore += await ethers.provider.getBalance(accounts[2].address);
                        await sellOnUniswap(uniswap, dough, accounts[2], (rewardsClaimed2));
                        ethBalanceAfter += await ethers.provider.getBalance(accounts[2].address);
                    }
                } catch (e) {
                    console.log(e);
                }

                try {
                    await oven.connect(accounts[3]).collectBread(1, true);
                    let rewardsClaimed3 = await dough.balanceOf(accounts[3].address);
                    console.log(`Rewards claimed 3: ${rewardsClaimed3}`);
                    rewardsAdditions[3] += rewardsClaimed3;
                    if (rewardsClaimed3 > 0n) {
                        ethBalanceBefore += await ethers.provider.getBalance(accounts[3].address);
                        await sellOnUniswap(uniswap, dough, accounts[3], (rewardsClaimed3));
                        ethBalanceAfter += await ethers.provider.getBalance(accounts[3].address);
                    }
                } catch (e) {
                    console.log(e);
                }

                try {
                    await oven.connect(accounts[4]).collectBread(2, true);
                    let rewardsClaimed4 = await dough.balanceOf(accounts[4].address);
                    console.log(`Rewards claimed 4: ${rewardsClaimed4}`);
                    rewardsAdditions[4] += rewardsClaimed4;
                    if (rewardsClaimed4 > 0n) {
                        ethBalanceBefore += await ethers.provider.getBalance(accounts[4].address);
                        await sellOnUniswap(uniswap, dough, accounts[4], (rewardsClaimed4));
                        ethBalanceAfter += await ethers.provider.getBalance(accounts[4].address);
                    }
                } catch (e) {
                    console.log(e);
                }
            }


            let todaysVol = parseInt(ethBalanceAfter - ethBalanceBefore) / 1e18 + dailyVol[i];
            dailyVols.push(todaysVol);
            // let priceAfter = await getCurrentPrice(doughLP);
            // let priceAfterRaw = priceAfter * 1e-9 * ETH_PRICE;
            // console.log(`Price after: ${priceAfterRaw}`);
        }

        let avgDailyVol = dailyVols.reduce((a, b) => a + b, 0) / dailyVols.length;
        let avgDailyVolUSD = avgDailyVol * ETH_PRICE;

        let priceAfterVolume = await getCurrentPrice(doughLP);
        let priceAfterVolumeRaw = priceAfterVolume * 1e-9 * ETH_PRICE;
        console.log(`Price after volume: ${priceAfterVolumeRaw}`);

        // inflate price to target
        await inflatePrice(uniswap, doughLP, dough.target, accounts[0], target, 5);

        //withdraw all
        // await oven.connect(accounts[2]).jeet(2, false);
        // await mine(10);
        // await oven.connect(accounts[2]).jeet(2, false);
        await oven.connect(accounts[1]).removeWhenGoldenBrown(1, false);
        await oven.connect(accounts[2]).removeWhenGoldenBrown(2, false);
        // await oven.connect(accounts[4]).jeet(2, true);
        await oven.connect(accounts[3]).removeWhenGoldenBrown(1, true);
        await oven.connect(accounts[4]).removeWhenGoldenBrown(2, true);

        //balances
        const balanceAfter1 = await dough.balanceOf(accounts[1]);
        const balanceAfter2 = await dough.balanceOf(accounts[2]);
        const balanceAfter3 = await dough.balanceOf(accounts[3]);
        const balanceAfter4 = await dough.balanceOf(accounts[4]);

        //price and mc final
        let priceFinal = await getCurrentPrice(doughLP);
        let priceFinalRaw = priceFinal * 1e-9 * ETH_PRICE;
        let mcFinal = priceFinalRaw * parseInt((await dough.totalSupply()) / 10n**9n);
        console.log(`Price final: ${priceFinalRaw}`);
        console.log(`Market cap final: ${mcFinal}`);

        //rewards dispensed $ value
        const rewardsDispensedDough = (parseInt(((balanceAfter1 + balanceAfter2) - (balanceBefore1 + balanceBefore2)) + (balanceAfter3 + balanceAfter4)) / 10**9);
        console.log(`Rewards dispensed in DOUGH: ${rewardsDispensedDough}`);
        const rewardsDispensed = rewardsDispensedDough * priceFinalRaw;
        console.log(`Rewards dispensed: ${rewardsDispensed}`);
        const onePct = rewardsDispensed * 0.01;
        const onePctShareLP = onePct * (parseInt(await oven.burnRewardsLPRatio()) / 100);
        const onePctShare = onePct - onePctShareLP;

        //apr
        const apr = (parseFloat(balanceAfter1 + balanceAfter2 + rewardsAdditions[1] + rewardsAdditions[2]) / parseFloat(balanceBefore1 + balanceAfter2) - 1) * 100;
        const aprLP = (parseFloat(balanceAfter3 + balanceAfter4 + rewardsAdditions[3] + rewardsAdditions[4])) / (parseFloat(lpResult1.doughBalance + lpResult2.doughBalance)) * 100;
        // const aprLP = 0;
        console.log(`APR: ${apr}%`);
        console.log(`APR LP: ${aprLP}%`);

        let totalSupplyFinal = await dough.totalSupply();
        console.log(`\nTOTAL SUPPLY FINAL: ${totalSupplyFinal}`);
        let changeInSupply = (parseFloat(totalSupplyFinal) - parseFloat(totalSupplyInitial)) / parseFloat(totalSupplyInitial) * 100;
        console.log(`% CHANGE IN SUPPLY: ${changeInSupply}%`);

        let rewardPerBlockFinal = await oven.rewardPerBlock();
        let rewardPerBlockFinalLP = await oven.rewardPerBlockLP();
        console.log(`REWARD PER BLOCK FINAL: ${rewardPerBlockFinal}`);
        console.log(`REWARD PER BLOCK LP FINAL: ${rewardPerBlockFinalLP}`);

        results.push({
            rpb: rpb[i] / 10n**9n,
            rpbLP: rpbLP[i] / 10n**9n,
            decay: parseInt(decay[i]) / 1e18,
            burnTax: `${burnTax[i][0]/10} / ${burnTax[i][1]/10}`,
            dailyVol: avgDailyVolUSD.toFixed(2).toString() + ' USD',
            pctStaked: (pctSupplyStaked * 100).toFixed(2).toString() + '%',
            pctStakedLP: (pctSupplyStakedLP * 100).toFixed(2).toString() + '%',
            apr: apr.toFixed(2).toString() + '%',
            aprLP: aprLP.toFixed(2).toString() + '%',
            changeInSupply: changeInSupply.toFixed(2).toString() + '%',
            rewardsDispensed: rewardsDispensed.toFixed(2).toString() + ' USD',
            rewardsDispensedDough: rewardsDispensedDough, 
            mcInitial: mcInitial.toFixed(2).toString() + ' USD',
            mcFinal: mcFinal.toFixed(2).toString() + ' USD',
            onePctShareLP: onePctShareLP,
            onePctShare: onePctShare
        });
    }

    return results;
}


async function main() {

    //check simulation_ csv files to find correct number
    let index = 0;
    while (true) {
        //check if file exists
        try {
            const fs = require('fs');
            fs.accessSync(`simulation_${index}.csv`);
            index++;
        } catch (err) {
            break;
        }
    }
    let csvWriter = createCsvWriter({
        path: `simulation_results/simulation_${index}.csv`,
        header: [
            {id: 'rpb', title: 'Reward Per Block'},
            {id: 'rpbLP', title: 'Reward Per Block LP'},
            {id: 'decay', title: 'Decay Rate'},
            {id: 'burnTax', title: 'Burn Tax'},
            {id: 'dailyVol', title: 'Avg Daily Volume'},
            {id: 'pctStaked', title: '% $DOUGH Supply Staked in $DOUGH pool'},
            {id: 'pctStakedLP', title: '% $DOUGH Supply Staked in LP pool'},
            {id: 'apr', title: 'Avg APR for $DOUGH stakers'},
            {id: 'aprLP', title: 'Avg APR LP stakers'},
            {id: 'changeInSupply', title: '% Change in Supply After 1 yr'},
            {id: 'mcInitial', title: 'Market Cap Initial'},
            {id: 'mcFinal', title: 'Market Cap Final'},
            {id: 'rewardsDispensed', title: 'Rewards Dispensed ($)'},
            {id: 'onePctShare', title: '1% Share of Rewards (DOUGH Pool) Payout'},
            {id: 'onePctShareLP', title: '1% Share of Rewards (LP Pool) Payout'},
        ]
    });

    // DEFAULT PARAMS //
    let rpb = [200000000000n, 200000000000n, 200000000000n, 200000000000n, 200000000000n];
    let rpbLP = [400000000000n, 400000000000n, 400000000000n, 400000000000n, 400000000000n];
    let burnTax = [[60, 90], [60, 90], [60, 90], [60, 90], [60, 90]];
    let decay = [DEFAULT_DECAY, DEFAULT_DECAY, DEFAULT_DECAY, DEFAULT_DECAY, DEFAULT_DECAY];
    let dailyVol = [5.72, 5.72, 5.72, 5.72, 5.72];
    let buyAmounts = [0.6, 0.6, 0.6, 0.6, 0.6];
    let buyAmountsLP = [1, 1, 1, 1, 1];

    // rpb = [100000000000n , 200000000000n, 300000000000n, 400000000000n, 500000000000n];
    // rpbLP = [200000000000n, 400000000000n, 600000000000n, 800000000000n, 1000000000000n];
    // rpb = [800000000000n, 800000000000n, 800000000000n, 800000000000n, 800000000000n];
    // rpbLP = [1200000000000n, 1200000000000n, 1200000000000n, 1200000000000n, 1200000000000n];

    // let dec = 999998465n * 10n**9n;
    // decay = [999999995n * 10n**9n, 999999965n * 10n**9n, DEFAULT_DECAY, 999998465n * 10n**9n, 999997465n * 10n**9n];

    // decay = [999990465n * 10n**9n, 999990465n * 10n**9n, 999990465n * 10n**9n, 999990465n * 10n**9n, 999990465n * 10n**9n]
    // decay = [0n, 0n, 0n, 0n, 0n]
    // decay = [999997465n * 10n**9n, 999997465n * 10n**9n, 999997465n * 10n**9n, 999997465n * 10n**9n, 999997465n * 10n**9n];

    // buyAmounts = [0.2, 0.35, 0.6, 0.8, 1.0];
    // buyAmountsLP = [0.25, 0.5, 1, 1.33, 1.67];
    buyAmounts = [.75, .75, .75, .75, .75];
    buyAmountsLP = [.35, .35, .35, .35, .35];
    // buyAmountsLP = [0, 0, 0, 0, 0];
    // buyAmounts = [.35, .35, .35, .35, .35];
    // buyAmountsLP = [.5, .5, .5, .5, .5];

    // dailyVol = [25, 25, 25, 25, 25];
    // dailyVol = [11.44, 11.44, 11.44, 11.44, 11.44];
    // dailyVol = [2.86, 2.86, 2.86, 2.86, 2.86];
    dailyVol = [2.86, 8.72, 11.44, 22.88, 45.76];
    
    // burnTax = [[0,0], [15, 23], [30, 50], [45, 68], [60, 90]];
    burnTax = [[40,40], [40,40], [40,40], [40,40], [40,40]];
    // burnTax = [[5,5], [10,10], [15,15], [20,20], [30,30]];
    
    rpb = [0n, 0n, 0n, 0n, 0n];
    rpbLP = [0n, 0n, 0n, 0n, 0n];

    const res = await simulate(rpb, rpbLP, burnTax, decay, dailyVol, buyAmounts, buyAmountsLP);
    console.log(res);
    
    // await csvWriter.writeRecords(res);
}


// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

