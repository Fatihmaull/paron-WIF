// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Native hardware of a canonical series. Weights live in ParonWifConstants.
enum GpuTier {
    A100,
    H100,
    H200,
    B200,
    GB200
}

/// @notice Direct-compute redemption lifecycle (Mode B).
enum RedemptionState {
    None,
    Requested,
    Acknowledged,
    Delivered,
    Disputed,
    Finalized,
    Slashed
}

enum DisputeStatus {
    None,
    Open,
    ResolvedSlash,
    ResolvedUphold
}

/// @notice Canonical compute series: one per (corridor, hardware, delivery month). Never fragmented.
struct SeriesInfo {
    string symbol;
    uint8 corridorId;
    GpuTier gpuTier;
    uint16 yymm;
    uint64 deliveryStart;
    uint64 deliveryEnd;
    address creator;
}

struct Corridor {
    string code;
    string name;
}

/// @notice A primary issuance lot. Buyer principal is escrowed per lot until delivery or settlement.
struct Lot {
    uint256 seriesId;
    address provider;
    uint256 cuMinted;
    uint256 cuUnsold;
    uint256 cuOutstanding;
    uint256 askPrice;
    uint16 marginBps;
    uint8 tier;
    bool closed;
    uint256 marginLocked;
    uint256 escrowUsdg;
    uint256 askOrderId;
}

/// @notice A resting CLOB order. Lane 0 is the $WIF priority lane, lane 1 the standard lane.
struct Order {
    uint256 seriesId;
    address maker;
    bool isBid;
    bool wifDiscount;
    uint8 lane;
    bool active;
    uint256 price;
    uint256 qtyRemaining;
    uint256 escrowUsdg;
    uint256 lotId;
    uint64 createdAt;
    uint256 prev;
    uint256 next;
}

struct Redemption {
    uint256 seriesId;
    uint256 lotId;
    address holder;
    address provider;
    uint256 cuAmount;
    uint256 principalUsdg;
    uint256 marginUsdg;
    RedemptionState state;
    uint64 requestedAt;
    uint64 ackDeadline;
    uint64 deliveryDeadline;
    uint64 challengeDeadline;
    bytes32 deliveryRef;
    bytes32 receiptHash;
    uint32 p95LatencyMs;
    uint16 uptimeBps;
    uint256 disputeId;
}

struct ProviderProfile {
    bool registered;
    string metadataUri;
    address attestationSigner;
    uint64 registeredAt;
    uint256 deliveredCu;
    uint256 slashedCu;
    uint32 deliveredCount;
    uint32 slashedCount;
}

struct Dispute {
    uint256 redemptionId;
    address challenger;
    bytes32 evidenceHash;
    uint64 openedAt;
    uint64 votingEndsAt;
    DisputeStatus status;
    uint32 voterCount;
    uint256 slashVotes;
    uint256 upholdVotes;
    uint256 rewardPoolUsdg;
    uint256 rewardPoolWif;
    uint256 claimedUsdg;
    uint256 claimedWif;
}

struct FlywheelStats {
    uint256 totalWifBurned;
    uint256 totalWifStaked;
    uint256 juryRewardPoolUsdg;
    uint256 buybackUsdgPool;
    uint256 buybackReserveWif;
    uint256 juryBonusWifPool;
    uint256 totalFeesUsdg;
    uint256 totalRebatesDistributedUsdg;
    uint256 wifPriceUsdg;
    uint256 burnCount;
}

struct SeriesMarket {
    uint256 bestBid;
    uint256 bestAsk;
    uint256 lastTradePrice;
    uint256 volumeCu;
    uint256 volumeUsdg;
    uint256 tradeCount;
    uint256 openInterestCu;
    uint256 unsoldCu;
}
