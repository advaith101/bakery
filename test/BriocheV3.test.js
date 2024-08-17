const {
	time,
	loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

const util = require('util');
const exec = util.promisify(require('child_process').exec);

//uniswap stuff
const uniswapContract = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const uniswapFactoryContract = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const uniswapAbi = require('../abis/uniswapV2router.json');
const uniswapFactoryAbi = require('../abis/uniswapV2factory.json');
const uniswapPairAbi = require('../abis/uniswapV2pair.json');
const { increase } = require("@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time");
const exp = require("constants");

const BLOCKS_PER_DAY = 7150;
const REWARD_PER_BLOCK = 400000000000n;
const REWARD_PER_BLOCK_LP = 1000000000000n;
const DEFAULT_DECAY = 999999465n * 10n**9n;

describe("L3T H1M C00K Master Test", function () {
	// We define a fixture to reuse the same setup in every test.
	// We use loadFixture to run this setup once, snapshot that state,
	// and reset Hardhat Network to that snapshot in every test.
	async function deployContractsFixture() {
		const accounts = await ethers.getSigners();
		const uniswap = await ethers.getContractAt(uniswapAbi, uniswapContract);
		const uniswapFactory = await ethers.getContractAt(uniswapFactoryAbi, uniswapFactoryContract);

		//Deploy Dough
		const dough = await ethers.deployContract("Dough");
		await dough.waitForDeployment();
		console.log(`Dough deployed to ${dough.target}`);
		console.log(`Dough balance: ${await dough.balanceOf(accounts[0].address)}`);

		//Create UniswapV2 pair with Dough
		// await uniswapFactory.connect(accounts[0]).createPair(dough.target, uniswap.WETH());
		await dough.connect(accounts[0]).approve(uniswap.target, await dough.balanceOf(accounts[0].address));
		await uniswap.connect(accounts[0]).addLiquidityETH(
			dough.target,
			await dough.balanceOf(accounts[0].address),
			0,
			ethers.parseEther("1"),
			accounts[0].address,
			(parseInt(Math.floor(new Date().getTime() / 1000))) + 60 * 5, //deadline
			{value: ethers.parseEther("1")}
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
		// const oven = await ethers.deployContract("LeOvenV4", [
		// 	dough.target,
		// 	doughLP.target,
		// 	REWARD_PER_BLOCK, //400 * 1e9
		// 	REWARD_PER_BLOCK_LP, //800 * 1e9
		// 	DEFAULT_DECAY,
		// ]);
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

		//Deploy Timelock controller
		const timelock = await ethers.deployContract("TimelockController", [
			10, //1 minute
			[accounts[0].address],
			[accounts[0].address],
			// '0x0000000000000000000000000000000000000000', //zero address
			accounts[0].address,
		]);
		await timelock.waitForDeployment();
		console.log(`Timelock controller deployed to ${timelock.target}`);

		//grant default admin role to timelock controller and renounce role
		await dough.connect(accounts[0]).grantRole(ethers.ZeroHash, timelock.target);
		await dough.connect(accounts[0]).renounceRole(ethers.ZeroHash, accounts[0].address);

		//check roles
		console.log(`OVEN_ROLE: ${await dough.getRoleMemberCount(ethers.keccak256(ethers.toUtf8Bytes("OVEN_ROLE")))}`);
		console.log(`DEFAULT_ADMIN_ROLE: ${await dough.getRoleMemberCount(ethers.ZeroHash)}`);
		console.log(`Account 0 has DEFAULT_ADMIN_ROLE: ${await dough.hasRole(ethers.ZeroHash, accounts[0].address)}`);
		console.log(`Timelock controller has DEFAULT_ADMIN_ROLE: ${await dough.hasRole(ethers.ZeroHash, timelock.target)}`);

		return { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts };
	}

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

	//helper function to deposit to Oven
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

	//Helper function that takes a 112x112 fixed point number and returns a float
	function fixedPointToFloat(fixedPoint) {
		let binary = fixedPoint.toString(2);
		let decimalBits = binary.slice(-112);
		let principalBits = binary.slice(0, -112);
		let decimal = parseInt(decimalBits, 2);
		let principal = parseInt(principalBits, 2);
		return principal + parseFloat('.' + decimal.toString().replace('.', '').split('e')[0]);
	}

	//helper function to check if a number is within a margin of another number
	function compareWithMargin(actual, expected, margin) {
		return actual >= expected * (1 - margin) && actual <= expected * (1 + margin);
	}

	//helper function to check if a number is within a margin of another number
	function compareWithMarginBigInt(actual, expected, margin, base) {
		return actual >= expected - expected * margin / base && actual <= expected + expected * margin / base;
	}

	// team supply test
	describe("Team supply test", function () {
		it("Should check team supply", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			//buy 2 eth on uniswap
			await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
			console.log(`balance: ${await dough.balanceOf(accounts[1].address)}`);
			console.log(`percentage of total supply: ${parseInt(await dough.balanceOf(accounts[1].address)) / parseInt(await dough.totalSupply())}`);
		});
	});

	return;

	// //Timelock controller test
	// describe("Timelock controller test", function () {
	// 	it("Should test updateDelay()", async function () {
	// 		const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

	// 		//check minDelay
	// 		let minDelay = await timelock.getMinDelay();
	// 		console.log(`\nMin delay before: ${minDelay}`);

	// 		//update taxes on dough
	// 		let predecessor = "0x0000000000000000000000000000000000000000000000000000000000000000";
	// 		let data = new ethers.Interface(['function setTaxInfo(uint32 _burnTaxBuy, uint32 _burnTaxSell, uint32 _rewardTaxBuy, uint32 _rewardTaxSell, uint32 _developmentTaxBuy, uint32 _developmentTaxSell)']).encodeFunctionData('setTaxInfo', [40, 40, 0, 0, 10, 10]);
	// 		let salt = ethers.hexlify(ethers.randomBytes(32));
	// 		let tx = await timelock.connect(accounts[0]).schedule(
	// 			timelock.target,
	// 			0,
	// 			data,
	// 			predecessor,
	// 			salt,
	// 			10,
	// 		);
	// 		console.log(`Transaction scheduled: ${tx.hash}`);

	// 		//get hash operation
	// 		let operationHash = await timelock.hashOperation(timelock.target, 0, data, predecessor, salt);
	// 		console.log(`Operation hash: ${operationHash}`);
	// 		let status = await timelock.isOperationPending(operationHash);
	// 		console.log(`Operation pending: ${status}`);

	// 		//schedule updateDelay
	// 		predecessor = "0x0000000000000000000000000000000000000000000000000000000000000000";
	// 		data = new ethers.Interface(['function updateDelay(uint256 newDelay)']).encodeFunctionData('updateDelay', [1]);
	// 		salt = ethers.hexlify(ethers.randomBytes(32));
	// 		tx = await timelock.connect(accounts[0]).schedule(
	// 			timelock.target,
	// 			0,
	// 			data,
	// 			predecessor,
	// 			salt,
	// 			10,
	// 		);
	// 		console.log(`Transaction scheduled: ${tx.hash}`);

	// 		//get hash operation
	// 		operationHash = await timelock.hashOperation(timelock.target, 0, data, predecessor, salt);
	// 		console.log(`Operation hash: ${operationHash}`);
	// 		status = await timelock.isOperationPending(operationHash);
	// 		console.log(`Operation pending: ${status}`);

	// 		//sleep 10s
	// 		await time.increase(10);

	// 		//execute updateDelay
	// 		tx = await timelock.connect(accounts[0]).execute(timelock.target, 0, data, predecessor, salt);
	// 		console.log(`Transaction executed: ${tx.hash}`);

	// 		//check minDelay
	// 		minDelay = await timelock.getMinDelay();
	// 		console.log(`Min delay after: ${minDelay}`);
	// 	});
	// });

	// return;

	// //Tests mev profitablity
	// describe("MEV profitability test", function () {
	// 	it("Checks slippage and if price is higher than before after instant buy/sell", async function () {
	// 		const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);
	// 		const currPrice = await getCurrentPrice(doughLP);
	// 		console.log(`Current price start: ${currPrice}`);
	// 		const currETHBalance = await ethers.provider.getBalance(accounts[1].address);
	// 		console.log(`Current ETH balance start: ${parseInt(currETHBalance)/1e18}`);
	// 		await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
	// 		await sellOnUniswap(uniswap, dough, accounts[1], await dough.balanceOf(accounts[1].address));
	// 		const newPrice = await getCurrentPrice(doughLP);
	// 		console.log(`Current price end: ${newPrice}`);
	// 		expect(newPrice).to.be.gt(currPrice);
	// 		const newETHBalance = await ethers.provider.getBalance(accounts[1].address);
	// 		console.log(`Current ETH balance end: ${parseInt(newETHBalance)/1e18}`);
	// 		console.log(`Total slippage after buy/sell: ${parseInt(currETHBalance - newETHBalance) / 1e18}`);
	// 	});
	// });

	// return;

  
	//Tests gas fees on LeOven
	describe("Gas fees test", function () {
		it("Should deposit, claim, withdraw, and check gas fees", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			for (let i = 0; i < 8; i++) {
				await buyOnUniswap(uniswap, dough.target, accounts[i+1], 1);
				await depositToOven(oven, dough, accounts[i+1], await dough.balanceOf(accounts[i+1].address), 5);
                await mine(7150);
                let tx = await oven.connect(accounts[i+1]).collectBread(i+1, false);
				let receipt = await tx.wait();
				console.log(`Gas used for claim ${i}: ${receipt.gasUsed.toString()}`);

				await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[i+9], 1);
                await depositLPToOven(oven, doughLP, accounts[i+9], await doughLP.balanceOf(accounts[i+9].address), 5);
                await mine(7150);
                tx = await oven.connect(accounts[i+9]).collectBread(i+1, true);
				receipt = await tx.wait();
				console.log(`Gas used for claim ${i+8}: ${receipt.gasUsed.toString()}`);
			}

			await mine(7150*365*2);

			const currPrice = await getCurrentPrice(doughLP);
			await inflatePrice(uniswap, doughLP, dough.target, accounts[0], currPrice * 1.252, 5);

			for (let i = 0; i < 8; i++) {
                let tx = await oven.connect(accounts[i+1]).removeWhenGoldenBrown(i+1, false);
				let receipt = await tx.wait();
				console.log(`Gas used for withdrawal ${i}: ${receipt.gasUsed.toString()}`);
				tx = await oven.connect(accounts[i+9]).removeWhenGoldenBrown(i+1, true);
				receipt = await tx.wait();
				console.log(`Gas used for withdrawal ${i+8}: ${receipt.gasUsed.toString()}`);
			}
		});
	});

	//Minimal rewards test - deposits, mines one block, withdraws
	describe("Minimal rewards test", function () {
		it("Should deposit, mine one block, and withdraw", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			//buy and deposit
			await buyOnUniswap(uniswap, dough.target, accounts[0], .000001);
			let balance = await dough.balanceOf(accounts[0].address);
			console.log(`Balance before: ${balance}`);
			let receipt = await depositToOven(oven, dough, accounts[0], balance, 5);
			let blockNumber = receipt.blockNumber;
			console.log(`Block number of deposit: ${blockNumber}`);

			//inflate price
			const currPrice = await getCurrentPrice(doughLP);
			await buyOnUniswap(uniswap, dough.target, accounts[2], 0.0001);
			// await inflatePrice(uniswap, doughLP, dough.target, accounts[2], currPrice * 1.25, .01);

			//mine 1 block and withdraw
			await mine(1);
			let tx = await oven.connect(accounts[0]).collectBread(1, false);
			receipt = await tx.wait();
			blockNumber = receipt.blockNumber;
			console.log(`Block number of withdrawal: ${blockNumber}`);

			let balanceAfter = await dough.balanceOf(accounts[0].address);
			console.log(`Balance after: ${balanceAfter}`);

			expect(balanceAfter).to.be.gt(0n);
		});
	});

	//immediate reward test
	describe("Immediate rewards test", function () {
		it("Should check for the bonus 8%", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			//buy and deposit
			await buyOnUniswap(uniswap, dough.target, accounts[1], 0.0001);
			let balance = await dough.balanceOf(accounts[1].address);
			console.log(`Balance before: ${balance}`);
			await depositToOven(oven, dough, accounts[1], balance, 5);

			let lpResult = await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[2], 0.0001);
			console.log(`LP balance before: ${lpResult.lpBalance}`);
			console.log(`Dough balance before: ${lpResult.doughBalance}`);
			await depositLPToOven(oven, doughLP, accounts[2], lpResult.lpBalance, 5);

			//force update rewards
			await oven.connect(accounts[0]).forceUpdateRewards(false);
			await oven.connect(accounts[0]).forceUpdateRewards(true);

			//buy and deposit again
			await buyOnUniswap(uniswap, dough.target, accounts[3], 0.1);
			await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[4], 0.1);
			await depositToOven(oven, dough, accounts[3], await dough.balanceOf(accounts[3].address), 80);
			await depositLPToOven(oven, doughLP, accounts[4], await doughLP.balanceOf(accounts[4].address), 80);

			//inflate price
			const currPrice = await getCurrentPrice(doughLP);
			const targetPrice = currPrice * 20;
			await inflatePrice(uniswap, doughLP, dough.target, accounts[3], targetPrice, 1);

			//withdraw all
			await oven.connect(accounts[1]).removeWhenGoldenBrown(1, false);
			await oven.connect(accounts[2]).removeWhenGoldenBrown(1, true);
			await oven.connect(accounts[3]).removeWhenGoldenBrown(2, false);
			await oven.connect(accounts[4]).removeWhenGoldenBrown(2, true);

			//check balances
			let balanceAfter = await dough.balanceOf(accounts[1].address);
			console.log(`Balance after: ${balanceAfter}`);
			let balanceAfter2 = await dough.balanceOf(accounts[2].address);
			console.log(`Balance after 2: ${balanceAfter2}`);

			//check total supply
			console.log(`Total supply: ${await dough.totalSupply()}`);
			expect(compareWithMarginBigInt(parseInt(await dough.totalSupply()), 1000000000n * 10n**9n, 1n, 100000n)).to.be.true;
			expect(await dough.totalSupply()).to.be.eq(await oven.netCirculatingDough());

			//check rewards
			let rewards1 = balanceAfter - balance;
			let rewards2 = balanceAfter2;
			console.log(`Rewards 1: ${rewards1}`);
			console.log(`Rewards 2: ${rewards2}`);
			console.log("Total Rewards as % of total supply: " + parseInt(rewards1 + rewards2) / parseInt(1000000000n * 10n**9n));
		});
	});

	// return;


	//Deposit test - deposits Dough to LeOven, checks depositInfo.
	describe("Deposit test", function () {
		it("Should purchase Dough on Uniswap and deposit into LeOven", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);
			
			const targets = [400, 27, 9];
			for (let i = 0; i < 3; i++) {
				//Purchase Dough on Uniswap
				await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[i+4], 1);
				await buyOnUniswap(uniswap, dough.target, accounts[i+1], 1);
				let balance = await dough.balanceOf(accounts[i+1].address);
				let lpBalance = await doughLP.balanceOf(accounts[i+4].address);
				console.log(`Dough balance ${i+1}: ${balance}`);

				//Checks target price
				await expect(depositToOven(oven, dough, accounts[i+1], balance, 401)).to.be.revertedWith("invalid target price");
				await expect(depositToOven(oven, dough, accounts[i+1], balance, 4)).to.be.revertedWith("invalid target price");

				//Deposit to LeOven
				await depositToOven(oven, dough, accounts[i+1], balance, targets[i]);
				await depositLPToOven(oven, doughLP, accounts[i+4], await doughLP.balanceOf(accounts[i+4].address), targets[i]);
				expect(await dough.balanceOf(accounts[i+1].address)).to.equal(0);
				expect(await doughLP.balanceOf(accounts[i+4].address)).to.equal(0);

				//Deposit info
				const depositInfo = await oven.getDepositInfo(i+1, false);
				const depositInfoLP = await oven.getDepositInfo(i+1, true);
				console.log(`Deposit info ${i+1}: ${depositInfo}`);
				console.log(`Deposit info ${i+2}: ${depositInfoLP}`);

				//Check deposit amounts
				expect(depositInfo[0]).to.be.eq(balance);
				expect(depositInfoLP[0]).to.be.eq(lpBalance);

				//Check deposit accounts
				expect(depositInfo[5]).to.be.eq(accounts[i+1].address);
				expect(depositInfoLP[5]).to.be.eq(accounts[i+4].address);

				//Check shares
				expect(compareWithMargin(parseInt(depositInfo[2]), parseInt(balance) * (targets[i]/4), .00001)).to.be.true;
				expect(compareWithMargin(parseInt(depositInfoLP[2]), parseInt(lpBalance) * (targets[i]/4), .00001)).to.be.true;

				//Check targets
				let targetPrice = fixedPointToFloat(depositInfoLP[4]);
				let currPrice = fixedPointToFloat(await oven.getCurrPrice());
				console.log(`Current price in contract: ${currPrice}`);
				console.log(`Target price in contract: ${targetPrice}`);
				expect(compareWithMargin(targetPrice/currPrice, targets[i]/4, .00001)).to.be.true;
			}
		});
	});

	//Tests burn tax rewards mechanism
	describe("Burn tax rewards test", function () {
		it("Supply should stay constant", async function () {
			// const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

            let initialTotalSupply = await dough.totalSupply();
            console.log(`Total supply initially: ${initialTotalSupply}`);
	
			//buy on uniswap
			await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
			await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[2], 1);
			let principal = await dough.balanceOf(accounts[1].address);
			let principalLP = await doughLP.balanceOf(accounts[2].address);

			//deposit to oven
			await depositToOven(oven, dough, accounts[1], principal, 5);
			await depositLPToOven(oven, doughLP, accounts[2], principalLP, 5);
            console.log(`Total supply after deposits: ${await dough.totalSupply()}`);

			//simulate buys
            await buyOnUniswap(uniswap, dough.target, accounts[4], 98);
			await buyOnUniswap(uniswap, dough.target, accounts[5], 98);
			await buyOnUniswap(uniswap, dough.target, accounts[6], 98);
			await buyOnUniswap(uniswap, dough.target, accounts[7], 98);
			await buyOnUniswap(uniswap, dough.target, accounts[8], 98);

            console.log(`Total supply after buys: ${await dough.totalSupply()}`);

            //withdraw
            await oven.connect(accounts[1]).removeWhenGoldenBrown(1, false);
			await oven.connect(accounts[2]).removeWhenGoldenBrown(1, true);

            let finalTotalSupply = await dough.totalSupply();
            console.log(`Total supply after withdrawals: ${finalTotalSupply}`);

            expect(compareWithMargin(parseInt(finalTotalSupply), parseInt(1000000000n * 10n**9n), 0.0001)).to.be.true;
		});
	});

	// return;

	// // Tests claiming rewards on LeOven
	// describe("Claim test", function () {
	// 	it("Should deposit, and keep claiming until claimed rewards = deposit amount, then claiming won't be possible. Then withdraws after price is > target", async function () {
	// 		const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

	// 		//buy on uniswap
	// 		await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
	// 		await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[2], 1);

	// 		const principal = await dough.balanceOf(accounts[1].address);
	// 		const principalLP = await doughLP.balanceOf(accounts[2].address);
	// 		console.log(`Dough balance of account 1: ${principal}`);
	// 		console.log(`Dough/WETH LP balance of account 2: ${principalLP}`);

	// 		//deposit to oven
	// 		await depositToOven(oven, dough, accounts[1], principal, 5);
	// 		await depositLPToOven(oven, doughLP, accounts[2], principalLP, 5);

	// 		//mine few blocks and claim
	// 		await mine(40);
	// 		let rewardsAccumulated = await oven.getOvenRewardsAccumulated(false);
	// 		let rewardsAccumulatedLP = await oven.getOvenRewardsAccumulated(true);
	// 		console.log(`Rewards accumulated from contract after 40 blocks: ${rewardsAccumulated}`);
	// 		console.log(`Rewards accumulated from contract after 40 blocks for LP: ${rewardsAccumulatedLP}`);
	// 		await oven.connect(accounts[1]).collectBread(1, false);
	// 		await oven.connect(accounts[2]).collectBread(1, true);
	// 		let balance1 = await dough.balanceOf(accounts[1].address);
	// 		let balance2 = await dough.balanceOf(accounts[2].address);
	// 		console.log(`Balance of account 1 after claiming 1: ${balance1}`);
	// 		console.log(`Balance of account 2 after claiming 1: ${balance2}`);
	// 		console.log(`Deposit info 1: ${await oven.getDepositInfo(1, false)}`);
	// 		console.log(`Deposit info 1 LP: ${await oven.getDepositInfo(1, true)}`);
	// 		expect(compareWithMargin(parseFloat(await dough.balanceOf(accounts[1].address)), parseFloat(rewardsAccumulated), .1)).to.be.true;
	// 		expect(compareWithMargin(parseFloat(await dough.balanceOf(accounts[2].address)), parseFloat(rewardsAccumulatedLP), .1)).to.be.true;

	// 		//mine 3 months
	// 		await mine(parseInt(1284800));
	// 		rewardsAccumulated += await oven.getOvenRewardsAccumulated(false);
	// 		rewardsAccumulatedLP += await oven.getOvenRewardsAccumulated(true);

	// 		//claim rewards
	// 		await oven.connect(accounts[1]).collectBread(1, false);
	// 		await oven.connect(accounts[2]).collectBread(1, true);
	// 		console.log(`Balance of account 1 after claiming 2: ${await dough.balanceOf(accounts[1].address)}`);
	// 		console.log(`Balance of account 2 after claiming 2: ${await dough.balanceOf(accounts[2].address)}`);
	// 		expect(await dough.balanceOf(accounts[1].address)).to.be.eq(principal); //claiming should only allow claim up to principal deposit
	// 		await oven.connect(accounts[1]).collectBread(1, false);
	// 		expect(await dough.balanceOf(accounts[1].address)).to.be.eq(principal);

	// 		//inflate price and withdraw
	// 		let currPrice = await getCurrentPrice(doughLP);
	// 		await inflatePrice(uniswap, doughLP, dough.target, accounts[2], currPrice * 1.25, .3);
	// 		await expect(oven.connect(accounts[1]).collectBread(1, false)).to.be.revertedWith("cannot claim once deposit is unlocked, must withdraw");
	// 		await expect(oven.connect(accounts[2]).collectBread(1, true)).to.be.revertedWith("cannot claim once deposit is unlocked, must withdraw");

	// 		// rewardsAccumulated += await oven.getOvenRewardsAccumulated(false);
	// 		// rewardsAccumulatedLP += await oven.getOvenRewardsAccumulated(true);
	// 		await oven.connect(accounts[1]).removeWhenGoldenBrown(1, false);
	// 		await oven.connect(accounts[2]).removeWhenGoldenBrown(1, true);

	// 		//balance after
	// 		let balanceOfAccount1AfterWithdraw = await dough.balanceOf(accounts[1].address);
	// 		let balanceOfAccount2AfterWithdraw = await dough.balanceOf(accounts[2].address);
	// 		let LPBalanceOfAccount2AfterWithdraw = await doughLP.balanceOf(accounts[2].address);
	// 		console.log(`Dough balance of account 1 after withdraw: ${balanceOfAccount1AfterWithdraw}`);
	// 		console.log(`Dough/WETH LP balance of account 2 after withdraw: ${LPBalanceOfAccount2AfterWithdraw}`);
	// 		expect(LPBalanceOfAccount2AfterWithdraw).to.be.eq(principalLP);

	// 		//expect balance difference to be within 1% of rewards accumulated
	// 		expect(compareWithMargin(parseFloat(balanceOfAccount1AfterWithdraw - principal), parseFloat(rewardsAccumulated), .01)).to.be.true;
	// 		expect(compareWithMargin(parseFloat(balanceOfAccount2AfterWithdraw), parseFloat(rewardsAccumulatedLP), .1)).to.be.true;
	// 	});
	// });

	//Withdraw test - deposits, checks withdrawal conditions.
	describe("Withdraw test", function () {
		it('Should ensure withdrawal conditions are enforced properly', async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			// buy on uniswap and deposit
			await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
			await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[2], 1);
			console.log(`Balance before: ${await dough.balanceOf(accounts[1])}`)
			await depositToOven(oven, dough, accounts[1], await dough.balanceOf(accounts[1]), 40);
			await depositLPToOven(oven, doughLP, accounts[2], await doughLP.balanceOf(accounts[2]), 40);

			//Checks withdrawal before target price
			await expect(oven.connect(accounts[1]).removeWhenGoldenBrown(1, false)).to.be.revertedWith("deposit not unlocked"); //can't be withdrawn until pledgePrice is met

			let currPrice = await getCurrentPrice(doughLP);
			let target1 = currPrice * 9.95;
			let target2 = currPrice * 10;

			//Inflate price till just under target
			await inflatePrice(uniswap, doughLP, dough.target, accounts[3], target1, 0.05);

			//Try to withdraw
			await expect(oven.connect(accounts[1]).removeWhenGoldenBrown(1, false)).to.be.revertedWith("deposit not unlocked"); //can't be withdrawn until pledgePrice is met
			await expect(oven.connect(accounts[2]).removeWhenGoldenBrown(1, true)).to.be.revertedWith("deposit not unlocked"); //can't be withdrawn until pledgePrice is met

			//Inflate till above target
			await inflatePrice(uniswap, doughLP, dough.target, accounts[3], target2, 0.1);

			//Checks withdrawal from different account
			await expect(oven.connect(accounts[3]).removeWhenGoldenBrown(1, false)).to.be.revertedWith("not allowed"); //can't be withdrawn by other accounts
			await expect(oven.connect(accounts[3]).removeWhenGoldenBrown(1, true)).to.be.revertedWith("not allowed");


			//Withdraw
			await oven.connect(accounts[1]).removeWhenGoldenBrown(1, false);
			await oven.connect(accounts[2]).removeWhenGoldenBrown(1, true);
			console.log(`Balance after: ${await dough.balanceOf(accounts[1])}`);
			console.log(`Balance after 2: ${await dough.balanceOf(accounts[2])}`);
		});
	});

	// return;

	//Compound test - deposits, compounds, checks new depositInfo, previous depositInfo.
	describe("Compound test", function () {
		it('Should compound rewards and check new and original deposit info', async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			// buy on uniswap and deposit
			await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
			const balanceBefore = await dough.balanceOf(accounts[1]);
			console.log(`Balance before: ${balanceBefore}`)
			await depositToOven(oven, dough, accounts[1], balanceBefore, 6, false);

			//Mine 1 day
			await mine(BLOCKS_PER_DAY);

			//Compound
			await oven.connect(accounts[1]).stayBaked(1, 6, false);
			expect(await dough.balanceOf(accounts[1].address)).to.be.eq(0n);

			//simulate volume
			await buyOnUniswap(uniswap, dough.target, accounts[2], 5);
			await sellOnUniswap(uniswap, dough, accounts[2], await dough.balanceOf(accounts[2].address));

			//get accRewardsPerShare
			let accRewardsPerShare = await oven.accRewardPerShare();
			console.log(`Accumulated rewards per share: ${accRewardsPerShare}`);

			//Checks
			const depositInfo1 = await oven.getDepositInfo(1, false);
			console.log(`Deposit info 1: ${depositInfo1}`);
			expect(depositInfo1[0]).to.be.eq(balanceBefore);

			// await oven.connect(accounts[1]).stayBaked(1, 6, false);
			// expect(await dough.balanceOf(accounts[1].address)).to.be.gt(0n);
			
			
			let depositInfo2 = await oven.getDepositInfo(2, false);
			console.log(`Deposit info 2: ${depositInfo2}`);
			expect(depositInfo2[2] * accRewardsPerShare / 1000000000000n).to.be.eq(depositInfo2[3]); //shares * accRewardsPerShare should equal rewardsDeductible
			expect(depositInfo2[0]).to.be.eq(depositInfo1[2] * accRewardsPerShare / 1000000000000n); //new deposit amount should equal old deposit shares * accRewardPerShare
			expect(depositInfo2[0]).to.be.eq(depositInfo1[1]); //new deposit amount should equal old deposit claimedRewards
			expect(depositInfo1[1]).to.be.eq(depositInfo1[3]); //reward deductible should equal claimed rewards for depsoit 1
			expect(depositInfo1[4]).to.be.eq(depositInfo2[4]); //target prices should be equal as price hasnt changed.

			//simulate some volume
			await buyOnUniswap(uniswap, dough.target, accounts[3], 5);
			await sellOnUniswap(uniswap, dough, accounts[3], await dough.balanceOf(accounts[3].address));

			//Compound again
			await oven.connect(accounts[1]).stayBaked(2, 6, false);

			//get accRewardsPerShare
			accRewardsPerShare = await oven.accRewardPerShare();
			console.log(`Accumulated rewards per share: ${accRewardsPerShare}`);

			//Checks
			const depositInfo3 = await oven.getDepositInfo(3, false);
			depositInfo2 = await oven.getDepositInfo(2, false);
			console.log(`Deposit info 2 again: ${depositInfo2}`)
			console.log(`Deposit info 3: ${depositInfo3}`);
			expect(depositInfo3[2] * accRewardsPerShare / 1000000000000n).to.be.eq(depositInfo3[3]); //shares * accRewardsPerShare should equal rewardsDeductible
			expect(depositInfo3[0]).to.be.lt(depositInfo2[2] * accRewardsPerShare / 1000000000000n); //new deposit amount should be less than old deposit shares * accRewardPerShare, since many blocks were mined, claimable rewards = deposit2.amount
			expect(depositInfo3[0]).to.be.eq(depositInfo2[1]); //new deposit amount should equal old deposit claimedRewards
			expect(depositInfo2[1]).to.be.lt(depositInfo2[3]); //reward deductible should be greater than claimed rewards for depsoit 1, since rewardDeductible = pendingRaw and claimedRewards = oending
			// expect(depositInfo2[4]).to.be.eq(depositInfo3[4]); //target prices should be equal as price hasnt changed.

			//inflate price
			const currPrice = await getCurrentPrice(doughLP);
			await inflatePrice(uniswap, doughLP, dough.target, accounts[4], currPrice * 2, 1);

			//withdraw all deposits
			await oven.connect(accounts[1]).removeWhenGoldenBrown(1, false);
			await oven.connect(accounts[1]).removeWhenGoldenBrown(2, false);
			await oven.connect(accounts[1]).removeWhenGoldenBrown(3, false);

			//check total balance
			console.log('total supply al final', await dough.totalSupply());
			expect(compareWithMarginBigInt(await dough.totalSupply(), 1000000000n * 10n**9n, 1n, 10000n)).to.be.true;
		});
	});

	// Jeet test
	describe("Jeet test", function () {
		it("Should check supply after jeets", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			// buy on uniswap and deposit
			await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
			const balanceBefore = await dough.balanceOf(accounts[1]);
			console.log(`Balance before: ${balanceBefore}`)
			await depositToOven(oven, dough, accounts[1], balanceBefore, 6, false);

			//simulate some volume
			await buyOnUniswap(uniswap, dough.target, accounts[2], 5);
			await sellOnUniswap(uniswap, dough, accounts[2], await dough.balanceOf(accounts[2].address));

			// buy and deposit
			await buyOnUniswap(uniswap, dough.target, accounts[3], 1);
			const balanceBefore2 = await dough.balanceOf(accounts[3]);
			console.log(`Balance before 2: ${balanceBefore2}`)
			await depositToOven(oven, dough, accounts[3], balanceBefore2, 6, false);

			//jeet
			await oven.connect(accounts[1]).jeet(1, false);

			//inflate price
			const currPrice = await getCurrentPrice(doughLP);
			await inflatePrice(uniswap, doughLP, dough.target, accounts[4], currPrice * 1.5, .3);

			//withdraw deposit 2
			await oven.connect(accounts[3]).removeWhenGoldenBrown(2, false);

			//check total supply
			console.log('total supply al final', await dough.totalSupply());
			expect(compareWithMarginBigInt(await dough.totalSupply(), 1000000000n * 10n**9n, 1n, 10000n)).to.be.true;
		});
	});

	return;

	//Rewards test - checks rewards per block, accRewardPerShare, and overall reward dynamics.
	describe("Rewards test", function () {
		it("Should check rewards per block, accRewardPerShare, and overall reward dynamics", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			// buy on uniswap and deposit
			await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
			const balanceBefore = await dough.balanceOf(accounts[1]);
			console.log(`Balance before: ${balanceBefore}`);
			await depositToOven(oven, dough, accounts[1], balanceBefore, 8, false);
			console.log(`Deposit info 1: ${await oven.getDepositInfo(1, false)}`);

			// accumulated rewards before
			let rewardsAccumulatedBefore = await oven.getOvenRewardsAccumulated(false);
			let accRewardPerShareBefore = await oven.accRewardPerShare();
			let rewardPerBlockBefore = await oven.rewardPerBlock();
			console.log(`Rewards accumulated before: ${rewardsAccumulatedBefore}`);
			console.log(`Accumulated rewards per share before: ${accRewardPerShareBefore}`);
			console.log(`Reward per block before: ${rewardPerBlockBefore}`);

			// mine 1 month
			await mine(BLOCKS_PER_DAY*30);

			// accumulated rewards after
			let rewardsAccumulatedAfter = await oven.getOvenRewardsAccumulated(false);
			await oven.connect(accounts[0]).forceUpdateRewards(false);
			let accRewardPerShareAfter = await oven.accRewardPerShare();
			console.log(`Rewards accumulated after: ${rewardsAccumulatedAfter}`);
			console.log(`Accumulated rewards per share after: ${accRewardPerShareAfter}`);

			// checks
			expect(rewardsAccumulatedAfter).to.be.eq(rewardsAccumulatedBefore + REWARD_PER_BLOCK * 7150n*30n); //rewards accumulated should equal reward per block * blocks mined
			expect(compareWithMarginBigInt(accRewardPerShareAfter, accRewardPerShareBefore + (rewardsAccumulatedAfter * 1000000000000n / (balanceBefore * 2n)), 1n, 1000n)).to.be.true; //accRewardPerShare should equal rewards accumulated / total shares

			// new reward per block
			let rewardPerBlockAfter = await oven.rewardPerBlock();
			console.log(`Reward per block after: ${rewardPerBlockAfter}`);
		});
	});
	
	describe("APR test", function () {
		it("Should check APR for stakers assuming 50% of supply staked", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			console.log(`Total supply before: ${await dough.totalSupply()}`);

			// buy 50% of supply on uniswap and deposit
			await buyOnUniswap(uniswap, dough.target, accounts[1], .5);
			await buyOnUniswap(uniswap, dough.target, accounts[2], .5);
			
			const balanceBefore1 = await dough.balanceOf(accounts[1]);
			const balanceBefore2 = await dough.balanceOf(accounts[2]);
			console.log(`Balance before 1: ${balanceBefore1}`);
			console.log(`Balance before 2: ${balanceBefore2}`);
			console.log(`Percentage of supply bought: ${parseFloat(balanceBefore1 + balanceBefore2) / parseFloat(await dough.totalSupply())}`);
			
			// deposit
			await depositToOven(oven, dough, accounts[1], balanceBefore1, 40, false); //10x
			await depositToOven(oven, dough, accounts[2], balanceBefore2, 20, false); //100x
			
			const deposit1Info = await oven.getDepositInfo(1, false);
			const deposit2Info = await oven.getDepositInfo(2, false);
			console.log(`Deposit info 1: ${deposit1Info}`);
			console.log(`Deposit info 2: ${deposit2Info}`);
			
			const currPrice = await getCurrentPrice(doughLP);

			// mine 1 year
			for (let i=0; i<365; i++) {
				await mine(BLOCKS_PER_DAY);
				await oven.connect(accounts[0]).forceUpdateRewards(false);
				//30k daily volume
				await buyOnUniswap(uniswap, dough.target, accounts[i % 16 + 3], 5.72);
				await sellOnUniswap(uniswap, dough, accounts[i % 16 + 3], (await dough.balanceOf(accounts[i % 16 + 3].address))/2n);
			}
			console.log(`Reward per block after 1 year: ${await oven.rewardPerBlock()}`);
			
			//inflate price
			await inflatePrice(uniswap, doughLP, dough.target, accounts[19], currPrice * 100, 10);

			//withdraw
			console.log(`Total shares: ${await oven.totalShares()}`);
			await oven.connect(accounts[1]).removeWhenGoldenBrown(1, false);
			await oven.connect(accounts[2]).removeWhenGoldenBrown(2, false);
			const accRewardPerShare = await oven.accRewardPerShare();
			console.log(`Accumulated rewards per share: ${accRewardPerShare}`);
			const balanceAfter1 = await dough.balanceOf(accounts[1]);
			const balanceAfter2 = await dough.balanceOf(accounts[2]);
			console.log(`Balance after 1: ${balanceAfter1}`);
			console.log(`Balance after 2: ${balanceAfter2}`);

			//calculate rewards
			const deposit1Rewards = accRewardPerShare * deposit1Info[2] - deposit1Info[3];
			const deposit2Rewards = accRewardPerShare * deposit2Info[2] - deposit2Info[3];
			console.log(`Rewards for deposit 1: ${deposit1Rewards / 1000000000000n}`);
			console.log(`Rewards for deposit 2: ${deposit2Rewards / 1000000000000n}`);

			//APR
			const apr1 = parseInt(balanceAfter1) / parseInt(balanceBefore1) - 1;
			console.log(`APR 1: ${apr1}`);
			const apr2 = parseInt(balanceAfter2) / parseInt(balanceBefore2) - 1;
			console.log(`APR 2: ${apr2}`);
			const avgAPR = parseInt(balanceAfter1 + balanceAfter2) / parseInt(balanceBefore1 + balanceBefore2) - 1;
			console.log(`Average APR: ${avgAPR}`);

			console.log(`Total supply after: ${await dough.totalSupply()}`);
		});
	});

	describe("APR test LP", function () {
		it("Should check APR for LP stakers assuming 50% of supply staked", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			console.log(`Total supply before: ${await dough.totalSupply()}`);

			// await buyOnUniswap(uniswap, dough.target, accounts[1], 7);
			// await buyOnUniswap(uniswap, dough.target, accounts[2], 7);
			const lpResult1 =  await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[3], .5);
			const lpResult2 = await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[4], .5);
			console.log(`LP balance before 1: ${lpResult1.lpBalance}`);
			console.log(`LP balance before 2: ${lpResult2.lpBalance}`);
			console.log(`Percentage of supply bought: ${parseFloat(lpResult1.doughBalance + lpResult2.doughBalance) / parseFloat(await dough.totalSupply())}`);

			await depositLPToOven(oven, doughLP, accounts[3], lpResult1.lpBalance, 40, true); //10x
			await depositLPToOven(oven, doughLP, accounts[4], lpResult2.lpBalance, 20, true); //100x
			const lpDeposit1Info = await oven.getDepositInfo(1, true);
			const lpDeposit2Info = await oven.getDepositInfo(2, true);
			console.log(`Deposit info 1 LP: ${lpDeposit1Info}`);
			console.log(`Deposit info 2 LP: ${lpDeposit2Info}`);

			// mine 1 year
			for (let i=0; i<365; i++) {
				await mine(BLOCKS_PER_DAY);
				await oven.connect(accounts[0]).forceUpdateRewards(true);
			}
			console.log(`Reward per block after 1 year: ${await oven.rewardPerBlockLP()}`);

			//inflate price
			const currPrice = await getCurrentPrice(doughLP);
			await inflatePrice(uniswap, doughLP, dough.target, accounts[19], currPrice * 100, 10);

			console.log(`Total shares LP: ${await oven.totalSharesLP()}`);
			await oven.connect(accounts[3]).removeWhenGoldenBrown(1, true);
			await oven.connect(accounts[4]).removeWhenGoldenBrown(2, true);

			const accRewardPerShareLP = await oven.accRewardPerShareLP();
			console.log(`Accumulated rewards per share LP: ${accRewardPerShareLP}`);
			const LPDoughBalanceAfter1 = await dough.balanceOf(accounts[3]);
			const LPDoughBalanceAfter2 = await dough.balanceOf(accounts[4]);
			console.log(`LP Dough Balance after 1: ${LPDoughBalanceAfter1}`);
			console.log(`LP Dough Balance after 2: ${LPDoughBalanceAfter2}`);

			//calculate rewards LP
			const LPDeposit1Rewards = accRewardPerShareLP * lpDeposit1Info[2] - lpDeposit1Info[3];
			const LPDeposit2Rewards = accRewardPerShareLP * lpDeposit2Info[2] - lpDeposit2Info[3];
			console.log(`Rewards for deposit 1 LP: ${LPDeposit1Rewards / 1000000000000n}`);
			console.log(`Rewards for deposit 2 LP: ${LPDeposit2Rewards / 1000000000000n}`);

			//APR LP
			const aprLP1 = parseInt(lpResult1.doughBalance * 2n + LPDoughBalanceAfter1) / parseInt(lpResult1.doughBalance * 2n) - 1;
			console.log(`APR 1 LP: ${aprLP1}`);
			const aprLP2 = parseInt(lpResult2.doughBalance * 2n + LPDoughBalanceAfter2) / parseInt(lpResult2.doughBalance * 2n) - 1;
			console.log(`APR 2 LP: ${aprLP2}`);
			const avgAPRLP = parseInt(lpResult1.doughBalance * 2n + LPDoughBalanceAfter1 + lpResult2.doughBalance * 2n + LPDoughBalanceAfter2) / parseInt(lpResult1.doughBalance * 2n + lpResult2.doughBalance * 2n) - 1;
			console.log(`Average APR LP: ${avgAPRLP}`);

			console.log(`Total supply after: ${await dough.totalSupply()}`);
		});
	});

	//Remove line below to run reward decay test - which plots reward emissions over time.
	//this will require python3 and matplotlib to be installed.
	return;

	//Tests reward decay on LeOven
	describe("Reward decay test", function () {
		it("Should decay rewards over time, supply before and supply at end should check out", async function () {
			const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

			//supply array for plotting
			let supplyArray = [];
			let blockArray = [];


			let tx = await oven.connect(accounts[0]).preheat(true);
			let receipt = await tx.wait();
			const blockNumber = receipt.blockNumber;
			//log block number of preheat
			console.log(`Block number of preheat: ${blockNumber}`);

			//Total supply before
			const totalSupplyBefore = await dough.totalSupply();
			console.log(`Total supply before: ${totalSupplyBefore}`);
			supplyArray.push(parseInt(totalSupplyBefore));
			blockArray.push(0);

			//buy on uniswap and deposit to oven
			await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
			await buyAndAddLiquidity(uniswap, dough, doughLP, accounts[2], 1);
			receipt = await depositToOven(oven, dough, accounts[1], await dough.balanceOf(accounts[1].address), 5, false);
			receipt = await depositLPToOven(oven, doughLP, accounts[2], await doughLP.balanceOf(accounts[2].address), 5, true);
			console.log(`Block number of deposit: ${receipt.blockNumber}`);

			// 4 years total, halvening every 3 months
			let rewardEmissions = 0n;
			let iterations = 365*2;
			let interval = BLOCKS_PER_DAY;
			const days = iterations * interval / BLOCKS_PER_DAY;
			const months = days / 30;
			const years = days / 365;
			for (let i = 0; i < iterations; i++) {
				//mine 3 months
				await mine(interval);
				rewardEmissions += await oven.getOvenRewardsAccumulated(false);
				rewardEmissions += await oven.getOvenRewardsAccumulated(true);
				// console.log(`Total supply after ${i+1} intervals: ${totalSupplyBefore + rewardEmissions}`);
				tx = await oven.connect(accounts[0]).forceUpdateRewards(false);
				tx = await oven.connect(accounts[0]).forceUpdateRewards(true);
				receipt = await tx.wait();
				supplyArray.push(parseInt(totalSupplyBefore + rewardEmissions));
				blockArray.push(parseInt(receipt.blockNumber - blockNumber));
				await buyOnUniswap(uniswap, dough.target, accounts[19], 7);
				await sellOnUniswap(uniswap, dough, accounts[19], await dough.balanceOf(accounts[19].address));
			}

			//get reward per block
			const rewardPerBlock = await oven.rewardPerBlock();
			console.log(`Reward per block: ${rewardPerBlock}`);
			const rewardPerBlockLP = await oven.rewardPerBlockLP();
			console.log(`Reward per block LP: ${rewardPerBlockLP}`);

			//Total supply after
			console.log(`% Change in supply after ${years} years: ${parseFloat(totalSupplyBefore + rewardEmissions) / parseFloat(totalSupplyBefore) - 1}`);

			let currPrice = await getCurrentPrice(doughLP);
			await inflatePrice(uniswap, doughLP, dough.target, accounts[2], currPrice * 1.25);
			await oven.connect(accounts[1]).removeWhenGoldenBrown(1, false);
			await oven.connect(accounts[2]).removeWhenGoldenBrown(1, true);

			const totalSupplyAfter = await dough.totalSupply();
			console.log(`Total supply after: ${totalSupplyAfter}`);
			console.log(`Expected total supply after: ${totalSupplyBefore + rewardEmissions}`);
			// expect(compareWithMarginBigInt(totalSupplyAfter, totalSupplyBefore + rewardEmissions, 1n, 100n)).to.be.true;
			// const lo = (totalSupplyBefore + rewardEmissions) * 99n / 100n;
			// const hi = (totalSupplyBefore + rewardEmissions) * 101n / 100n;
			// expect(totalSupplyAfter).to.be.gte(lo);
			// expect(totalSupplyAfter).to.be.lte(hi);

			// call python script plotter.py with x and y
			const { stdout, stderr } = await exec(`cd ./test/python_scripts && pipenv run python3 plotter.py '${JSON.stringify({x: blockArray, y: supplyArray})}' '${years}'`);
			
		});
	});

	// //Extreme prices test - checks for extreme price changes and their effects on LeOven
	// describe("Extreme prices test", function () {
	// 	it("Should withstand extremely high prices", async function () {
	// 		const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

	// 		//buy a lot
	// 		let startBlockNumber;
	// 		for (let i=1; i<5; i++) {
	// 			let receipt = await buyOnUniswap(uniswap, dough.target, accounts[i], 90);
	// 			if (i == 1) startBlockNumber = receipt.blockNumber;
	// 		}

	// 		//buy and deposit
	// 		await buyOnUniswap(uniswap, dough.target, accounts[19], 1);
	// 		let balanceBefore = await dough.balanceOf(accounts[19].address);
	// 		console.log(`Balance before: ${balanceBefore}`);
	// 		await depositToOven(oven, dough, accounts[19], balanceBefore, 40); // 10x

	// 		//inflate price
	// 		const currPrice = await getCurrentPrice(doughLP);
	// 		await inflatePrice(uniswap, doughLP, dough.target, accounts[18], currPrice * 9, 5);
	// 		await expect(oven.connect(accounts[19]).removeWhenGoldenBrown(1)).to.be.revertedWith("deposit not unlocked"); //can't be withdrawn until pledgePrice is met
	// 		await inflatePrice(uniswap, doughLP, dough.target, accounts[17], currPrice * 10, 5);

	// 		let contractRewardsAfter = await dough.getRewardsAccumulated();
	// 		console.log(`Contract reward balance after: ${contractRewardsAfter}`);

	// 		let tx = await oven.connect(accounts[19]).removeWhenGoldenBrown(1);
	// 		let receipt = await tx.wait();
	// 		let endBlockNumber = receipt.blockNumber;
	// 		console.log(`Block number of withdrawal: ${endBlockNumber}`);

	// 		let balance = await dough.balanceOf(accounts[19].address);
	// 		console.log(`Balance after: ${balance}`);
	// 		let expectedBalance = balanceBefore + BigInt(endBlockNumber - startBlockNumber) * 1200000000000n + contractRewardsAfter;
	// 		console.log(`Expected balance: ${expectedBalance}`);
	// 		let lo = balance * 96n / 100n;
	// 		let hi = balance * 104n / 100n;
	// 		expect(expectedBalance).to.be.gte(lo);
	// 		expect(expectedBalance).to.be.lte(hi);
	// 	});
	// });

	// //Extreme conditions test - pushes limits of LeOven, checks for overflows, underflows, etc.
	// describe("Extreme conditions test", function () {
	// 	it('Should withstand extreme conditions and overflow/underflow', async function () {
	// 		const { dough, doughLP, oven, timelock, uniswap, uniswapFactory, accounts } = await loadFixture(deployContractsFixture);

	// 		const tokens = 10n * 1000000000n; //10 tokens
	// 		const shares = tokens * 100n; //100x
	// 		const rewardsAccumulated = 1200n * 7150n*365n*100n * 1000000000n; //1200 tokens per block for 100 years
	// 		const accRewardsPerShare = rewardsAccumulated * 1000000000000n / shares;
	// 		const tokensDeposited = 10000000000n * 1000000000n; //10B
	// 		const sharesDeposited = tokensDeposited * 100n; //100x
	// 		const rewardDebt = sharesDeposited * accRewardsPerShare / 1000000000000n;
	// 		console.log(`Rewards accumulated: ${rewardsAccumulated}`);
	// 		console.log(`Reward per share: ${accRewardsPerShare}`);
	// 		console.log(`Reward debt: ${rewardDebt}`);
	// 		expect(rewardDebt).to.be.lt(2n**128n - 1n); //cannot overflow maxUint

	// 		//accRewardPerBlock overflow test
	// 		await buyOnUniswap(uniswap, dough.target, accounts[1], 1);
	// 		await depositToOven(oven, dough, accounts[1], await dough.balanceOf(accounts[1].address), 5);
	// 		await mine(BLOCKS_PER_DAY*365*15); // mine 1000 years
	// 		let tx = await oven.connect(accounts[1]).stayBaked(1, 5);
	// 		let receipt = await tx.wait();
	// 		// console.log(`Block number 1: ${receipt.blockNumber}`);
	// 		console.log(`Accumulated rewards: ${await oven.getTotalRewardsAccumulated()}`);
	// 		console.log(`Acc rewards per share: ${await oven.getAccRewardPerShare()}`);
	// 		console.log(`Reward per block: ${await oven.getRewardPerBlock()}`);
	// 		console.log(`Deposit 2 info: ${await oven.getDepositInfo(2)}`);

	// 		//rewardDeductible overflow test
	// 		await mine(BLOCKS_PER_DAY*365*10); // mine another 1000 years
	// 		// tx = await oven.connect(accounts[0]).forceUpdateRewards();
	// 		// receipt = await tx.wait();
	// 		// console.log(`Block number 2: ${receipt.blockNumber}`);
	// 		console.log(`Curr Acc rewards per share: ${await oven.getCurrAccRewardPerShare()}`);
	// 		console.log(`Curr Accumulated rewards: ${await oven.getTotalRewardsAccumulated()}`);
	// 		await oven.connect(accounts[1]).stayBaked(2, 5);
	// 		console.log(`Curr Reward per block: ${await oven.getRewardPerBlock()}`);
	// 		console.log(`Deposit 3 info: ${await oven.getDepositInfo(3)}`);
	// 		await buyOnUniswap(uniswap, dough.target, accounts[2], 98);
	// 		await depositToOven(oven, dough, accounts[2], await dough.balanceOf(accounts[2].address), 5);
	// 	});
	// });

});
