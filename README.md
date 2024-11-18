### More Liquidation Bot

# Requirements

- [Node.js](https://nodejs.org/en) v18 or later

# How To Run Bot

- Create `config.json` and add values

```
{
  "subgraph_url": "https://graph.more.markets/subgraphs/name/more-markets/more-subgraph",
  "rpc_url": "https://mainnet.evm.nodes.onflow.org",
  "liquidation_be": "http://18.233.102.130:3000",
  "liquidator_key": "your_liquidation_executor_private_key",
  "contracts": {
    "markets": "0x94A2a9202EFf6422ab80B6338d41c89014E5DD72",
    "multicall": "0x8358d18E99F44E39ea90339c4d6E8C36101f8161"
  }
}
```

- Install npm packages

```
npm run install
or
yarn install
```

- Deploy on AWS EC2 instance or any hosting service
- Then setup cron to run this script with your certain interval
  Check this [Guide](https://www.swhosting.com/en/comunidad/manual/how-to-use-cron-to-automate-tasks-in-ubuntu-2204debian-11)
