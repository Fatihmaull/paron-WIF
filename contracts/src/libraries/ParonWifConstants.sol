// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ParonWifConstants
/// @notice Protocol constants for the Paron WIF compute exchange and its 4-engine $WIF flywheel.
/// @dev Every number here is mirrored 1:1 in `packages/core/src/constants.ts` so the deterministic
///      local simulation, the indexer and the contracts agree to the last unit.
library ParonWifConstants {
    uint256 internal constant BPS = 10_000;

    // ---------------------------------------------------------------------
    // Compute Unit standard: 1 CU = 1 hour of NVIDIA H100-SXM-80GB equivalent compute.
    // Hardware weights are expressed in bps of one H100 hour.
    // ---------------------------------------------------------------------
    uint16 internal constant WEIGHT_A100 = 4_500; // 0.45x
    uint16 internal constant WEIGHT_H100 = 10_000; // 1.00x
    uint16 internal constant WEIGHT_H200 = 14_000; // 1.40x
    uint16 internal constant WEIGHT_B200 = 25_000; // 2.50x
    uint16 internal constant WEIGHT_GB200 = 35_000; // 3.50x

    // ---------------------------------------------------------------------
    // Loop 2: $WIF-boosted provider margin (replaces the legacy 150% cash bond).
    // ---------------------------------------------------------------------
    uint256 internal constant TIER1_STAKE = 25_000e18;
    uint256 internal constant TIER2_STAKE = 100_000e18;
    uint16 internal constant MARGIN_TIER0_BPS = 5_000; // 50% -> 2.0x capital efficiency
    uint16 internal constant MARGIN_TIER1_BPS = 3_500; // 35% -> 2.85x
    uint16 internal constant MARGIN_TIER2_BPS = 2_500; // 25% -> 4.0x (Flat-World Prime)
    uint16 internal constant CORRIDOR_BOOST_MARGIN_BPS = 250; // elected corridor: extra -2.5% margin

    // ---------------------------------------------------------------------
    // Loop 1: protocol fee buy-and-burn.
    // ---------------------------------------------------------------------
    uint256 internal constant FEE_DISCOUNT_THRESHOLD = 10_000e18; // hold or stake 10k $WIF
    uint16 internal constant STANDARD_FEE_BPS = 30; // 0.30%
    uint16 internal constant WIF_FEE_BPS = 10; // 0.10% (66% discount)
    uint16 internal constant FEE_BURN_SHARE_BPS = 5_000; // 50% of every fee burns $WIF
    uint16 internal constant FEE_JURY_SHARE_BPS = 3_000; // 30% to the SLA jury reward pool
    // The remaining 20% is the provider rebate leg, streamed to $WIF stakers.

    // ---------------------------------------------------------------------
    // Loop 3: burn-to-vote SLA jury and corridor election.
    // ---------------------------------------------------------------------
    uint16 internal constant SLA_COMPENSATION_BPS = 1_500; // buyer gets principal + 15%
    uint16 internal constant SLASH_VOTER_SHARE_BPS = 5_000; // 50% of the remaining slashed margin
    uint16 internal constant SLASH_BURN_SHARE_BPS = 2_500; // 25% bought back and burned as $WIF
    // The remaining 25% refills The Paron Vault jury pool.
    uint16 internal constant JURY_POOL_DRAW_BPS = 2_000; // each resolved dispute draws 20% of the vault jury pool, capped at its margin
    uint16 internal constant JURY_WIF_BONUS_BPS = 1_000; // winners receive a bonus of 10% of winning votes in $WIF
    uint256 internal constant DISPUTE_FILING_BURN = 100e18; // filing burns 100 $WIF and counts as SLASH votes
    uint16 internal constant BUYBACK_SELL_DISCOUNT_BPS = 100; // sellers into the buyback desk take a 1% haircut

    // ---------------------------------------------------------------------
    // Market structure and SLA defaults for canonical series.
    // ---------------------------------------------------------------------
    uint256 internal constant PRICE_TICK = 10_000; // 0.01 USDG (6 decimals)
    uint256 internal constant WIF_UNIT = 1e18;
    uint256 internal constant MAX_LEVELS = 24;
    /// @dev Minimum notional (USDG, 6 decimals) of a resting order or primary mint: $5. Makes filling the
    ///      book with dust levels cost real capital.
    uint256 internal constant MIN_ORDER_NOTIONAL = 5_000_000;
    /// @dev Active orders one address may hold per series and side. One wallet can no longer occupy
    ///      more than a third of the 24 price levels.
    uint256 internal constant MAX_ORDERS_PER_MAKER = 8;
    uint256 internal constant MAX_FILLS_PER_TX = 32;
    uint256 internal constant MAX_LOT_SCAN = 64;
    uint256 internal constant SETTLEMENT_GRACE = 7 days;
    uint32 internal constant SLA_MAX_P95_LATENCY_MS = 250;
    uint16 internal constant SLA_MIN_UPTIME_BPS = 9_950;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant REBATE_PRECISION = 1e24;

    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
