// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ParonWifBase} from "./ParonWifBase.sol";
import {Dispute, DisputeStatus, GpuTier, Redemption, RedemptionState} from "../src/libraries/ParonWifTypes.sol";

/// @notice The 60-Second Coded Judge Tour, executed on-chain step by step.
///         Every number is asserted against `packages/core/fixtures/tour-golden.json`, the same file the
///         TypeScript simulation engine is tested against, proving the zero-wallet tour mirrors the contracts.
contract ParonWifTourTest is ParonWifBase {
    string internal golden;

    address internal genesisProvider;
    address internal marketMaker;
    address internal prime;
    address internal agent;
    address internal lab;
    address internal jurorA;
    address internal jurorB;
    address internal jurorC;
    uint256 internal primeTeeKey;

    function setUp() public override {
        super.setUp();
        // Read-only access to the shared golden fixture (fs_permissions limits it to packages/core/fixtures).
        // forge-lint: disable-next-line(unsafe-cheatcode)
        golden = vm.readFile(string.concat(vm.projectRoot(), "/../packages/core/fixtures/tour-golden.json"));
        assertEq(_g("params.wifPriceUsdg"), WIF_PRICE);
        assertEq(_g("params.criH100Usdg"), CRI_GENESIS);

        // Pre-seeded market (see packages/core/src/seed.ts: seedTourWorld)
        genesisProvider = _provider("batam-riau-gpu-park", 30_000e18);
        marketMaker = _actor("flatline-market-maker", 20_000e18, 50_000e6);
        lab = _actor("inference-lab-a100", 0, 1_000e6);
        agent = _actor("cfo-compute-agent", 120_000e18, 10_000e6);
        jurorA = _actor("juror-alpha", 10_000e18, 0);
        jurorB = _actor("juror-beta", 10_000e18, 0);
        jurorC = _actor("juror-gamma", 5_000e18, 0);

        _mint(genesisProvider, seriesBtm, 40, 2_200_000);
        _buy(marketMaker, seriesBtm, 40, 2_200_000, false);
        _buy(marketMaker, seriesBtm, 40, 2_150_000, false);
        _buy(marketMaker, seriesBtm, 60, 2_120_000, false);
    }

    function test_SixtySecondJudgeTourMatchesGoldenParity() public {
        // ---- Step 1: Prime provider stakes 100,000 $WIF -> Tier 2 -> 25% margin, mints 200 CU ----
        vm.warp(vm.getBlockTimestamp() + 10);
        prime = _provider("batam-prime-h200", 100_000e18);
        address tee;
        (tee, primeTeeKey) = makeAddrAndKey("batam-prime-tee");
        vm.prank(prime);
        desk.setAttestationSigner(tee);
        assertEq(vault.getRequiredMarginBps(prime), _g("expect.providerMarginBps"));
        uint256 usdgBefore = usdg.balanceOf(prime);
        uint256 lotId = _mint(prime, seriesBtm, 200, 2_240_000);
        assertEq(usdgBefore - usdg.balanceOf(prime), _g("expect.providerMarginUsdg"));

        // ---- Step 2: autonomous agent stakes, buys 50 CU in $WIF discount mode (10 bps, burns its WIF) ----
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(agent);
        vault.stakeWifForMarginBoost(20_000e18);
        uint256 burned0 = vault.totalWifBurnedByParon();
        uint256 fees0 = vault.totalFeesUsdg();
        (uint256 agentFill,) = _buy(agent, seriesBtm, 50, 2_300_000, true);
        assertEq(agentFill, _g("expect.agentFillCu"));
        assertEq(vault.totalFeesUsdg() - fees0, _g("expect.agentFeeUsdg"));
        assertEq(vault.totalWifBurnedByParon() - burned0, _g("expect.agentFeeWifBurned"));

        // ---- Step 3: secondary CLOB fill. MM undercuts at $2.23, the A100 lab lifts 18 CU (40 A100 h) ----
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(marketMaker);
        desk.placeAsk(seriesBtm, 20, 2_230_000);
        uint256 labCu = seriesToken.convertGpuHoursToCu(GpuTier.A100, 40e18) / 1e18;
        burned0 = vault.totalWifBurnedByParon();
        fees0 = vault.totalFeesUsdg();
        (uint256 labFill,) = _buy(lab, seriesBtm, labCu, 2_230_000, false);
        assertEq(labFill, _g("expect.labFillCu"));
        assertEq(vault.totalFeesUsdg() - fees0, _g("expect.labFeeUsdg"));
        assertEq(vault.totalWifBurnedByParon() - burned0, _g("expect.labFeeWifBurned"));

        // ---- Step 4: happy-path delivery of the first 25 CU with a signed execution receipt ----
        vm.warp(vm.getBlockTimestamp() + 10);
        uint256 r1 = _redeemAndDeliver(lotId, 142, 9_997, "job-log: 25 CU, p95 142ms");
        vm.prank(agent);
        desk.confirmDelivery(r1);
        assertEq(desk.providerClaimableUsdg(prime), _g("expect.happyPathProviderRelease"));
        vm.prank(prime);
        assertEq(vault.claimProviderRebate(), _g("expect.providerRebateClaimed"));

        // ---- Step 5: SLA breach -> dispute -> $WIF burn-to-vote jury -> slash -> voter upside ----
        vm.warp(vm.getBlockTimestamp() + 10);
        uint256 r2 = _redeemAndDeliver(lotId, 612, 9_780, "job-log: 25 CU, p95 612ms, 97.8% uptime");
        vm.prank(agent);
        uint256 did = jury.openSlaDispute(r2, keccak256("agent-probe-log.json"), "p95 612ms > 250ms SLA");
        vm.prank(jurorA);
        jury.voteOnDisputeWithWifBurn(did, true, 2_500e18);
        vm.prank(jurorB);
        jury.voteOnDisputeWithWifBurn(did, true, 1_500e18);
        vm.prank(jurorC);
        jury.voteOnDisputeWithWifBurn(did, true, 1_000e18);
        vm.prank(prime);
        jury.voteOnDisputeWithWifBurn(did, false, 1_000e18);
        vm.warp(vm.getBlockTimestamp() + VOTING);

        uint256 agentUsdg = usdg.balanceOf(agent);
        burned0 = vault.totalWifBurnedByParon();
        jury.resolveDispute(did);
        Dispute memory d = jury.getDispute(did);
        assertEq(uint8(d.status), uint8(DisputeStatus.ResolvedSlash));
        assertEq(d.slashVotes, _g("expect.slashVotes"));
        assertEq(d.upholdVotes, _g("expect.upholdVotes"));
        assertEq(usdg.balanceOf(agent) - agentUsdg, _g("expect.agentSlashRefund"));
        assertEq(vault.totalWifBurnedByParon() - burned0, _g("expect.slashBurnWif"));
        assertEq(d.rewardPoolUsdg, _g("expect.disputeRewardPoolUsdg"));
        assertEq(d.rewardPoolWif, _g("expect.disputeRewardPoolWif"));
        assertEq(vault.juryRewardPoolUsdg(), _g("expect.juryPoolAfter"));
        assertEq(uint8(desk.getRedemption(r2).state), uint8(RedemptionState.Slashed));

        _claim(did, jurorA, "expect.jurorAUsdg", "expect.jurorAWif");
        _claim(did, jurorB, "expect.jurorBUsdg", "expect.jurorBWif");
        _claim(did, jurorC, "expect.jurorCUsdg", "expect.jurorCWif");
        _claim(did, agent, "expect.agentJurorUsdg", "expect.agentJurorWif");

        // ---- Step 6: corridor election burn-vote; Batam-Singapore H200 wins the next margin boost ----
        vm.prank(jurorA);
        jury.voteForComputeCorridor(1, 3_000e18);
        vm.prank(jurorB);
        jury.voteForComputeCorridor(1, 2_000e18);
        vm.prank(agent);
        jury.voteForComputeCorridor(1, 1_500e18);
        vm.prank(marketMaker);
        jury.voteForComputeCorridor(0, 2_500e18);
        assertEq(jury.corridorVotes(0, 1), _g("expect.corridorBtmVotes"));
        assertEq(jury.corridorVotes(0, 0), _g("expect.corridorJktVotes"));
        vm.warp(T0 + EPOCH);
        assertEq(jury.finalizeCorridorEpoch(0), _g("expect.electedCorridor"));
        assertEq(desk.requiredMarginBpsFor(prime, seriesBtm), _g("expect.boostedMarginBps"));

        // ---- Flywheel telemetry ----
        assertEq(vault.totalWifStaked(), _g("expect.totalWifStaked"));
        assertEq(vault.totalWifBurnedByParon(), _g("expect.totalWifBurned"));
        assertEq(wif.totalBurned(), vault.totalWifBurnedByParon(), "every Paron burn is a real supply burn");
    }

    function _redeemAndDeliver(uint256 lotId, uint32 p95, uint16 uptime, string memory log)
        internal
        returns (uint256 rid)
    {
        vm.prank(agent);
        rid = desk.requestRedemption(seriesBtm, 25, lotId, keccak256("agent-ssh-pubkey"));
        vm.prank(prime);
        desk.acknowledgeRedemption(rid);
        bytes32 receipt = keccak256(bytes(log));
        bytes memory sig = _sign(primeTeeKey, desk.deliveryReceiptDigest(rid, receipt, p95, uptime));
        vm.prank(prime);
        desk.deliverWithReceipt(rid, receipt, p95, uptime, sig);
        Redemption memory r = desk.getRedemption(rid);
        assertEq(uint8(r.state), uint8(RedemptionState.Delivered));
    }

    function _claim(uint256 did, address voter, string memory usdgKey, string memory wifKey) internal {
        vm.prank(voter);
        (uint256 usdgOut, uint256 wifOut) = jury.claimVoterUpside(did);
        assertEq(usdgOut, _g(usdgKey), usdgKey);
        assertEq(wifOut, _g(wifKey), wifKey);
    }

    function _g(string memory key) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(golden, string.concat(".", key)));
    }
}
