# Paron WIF contracts

Foundry project. Dependencies (forge-std, an OpenZeppelin 5.6.1 subset) are vendored under `lib/`, so builds work offline with no `forge install`.

```bash
forge build --sizes
forge test -vvv
```

| File | Purpose |
| --- | --- |
| `src/ParonExchangeDesk.sol` | Permissionless providers, `$WIF`-tier primary margin, price-time CLOB with a `$WIF` priority lane, Mode A cash settlement at CRI-H100, Mode B compute redemption with signed receipts |
| `src/WifFlywheelVault.sol` | The Paron Vault: margin tiers and stake locks, 50/30/20 fee routing, buyback & burn, staker rebate stream, juror pools |
| `src/WifSlaJury.sol` | Burn-to-vote SLA disputes and weekly corridor elections |
| `src/ParonSeriesToken.sol` | ERC-1155 canonical CU series and hardware weights |
| `src/WifTokenMock.sol`, `src/UsdgMock.sol` | Testnet tokens with faucets |
| `src/libraries/ParonClobLib.sol` | Linked library: order-book storage (sorted levels, two FIFO lanes per level), per-maker cap, worst-level eviction |
| `src/libraries/ParonSettlementLib.sol` | Linked library: slash waterfall, delivery finalization, EIP-191 receipt recovery |
| `script/DeployParonWif.s.sol` | Deterministic deployment and seeded market; writes `../deployments/<chainId>.json` |
| `test/ParonWif.t.sol` | 31 unit and fuzz tests |
| `test/ParonWifClob.t.sol` | 11 order-book tests: dust limits, per-maker cap, level-flooding attack, eviction |
| `test/ParonWifTour.t.sol` | The judge tour on-chain, asserted against `../packages/core/fixtures/tour-golden.json` |

Deploy (see the root README for every variable):

```bash
PARON_DEPLOYER_PK=<key> forge script script/DeployParonWif.s.sol --rpc-url <rpc> --broadcast
```
