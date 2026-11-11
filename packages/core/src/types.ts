import type { GpuTier } from "./constants.ts";

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export const REDEMPTION_STATES = [
  "None",
  "Requested",
  "Acknowledged",
  "Delivered",
  "Disputed",
  "Finalized",
  "Slashed",
] as const;
export type RedemptionState = (typeof REDEMPTION_STATES)[number];

export const DISPUTE_STATUSES = ["None", "Open", "ResolvedSlash", "ResolvedUphold"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export type SeriesInfo = {
  id: number;
  symbol: string;
  corridorId: number;
  gpuTier: GpuTier;
  yymm: number;
  deliveryStart: bigint;
  deliveryEnd: bigint;
  creator: Address;
};

export type Corridor = { id: number; code: string; name: string };

export type Lot = {
  id: number;
  seriesId: number;
  provider: Address;
  cuMinted: bigint;
  cuUnsold: bigint;
  cuOutstanding: bigint;
  askPrice: bigint;
  marginBps: bigint;
  tier: number;
  closed: boolean;
  marginLocked: bigint;
  escrowUsdg: bigint;
  askOrderId: number;
};

export type Order = {
  id: number;
  seriesId: number;
  maker: Address;
  isBid: boolean;
  wifDiscount: boolean;
  lane: 0 | 1;
  active: boolean;
  price: bigint;
  qtyRemaining: bigint;
  qtyOriginal: bigint;
  escrowUsdg: bigint;
  lotId: number;
  createdAt: bigint;
  prev: number;
  next: number;
};

export type Redemption = {
  id: number;
  seriesId: number;
  lotId: number;
  holder: Address;
  provider: Address;
  cuAmount: bigint;
  principalUsdg: bigint;
  marginUsdg: bigint;
  state: RedemptionState;
  requestedAt: bigint;
  ackDeadline: bigint;
  deliveryDeadline: bigint;
  challengeDeadline: bigint;
  deliveryRef: Hex;
  receiptHash: Hex;
  p95LatencyMs: number;
  uptimeBps: number;
  disputeId: number;
};

export type ProviderProfile = {
  address: Address;
  registered: boolean;
  metadataUri: string;
  attestationSigner: Address | null;
  registeredAt: bigint;
  deliveredCu: bigint;
  slashedCu: bigint;
  deliveredCount: number;
  slashedCount: number;
};

export type Dispute = {
  id: number;
  redemptionId: number;
  challenger: Address;
  evidenceHash: Hex;
  reason: string;
  openedAt: bigint;
  votingEndsAt: bigint;
  status: DisputeStatus;
  voterCount: number;
  slashVotes: bigint;
  upholdVotes: bigint;
  rewardPoolUsdg: bigint;
  rewardPoolWif: bigint;
  claimedUsdg: bigint;
  claimedWif: bigint;
};

export type EventArgs = Record<string, bigint | number | string | boolean>;

/** A protocol event. Names and argument keys match the contract ABIs exactly. */
export type ParonEvent = {
  seq: number;
  block: number;
  timestamp: bigint;
  txHash: Hex;
  contract: "WifToken" | "Usdg" | "ParonSeriesToken" | "WifFlywheelVault" | "WifSlaJury" | "ParonExchangeDesk" | "ComputeReferenceIndex";
  name: string;
  args: EventArgs;
};
