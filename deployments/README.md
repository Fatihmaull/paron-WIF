# Deployment manifests

`contracts/script/DeployParonWif.s.sol` writes `deployments/<chainId>.json` after every broadcast (schema `paron-wif-deployment/v1`):

```json
{
  "schema": "paron-wif-deployment/v1",
  "chainId": 46630,
  "deployedAt": 0,
  "startBlock": 0,
  "deployer": "0x…",
  "treasury": "0x…",
  "indexAttestor": "0x…",
  "wifIsMock": true,
  "usdgIsMock": true,
  "nativeBurn": true,
  "wifPriceUsdg": 500,
  "series": { "jkt": 1, "btm": 2, "sgp": 3 },
  "contracts": {
    "WifToken": "0x…",
    "Usdg": "0x…",
    "ParonSeriesToken": "0x…",
    "WifFlywheelVault": "0x…",
    "WifSlaJury": "0x…",
    "ParonExchangeDesk": "0x…"
  }
}
```

Consumers: `web/next.config.ts` fills empty `NEXT_PUBLIC_ADDR_*` values from the manifest of `NEXT_PUBLIC_CHAIN_ID`, and the indexer and agent runner load it for `NEXT_PUBLIC_CHAIN_ID` / `CHAIN_ID`. Local anvil manifests (`31337.json`) are ignored by git.
