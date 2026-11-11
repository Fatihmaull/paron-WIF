/**
 * Protocol constants, mirrored 1:1 from contracts/src/libraries/ParonWifConstants.sol.
 * The deterministic engine, the indexer and the UI all read these, so every number a judge
 * sees in the simulation is the number the contracts would produce.
 */

export const WIF = 10n ** 18n; // $WIF has 18 decimals
export const USDG = 10n ** 6n; // USDG has 6 decimals
export const BPS = 10_000n;

export const GPU_TIERS = ["A100", "H100", "H200", "B200", "GB200"] as const;
export type GpuTier = (typeof GPU_TIERS)[number];

/** Weight of one native GPU hour in bps of one H100-SXM-80GB hour (1 CU). */
export const GPU_WEIGHT_BPS: Record<GpuTier, bigint> = {
  A100: 4_500n,
  H100: 10_000n,
  H200: 14_000n,
  B200: 25_000n,
  GB200: 35_000n,
};

export const GPU_LABEL: Record<GpuTier, string> = {
  A100: "NVIDIA A100 SXM 80GB",
  H100: "NVIDIA H100 SXM 80GB",
  H200: "NVIDIA H200 SXM 141GB",
  B200: "NVIDIA B200 SXM 180GB",
  GB200: "NVIDIA GB200 NVL72",
};

// Loop 2: $WIF-boosted margin
export const TIER1_STAKE = 25_000n * WIF;
export const TIER2_STAKE = 100_000n * WIF;
export const MARGIN_TIER0_BPS = 5_000n;
export const MARGIN_TIER1_BPS = 3_500n;
export const MARGIN_TIER2_BPS = 2_500n;
export const CORRIDOR_BOOST_MARGIN_BPS = 250n;
export const LEGACY_BOND_BPS = 15_000n; // the legacy 150% cash bond, for comparisons only

// Loop 1: fees and buy-and-burn
export const FEE_DISCOUNT_THRESHOLD = 10_000n * WIF;
export const STANDARD_FEE_BPS = 30n;
export const WIF_FEE_BPS = 10n;
export const FEE_BURN_SHARE_BPS = 5_000n;
export const FEE_JURY_SHARE_BPS = 3_000n;
export const FEE_PROVIDER_SHARE_BPS = 2_000n;

// Loop 3: jury
export const SLA_COMPENSATION_BPS = 1_500n;
export const SLASH_VOTER_SHARE_BPS = 5_000n;
export const SLASH_BURN_SHARE_BPS = 2_500n;
export const JURY_POOL_DRAW_BPS = 2_000n;
export const JURY_WIF_BONUS_BPS = 1_000n;
export const DISPUTE_FILING_BURN = 100n * WIF;
export const BUYBACK_SELL_DISCOUNT_BPS = 100n;

// Oracles (mirrors ComputeReferenceIndex and the vault's $WIF price bounds)
export const CRI_MAX_STEP_BPS = 1_000n; // each publication moves the index at most +-10%
export const CRI_MIN_INTERVAL = 3_600n;
export const CRI_WINDOW = 6n * 3_600n;
export const CRI_MAX_ATTESTORS = 9;
export const WIF_PRICE_MAX_MOVE_BPS = 1_000n;
export const WIF_PRICE_MIN_INTERVAL = 3_600n;
export const MAX_UINT256 = (1n << 256n) - 1n;

// Market structure
export const PRICE_TICK = 10_000n; // 0.01 USDG
export const MAX_LEVELS = 24;
/** Minimum notional (USDG) of a resting order or primary mint: $5. */
export const MIN_ORDER_NOTIONAL = 5_000_000n;
/** Active orders one address may hold per series and side. */
export const MAX_ORDERS_PER_MAKER = 8;
/** Orders one transaction may evict from the worst level to admit a better price. */
export const MAX_EVICTIONS_PER_TX = 16;
export const MAX_FILLS_PER_TX = 32;
export const MAX_LOT_SCAN = 64;
export const SETTLEMENT_GRACE = 7n * 86_400n;
export const SLA_MAX_P95_LATENCY_MS = 250;
export const SLA_MIN_UPTIME_BPS = 9_950;
export const REBATE_PRECISION = 10n ** 24n;
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;

// Testnet faucets
export const WIF_FAUCET_AMOUNT = 50_000n * WIF;
export const USDG_FAUCET_AMOUNT = 10_000n * USDG;
export const FAUCET_COOLDOWN = 3_600n;

/** Default protocol timing, identical to contracts/script/DeployParonWif.s.sol. */
export const DEFAULT_PARAMS = {
  chainId: 46_630,
  wifPriceUsdg: 500n, // $0.0005 per $WIF (testnet oracle)
  criH100Usdg: 2_200_000n, // $2.20 per CU
  votingPeriod: 15n * 60n,
  epochLength: 7n * 86_400n,
  ackWindow: 2n * 3_600n,
  deliveryWindow: 24n * 3_600n,
  challengeWindow: 6n * 3_600n,
  maxIndexAge: 30n * 86_400n,
  nativeBurn: true,
} as const;

export type WorldParams = {
  chainId: number;
  wifPriceUsdg: bigint;
  criH100Usdg: bigint;
  votingPeriod: bigint;
  epochLength: bigint;
  ackWindow: bigint;
  deliveryWindow: bigint;
  challengeWindow: bigint;
  maxIndexAge: bigint;
  nativeBurn: boolean;
};

/** 2026-11-05T00:00:00Z: genesis of the deterministic worlds (matches the Foundry fixture). */
export const SIM_GENESIS_TIME = 1_793_836_800n;

export const CORRIDORS = [
  { code: "JKT", name: "Jakarta H100" },
  { code: "BTM", name: "Batam-Singapore H200" },
  { code: "JHB", name: "Johor B200" },
  { code: "SGP", name: "Singapore GB200" },
] as const;
