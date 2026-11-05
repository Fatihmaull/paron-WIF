> **Brand-compliant copy.** Per the World is Flat build rules, project names, logos, handles and comments may not use
> the host sponsor's name or logo, so every such reference in this PRD has been neutralized. Implementation status
> for each requirement is tracked in `README.md` (section *PRD coverage*).

# PRD & MASTER ENGINEERING SPECIFICATION: PARON WIF
**Paron WIF: The Flat-World Compute Commodity Exchange & `$WIF` On-Chain Flywheel Protocol**  
**Target Event:** [World is Flat Hackathon](https://worldisflat.fun/build) (Deadline: Nov 12, 2026 · 17:30 UTC · $10,000 USDG Winner-Takes-All Prize)  
**Target Categories:** `Hooks and DeFi` (Primary) · `Agents and AI` · `Tools and Infra` · `Consumer and Payments`  
**Source Reference:** the legacy Paron v1 codebase (private history, not imported)  
**Target Destination Repo:** [`https://github.com/Fatihmaull/paron-WIF.git`](https://github.com/Fatihmaull/paron-WIF.git)

## 1. Executive Thesis: Why Paron WIF Embodies "The World Is Flat"

### 1.1 Aligning Paron with the World is Flat ($WIF) Ideology
The [World is Flat](https://iq.wiki/wiki/worldisflat) thesis states that over the past three decades, technology has systematically flattened geography, institutions, and traditional intermediaries: *"The internet broadened access to information. AI is broadening access to knowledge."* Yet the physical fuel of AI—**high-performance GPU compute (`NVIDIA H100 / H200 / B200`)**—remains locked behind hyperscaler oligopolies, geographic walls, and opaque enterprise contracts.

**Paron WIF** flattens the global compute market by turning 1 hour of standardized GPU compute (**1 CU = 1 hour NVIDIA H100 SXM 80GB equivalent**) into a liquid, permissionless, on-chain asset class powered at its core by the **`$WIF` token and a 4-stage `$WIF` Burn & Yield Flywheel**.

### 1.2 Mandatory Hackathon Compliance & Architectural Upgrades Over Paron v1 (legacy)
Per the official rules at [worldisflat.fun/build/rules](https://worldisflat.fun/build/rules), pre-existing code on the target EVM chain is explicitly welcome provided it integrates **`$WIF` on-chain in a real, meaningful way**, includes a **self-sustaining `$WIF` flywheel**, and strictly complies with **brand guidelines**. This specification rewrites and upgrades the legacy Paron v1 codebase into [`Fatihmaull/paron-WIF`](https://github.com/Fatihmaull/paron-WIF.git) with 6 decisive fixes:

| Legacy Issue in Paron v1 (legacy) | Hackathon / Judge Risk | Fix Implemented in `paron-WIF` |
| :--- | :--- | :--- |
| **Brand Rule Violation (sponsor brand in name/UI)** | [worldisflat.fun/build/rules](https://worldisflat.fun/build/rules) strictly forbids using the host sponsor's name or logo in project names, logos, handles, or comments. | **100% Brand Scrubbing:** Rename all titles, headers, package names, badges, and docs to **`Paron WIF`** (*"Built for the Flat World Ecosystem"*). Keep the exact EVM chain ID (`chainId`) and RPC compatibility without forbidden brand strings. |
| **No Native `$WIF` Token Utility** | Projects without deep on-chain `$WIF` integration and a flywheel are ineligible to win. | **4-Loop `$WIF` On-Chain Flywheel:** `$WIF` is embedded as (1) Margin Collateral Boost, (2) Fee Discount & Automated Buy-and-Burn Fuel, (3) Burn-to-Vote SLA Dispute Jury & Series Listing Governance, and (4) AI Agent Priority Execution Staking. |
| **1.5x Upfront Dead-Cash Bond Paradox** | Forcing compute providers to lock 150% idle cash upfront kills working capital efficiency. | **`$WIF`-Boosted Dynamic Margin Vault:** Base stablecoin collateral starts at **50% Margin**, and providers who stake `$WIF` alongside their series unlock a **Margin Reduction down to 25%** plus earn a share of protocol `$WIF` rewards. |
| **Centralized KYB & Single "Paron Verifier"** | Relying on a centralized admin for KYB approval and `Delivered`/`Defaulted` arbitration contradicts crypto-native decentralization. | **`$WIF` Burn-to-Vote SLA Jury & Permissionless Onboarding:** Replace centralized KYB/Verifier roles with an on-chain **`$WIF` SLA Jury** where community holders burn `$WIF` (`1 $WIF burned = 1 permanent vote`) to arbitrate disputed deliveries and earn 50% of slashed bonds ("*Participation Should Have Upside*"). |
| **Fragmented Order Book Across 11+ Micro-Series** | Splitting order books by every city/month leaves empty books (`0 bids`). | **Unified Canonical `CU` Series + Pre-Seeded AMM/Orderbook Depth:** Standardize around canonical hardware weights (`A100=0.45x`, `H100=1.00x`, `H200=1.40x`, `B200=2.50x`, `GB200=3.50x`) across active liquid series with built-in market-maker liquidity. |
| **Git History & Secret Hygiene** | Legacy commit history contained an exposed Infura credential warning. | **Clean-Slate Git Rewrite:** Initialize `paron-WIF` with a fresh commit history, zero hardcoded API keys in `.env.example`, and a 100% self-contained **Coded Judge Tour** that works with or without an external wallet. |

## 2. The 4-Engine `$WIF` On-Chain Flywheel Architecture

To win both the **6 Judge Seats** (**Ogle**, **Niro**, **Daniel Zou**, **Glabuz**, **Sahil Sen**, WIF Team) and the **1 Community Burn-Vote Seat** (`1 $WIF burned = 1 vote` on [worldisflat.fun/build](https://worldisflat.fun/build)), Paron WIF makes `$WIF` the economic heartbeat of every transaction:

```
+-----------------------------------------------------------------------------------+
|                      THE PARON $WIF ON-CHAIN FLYWHEEL                             |
|                                                                                   |
|   [1. AI Agents & Compute Traders]                                                |
|         │  Pay 0.30% Trade Fee (or 0.10% when staking/paying in $WIF)             |
|         ▼                                                                         |
|   [2. WifFlywheelVault.sol (The Paron Vault)]                                     |
|         ├──► 50% of Fees & Slashes ──► PERMANENT ON-CHAIN $WIF BURN (0x...dEaD)   |
|         ├──► 30% of Fees & Slashes ──► Distributed to $WIF SLA Jury & Voters      |
|         └──► 20% of Fees & Slashes ──► Rebates to $WIF-Staking Compute Providers  |
|         ▲                                                                         |
|   [3. Compute Providers & Market Makers]                                          |
|         │  Lock $WIF + 25% USDG Margin to Mint Standardized CU Series             |
|         ▼                                                                         |
|   [4. $WIF Burn-to-Vote Governance & SLA Jury (WifSlaJury.sol)]                   |
|         └──► Holders burn $WIF to vote on SLA Disputes & New GPU Series Listings  |
|              ──► Winning Voters Earn Real USDG + $WIF Upside From The Vault!      |
+-----------------------------------------------------------------------------------+
```

### 2.1 Loop 1 — Protocol Fee Buy-and-Burn (`burnWifOnTrade`)
- Every primary mint, secondary order book fill, and cash/compute settlement collects a `30 bps (0.30%)` protocol fee.
- Traders or AI Agents who hold at least `10,000 $WIF` or pay the fee directly in `$WIF` receive an instant **66% fee discount (`10 bps`)** and priority order matching.
- **50% of every fee collected** is routed through `WifFlywheelVault.sol` to permanently burn `$WIF` to `0x000000000000000000000000000000000000dEaD`, incrementing the live on-chain counter `totalWifBurnedByParon`.

### 2.2 Loop 2 — `$WIF`-Boosted Provider Margin (`WifBoostedBond`)
- In legacy Paron, providers had to lock 150% (`1.5x`) cash collateral.
- In **Paron WIF**, base collateral is **50% USDG/USDC**, and providers can stake `$WIF` in `ParonEscrowVault.sol` across 3 tiers to unlock capital efficiency:
  - **Tier 0 (No `$WIF` Staked):** `50%` cash margin required (`2.0x` capital efficiency).
  - **Tier 1 (`25,000 $WIF` Staked):** `35%` cash margin required (`2.85x` capital efficiency).
  - **Tier 2 (`100,000 $WIF` Staked — Flat-World Prime Provider):** `25%` cash margin required (`4.0x` capital efficiency) + verified `$WIF` badge in the UI + `20%` share of protocol vault fee rebates.

### 2.3 Loop 3 — `$WIF` Burn-to-Vote SLA Jury & Series Election (`WifSlaJury.sol`)
- Mirroring [World is Flat's](https://iq.wiki/wiki/worldisflat) signature mechanic (*"Votes burn $WIF permanently and Participation Should Have Upside"*):
  1. **Decentralized SLA Dispute Resolution (Replacing Centralized Paron Verifier):** If a compute redemption request (`Requested` → `Acknowledged` → `Delivered`) is challenged for high latency, downtime, or non-delivery, a 15-minute on-chain **SLA Jury Round** opens. `$WIF` holders vote `UPHOLD_DELIVERY` or `SLASH_PROVIDER` by burning `$WIF` (`1 $WIF burned = 1 vote`).
     - If `SLASH_PROVIDER` wins: The buyer receives **100% principal refund + 15% SLA compensation**, **50% of the remaining slashed margin** is distributed pro-rata to the winning `$WIF` voters (*Participation Upside*), and **50% permanently burns `$WIF`**!
  2. **The Next Compute Corridor Election:** Community members burn `$WIF` to vote on which data center corridor or GPU series receives the next liquidity incentive boost from **The Paron Vault** (e.g., `CU-JKT-H100`, `CU-BTM-H200`, `CU-SGP-B200`, `CU-TYO-GB200`).

### 2.4 Loop 4 — Autonomous `$WIF` Compute Procurement Agent (`Agents and AI` Track)
- Includes an on-chain/TypeScript **Autonomous Compute Agent** that monitors AI inference demand, automatically buys the cheapest standardized `CU` series on the Paron Order Book, uses `$WIF` for the 66% fee rebate, and either settles for cash PnL when compute prices spike or redeems compute hours with cryptographic SLA verification.

## 3. Smart Contract Architecture (`contracts/src/`)

Rewrite and expand the Solidity smart contracts from Paron v1 (legacy) using **Foundry (Solidity 0.8.24+)** so they compile cleanly and pass comprehensive tests:

```text
paron-WIF/
├── README.md                          # Judge & Community Overview + $WIF Flywheel Diagram
├── Cargo.toml / foundry.toml          # Foundry config & workspace scripts
├── package.json                       # Root verification & dev scripts (verify:all, dev, test)
├── .env.example                       # Clean env template (0 hardcoded secrets!)
├── contracts/
│   ├── foundry.toml
│   ├── src/
│   │   ├── WifTokenMock.sol           # ERC-20 $WIF with burn() + live mainnet/testnet address config
│   │   ├── UsdgMock.sol               # ERC-20 USDG / USDC settlement stablecoin
│   │   ├── ParonSeriesToken.sol       # ERC-1155 / ERC-20 Standardized CU Series + Hardware Weights
│   │   ├── WifFlywheelVault.sol       # The Paron Vault: Fee Buy-and-Burn, Staking Tiers & Voter Rewards
│   │   ├── WifSlaJury.sol             # Burn-to-Vote ($WIF) SLA Dispute Resolution & Corridor Election
│   │   └── ParonExchangeDesk.sol      # Primary Mint (25%-50% Margin), CLOB Order Book & Dual Settlement
│   ├── script/
│   │   └── DeployParonWif.s.sol       # Deterministic deployment + pre-seeded orderbook & flywheel state
│   └── test/
│       └── ParonWif.t.sol             # 18+ Foundry tests covering all $WIF flywheel & trading flows
├── indexer/                           # Rewritten clean event indexer & API routes (fixes PR #100 bugs)
└── web/                               # Next.js + TypeScript + Tailwind CSS + EIP-6963 Wallet Discovery
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx               # Main Paron WIF Trading Desk + Live $WIF Burn Ticker
    │   │   ├── flywheel/page.tsx      # The $WIF Flywheel Vault, Margin Booster & SLA Burn-Vote Jury
    │   │   ├── agents/page.tsx        # Autonomous $WIF Compute Agent Telemetry & Auto-Hedge Runner
    │   │   └── tour/page.tsx          # 60-Second Interactive Coded Judge Tour (Zero-Wallet Needed)
    │   └── components/
    │       ├── WifBurnBanner.tsx      # Live real-time counter: Total $WIF Burned, Vault APY, Active Votes
    │       ├── SeriesMatrix.tsx       # Standardized CU Series & Hardware Weight Converter (A100..GB200)
    │       ├── OrderBookDesk.tsx      # Primary & Secondary CLOB + $WIF Margin Tier Selector (50%->25%)
    │       ├── SlaJuryVotingCard.tsx  # Burn $WIF to vote on SLA disputes & Corridor Elections + Claim USDG
    │       ├── RedemptionLifecycle.tsx# Requested -> Acknowledged -> Delivered / $WIF Jury Slashed
    │       └── CodedTourController.tsx# Upgraded from PR #99: walks judges through the full $WIF flywheel
```

### 3.1 Core Smart Contract Specifications

1. **`WifFlywheelVault.sol` (The Paron Vault & Burn Engine):**
   - Stores staked `$WIF` for providers (`stakeWifForMarginBoost(uint256 amount)`) and calculates the provider's required margin basis points:
     - `< 25,000 WIF`: `5000 bps` (`50%` margin)
     - `>= 25,000 WIF`: `3500 bps` (`35%` margin)
     - `>= 100,000 WIF`: `2500 bps` (`25%` margin)
   - Implements `routeFeeAndBurnWif(uint256 usdgFeeAmount, uint256 wifFeeAmount)`:
     - Permanently burns `50%` of `$WIF` fees via `IWifToken.burn()` (or transfers to `0x000000000000000000000000000000000000dEaD`), increments `totalWifBurned`, allocates `30%` to the `juryRewardPoolUsdg`, and `20%` to `providerRebatePoolWif`.
     - Emits `event WifFlywheelBurned(address indexed actor, uint256 wifBurned, uint256 totalWifBurned, uint256 vaultUsdgAdded, string reason)`.

2. **`WifSlaJury.sol` (Burn-to-Vote SLA Arbitration & Series Election):**
   - Replaces the legacy centralized `verifier` modifier from Paron v1 (legacy).
   - `openSlaDispute(uint256 redemptionId, bytes32 evidenceHash, string reason)`: Opens a dispute window on a contested compute redemption.
   - `castBurnVoteOnDispute(uint256 disputeId, bool supportSlash, uint256 wifVoteAmount)`:
     - Transfers `wifVoteAmount` from voter and **permanently burns 100% of the voted `$WIF`** (`votes burn $WIF permanently`), recording `voterWeight[disputeId][msg.sender] += wifVoteAmount`.
   - `resolveDispute(uint256 disputeId)`:
     - If `slashVotes > upholdVotes`: Marks redemption as `Slashed`, refunds `100%` principal + `15%` SLA penalty to buyer, burns `25%` worth of `$WIF`, and sends `50%` of the slashed provider margin into the dispute's `winningVoterRewardPoolUsdg`.
     - Winning voters call `claimJuryUpside(uint256 disputeId)` to claim their pro-rata USDG + bonus `$WIF` reward!
   - `voteForCorridorSeries(uint256 corridorId, uint256 wifBurnAmount)`: Lets the community burn `$WIF` to vote on which compute corridor (`Jakarta H100`, `Batam H200`, `Johor B200`, `Singapore GB200`) wins the weekly Vault Liquidity Boost.

3. **`ParonExchangeDesk.sol` (Standardized CU Series, CLOB & Dual Settlement):**
   - Maintains canonical hardware weights (`A100 = 4500 bps`, `H100 = 10000 bps`, `H200 = 14000 bps`, `B200 = 25000 bps`, `GB200 = 35000 bps`).
   - `mintPrimarySeries(uint256 seriesId, uint256 cuAmount, uint256 askPriceUsdg)`: Checks provider's `$WIF` staking tier from `WifFlywheelVault`, locks only the required `25%–50%` USDG margin, and lists the `CU` supply on the order book.
   - `buyPrimaryOrPlaceBid(uint256 seriesId, uint256 cuAmount, uint256 limitPriceUsdg, bool payFeeInWif)`: Applies the `66%` fee discount if `payFeeInWif == true` or if `msg.sender` holds `>= 10,000 $WIF`, matches orders in the CLOB, and triggers `WifFlywheelVault.routeFeeAndBurnWif()`.
   - Supports both **Cash/Index Settlement (`settleAtReferenceIndex`)** and **Direct Compute Redemption (`requestRedemption` -> `acknowledgeRedemption` -> `confirmDeliveryWithReceipt` / `openSlaDispute`)**.

## 4. Frontend & "60-Second Coded Judge Tour" Specifications (`web/`)

Preserve the sleek institutional terminal UX from Paron v1 (legacy) while upgrading every screen to showcase the **`$WIF` Flywheel** and strictly removing every third-party brand string:

1. **Global Top Bar — Live `$WIF` Flywheel Telemetry (`WifBurnBanner.tsx`):**
   - Displays 4 live on-chain counters at the top of every page:
     - 🔥 **Total `$WIF` Permanently Burned:** e.g., `1,428,500 $WIF` (updates live with animations on every trade, dispute vote, and corridor vote)
     - 🔒 **`$WIF` Locked in Margin Boost Vaults:** e.g., `4,850,000 $WIF`
     - 💰 **The Paron Vault (Voter & Staker Upside Pool):** e.g., `$18,420 USDG`
     - ⚡ **Standardized Compute Open Interest:** e.g., `12,400 CU (H100-Eq Hours)`
2. **Upgraded 60-Second Coded Judge Tour (`/tour` & Top CTA Button):**
   - Upgraded directly from Paron v1 (legacy) PR #99 (*"Play the full sample path as a coded tour"*).
   - One click runs a deterministic, visual 6-step guided tour (requiring zero wallet setup for judges):
     1. **Step 1 — Provider Stakes `100,000 $WIF`:** Unlocks **Tier-2 Prime Provider** status, cutting required cash margin from `150%` (legacy) down to **`25%`** and minting `200 CU` of `CU-BTM-H200-2611`.
     2. **Step 2 — Autonomous AI Agent Buys `50 CU` on the Order Book:** Uses `$WIF` fee mode for a **66% fee discount (`10 bps`)**, automatically triggering an **on-chain `$WIF` Buy-and-Burn** in `WifFlywheelVault`.
     3. **Step 3 — Secondary CLOB Trading & Hardware Normalization:** Demonstrates converting `A100 (0.45x)` and `H200 (1.40x)` workloads into canonical `H100 (1.00x)` Compute Units with instant bid/ask matching.
     4. **Step 4 — Happy-Path Compute Redemption (`Delivered`):** Provider delivers the first `25 CU` batch with a cryptographic execution receipt; escrow settles and provider earns `$WIF` vault rebates.
     5. **Step 5 — SLA Breach & `$WIF` Burn-to-Vote Jury (`votes burn $WIF permanently`):** Provider fails SLA on the second `25 CU` batch -> Dispute opens -> Community jurors burn `5,000 $WIF` to vote `SLASH_PROVIDER` -> Buyer gets `100%` refund + `15%` SLA compensation, `25%` burns more `$WIF`, and winning `$WIF` voters claim **`$USDG` upside rewards** from The Paron Vault!
     6. **Step 6 — Corridor Election Vote:** Jurors burn `$WIF` to vote `Batam-Singapore H200 Corridor` as the next incentivized compute pool.
3. **EIP-6963 Multi-Wallet Discovery + Built-In Testnet Faucet:**
   - Retains the clean EIP-6963 wallet connector from Paron v1 (legacy) (PR #96) plus a 1-click **"Mint Test `$WIF` & `USDG`"** faucet button in the header so judges and community voters can test real transactions immediately.

## 5. Verification & Submission Checklist for `worldisflat.fun/build`

1. **Zero Sponsor-Brand Strings Audit:**
   - Running `npm run audit:compliance` (scripts/audit-compliance.sh) must return **0 matches** for the sponsor brand in user-facing UI, titles, logos, handles, or comments (use environment variable `NEXT_PUBLIC_CHAIN_NAME="Flat World EVM / Target Chain"`).
2. **Zero Exposed Secrets Audit:**
   - Ensure zero hardcoded Infura, Alchemy, or private keys exist anywhere in the repository.
3. **Automated Verification Script (`./scripts/verify-all.sh` / `npm run verify:all`):**
   - Runs `forge test -vvv` (18+ tests in `contracts/test/ParonWif.t.sol`), runs indexer/shared-types checks, and runs `npm --prefix web run build` with zero errors.
