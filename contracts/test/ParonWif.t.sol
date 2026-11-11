// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ParonWifBase} from "./ParonWifBase.sol";
import {ParonSeriesToken} from "../src/ParonSeriesToken.sol";
import {WifFlywheelVault} from "../src/WifFlywheelVault.sol";
import {WifSlaJury} from "../src/WifSlaJury.sol";
import {ParonExchangeDesk} from "../src/ParonExchangeDesk.sol";
import {WifTokenMock} from "../src/WifTokenMock.sol";
import {UsdgMock} from "../src/UsdgMock.sol";
import {
    Dispute, DisputeStatus, GpuTier, Lot, ProviderProfile, Redemption, RedemptionState, SeriesInfo, SeriesMarket
} from "../src/libraries/ParonWifTypes.sol";

/// @notice Paron WIF protocol test suite: hardware normalization, $WIF margin tiers, fee buy-and-burn,
///         CLOB matching, dual settlement, burn-to-vote SLA jury and corridor elections.
contract ParonWifTest is ParonWifBase {
    // ------------------------------------------------------------------
    // Standardized CU series
    // ------------------------------------------------------------------

    function test_HardwareWeightsConvertGpuHoursToCu() public view {
        assertEq(seriesToken.convertGpuHoursToCu(GpuTier.A100, 100e18), 45e18, "A100 = 0.45x");
        assertEq(seriesToken.convertGpuHoursToCu(GpuTier.H100, 100e18), 100e18, "H100 = 1.00x");
        assertEq(seriesToken.convertGpuHoursToCu(GpuTier.H200, 100e18), 140e18, "H200 = 1.40x");
        assertEq(seriesToken.convertGpuHoursToCu(GpuTier.B200, 100e18), 250e18, "B200 = 2.50x");
        assertEq(seriesToken.convertGpuHoursToCu(GpuTier.GB200, 100e18), 350e18, "GB200 = 3.50x");
        assertEq(seriesToken.convertGpuHoursToCu(GpuTier.A100, 40e18), 18e18, "40 A100 hours = 18 CU");
        assertEq(seriesToken.convertCuToGpuHours(GpuTier.H200, 35e18), 25e18, "35 CU = 25 H200 hours");
    }

    function test_CanonicalSeriesSymbolsAndDeliveryWindows() public view {
        SeriesInfo memory btm = seriesToken.getSeries(seriesBtm);
        assertEq(btm.symbol, "CU-BTM-H200-2611");
        assertEq(btm.deliveryStart, 1_793_491_200, "2026-11-01T00:00Z");
        assertEq(btm.deliveryEnd, 1_796_083_200, "2026-12-01T00:00Z");
        assertEq(seriesToken.getSeries(seriesJkt).symbol, "CU-JKT-H100-2611");
        SeriesInfo memory sgp = seriesToken.getSeries(seriesSgp);
        assertEq(sgp.symbol, "CU-SGP-B200-2612");
        assertEq(sgp.deliveryStart, 1_796_083_200);
        assertEq(sgp.deliveryEnd, 1_798_761_600, "2027-01-01T00:00Z");
    }

    function test_CanonicalSeriesCannotFragment() public {
        vm.expectRevert(abi.encodeWithSelector(ParonSeriesToken.SeriesExists.selector, seriesBtm));
        seriesToken.createSeries(1, GpuTier.H200, 2611);
        vm.expectRevert(abi.encodeWithSelector(ParonSeriesToken.InvalidDeliveryMonth.selector, uint16(2613)));
        seriesToken.createSeries(1, GpuTier.H200, 2613);
        vm.expectRevert(abi.encodeWithSelector(ParonSeriesToken.UnknownCorridor.selector, uint8(9)));
        seriesToken.createSeries(9, GpuTier.H200, 2701);
        // Anyone may list a new canonical series.
        vm.prank(makeAddr("anyone"));
        uint256 id = seriesToken.createSeries(2, GpuTier.B200, 2701);
        assertEq(seriesToken.getSeries(id).symbol, "CU-JHB-B200-2701");
    }

    // ------------------------------------------------------------------
    // Loop 2: $WIF-boosted margin
    // ------------------------------------------------------------------

    function test_MarginTier0RequiresFiftyPercent() public {
        address p = _provider("tier0", 0);
        assertEq(vault.getRequiredMarginBps(p), 5_000);
        uint256 before = usdg.balanceOf(p);
        uint256 lotId = _mint(p, seriesJkt, 100, 2_000_000);
        assertEq(before - usdg.balanceOf(p), 100_000_000, "50% of 100 CU x $2.00");
        assertEq(desk.getLot(lotId).marginLocked, 100_000_000);
    }

    function test_MarginTier1RequiresThirtyFivePercent() public {
        address p = _provider("tier1", 25_000e18);
        assertEq(vault.getProviderTier(p), 1);
        assertEq(vault.getRequiredMarginBps(p), 3_500);
        uint256 lotId = _mint(p, seriesJkt, 100, 2_000_000);
        assertEq(desk.getLot(lotId).marginLocked, 70_000_000, "35% margin");
    }

    function test_MarginTier2PrimeRequiresTwentyFivePercentForFourXEfficiency() public {
        address p = _provider("prime", 100_000e18);
        assertEq(vault.getProviderTier(p), 2);
        assertEq(vault.getRequiredMarginBps(p), 2_500);
        uint256 lotId = _mint(p, seriesJkt, 100, 2_000_000);
        Lot memory lot = desk.getLot(lotId);
        assertEq(lot.marginLocked, 50_000_000, "25% margin");
        assertEq((100 * 2_000_000) / lot.marginLocked, 4, "4x capital efficiency");
        // The legacy 150% cash bond would have locked $300 for the same $200 of compute: 6x more dead capital.
        assertEq((100 * 2_000_000 * 15_000) / 10_000 / lot.marginLocked, 6);
    }

    function test_PermissionlessProviderOnboardingWithoutKyb() public {
        address p = _actor("garage-gpu-farm", 0, 10_000e6);
        vm.prank(p);
        desk.registerProviderAndStakeWif("ipfs://garage", 0);
        ProviderProfile memory prof = desk.getProvider(p);
        assertTrue(prof.registered);
        uint256 lotId = _mint(p, seriesJkt, 10, 2_000_000);
        assertEq(desk.getLot(lotId).provider, p);

        address stranger = _actor("stranger", 0, 1_000e6);
        vm.prank(stranger);
        vm.expectRevert(ParonExchangeDesk.NotRegisteredProvider.selector);
        desk.mintPrimarySeries(seriesJkt, 1, 2_000_000);
    }

    function test_StakeLockBlocksUnstakeWhileTierLotIsOpen() public {
        address p = _provider("locked", 100_000e18);
        _mint(p, seriesJkt, 50, 2_000_000);
        assertEq(vault.stakeLock(p), 100_000e18);
        vm.prank(p);
        vm.expectRevert(abi.encodeWithSelector(WifFlywheelVault.StakeLocked.selector, 100_000e18));
        vault.unstakeWif(1e18);
        // Cancelling the unsold primary ask closes the lot and releases the lock and all margin.
        uint256 orderId = desk.getLot(1).askOrderId;
        vm.prank(p);
        desk.cancelOrder(orderId);
        assertEq(vault.stakeLock(p), 0);
        assertEq(desk.providerClaimableUsdg(p), 25_000_000);
        vm.prank(p);
        vault.unstakeWif(100_000e18);
        assertEq(vault.stakedWif(p), 0);
    }

    // ------------------------------------------------------------------
    // Loop 1: fees, discount and buy-and-burn
    // ------------------------------------------------------------------

    function test_StandardFeeThirtyBpsBurnsWifThroughBuyback() public {
        address p = _provider("fee-provider", 100_000e18);
        _mint(p, seriesJkt, 100, 2_000_000);
        address buyer = _actor("usdg-only-buyer", 0, 1_000e6);
        uint256 supplyBefore = wif.totalSupply();
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        uint256 juryBefore = vault.juryRewardPoolUsdg();

        _buy(buyer, seriesJkt, 10, 2_000_000, false);

        // fee = 30 bps of $20 = $0.06 -> 50% burn ($0.03 -> 60 WIF), 30% jury, 20% stakers
        assertEq(vault.totalFeesUsdg(), 60_000);
        assertEq(vault.totalWifBurnedByParon(), 60e18);
        assertEq(supplyBefore - wif.totalSupply(), 60e18, "burn reduces total supply");
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, 30_000, "buyback paid at reference price");
        assertEq(vault.juryRewardPoolUsdg() - juryBefore, 18_000);
        assertEq(vault.earnedRebate(p), 12_000, "sole staker earns the 20% rebate leg");
        assertEq(usdg.balanceOf(buyer), 1_000e6 - 20_000_000 - 60_000);
    }

    function test_WifDiscountTenBpsBurnsBuyersOwnWif() public {
        address p = _provider("disc-provider", 100_000e18);
        _mint(p, seriesJkt, 100, 2_000_000);
        address buyer = _actor("wif-holder", 20_000e18, 1_000e6);
        assertTrue(vault.hasWifFeeDiscount(buyer));
        uint256 reserveBefore = vault.buybackReserveWif();

        (,, uint256 quotedFee, uint256 quotedBurn) = desk.quoteBuy(seriesJkt, 10, 2_000_000, true);
        _buy(buyer, seriesJkt, 10, 2_000_000, true);

        // fee = 10 bps of $20 = $0.02; burn leg $0.01 paid in WIF = 20 WIF, burned from the buyer
        assertEq(quotedFee, 20_000);
        assertEq(quotedBurn, 20e18);
        assertEq(wif.balanceOf(buyer), 20_000e18 - 20e18);
        assertEq(usdg.balanceOf(buyer), 1_000e6 - 20_000_000 - 10_000);
        assertEq(vault.totalWifBurnedByParon(), 20e18);
        assertEq(vault.buybackReserveWif(), reserveBefore, "discount mode burns the buyer's WIF, not the reserve");
    }

    function test_WifDiscountRequiresTenThousandWif() public {
        address p = _provider("gate-provider", 0);
        _mint(p, seriesJkt, 100, 2_000_000);
        address buyer = _actor("almost", 9_999e18, 1_000e6);
        vm.prank(buyer);
        vm.expectRevert(ParonExchangeDesk.NotWifDiscountEligible.selector);
        desk.buySeriesOrPlaceBid(seriesJkt, 1, 2_000_000, true, MAX);
        // Staking counts towards the threshold too.
        _fund(buyer, 1e18, 0);
        vm.prank(buyer);
        vault.stakeWifForMarginBoost(5_000e18);
        assertTrue(vault.hasWifFeeDiscount(buyer));
    }

    function test_BurnCounterIncrementsOnEveryTrade() public {
        address p = _provider("counter-provider", 100_000e18);
        _mint(p, seriesJkt, 300, 2_000_000);
        address buyer = _actor("counter-buyer", 50_000e18, 5_000e6);
        uint256 last;
        for (uint256 i; i < 3; ++i) {
            _buy(buyer, seriesJkt, 10, 2_000_000, i % 2 == 0);
            uint256 burned = vault.totalWifBurnedByParon();
            assertGt(burned, last, "every trade burns WIF");
            last = burned;
        }
        assertEq(vault.burnCount(), 3);
        assertEq(wif.totalBurned(), vault.totalWifBurnedByParon());
    }

    function test_ProviderRebatesStreamToWifStakersProRata() public {
        address a = _provider("staker-a", 100_000e18);
        address b = _provider("staker-b", 300_000e18);
        _mint(a, seriesJkt, 500, 2_000_000);
        address buyer = _actor("rebate-buyer", 0, 2_000e6);
        _buy(buyer, seriesJkt, 500, 2_000_000, false);
        // fee $3.00 -> provider leg $0.60 split 1:3
        assertEq(vault.earnedRebate(a), 150_000);
        assertEq(vault.earnedRebate(b), 450_000);
        vm.prank(b);
        assertEq(vault.claimProviderRebate(), 450_000);
        assertEq(vault.earnedRebate(b), 0);
    }

    function test_SellWifIntoFeeFundedBuybackBurnsIt() public {
        address p = _provider("whale-provider", 100_000e18);
        _fund(p, 0, 300_000e6);
        _mint(p, seriesJkt, 500_000, 2_000_000);
        address buyer = _actor("whale-buyer", 0, 1_100_000e6);
        _buy(buyer, seriesJkt, 500_000, 2_000_000, false);
        // burn leg $1,500 wants 3M WIF but the reserve holds 2M: reserve fully burned, $500 queued
        assertEq(vault.buybackReserveWif(), 0);
        assertEq(vault.buybackUsdgPool(), 500e6);

        address seller = _actor("wif-seller", 100_000e18, 0);
        vm.prank(seller);
        uint256 out = vault.sellWifToBuyback(100_000e18, 49e6);
        assertEq(out, 49_500_000, "reference price minus 1% haircut");
        assertEq(usdg.balanceOf(seller), 49_500_000);
        assertEq(vault.buybackUsdgPool(), 450_500_000);

        uint256 burnedBefore = vault.totalWifBurnedByParon();
        vm.prank(treasury);
        vault.fundBuybackReserve(1_000_000e18);
        assertEq(vault.totalWifBurnedByParon() - burnedBefore, 901_000e18, "refill flushes the queued buyback");
        assertEq(vault.buybackUsdgPool(), 0);
    }

    // ------------------------------------------------------------------
    // CLOB
    // ------------------------------------------------------------------

    function test_ClobPriceTimePriorityAndPartialFills() public {
        address a = _provider("ask-210", 0);
        address b = _provider("ask-205-first", 0);
        address c = _provider("ask-205-second", 0);
        uint256 lotA = _mint(a, seriesJkt, 10, 2_100_000);
        uint256 lotB = _mint(b, seriesJkt, 10, 2_050_000);
        vm.warp(block.timestamp + 1);
        uint256 lotC = _mint(c, seriesJkt, 10, 2_050_000);
        address buyer = _actor("clob-buyer", 0, 1_000e6);

        (uint256 filled, uint256 restingId) = _buy(buyer, seriesJkt, 15, 2_100_000, false);
        assertEq(filled, 15);
        assertEq(restingId, 0);
        assertEq(desk.getLot(lotB).cuUnsold, 0, "best price first");
        assertEq(desk.getLot(lotC).cuUnsold, 5, "then time priority at the same price");
        assertEq(desk.getLot(lotA).cuUnsold, 10, "worse price untouched");
        assertEq(seriesToken.balanceOf(buyer, seriesJkt), 15);

        (uint256[] memory prices, uint256[] memory qtys) = desk.getBookSide(seriesJkt, false, 5);
        assertEq(prices[0], 2_050_000);
        assertEq(qtys[0], 5);
        assertEq(prices[1], 2_100_000);
    }

    function test_WifPriorityLaneFillsBeforeStandardLane() public {
        address p = _provider("lane-provider", 0);
        _mint(p, seriesJkt, 10, 2_000_000);
        address plain = _actor("plain-maker", 0, 1_000e6);
        address holder = _actor("wif-maker", 15_000e18, 1_000e6);
        _buy(plain, seriesJkt, 5, 2_000_000, false);
        _buy(holder, seriesJkt, 5, 2_000_000, false);

        vm.prank(plain);
        (, uint256 plainAsk) = desk.placeAsk(seriesJkt, 5, 2_500_000);
        vm.warp(block.timestamp + 60);
        vm.prank(holder);
        (, uint256 holderAsk) = desk.placeAsk(seriesJkt, 5, 2_500_000);
        assertEq(desk.getOrder(plainAsk).lane, 1);
        assertEq(desk.getOrder(holderAsk).lane, 0);

        address buyer = _actor("lane-buyer", 0, 1_000e6);
        _buy(buyer, seriesJkt, 5, 2_500_000, false);
        assertEq(desk.getOrder(holderAsk).qtyRemaining, 0, "WIF priority lane filled first");
        assertEq(desk.getOrder(plainAsk).qtyRemaining, 5);
        assertEq(usdg.balanceOf(holder), 1_000e6 - 10_000_000 - 30_000 + 12_500_000);
    }

    function test_RestingBidFilledBySecondaryAskChargesBidderFee() public {
        address p = _provider("bid-provider", 0);
        _mint(p, seriesJkt, 10, 2_000_000);
        address seller = _actor("cu-seller", 0, 1_000e6);
        _buy(seller, seriesJkt, 10, 2_000_000, false);

        address bidder = _actor("discount-bidder", 20_000e18, 1_000e6);
        (uint256 filled, uint256 bidId) = _buy(bidder, seriesJkt, 10, 1_900_000, true);
        assertEq(filled, 0);
        assertEq(desk.getOrder(bidId).escrowUsdg, 19_000_000 + 57_000, "escrow covers the max 30 bps fee");

        uint256 sellerBefore = usdg.balanceOf(seller);
        vm.prank(seller);
        (uint256 sold,) = desk.placeAsk(seriesJkt, 10, 1_900_000);
        assertEq(sold, 10);
        assertEq(usdg.balanceOf(seller) - sellerBefore, 19_000_000, "seller receives the full trade price");
        assertEq(usdg.balanceOf(bidder), 1_000e6 - 19_000_000 - 19_000, "bidder paid 10 bps, rest refunded");
        assertEq(seriesToken.balanceOf(bidder, seriesJkt), 10);
        (uint256 bestBid,,,,,,,) = _market(seriesJkt);
        assertEq(bestBid, 0);
    }

    function test_CancelOrdersRefundEscrowCuAndPrimaryMargin() public {
        address p = _provider("cancel-provider", 0);
        uint256 lotId = _mint(p, seriesJkt, 10, 2_000_000);
        address trader = _actor("cancel-trader", 0, 1_000e6);
        _buy(trader, seriesJkt, 4, 2_000_000, false);

        (, uint256 bidId) = _buy(trader, seriesJkt, 5, 1_500_000, false);
        uint256 beforeBid = usdg.balanceOf(trader);
        vm.prank(trader);
        desk.cancelOrder(bidId);
        assertEq(usdg.balanceOf(trader) - beforeBid, 7_500_000 + 22_500);

        vm.prank(trader);
        (, uint256 askId) = desk.placeAsk(seriesJkt, 4, 2_900_000);
        assertEq(seriesToken.balanceOf(trader, seriesJkt), 0);
        vm.prank(trader);
        desk.cancelOrder(askId);
        assertEq(seriesToken.balanceOf(trader, seriesJkt), 4);

        uint256 primaryAsk = desk.getLot(lotId).askOrderId;
        vm.prank(p);
        desk.cancelOrder(primaryAsk);
        Lot memory lot = desk.getLot(lotId);
        assertEq(lot.cuUnsold, 0);
        assertEq(lot.marginLocked, 4_000_000, "margin for the 4 sold CU stays locked");
        assertEq(desk.providerClaimableUsdg(p), 6_000_000);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ParonExchangeDesk.OrderNotActive.selector, primaryAsk));
        desk.cancelOrder(primaryAsk);
    }

    // ------------------------------------------------------------------
    // Mode A: cash settlement at CRI-H100
    // ------------------------------------------------------------------

    function test_CashSettlementAtIndexPaysHedgePnl() public {
        address p = _provider("mode-a-provider", 100_000e18);
        uint256 lotId = _mint(p, seriesJkt, 100, 2_000_000);
        address agent = _actor("hedging-agent", 0, 1_000e6);
        _buy(agent, seriesJkt, 20, 2_000_000, false);

        vm.warp(block.timestamp + CRI_MIN_INTERVAL);
        vm.prank(attestor);
        criOracle.submit(2_400_000, keccak256("CRI spike +9%")); // within the +-10% step
        assertEq(desk.criH100Usdg(), 2_400_000);
        vm.prank(agent);
        uint256 payout = desk.settleCashAtIndex(seriesJkt, 10);
        // collateral $20 principal + $5 margin; index value $24; 30 bps fee
        assertEq(payout, 24_000_000 - 72_000);
        assertEq(desk.providerClaimableUsdg(p), 1_000_000, "provider keeps collateral above the index value");
        assertEq(seriesToken.balanceOf(agent, seriesJkt), 10);

        vm.warp(block.timestamp + CRI_MIN_INTERVAL);
        vm.prank(attestor);
        criOracle.submit(3_000_000, keccak256("CRI spike +25%"));
        assertEq(desk.criH100Usdg(), 2_640_000, "a +25% report is clamped to one +10% step");
        vm.prank(agent);
        payout = desk.settleCashAtIndex(seriesJkt, 10);
        assertEq(payout, 25_000_000 - 75_000, "payout capped at principal + margin");
        assertEq(desk.getLot(lotId).cuOutstanding, 0);
    }

    function test_CashSettlementRejectsStaleIndex() public {
        address p = _provider("stale-provider", 0);
        _mint(p, seriesJkt, 10, 2_000_000);
        address agent = _actor("stale-agent", 0, 100e6);
        _buy(agent, seriesJkt, 5, 2_000_000, false);
        vm.warp(block.timestamp + MAX_INDEX_AGE + 1);
        vm.prank(agent);
        vm.expectRevert(ParonExchangeDesk.StaleIndex.selector);
        desk.settleCashAtIndex(seriesJkt, 5);
    }

    // ------------------------------------------------------------------
    // Mode B: direct compute redemption
    // ------------------------------------------------------------------

    function test_ModeBHappyPathWithSignedExecutionReceipt() public {
        (address p, uint256 lotId, address holder, uint256 signerPk) = _deliverySetup();
        vm.prank(holder);
        uint256 rid = desk.requestRedemption(seriesBtm, 20, lotId, keccak256("ssh-key:holder"));
        vm.prank(p);
        desk.acknowledgeRedemption(rid);
        bytes32 receipt = keccak256("job-log: 20 CU on 8x H200, p95 138ms");
        bytes memory sig = _sign(signerPk, desk.deliveryReceiptDigest(rid, receipt, 138, 9_998));
        vm.prank(p);
        desk.deliverWithReceipt(rid, receipt, 138, 9_998, sig);
        assertEq(uint8(desk.getRedemption(rid).state), uint8(RedemptionState.Delivered));

        vm.prank(holder);
        desk.confirmDelivery(rid);
        Redemption memory r = desk.getRedemption(rid);
        assertEq(uint8(r.state), uint8(RedemptionState.Finalized));
        assertEq(desk.providerClaimableUsdg(p), r.principalUsdg + r.marginUsdg);
        assertEq(r.principalUsdg, 40_000_000);
        assertEq(r.marginUsdg, 10_000_000);
        assertEq(desk.getProvider(p).deliveredCu, 20);
        assertEq(seriesToken.totalSupply(seriesBtm), 80, "redeemed CU are burned");
        vm.prank(p);
        assertEq(desk.withdrawProviderBalance(), 50_000_000);
    }

    function test_DeliveryRejectsForgedAttestation() public {
        (address p, uint256 lotId, address holder,) = _deliverySetup();
        vm.prank(holder);
        uint256 rid = desk.requestRedemption(seriesBtm, 5, lotId, bytes32(0));
        vm.prank(p);
        desk.acknowledgeRedemption(rid);
        (, uint256 wrongPk) = makeAddrAndKey("impostor");
        bytes32 receipt = keccak256("forged");
        bytes memory sig = _sign(wrongPk, desk.deliveryReceiptDigest(rid, receipt, 100, 10_000));
        vm.prank(p);
        vm.expectRevert(ParonExchangeDesk.InvalidAttestation.selector);
        desk.deliverWithReceipt(rid, receipt, 100, 10_000, sig);
    }

    function test_MissedDeadlineSlashesInstantlyWithoutVote() public {
        (address p, uint256 lotId, address holder,) = _deliverySetup();
        vm.prank(holder);
        uint256 rid = desk.requestRedemption(seriesBtm, 10, lotId, bytes32(0));
        vm.expectRevert(ParonExchangeDesk.DeadlineNotPassed.selector);
        desk.claimMissedDeadline(rid);
        vm.warp(block.timestamp + ACK + 1);
        uint256 before = usdg.balanceOf(holder);
        uint256 juryBefore = vault.juryRewardPoolUsdg();
        vm.prank(makeAddr("keeper"));
        desk.claimMissedDeadline(rid);
        // principal $20 + 15% ($3) from margin $5; remaining $2 -> 25% burn, 75% vault jury pool
        assertEq(usdg.balanceOf(holder) - before, 23_000_000);
        assertEq(vault.juryRewardPoolUsdg() - juryBefore, 1_500_000);
        assertEq(desk.getProvider(p).slashedCu, 10);
        assertEq(uint8(desk.getRedemption(rid).state), uint8(RedemptionState.Slashed));
    }

    // ------------------------------------------------------------------
    // Loop 3: burn-to-vote SLA jury
    // ------------------------------------------------------------------

    function test_OpenSlaDisputeBurnsFilingWif() public {
        (uint256 rid, address holder,) = _deliveredBreach();
        uint256 wifBefore = wif.balanceOf(holder);
        vm.prank(holder);
        uint256 did = jury.openSlaDispute(rid, keccak256("probe-log.json"), "p95 latency 612ms > 250ms SLA");
        assertEq(wifBefore - wif.balanceOf(holder), 100e18);
        Dispute memory d = jury.getDispute(did);
        assertEq(d.slashVotes, 100e18, "filing burn counts as SLASH votes");
        assertEq(uint8(d.status), uint8(DisputeStatus.Open));
        assertEq(uint8(desk.getRedemption(rid).state), uint8(RedemptionState.Disputed));
        vm.prank(makeAddr("not-holder"));
        vm.expectRevert(WifSlaJury.NotRedemptionHolder.selector);
        jury.openSlaDispute(rid, keccak256("x"), "x");
    }

    function test_BurnToVotePermanentlyReducesWifSupply() public {
        (uint256 rid, address holder,) = _deliveredBreach();
        vm.prank(holder);
        uint256 did = jury.openSlaDispute(rid, keccak256("probe"), "latency");
        address juror = _actor("juror", 5_000e18, 0);
        uint256 supplyBefore = wif.totalSupply();
        vm.prank(juror);
        jury.voteOnDisputeWithWifBurn(did, true, 1_000e18);
        assertEq(supplyBefore - wif.totalSupply(), 1_000e18);
        assertEq(jury.getDispute(did).slashVotes, 1_100e18);
        assertEq(jury.slashWeightOf(did, juror), 1_000e18);
        vm.prank(juror);
        vm.expectRevert(WifSlaJury.CannotVoteBothSides.selector);
        jury.voteOnDisputeWithWifBurn(did, false, 1e18);
        uint64 endsAt = jury.getDispute(did).votingEndsAt;
        vm.warp(block.timestamp + VOTING);
        vm.prank(juror);
        vm.expectRevert(abi.encodeWithSelector(WifSlaJury.VotingClosed.selector, endsAt));
        jury.voteOnDisputeWithWifBurn(did, true, 1e18);
    }

    function test_SlashDefaultingProviderAndClaimVoterUpside() public {
        (uint256 rid, address holder, address p) = _deliveredBreach();
        Redemption memory r = desk.getRedemption(rid);
        vm.prank(holder);
        uint256 did = jury.openSlaDispute(rid, keccak256("probe"), "latency");
        address j1 = _actor("juror-1", 10_000e18, 0);
        address j2 = _actor("juror-2", 10_000e18, 0);
        vm.prank(j1);
        jury.voteOnDisputeWithWifBurn(did, true, 3_000e18);
        vm.prank(j2);
        jury.voteOnDisputeWithWifBurn(did, true, 900e18);
        vm.prank(p);
        jury.voteOnDisputeWithWifBurn(did, false, 1_000e18);

        vm.expectRevert(abi.encodeWithSelector(WifSlaJury.VotingStillOpen.selector, jury.getDispute(did).votingEndsAt));
        jury.resolveDispute(did);
        vm.warp(block.timestamp + VOTING);
        uint256 holderBefore = usdg.balanceOf(holder);
        uint256 poolBefore = vault.juryRewardPoolUsdg();
        jury.resolveDispute(did);

        uint256 comp = (r.principalUsdg * 1_500) / 10_000;
        uint256 remainder = r.marginUsdg - comp;
        assertEq(usdg.balanceOf(holder) - holderBefore, r.principalUsdg + comp, "100% principal + 15% SLA comp");
        Dispute memory d = jury.getDispute(did);
        assertEq(uint8(d.status), uint8(DisputeStatus.ResolvedSlash));
        uint256 vaultShare = remainder - remainder / 2 - remainder / 4;
        uint256 draw = ((poolBefore + vaultShare) * 2_000) / 10_000;
        if (draw > r.marginUsdg) draw = r.marginUsdg;
        assertEq(d.rewardPoolUsdg, remainder / 2 + draw, "50% of remaining margin + 20% of the vault jury pool (capped)");
        assertEq(d.rewardPoolWif, (4_000e18 * 1_000) / 10_000, "10% bonus WIF");
        assertEq(uint8(desk.getRedemption(rid).state), uint8(RedemptionState.Slashed));

        vm.prank(j1);
        (uint256 usdgOut, uint256 wifOut) = jury.claimVoterUpside(did);
        assertEq(usdgOut, (d.rewardPoolUsdg * 3_000e18) / 4_000e18);
        assertEq(wifOut, 300e18);
        assertEq(usdg.balanceOf(j1), usdgOut);
        vm.prank(j1);
        vm.expectRevert(WifSlaJury.AlreadyClaimed.selector);
        jury.claimVoterUpside(did);
        vm.prank(p);
        vm.expectRevert(WifSlaJury.NotWinningVoter.selector);
        jury.claimVoterUpside(did);
    }

    function test_UpholdOutcomeReleasesEscrowToProvider() public {
        (uint256 rid, address holder, address p) = _deliveredBreach();
        Redemption memory r = desk.getRedemption(rid);
        vm.prank(holder);
        uint256 did = jury.openSlaDispute(rid, keccak256("weak evidence"), "latency");
        vm.prank(p);
        jury.voteOnDisputeWithWifBurn(did, false, 2_000e18);
        vm.warp(block.timestamp + VOTING);
        jury.resolveDispute(did);
        assertEq(uint8(jury.getDispute(did).status), uint8(DisputeStatus.ResolvedUphold));
        assertEq(desk.providerClaimableUsdg(p), r.principalUsdg + r.marginUsdg);
        vm.prank(p);
        (uint256 usdgOut, uint256 wifOut) = jury.claimVoterUpside(did);
        assertGt(usdgOut, 0, "upholders share the vault jury pool draw");
        assertEq(wifOut, 200e18);
        vm.prank(holder);
        vm.expectRevert(WifSlaJury.NotWinningVoter.selector);
        jury.claimVoterUpside(did);
    }

    // ------------------------------------------------------------------
    // Loop 3b: corridor election
    // ------------------------------------------------------------------

    function test_CorridorElectionBurnsWifAndBoostsWinnerMargin() public {
        address v1 = _actor("voter-1", 10_000e18, 0);
        address v2 = _actor("voter-2", 10_000e18, 0);
        uint256 supplyBefore = wif.totalSupply();
        vm.prank(v1);
        jury.voteForComputeCorridor(1, 4_000e18);
        vm.prank(v2);
        jury.voteForComputeCorridor(0, 2_500e18);
        assertEq(supplyBefore - wif.totalSupply(), 6_500e18);
        uint256[] memory tally = jury.getCorridorTally(0);
        assertEq(tally[1], 4_000e18);
        assertEq(tally[0], 2_500e18);

        vm.expectRevert(abi.encodeWithSelector(WifSlaJury.EpochNotEnded.selector, 0));
        jury.finalizeCorridorEpoch(0);
        vm.warp(T0 + EPOCH);
        assertEq(jury.finalizeCorridorEpoch(0), 1);
        (bool active, uint8 corridor) = jury.currentBoostedCorridor();
        assertTrue(active);
        assertEq(corridor, 1);

        address p = _provider("boosted-provider", 100_000e18);
        assertEq(desk.requiredMarginBpsFor(p, seriesBtm), 2_250, "elected corridor: 25% -> 22.5%");
        assertEq(desk.requiredMarginBpsFor(p, seriesJkt), 2_500);
    }

    // ------------------------------------------------------------------
    // Faucets
    // ------------------------------------------------------------------

    function test_TestnetFaucetsAndCooldown() public {
        address judge = makeAddr("judge");
        vm.startPrank(judge);
        wif.faucet();
        usdg.faucet();
        assertEq(wif.balanceOf(judge), 50_000e18);
        assertEq(usdg.balanceOf(judge), 10_000e6);
        vm.expectRevert(abi.encodeWithSelector(WifTokenMock.FaucetCooldown.selector, block.timestamp + 1 hours));
        wif.faucet();
        vm.expectRevert(abi.encodeWithSelector(UsdgMock.FaucetCooldown.selector, block.timestamp + 1 hours));
        usdg.faucet();
        vm.warp(block.timestamp + 1 hours);
        wif.faucet();
        vm.stopPrank();
        assertEq(wif.balanceOf(judge), 100_000e18);
    }

    // ------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------

    function testFuzz_FeeRoutingConservesUsdg(uint32 qty, uint8 priceTicks, bool wifMode) public {
        uint256 cu = bound(qty, 10, 5_000);
        uint256 price = bound(priceTicks, 1, 255) * 10_000 + 1_000_000;
        address p = _provider("fuzz-provider", 100_000e18);
        _fund(p, 0, 10_000e6);
        _mint(p, seriesJkt, cu, price);
        address buyer = _actor("fuzz-buyer", 50_000e18, 20_000e6);

        uint256 usdgSystemBefore = usdg.balanceOf(buyer) + usdg.balanceOf(address(desk))
            + usdg.balanceOf(address(vault)) + usdg.balanceOf(treasury);
        _buy(buyer, seriesJkt, cu, price, wifMode);
        uint256 usdgSystemAfter = usdg.balanceOf(buyer) + usdg.balanceOf(address(desk))
            + usdg.balanceOf(address(vault)) + usdg.balanceOf(treasury);
        assertEq(usdgSystemAfter, usdgSystemBefore, "USDG is conserved across buyer, desk, vault, treasury");
        uint256 fee = (cu * price * (wifMode ? 10 : 30)) / 10_000;
        assertEq(vault.totalFeesUsdg(), fee);
        assertEq(desk.getLot(1).escrowUsdg, cu * price, "full principal escrowed for the buyer");
        assertEq(wif.totalBurned(), vault.totalWifBurnedByParon());
    }

    function testFuzz_HardwareConversionRoundTrip(uint128 hoursScaled, uint8 tierIndex) public view {
        GpuTier tier = GpuTier(bound(tierIndex, 0, 4));
        uint256 cu = seriesToken.convertGpuHoursToCu(tier, hoursScaled);
        uint256 back = seriesToken.convertCuToGpuHours(tier, cu);
        assertLe(back, hoursScaled);
        assertLe(hoursScaled - back, 3, "round trip loses at most rounding dust");
    }

    // ------------------------------------------------------------------
    // Scenario helpers
    // ------------------------------------------------------------------

    function _market(uint256 seriesId)
        internal
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
    {
        SeriesMarket memory m = desk.getSeriesMarket(seriesId);
        return (
            m.bestBid, m.bestAsk, m.lastTradePrice, m.volumeCu, m.volumeUsdg, m.tradeCount, m.openInterestCu, m.unsoldCu
        );
    }

    /// @dev Tier-2 provider with a hardware attestation key, 100 CU of BTM-H200 at $2.00, a holder with 40 CU.
    function _deliverySetup() internal returns (address p, uint256 lotId, address holder, uint256 signerPk) {
        p = _provider("delivery-provider", 100_000e18);
        address signer;
        (signer, signerPk) = makeAddrAndKey("tee-attestation-key");
        vm.prank(p);
        desk.setAttestationSigner(signer);
        lotId = _mint(p, seriesBtm, 100, 2_000_000);
        holder = _actor("delivery-holder", 20_000e18, 1_000e6);
        _buy(holder, seriesBtm, 40, 2_000_000, true);
    }

    /// @dev A 20 CU redemption delivered with a receipt that breaches the 250 ms p95 SLA.
    function _deliveredBreach() internal returns (uint256 rid, address holder, address p) {
        uint256 lotId;
        uint256 signerPk;
        (p, lotId, holder, signerPk) = _deliverySetup();
        vm.prank(holder);
        rid = desk.requestRedemption(seriesBtm, 20, lotId, keccak256("ssh"));
        vm.prank(p);
        desk.acknowledgeRedemption(rid);
        bytes32 receipt = keccak256("job-log: degraded fabric");
        bytes memory sig = _sign(signerPk, desk.deliveryReceiptDigest(rid, receipt, 612, 9_780));
        vm.prank(p);
        desk.deliverWithReceipt(rid, receipt, 612, 9_780, sig);
    }
}
