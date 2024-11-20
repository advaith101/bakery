# Smart contracts, hardhat environment, tests for bakery.

Test scripts are in test/ folder
Deploy scripts are in scripts/ folder
Main contracts are in contracts/ folder
Libraries by contracts are in libraries/ folder

Prerequisites:
Node.js
NPM
.env file with the following attributes:
MAINNET_RPC_URL - url to connect to a mainnet RPC


To install dependencies:
npm install


To run hardhat node:

```shell
npm install
npm hardhat node
```

To deploy contracts on local hardhat network:

```shell
npx run hardhat scripts/deployLocal.js
```

To test contracts using test script(s) in test/ folder:

```shell
npx run hardhat test
```
