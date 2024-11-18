const _ = require("lodash");
const {
  utils,
  constants,
  providers,
  BigNumber,
  Wallet,
  Contract,
} = require("ethers");

const config = require("./config.json");
const ERC20Abi = require("./abis/ERC20Abi.json");
const OracleAbi = require("./abis/OracleAbi.json");
const MarketsAbi = require("./abis/MarketsAbi.json");
const MulticallAbi = require("./abis/MulticallAbi.json");

const provider = new providers.JsonRpcProvider(config.rpc_url);
const oraclePriceScale = constants.WeiPerEther.mul(constants.WeiPerEther); // 1e36

const oracleInterface = new utils.Interface(OracleAbi);
const marketsInterface = new utils.Interface(MarketsAbi);

const virtualAssets = BigNumber.from(1);
const virtualShares = BigNumber.from(1e6);

const marketContract = new Contract(
  config.contracts.markets,
  MarketsAbi,
  provider
);

const multicallContract = new Contract(
  config.contracts.multicall,
  MulticallAbi,
  provider
);

function mulDivUp(x, y, d) {
  return x.mul(y).add(d.sub(virtualAssets)).div(d);
}

function delay(seconds) {
  return new Promise((res) => setTimeout(res, seconds * 1000));
}

// exports.handler = async (event) => {
async function main() {
  // fetch available positions
  const positionsRes = await fetch(config.liquidation_be);
  const { positions, markets } = await positionsRes.json();

  // fetch position details
  const positionDetailsRes = await multicallContract.callStatic.aggregate(
    positions.map((position) => {
      return {
        target: config.contracts.markets.toLowerCase(),
        callData: marketsInterface.encodeFunctionData("position", [
          position.market_id,
          position.user_address,
        ]),
      };
    })
  );
  const detailedPositions = positionDetailsRes[1].map((posDetail, ind) => {
    const detailedInfo = marketsInterface.decodeFunctionResult(
      "position",
      posDetail
    );

    return {
      market: positions[ind].market_id,
      user: positions[ind].user_address,
      collateral: detailedInfo.collateral,
      borrow_share: detailedInfo.borrowShares,
      last_multiplier: detailedInfo.lastMultiplier,
    };
  });

  // init markets and markets with multiplier info
  let marketInfos = [];
  let multiplierInfos = [];
  {
    let marketRequests = [];

    markets.map((market) => {
      marketRequests.push({
        target: config.contracts.markets,
        callData: marketsInterface.encodeFunctionData("idToMarketParams", [
          market.market_id,
        ]),
      });

      marketRequests.push({
        target: market.market_oracle,
        callData: oracleInterface.encodeFunctionData("price", []),
      });
    });

    const marketsWithmultiplier = _.uniqWith(
      detailedPositions.map((position) => ({
        market_id: position.market,
        multiplier: position.last_multiplier,
      })),
      _.isEqual
    );
    marketsWithmultiplier.map((marketWithmultiplier) => {
      marketRequests.push({
        target: config.contracts.markets,
        callData: marketsInterface.encodeFunctionData(
          "totalBorrowAssetsForMultiplier",
          [marketWithmultiplier.market_id, marketWithmultiplier.multiplier]
        ),
      });

      marketRequests.push({
        target: config.contracts.markets,
        callData: marketsInterface.encodeFunctionData(
          "totalBorrowSharesForMultiplier",
          [marketWithmultiplier.market_id, marketWithmultiplier.multiplier]
        ),
      });
    });
    const marketDetails = await multicallContract.callStatic.aggregate(
      marketRequests
    );

    const marketLen = markets.length;
    for (let ii = 0; ii < marketLen; ii++) {
      marketInfos.push({
        id: markets[ii].market_id.toLowerCase(),
        lltv: BigNumber.from(markets[ii].lltv),
        price: oracleInterface.decodeFunctionResult(
          "price",
          marketDetails[1][ii * 2 + 1]
        )[0],
        info: marketsInterface.decodeFunctionResult(
          "idToMarketParams",
          marketDetails[1][ii * 2]
        ),
      });
    }
    for (let ii = 0; ii < marketsWithmultiplier.length; ii++) {
      multiplierInfos.push({
        ...marketsWithmultiplier[ii],
        totalBorrowAssetsForMultiplier: marketsInterface.decodeFunctionResult(
          "totalBorrowAssetsForMultiplier",
          marketDetails[1][marketLen * 2 + 2 * ii]
        )[0],
        totalBorrowSharesForMultiplier: marketsInterface.decodeFunctionResult(
          "totalBorrowSharesForMultiplier",
          marketDetails[1][marketLen * 2 + 2 * ii + 1]
        )[0],
      });
    }
  }

  // check unhealthy positions
  const unhealthyPositions = _.compact(
    detailedPositions.map((position) => {
      const marketInfo = marketInfos.find(
        (marketInfo) => marketInfo.id == position.market
      );
      const multiplierInfo = multiplierInfos.find(
        (multiplierItem) =>
          multiplierItem.market_id == position.market &&
          position.last_multiplier.eq(multiplierItem.multiplier)
      );

      if (_.isEmpty(marketInfo) || _.isEmpty(multiplierInfo)) {
        return null;
      } else {
        const borrowLimit = position.collateral
          .mul(marketInfo.lltv)
          .mul(marketInfo.price)
          .div(constants.WeiPerEther)
          .div(oraclePriceScale);

        const borrowedAmount = mulDivUp(
          position.borrow_share,
          multiplierInfo.totalBorrowAssetsForMultiplier.add(virtualAssets),
          multiplierInfo.totalBorrowSharesForMultiplier.add(virtualShares)
        );

        return borrowedAmount > borrowLimit
          ? {
              ...position,
              borrowedAmount,
            }
          : null;
      }
    })
  );

  // do liquidation
  console.log(unhealthyPositions);
  const liquidator = new Wallet(config.liquidator_key, provider);
  for (const position of unhealthyPositions) {
    const marketInfo = marketInfos.find(
      (marketInfo) => marketInfo.id == position.market
    );

    // check balance
    const borrowToken = new Contract(marketInfo.info[2], ERC20Abi, provider);
    const borrowBalance = await borrowToken.balanceOf(liquidator.address);
    if (borrowBalance.gte(position.borrowedAmount)) {
      // check approve first
      const borrowAllowance = await borrowBalance.allowance(
        liquidator.address,
        config.contracts.markets
      );
      // approve if required
      if (borrowAllowance.lt(borrowBalance)) {
        const approveTx = await borrowToken
          .connect(liquidator)
          .approve(config.contracts.markets, constants.MaxUint256);
        await approveTx.wait();

        // delay 2 sec
        await delay(2);
      }

      const liquidateTx = await marketContract.connect(liquidator).liquidate(
        // market params
        {
          isPremiumMarket: marketInfo.info[0],
          loanToken: marketInfo.info[1],
          collateralToken: marketInfo.info[2],
          oracle: marketInfo.info[3],
          irm: marketInfo.info[4],
          lltv: marketInfo.info[5],
          creditAttestationService: marketInfo.info[6],
          irxMaxLltv: marketInfo.info[7],
          categoryLltv: marketInfo.info[8],
        },
        position.user,
        0,
        position.borrow_share,
        "0x"
      );
      await liquidateTx.wait();

      // delay 2 sec
      await delay(2);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit();
  })
  .finally(() => {
    console.log("finally");
    process.exit();
  });
