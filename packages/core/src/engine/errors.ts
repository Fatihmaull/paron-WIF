/**
 * Engine errors carry the exact Solidity custom-error name so the UI explains a simulated
 * revert exactly the way it explains an on-chain one.
 */
export class ParonError extends Error {
  readonly errorName: string;
  readonly detail: Record<string, unknown>;

  constructor(errorName: string, detail: Record<string, unknown> = {}) {
    super(`${errorName}${Object.keys(detail).length ? ` ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` : ""}`);
    this.name = "ParonError";
    this.errorName = errorName;
    this.detail = detail;
  }
}

const EXPLANATIONS: Record<string, string> = {
  NotRegisteredProvider: "Register as a provider first (permissionless, no KYB).",
  NotWifDiscountEligible: "The 10 bps $WIF fee needs 10,000 $WIF held or staked.",
  SelfTrade: "This order would trade against your own resting order.",
  OrderTooSmall: "Orders must be worth at least $5 (USDG).",
  TooManyOrders: "You already hold the maximum of 8 resting orders on this side of the series.",
  TooManyLevels: "This side of the book is at its 24-level cap. Join an existing price.",
  InvalidPrice: "Prices must be positive multiples of $0.01.",
  ZeroAmount: "Enter an amount greater than zero.",
  SeriesNotTradable: "This series' delivery window has ended.",
  OutsideDeliveryWindow: "Redemptions open during the series' delivery month.",
  OutsideSettlementWindow: "Cash settlement opens at the start of the delivery month.",
  StaleIndex: "The Compute Reference Index is stale. Wait for a fresh attestation.",
  NoLotCapacity: "No provider lot has enough sold capacity for this amount.",
  LotCapacity: "That provider lot does not have enough outstanding CU.",
  InsufficientBalance: "Insufficient balance for this action.",
  InsufficientCu: "You do not hold enough CU of this series.",
  StakeLocked: "Stake is locked while lots minted at your tier are open.",
  InsufficientStake: "You cannot unstake more than you staked.",
  NotRedemptionHolder: "Only the redemption holder can open a dispute.",
  NotDisputable: "Disputes open after delivery, inside the challenge window.",
  DisputeNotOpen: "This dispute is not open for votes.",
  VotingClosed: "Voting for this dispute has ended. Resolve it.",
  VotingStillOpen: "Voting is still open. Resolve after the round ends.",
  CannotVoteBothSides: "You already voted the other side of this dispute.",
  NotWinningVoter: "Only winning voters can claim upside.",
  AlreadyClaimed: "Already claimed.",
  EpochNotEnded: "The corridor epoch has not ended yet.",
  EpochAlreadyFinalized: "This corridor epoch is already finalized.",
  NoVotes: "No corridor votes were cast in this epoch.",
  FaucetCooldown: "Faucet cooldown: one drip per hour.",
  InsufficientBuybackPool: "The buyback pool cannot pay for that much $WIF right now.",
  DeadlinePassed: "The deadline for this step has passed.",
  DeadlineNotPassed: "The provider still has time to respond.",
  ChallengeWindowOpen: "The challenge window is still open.",
  InvalidAttestation: "The delivery receipt signature does not match the provider's attestation key.",
  InvalidState: "This redemption is not in the right state for that action.",
  NotProvider: "Only the lot's provider can do this.",
  NotHolder: "Only the redemption holder can do this.",
  NotOrderMaker: "Only the order's maker can cancel it.",
  OrderNotActive: "This order is no longer active.",
  EmptyReceipt: "A delivery receipt hash is required.",
  EmptyEvidence: "Evidence hash is required.",
  UnknownCorridor: "Unknown corridor.",
  UnknownSeries: "Unknown series.",
  SeriesExists: "That canonical series already exists.",
  InvalidDeliveryMonth: "Delivery month must be YYMM with 01-12.",
};

export function explainError(error: unknown): string {
  if (error instanceof ParonError) return EXPLANATIONS[error.errorName] ?? error.errorName;
  if (error && typeof error === "object") {
    const e = error as { shortMessage?: string; message?: string; data?: { errorName?: string }; cause?: unknown };
    const name = e.data?.errorName ?? (e.cause as { data?: { errorName?: string } } | undefined)?.data?.errorName;
    if (name && EXPLANATIONS[name]) return EXPLANATIONS[name];
    if (typeof e.shortMessage === "string") return e.shortMessage;
    if (typeof e.message === "string") return e.message.split("\n")[0];
  }
  return "Transaction failed.";
}
