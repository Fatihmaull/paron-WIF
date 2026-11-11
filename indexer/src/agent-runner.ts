/**
 * Runs the autonomous CFO Compute Agent.
 *   npm run agent                       -> deterministic simulation on the genesis world
 *   AGENT_PRIVATE_KEY=... RPC_URL=... npm run agent -- --interval 30000
 *                                       -> live: signs real transactions against deployments/<chainId>.json
 * Flags: --ticks <n> (default: 8 in simulation, unlimited live), --interval <ms>, --advance <seconds> (simulation)
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address as ViemAddress,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CfoComputeAgent,
  DEFAULT_AGENT_POLICY,
  GENESIS_ACTORS,
  GPU_TIERS,
  LedgerAgentBackend,
  REDEMPTION_STATES,
  createGenesisWorld,
  explainError,
  paronExchangeDeskAbi,
  paronSeriesTokenAbi,
  usdgAbi,
  wifFlywheelVaultAbi,
  wifSlaJuryAbi,
  wifTokenAbi,
  type AgentBackend,
  type AgentObservation,
  type AgentTickReport,
  type Address,
  type Hex,
  type TxResult,
} from "@paron-wif/core";
import { chainFor, loadConfig, type Manifest } from "./config.ts";
import { withRetry } from "./rpc.ts";

type Contracts = Manifest["contracts"];

/** AgentBackend that signs real transactions with viem. Every write is simulated first for a clean revert reason. */
export class ChainAgentBackend implements AgentBackend {
  readonly address: Address;
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly c: Contracts;
  private budgetUsdg = 10_000n * 1_000_000n;
  private budgetWif = 500_000n * 10n ** 18n;

  constructor(pub: PublicClient, wallet: WalletClient, contracts: Contracts) {
    this.pub = pub;
    this.wallet = wallet;
    this.c = contracts;
    this.address = wallet.account!.address.toLowerCase() as Address;
  }

  private read<T>(address: ViemAddress, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
    return withRetry(() => this.pub.readContract({ address, abi, functionName, args }) as Promise<T>);
  }

  private async write(address: ViemAddress, abi: Abi, functionName: string, args: unknown[]): Promise<TxResult> {
    try {
      const { request } = await this.pub.simulateContract({ address, abi, functionName, args, account: this.wallet.account! });
      const hash = await this.wallet.writeContract(request);
      const receipt = await this.pub.waitForTransactionReceipt({ hash });
      return receipt.status === "success" ? { ok: true, txHash: hash } : { ok: false, error: `reverted in ${hash}` };
    } catch (error) {
      return { ok: false, error: explainError(error) };
    }
  }

  /**
   * Approves bounded budgets, not unlimited allowances: a compromised desk or oracle can then lose at most
   * AGENT_APPROVAL_USDG / AGENT_APPROVAL_WIF. Allowances are topped up when they fall below half the budget.
   */
  async ensureApprovals(budgetUsdg = this.budgetUsdg, budgetWif = this.budgetWif): Promise<void> {
    this.budgetUsdg = budgetUsdg;
    this.budgetWif = budgetWif;
    const pairs: [ViemAddress, Abi, ViemAddress][] = [
      [this.c.Usdg, usdgAbi as Abi, this.c.ParonExchangeDesk],
      [this.c.WifToken, wifTokenAbi as Abi, this.c.ParonExchangeDesk],
      [this.c.WifToken, wifTokenAbi as Abi, this.c.WifFlywheelVault],
      [this.c.WifToken, wifTokenAbi as Abi, this.c.WifSlaJury],
    ];
    for (const [token, abi, spender] of pairs) {
      const allowance = await this.read<bigint>(token, abi, "allowance", [this.address, spender]);
      const budget = token === this.c.Usdg ? budgetUsdg : budgetWif;
      if (allowance < budget / 2n) await this.write(token, abi, "approve", [spender, budget]);
    }
  }

  async observe(): Promise<AgentObservation> {
    await this.ensureApprovals(); // top up bounded allowances every tick
    const c = this.c;
    const me = this.address as ViemAddress;
    const [wif, usdg, stakedWif, wifDiscount, cri, criAt, seriesCount, redemptionCount, disputeCount, block] = await Promise.all([
      this.read<bigint>(c.WifToken, wifTokenAbi as Abi, "balanceOf", [me]),
      this.read<bigint>(c.Usdg, usdgAbi as Abi, "balanceOf", [me]),
      this.read<bigint>(c.WifFlywheelVault, wifFlywheelVaultAbi as Abi, "stakedWif", [me]),
      this.read<boolean>(c.WifFlywheelVault, wifFlywheelVaultAbi as Abi, "hasWifFeeDiscount", [me]),
      this.read<bigint>(c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "criH100Usdg"),
      this.read<bigint>(c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "criUpdatedAt"),
      this.read<bigint>(c.ParonSeriesToken, paronSeriesTokenAbi as Abi, "seriesCount"),
      this.read<bigint>(c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "redemptionCount"),
      this.read<bigint>(c.WifSlaJury, wifSlaJuryAbi as Abi, "disputeCount"),
      withRetry(() => this.pub.getBlock()),
    ]);
    const holdings: Record<number, bigint> = {};
    const series: AgentObservation["series"] = [];
    for (let id = 1; id <= Number(seriesCount); id += 1) {
      const [info, market, asks, bal] = await Promise.all([
        this.read<{ symbol: string; gpuTier: number; deliveryStart: bigint; deliveryEnd: bigint }>(c.ParonSeriesToken, paronSeriesTokenAbi as Abi, "getSeries", [BigInt(id)]),
        this.read<{ bestAsk: bigint; bestBid: bigint }>(c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "getSeriesMarket", [BigInt(id)]),
        this.read<[bigint[], bigint[]]>(c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "getBookSide", [BigInt(id), false, 1n]),
        this.read<bigint>(c.ParonSeriesToken, paronSeriesTokenAbi as Abi, "balanceOf", [me, BigInt(id)]),
      ]);
      holdings[id] = bal;
      series.push({
        id,
        symbol: info.symbol,
        gpuTier: GPU_TIERS[Number(info.gpuTier)],
        deliveryStart: info.deliveryStart,
        deliveryEnd: info.deliveryEnd,
        bestAsk: market.bestAsk,
        askQtyAtBest: asks[1][0] ?? 0n,
        bestBid: market.bestBid,
      });
    }
    const redemptions: AgentObservation["redemptions"] = [];
    const firstR = Math.max(1, Number(redemptionCount) - 199);
    for (let id = firstR; id <= Number(redemptionCount); id += 1) {
      const r = await this.read<{ holder: string; seriesId: bigint; cuAmount: bigint; state: number; p95LatencyMs: number; uptimeBps: number; challengeDeadline: bigint; receiptHash: Hex }>(
        c.ParonExchangeDesk,
        paronExchangeDeskAbi as Abi,
        "getRedemption",
        [BigInt(id)],
      );
      if (r.holder.toLowerCase() !== this.address) continue;
      redemptions.push({
        id,
        seriesId: Number(r.seriesId),
        cuAmount: r.cuAmount,
        state: REDEMPTION_STATES[Number(r.state)],
        p95LatencyMs: Number(r.p95LatencyMs),
        uptimeBps: Number(r.uptimeBps),
        challengeDeadline: r.challengeDeadline,
        receiptHash: r.receiptHash,
      });
    }
    const pendingUpside: AgentObservation["pendingUpside"] = [];
    for (let id = Math.max(1, Number(disputeCount) - 49); id <= Number(disputeCount); id += 1) {
      const [u, w] = await this.read<[bigint, bigint]>(c.WifSlaJury, wifSlaJuryAbi as Abi, "pendingVoterUpside", [BigInt(id), me]);
      if (u > 0n || w > 0n) pendingUpside.push({ disputeId: id, usdg: u, wif: w });
    }
    return {
      address: this.address,
      now: block.timestamp,
      wif,
      usdg,
      stakedWif,
      wifDiscount,
      criH100Usdg: cri,
      criUpdatedAt: criAt,
      series,
      holdings,
      redemptions,
      pendingUpside,
    };
  }

  stake(amount: bigint) {
    return this.write(this.c.WifFlywheelVault, wifFlywheelVaultAbi as Abi, "stakeWifForMarginBoost", [amount]);
  }

  async buy(seriesId: number, cu: bigint, maxPrice: bigint, useWifDiscount: boolean, maxWifSlippageBps: bigint) {
    const quote = await this.read<[bigint, bigint, bigint, bigint]>(this.c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "quoteBuy", [BigInt(seriesId), cu, maxPrice, useWifDiscount]);
    const maxWifBurn = quote[3] + (quote[3] * maxWifSlippageBps) / 10_000n;
    const before = await this.read<bigint>(this.c.ParonSeriesToken, paronSeriesTokenAbi as Abi, "balanceOf", [this.address, BigInt(seriesId)]);
    const usdgBefore = await this.read<bigint>(this.c.Usdg, usdgAbi as Abi, "balanceOf", [this.address]);
    const r = await this.write(this.c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "buySeriesOrPlaceBid", [BigInt(seriesId), cu, maxPrice, useWifDiscount, maxWifBurn]);
    if (!r.ok) return r;
    const after = await this.read<bigint>(this.c.ParonSeriesToken, paronSeriesTokenAbi as Abi, "balanceOf", [this.address, BigInt(seriesId)]);
    const usdgAfter = await this.read<bigint>(this.c.Usdg, usdgAbi as Abi, "balanceOf", [this.address]);
    return { ...r, filledCu: after - before, notional: usdgBefore - usdgAfter, detail: `${after - before} CU filled` };
  }

  requestRedemption(seriesId: number, cu: bigint, deliveryRef: Hex) {
    return this.write(this.c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "requestRedemption", [BigInt(seriesId), cu, 0n, deliveryRef]);
  }

  confirmDelivery(redemptionId: number) {
    return this.write(this.c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "confirmDelivery", [BigInt(redemptionId)]);
  }

  openDispute(redemptionId: number, evidenceHash: Hex, reason: string) {
    return this.write(this.c.WifSlaJury, wifSlaJuryAbi as Abi, "openSlaDispute", [BigInt(redemptionId), evidenceHash, reason]);
  }

  settleCash(seriesId: number, cu: bigint) {
    return this.write(this.c.ParonExchangeDesk, paronExchangeDeskAbi as Abi, "settleCashAtIndex", [BigInt(seriesId), cu]);
  }

  claimUpside(disputeId: number) {
    return this.write(this.c.WifSlaJury, wifSlaJuryAbi as Abi, "claimVoterUpside", [BigInt(disputeId)]);
  }
}

function arg(name: string, fallback: number | null): number | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

export function printReport(report: AgentTickReport): void {
  for (const entry of report.log) {
    const tag = entry.kind === "error" ? "ERR " : entry.kind === "act" ? "ACT " : entry.kind === "decide" ? "PLAN" : "OBS ";
    console.log(`[agent #${String(entry.tick).padStart(3, "0")}] ${tag} ${entry.message}${entry.txHash ? ` (${entry.txHash.slice(0, 12)}…)` : ""}`);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const key = process.env.AGENT_PRIVATE_KEY;
  const interval = arg("interval", 0) ?? 0;
  const policy = {
    ...DEFAULT_AGENT_POLICY,
    maxPriceUsdg: BigInt(process.env.AGENT_MAX_PRICE_USDG || DEFAULT_AGENT_POLICY.maxPriceUsdg),
    latencySlaMs: Number(process.env.AGENT_LATENCY_SLA_MS || DEFAULT_AGENT_POLICY.latencySlaMs),
  };
  let backend: AgentBackend;
  let advance: (() => void) | null = null;
  let ticks = arg("ticks", null);
  if (key && cfg.rpcUrl && cfg.manifest) {
    const chain = chainFor(cfg);
    const account = privateKeyToAccount(key as Hex);
    const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
    const wallet = createWalletClient({ chain, transport: http(cfg.rpcUrl), account });
    const live = new ChainAgentBackend(pub, wallet, cfg.manifest.contracts);
    await live.ensureApprovals(
      BigInt(process.env.AGENT_APPROVAL_USDG || 10_000n * 1_000_000n),
      BigInt(process.env.AGENT_APPROVAL_WIF || 500_000n * 10n ** 18n),
    );
    backend = live;
    console.log(`[agent] live mode as ${account.address} on chain ${cfg.chainId}`);
  } else {
    const world = createGenesisWorld();
    backend = new LedgerAgentBackend(world.ledger, GENESIS_ACTORS.cfoAgent.address);
    const step = arg("advance", 1_200) ?? 1_200;
    advance = () => world.ledger.advance(step);
    ticks = ticks ?? 8;
    console.log("[agent] simulation mode (no AGENT_PRIVATE_KEY / RPC_URL / manifest): deterministic genesis world");
  }
  const agent = new CfoComputeAgent(backend, policy);
  for (let i = 0; ticks === null || i < ticks; i += 1) {
    printReport(await agent.tick());
    advance?.();
    if (interval > 0) await new Promise((r) => setTimeout(r, interval));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
