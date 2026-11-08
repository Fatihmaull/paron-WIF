<p align="center">
  <img src="web/public/brand/paron-wif-mark.svg" width="72" alt="Paron WIF mark" />
</p>

# Paron WIF

**The flat-world compute commodity exchange, powered by a 4-engine `$WIF` on-chain flywheel.**

Paron WIF turns one hour of GPU compute into a liquid, permissionless asset: **1 CU = 1 hour of NVIDIA H100-SXM-80GB-equivalent compute**, whatever hardware delivers it. Providers anywhere list capacity without a KYB queue, buyers and AI agents trade it on a central limit order book, delivery is settled in cash at a compute index or redeemed as real GPU hours, and disputes are decided by a jury that votes by burning `$WIF`. Every one of those actions feeds `$WIF`.

> Built for the [World is Flat hackathon](https://worldisflat.fun/build) · Hooks & DeFi · Agents & AI · Tools & Infra · Consumer & Payments

| | |
| --- | --- |
| Contracts | 6 Solidity contracts + 2 linked libraries, Foundry, OpenZeppelin 5.6.1, solc 0.8.30, zero compiler warnings |
| Tests | 32 Foundry tests (incl. fuzzing and an on-chain judge-tour parity test), 14 engine tests, 4 indexer tests, an anvil end-to-end run |
| Parity | The zero-wallet simulation reproduces the on-chain judge tour **to the last unit** (shared golden fixture) |
| One command | `npm run verify:all` → exits 0 in about a minute |

---

## 60-second judge path

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:3000/tour> and press **▶ Play the 60-second tour**. No wallet, no `.env`, no RPC: the app runs a contract-exact deterministic simulation of the protocol and the telemetry bar at the top follows every burn live. At the end, download the hash-chained JSON audit receipts or press **Continue in this world** to keep trading the post-tour state.

To check everything a judge would want checked (brand and secret hygiene, contracts, tests, build, a real local chain):

```bash
npm run verify:all
```

---

## Why Paron WIF is the World is Flat thesis

The internet flattened access to information; AI is flattening access to knowledge. The physical fuel of AI, high-end GPU hours, is still sold through hyperscaler contracts, private broker deals and regional walls. There is no public price, no standard unit and no recourse when a provider under-delivers.

Paron WIF flattens that market:

- **One standard unit.** Hardware weights normalize everything to H100 hours: `A100 = 0.45x`, `H100 = 1.00x`, `H200 = 1.40x`, `B200 = 2.50x`, `GB200 = 3.50x`. A lab with A100s and an agent that needs H200 time trade the same unit.
- **Canonical series, deep books.** Exactly one series per (corridor, hardware, delivery month), derived on-chain (`CU-JKT-H100-2611`, `CU-BTM-H200-2611`, `CU-SGP-B200-2612`). Anyone can list a series; nobody can fragment one.
- **Anyone can be a provider.** No KYB, no verifier role. Skin in the game is USDG margin plus staked `$WIF`.
- **Anyone can be the judge.** SLA disputes are decided by community jurors who burn `$WIF` to vote and are paid real USDG when they win.

---

## The 4-engine `$WIF` on-chain flywheel

```
                ┌──────────────────────────────────────────────────────────┐
  AI agents     │  Loop 1 · every fill pays 30 bps (10 bps in $WIF mode)   │
  & traders ───►│  WifFlywheelVault.processProtocolFeeAndBurn              │
                │    50% ─► $WIF burned (buyer's own $WIF, or bought back)  │
                │    30% ─► SLA jury reward pool (USDG)                     │
                │    20% ─► rebates streamed to $WIF stakers               │
                └──────────────────────────────────────────────────────────┘
                         ▲                                   │
  Providers  ── Loop 2 · stake $WIF: margin 50% ► 35% ► 25%  │
  (permissionless)        (25k / 100k $WIF, 4x capital)      ▼
                ┌──────────────────────────────────────────────────────────┐
  Community  ──►│  Loop 3 · WifSlaJury: 1 $WIF burned = 1 vote             │
  jurors        │    SLA disputes  → slash: buyer 100% + 15%, remaining     │
                │      margin 50% voters · 25% $WIF burn · 25% Vault         │
                │    corridor election → winner mints at -2.5% margin       │
                └──────────────────────────────────────────────────────────┘
  Loop 4 · autonomous agents stake $WIF for 10 bps + the priority matching lane,
           buy compute, redeem it, police SLAs (burning $WIF to file) and hedge at the index.
```

| Loop | Mechanism | Where |
| --- | --- | --- |
| 1 · Fee buy-and-burn | 30 bps on every fill and cash settlement; 10 bps if you hold or stake ≥ 10,000 `$WIF` and opt in, in which case the fee's 50% burn leg is paid by burning **your own** `$WIF`. USDG burn legs buy `$WIF` from the buyback reserve at the reference price and burn it in the same transaction; anyone can also sell `$WIF` into the fee-funded buyback pool, where it is burned on arrival. | `ParonExchangeDesk._chargeTakerFee`, `WifFlywheelVault.processProtocolFeeAndBurn`, `sellWifToBuyback` |
| 2 · Margin boost | Tier 0: 50% cash margin (2.0x). Tier 1 (25k `$WIF`): 35% (2.85x). Tier 2 Flat-World Prime (100k `$WIF`): 25% (4.0x), versus the legacy 150% bond. A stake lock stops one stake from qualifying several providers. 20% of all fees stream to stakers. | `WifFlywheelVault.stakeWifForMarginBoost`, `getRequiredMarginBps`, `setStakeLock`, `claimProviderRebate` |
| 3 · Burn-to-vote | Filing a dispute burns 100 `$WIF` (counted as SLASH votes); voting burns any amount. SLASH refunds the buyer 100% principal + 15% from margin; the remaining margin goes 50% to winning voters, 25% to buy-and-burn, 25% to the Vault. Winners also get 20% of the jury pool (capped at the disputed margin) and a 10% `$WIF` bonus. Weekly corridor elections cut the winner's margin by 2.5%. | `WifSlaJury.openSlaDispute`, `voteOnDisputeWithWifBurn`, `resolveDispute`, `claimVoterUpside`, `voteForComputeCorridor`, `finalizeCorridorEpoch` |
| 4 · Agents | The CFO Compute Agent forecasts LLM inference load, keeps `$WIF` staked, buys the cheapest H100-equivalent hour within its premium budget over the index, redeems on load peaks, independently probes every delivery and files a dispute when p95 latency breaks its SLA. | `packages/core/src/cfoComputeAgent.ts`, `indexer/src/agent-runner.ts` |

---

## What changed versus the legacy Paron v1

| Legacy v1 | Paron WIF |
| --- | --- |
| Third-party brand in names, UI and docs | Fully rebranded; `scripts/audit-compliance.sh` proves 0 occurrences in files, file names and commits |
| 150% upfront cash bond (dead capital) | 25–50% USDG margin by `$WIF` tier; buyer principal escrowed per lot until delivery |
| Central KYB approval + single verifier role | Permissionless registration; objective failures slash instantly (`claimMissedDeadline`), subjective SLA quality goes to the `$WIF` burn-to-vote jury; the desk has no owner after wiring |
| No `$WIF` utility | Four `$WIF` loops wired into every trade, mint, settlement, dispute and election |
| 11+ fragmented micro-series with empty books | Canonical series derived on-chain, pre-seeded two-sided depth, hardware normalization |
| Secrets in history | Fresh history, keyless `.env.example`, secret audit in CI |

---

## Repository layout

```
paron-WIF/
├── contracts/                    Foundry project (vendored forge-std + OpenZeppelin subset, offline builds)
│   ├── src/WifTokenMock.sol        $WIF test token: burn/burnFrom shrink supply, hourly faucet
│   ├── src/UsdgMock.sol            USDG (6 decimals) settlement token, hourly faucet
│   ├── src/ParonSeriesToken.sol    ERC-1155 canonical CU series + hardware weight conversion
│   ├── src/WifFlywheelVault.sol    The Paron Vault: margin tiers, fee routing, buyback & burn, juror pools
│   ├── src/WifSlaJury.sol          burn-to-vote SLA jury + corridor elections
│   ├── src/ParonExchangeDesk.sol   primary issuance, CLOB, Mode A cash settlement, Mode B redemption
│   ├── src/libraries/              ParonClobLib, ParonSettlementLib (linked), constants, types
│   ├── script/DeployParonWif.s.sol deterministic deploy + seeded market, writes deployments/<chainId>.json
│   └── test/                       ParonWif.t.sol (31 tests), ParonWifTour.t.sol (golden parity)
├── packages/core/                @paron-wif/core: contract-exact simulation engine, tour, agent, typed ABIs
├── indexer/                      event indexer, flywheel REST API, live agent runner, e2e check
├── web/                          Next.js 16 terminal: /, /flywheel, /agents, /tour
├── scripts/                      verify-all.sh, audit-compliance.sh, e2e-local.sh, export-abis.mjs
└── PARON_WIF_PRD.md              product requirements (brand-compliant copy)
```

---

## Contracts

| Contract | Role | Runtime size |
| --- | --- | --- |
| `ParonExchangeDesk` | Permissionless providers, primary mint with `$WIF`-tier margin, price-time CLOB with a `$WIF` priority lane, Mode A `settleCashAtIndex`, Mode B `requestRedemption` → `acknowledgeRedemption` → `deliverWithReceipt` → `confirmDelivery` / dispute | 23,793 B |
| `ParonSeriesToken` | ERC-1155 CU ledger; `createSeries(corridor, gpu, yymm)` derives symbol and delivery window on-chain; `convertGpuHoursToCu` | 10,215 B |
| `WifSlaJury` | Disputes, burn votes, outcome execution, voter upside claims, corridor elections | 9,513 B |
| `WifFlywheelVault` | Staking tiers, stake locks, fee legs, buyback & burn, rebate accumulator, juror pools | 8,183 B |
| `ParonClobLib` / `ParonSettlementLib` | Linked libraries: order-book storage ops; slash waterfall, finalize, receipt signature recovery | 2,859 B / 2,349 B |
| `WifTokenMock` / `UsdgMock` | Testnet tokens with faucets; point the protocol at canonical tokens with `WIF_TOKEN_ADDRESS` / `USDG_TOKEN_ADDRESS` | 2,868 B / 2,443 B |

Design notes:

- **Escrow, not bonds.** A buyer's primary purchase price is escrowed in the provider's lot. Delivery or cash settlement releases it; a slash refunds it in full plus 15% from margin. That is why 25% margin is safe where the legacy design needed 150%.
- **Dual settlement.** Mode A pays `CU × CRI-H100`, capped at escrowed principal + margin, so agents can hedge compute price spikes without touching hardware. Mode B delivers real GPU hours with a receipt signed by the provider's attestation (TEE/hardware) key, verified on-chain with EIP-191.
- **Burn modes.** With a token exposing `burn`/`burnFrom` (`WIF_NATIVE_BURN=true`) burns shrink total supply; otherwise burns go to `0x000000000000000000000000000000000000dEaD`.
- **Bounded loops.** The book keeps at most 24 price levels per side, a transaction fills at most 32 orders, lot assignment scans at most 64 lots.
- **Trust assumptions, stated plainly.** Two oracle roles exist: the `$WIF` reference price (used to size fee burns and buyback payouts) and the CRI-H100 attestor (used for Mode A). On testnet both are the deployer; the attestor can rotate itself to a multisig or oracle network. The desk has no owner once the jury is wired. The remaining owner powers are narrow: one-time module wiring, registering new physical corridors on the series token, and setting the vault's treasury and oracle addresses; none of them can move user funds.

---

## The coded judge tour, on-chain and off-chain

The six steps run on the deterministic engine in the browser and, identically, on-chain in `contracts/test/ParonWifTour.t.sol`. Both assert the same numbers from `packages/core/fixtures/tour-golden.json`.

| Step | What happens | Golden result |
| --- | --- | --- |
| 1 · Provider stakes | Batam Prime H200 registers (no KYB), stakes 100,000 `$WIF`, mints 200 CU of `CU-BTM-H200-2611` at $2.24 | 25% margin = **$112.00** locked (legacy bond: $672.00) |
| 2 · Agent buys | CFO agent stakes 20k `$WIF`, buys 50 CU in `$WIF` mode | fee **$0.112** (10 bps); **112 `$WIF`** burned from the agent |
| 3 · Secondary fill | 40 A100 hours → 18 CU; the lab lifts the market maker's $2.23 ask at 30 bps | **120.42 `$WIF`** bought back and burned |
| 4 · Happy delivery | 25 CU redeemed, TEE-signed receipt (p95 142 ms), confirmed | provider receives **$70.00**; claims **$0.030989** staker rebate |
| 5 · SLA jury | p95 612 ms breach, dispute (100 `$WIF`), jurors burn 5,000 for SLASH, provider 1,000 for UPHOLD | agent refunded **$64.40** (100% + 15%); **2,800 `$WIF`** slash buyback burn; voter pool **$16.80** + 510 `$WIF`; Juror Alpha (2,500 burned) claims **$8.235294** + 250 `$WIF` |
| 6 · Corridor election | 6,500 `$WIF` for Batam-Singapore H200 vs 2,500 for Jakarta; epoch finalized | Prime margin **25% → 22.5%**; tour total **18,396.42 `$WIF`** burned |

The receipts the tour downloads chain each step's calls, events and flywheel deltas with keccak256 so any edit is detectable (`verifyReceiptChain`).

---

## Verification

`npm run verify:all` (`scripts/verify-all.sh`) runs, failing fast:

1. Toolchain check (Node ≥ 22.18, Foundry), dependency install if needed
2. **Brand & secret audit**: sponsor brand in files, file names and history; private keys, keyed RPC URLs, tokens, PEM keys; tracked env files; empty key slots in `.env.example`
3. **Solidity build** with zero compiler and lint warnings, every contract under EIP-170
4. **`forge test -vvv`**: 32 tests
5. **ABI drift**: the typed ABIs in `packages/core` match the compiled contracts
6. **Typecheck**: core, indexer, web
7. **Engine tests** (14): golden parity, receipt hash chain, atomic rollback, USDG conservation and `$WIF` supply invariants, CLOB priority, signature checks, genesis world, agent decisions and an agent end-to-end run
8. **Indexer tests** (4): events alone rebuild the exact ledger state (flywheel totals, open interest, every book level), RPC retry and adaptive `getLogs` range splitting, the REST API, fresh chain-head reads
9. **`next build`** of the web app
10. **Anvil end-to-end** (`scripts/e2e-local.sh`): deploy and seed with the real script, index the chain and cross-check it against contract views, then run the autonomous agent with a live key and verify its `$WIF` fee burn on-chain

Foundry test inventory: hardware weights, canonical series windows and anti-fragmentation, margin tiers 0/1/2, permissionless onboarding, stake lock, 30 bps buyback burn, 10 bps `$WIF`-mode burn, discount eligibility, burn counter on every trade, pro-rata staker rebates, sell-into-buyback, price-time priority, `$WIF` priority lane, resting-bid fills, cancels and margin release, Mode A PnL and stale-index guard, Mode B signed delivery, forged attestation rejection, instant slash on missed deadlines, dispute filing burn, burn votes shrinking supply, slash waterfall and voter claims, uphold path, corridor election boost, faucets, two fuzz suites and the full judge tour.

---

## Run it

| Command | What it does |
| --- | --- |
| `npm run dev` | Web app on :3000 (simulation by default) |
| `npm run indexer` | REST API on :8787: live chain if `RPC_URL` + `deployments/<chainId>.json` exist, otherwise the simulation |
| `npm run agent` | CFO compute agent: simulation, or live signing with `AGENT_PRIVATE_KEY` + `RPC_URL` |
| `npm run e2e:local` | Throwaway anvil chain: deploy, seed, index, live agent |
| `npm test` | Foundry + engine + indexer tests |

### Deploy to the target chain

The protocol is deployment-ready; no public testnet deployment was made from this repository's build environment. With a funded testnet key:

```bash
cd contracts && PARON_DEPLOYER_PK=<key> forge script script/DeployParonWif.s.sol --rpc-url <target-chain-rpc> --broadcast
```

Optional variables (see `.env.example`): `WIF_TOKEN_ADDRESS` and `WIF_NATIVE_BURN` to use the canonical `$WIF`, `USDG_TOKEN_ADDRESS`, `TREASURY_ADDRESS`, `INDEX_ATTESTOR`, `WIF_PRICE_USDG`, `CRI_H100_USDG`, `SEED_MARKET`. The script writes `deployments/<chainId>.json`; the web build picks addresses up from it, and with a wallet connected on chain `NEXT_PUBLIC_CHAIN_ID` (target chain 46630, label "Flat World EVM / Target Chain") the app switches to **Live** mode and sends real transactions with automatic approvals.

---

## Category fit

- **Hooks & DeFi.** A collateralized compute forward market: escrowed primary issuance, a central limit order book, cash settlement at an attested index, and a fee hook that burns `$WIF` on every fill.
- **Agents & AI.** AI agents are the natural buyers of compute. The CFO Compute Agent runs the whole loop autonomously, in the browser (`/agents`) and against a live chain from the CLI.
- **Tools & Infra.** A contract-exact TypeScript engine, an event indexer whose read model is proven equal to chain state, a REST API, typed ABIs, one-command verification and an anvil e2e harness.
- **Consumer & Payments.** One-click faucet, EIP-6963 wallet discovery, USDG settlement, a zero-wallet 60-second tour and downloadable receipts.

---

## Brand and secret compliance

- `npm run audit:compliance` reports 0 occurrences of the host sponsor's brand in every file, file name and commit message of this repository; the chain is referred to as "Flat World EVM / Target Chain" and configured by chain id and RPC in `.env.example`.
- No private keys, keyed RPC URLs or API tokens are committed. Scripts derive anvil keys at runtime from anvil's public development mnemonic.
- One note for full transparency: the first commits vendored `forge-std` verbatim, and its `StdChains.sol` ships Foundry's public default Infura project id for Sepolia. It is not a credential of this project and is patched out at HEAD (documented in `contracts/lib/VENDOR.md`); squash-merging this branch keeps it out of the main history entirely. The audit prints it as an informational history note.

---

## PRD coverage

| Requirement | Status |
| --- | --- |
| `WifTokenMock` (burn, burnFrom, totalBurned, faucet) and `UsdgMock` (6 decimals, faucet), external token addresses via env | Done |
| `ParonSeriesToken.convertGpuHoursToCu` with A100 4500 … GB200 35000 | Done |
| `WifFlywheelVault`: stake/unstake, 5000/3500/2500 margin tiers, `hasWifFeeDiscount`, `processProtocolFeeAndBurn` with 50/30/20 legs and `WifFlywheelBurned` events | Done (signature adds the payer for telemetry) |
| `WifSlaJury`: `openSlaDispute`, `voteOnDisputeWithWifBurn`, `resolveDispute`, `claimVoterUpside`, `voteForComputeCorridor` | Done |
| `ParonExchangeDesk`: `registerProviderAndStakeWif`, `mintPrimarySeries`, `buySeriesOrPlaceBid`, Mode A and Mode B | Done |
| 18+ Foundry tests | 32 |
| Clean indexer without KYB, flywheel metrics, disputes, corridor leaderboards | Done (`indexer/`) |
| `cfoComputeAgent.ts` | Done (`packages/core/src/cfoComputeAgent.ts`) |
| `WifBurnBanner`, series matrix + converter, order book with margin slider and fee preview, `/flywheel` 3 panels, `/agents`, 6-step `/tour` with JSON receipts, EIP-6963 | Done |
| Brand scrub, secret audit, `verify-all.sh` / `npm run verify:all` | Done |

---

## License

MIT © 2026 Fatih Maulana
