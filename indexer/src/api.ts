/**
 * Flywheel REST API over the indexed read model. Framework-free (node:http), CORS-enabled,
 * bigint-safe JSON. Routes:
 *   GET /health
 *   GET /v1/flywheel            burn/stake/pool telemetry + burns by reason
 *   GET /v1/series              canonical series with top of book, 24h volume, open interest
 *   GET /v1/series/:id/book     aggregated depth
 *   GET /v1/trades?seriesId=&limit=
 *   GET /v1/burns?limit=
 *   GET /v1/providers           $WIF tier + reliability (delivered vs slashed CU)
 *   GET /v1/disputes, /v1/disputes/:id
 *   GET /v1/corridors           election tallies per epoch and elected corridors
 *   GET /v1/redemptions?holder=
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { bigintReplacer, GPU_TIERS } from "@paron-wif/core";
import { bookLevels, openInterest, tierOf, volume24h, type View } from "./reducer.ts";

export type ApiSource = {
  mode: "live" | "simulation";
  chainId: number;
  view: () => View;
  health: () => { indexedBlock: number; headBlock: number; lastError: string | null };
  now: () => number;
};

type Json = Record<string, unknown> | unknown[];

function send(res: ServerResponse, status: number, body: Json): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, bigintReplacer));
}

export function seriesPayload(view: View, now: number) {
  return [...view.series.values()].map((s) => {
    const m = view.market.get(s.id);
    const bids = bookLevels(view, s.id, true, 1);
    const asks = bookLevels(view, s.id, false, 1);
    return {
      ...s,
      gpu: GPU_TIERS[s.gpuTier] ?? String(s.gpuTier),
      corridor: view.corridors.get(s.corridorId) ?? null,
      bestBid: bids[0]?.price ?? 0n,
      bestAsk: asks[0]?.price ?? 0n,
      lastPrice: m?.lastPrice ?? 0n,
      volumeCu: m?.volumeCu ?? 0n,
      trades: m?.trades ?? 0,
      volume24h: volume24h(view, s.id, now),
      openInterestCu: openInterest(view, s.id),
    };
  });
}

export function flywheelPayload(view: View) {
  const f = view.flywheel;
  let oi = 0n;
  for (const id of view.series.keys()) oi += openInterest(view, id);
  return {
    ...f,
    openInterestCu: oi,
    stakers: view.stakers.size,
    cri: view.cri,
    recentBurns: view.burns.slice(0, 20),
  };
}

export function createApiHandler(source: ApiSource) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const view = source.view();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    try {
      if (path === "/health" || path === "/v1/health") {
        const h = source.health();
        return send(res, 200, {
          ok: h.lastError === null,
          mode: source.mode,
          chainId: source.chainId,
          indexedBlock: h.indexedBlock,
          headBlock: h.headBlock,
          lagBlocks: Math.max(0, h.headBlock - h.indexedBlock),
          events: view.eventCount,
          lastError: h.lastError,
        });
      }
      if (path === "/v1/flywheel") return send(res, 200, flywheelPayload(view));
      if (path === "/v1/series") return send(res, 200, seriesPayload(view, source.now()));
      const book = path.match(/^\/v1\/series\/(\d+)\/book$/);
      if (book) {
        const id = Number(book[1]);
        if (!view.series.has(id)) return send(res, 404, { error: "unknown series" });
        const depth = Math.min(24, Number(url.searchParams.get("depth") ?? 10));
        return send(res, 200, { seriesId: id, bids: bookLevels(view, id, true, depth), asks: bookLevels(view, id, false, depth) });
      }
      if (path === "/v1/trades") {
        const sid = url.searchParams.get("seriesId");
        const rows = view.trades.filter((t) => sid === null || t.seriesId === Number(sid)).slice(0, limit);
        return send(res, 200, rows);
      }
      if (path === "/v1/burns") return send(res, 200, view.burns.slice(0, limit));
      if (path === "/v1/providers") {
        return send(
          res,
          200,
          [...view.providers.values()].map((p) => {
            const staked = view.stakers.get(p.address) ?? 0n;
            const total = p.deliveredCu + p.slashedCu;
            return { ...p, stakedWif: staked, tier: tierOf(staked), reliabilityBps: total === 0n ? 10_000 : Number((p.deliveredCu * 10_000n) / total) };
          }),
        );
      }
      if (path === "/v1/disputes") return send(res, 200, [...view.disputes.values()].map((d) => ({ ...d, voters: d.voters.size })));
      const dispute = path.match(/^\/v1\/disputes\/(\d+)$/);
      if (dispute) {
        const d = view.disputes.get(Number(dispute[1]));
        if (!d) return send(res, 404, { error: "unknown dispute" });
        return send(res, 200, { ...d, voters: [...d.voters], redemption: view.redemptions.get(d.redemptionId) ?? null });
      }
      if (path === "/v1/corridors") {
        const epochs = new Map<number, Record<number, bigint>>();
        for (const [key, votes] of view.corridorVotes) {
          const [epoch, corridor] = key.split(":").map(Number);
          const row = epochs.get(epoch) ?? {};
          row[corridor] = votes;
          epochs.set(epoch, row);
        }
        return send(res, 200, {
          corridors: [...view.corridors.values()],
          epochs: [...epochs.entries()].sort((a, b) => a[0] - b[0]).map(([epoch, tally]) => ({ epoch, tally, elected: view.elected.get(epoch) ?? null })),
        });
      }
      if (path === "/v1/redemptions") {
        const holder = url.searchParams.get("holder")?.toLowerCase();
        return send(res, 200, [...view.redemptions.values()].filter((r) => !holder || r.holder === holder));
      }
      if (path === "/" || path === "/v1") {
        return send(res, 200, {
          name: "Paron WIF indexer",
          mode: source.mode,
          routes: ["/health", "/v1/flywheel", "/v1/series", "/v1/series/:id/book", "/v1/trades", "/v1/burns", "/v1/providers", "/v1/disputes", "/v1/disputes/:id", "/v1/corridors", "/v1/redemptions"],
        });
      }
      return send(res, 404, { error: "not found" });
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : "internal error" });
    }
  };
}
