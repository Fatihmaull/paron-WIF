// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ParonWifBase} from "./ParonWifBase.sol";
import {ParonExchangeDesk} from "../src/ParonExchangeDesk.sol";
import {ParonClobLib} from "../src/libraries/ParonClobLib.sol";
import {Order} from "../src/libraries/ParonWifTypes.sol";

/// @notice Order-book griefing resistance: minimum notional, per-maker order cap, worst-level eviction.
contract ParonWifClobTest is ParonWifBase {
    uint256 internal constant MIN = 5_000_000;

    function _stockedProvider(string memory name, uint256 cu, uint256 price) internal returns (address p) {
        p = _provider(name, 100_000e18);
        _fund(p, 0, 100_000e6);
        _mint(p, seriesJkt, cu, price);
    }

    function test_PrimaryMintBelowMinimumNotionalReverts() public {
        address p = _provider("dust-provider", 0);
        vm.prank(p);
        vm.expectRevert(abi.encodeWithSelector(ParonExchangeDesk.OrderTooSmall.selector, 4_000_000, MIN));
        desk.mintPrimarySeries(seriesJkt, 2, 2_000_000);
        vm.prank(p);
        desk.mintPrimarySeries(seriesJkt, 3, 2_000_000); // $6 is enough
    }

    function test_DustBidThatFillsNothingReverts() public {
        address buyer = _actor("dust-buyer", 0, 100e6);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ParonExchangeDesk.OrderTooSmall.selector, 2_000_000, MIN));
        desk.buySeriesOrPlaceBid(seriesJkt, 2, 1_000_000, false);
    }

    function test_DustRemainderOfABidNeverRests() public {
        _stockedProvider("fill-provider", 10, 2_000_000);
        address buyer = _actor("remainder-buyer", 0, 100e6);
        // 11 CU wanted, 10 fill, the 1 CU remainder ($2) is below $5: it does not rest and nothing extra is escrowed.
        uint256 before = usdg.balanceOf(buyer);
        (uint256 filled, uint256 orderId) = _buy(buyer, seriesJkt, 11, 2_000_000, false);
        assertEq(filled, 10);
        assertEq(orderId, 0);
        assertEq(before - usdg.balanceOf(buyer), 20_000_000 + 60_000, "only the filled part and its fee are paid");
    }

    function test_DustRemainderOfAnAskGoesBackToTheSeller() public {
        _stockedProvider("ask-provider", 10, 2_000_000);
        address seller = _actor("ask-seller", 0, 100e6);
        _buy(seller, seriesJkt, 10, 2_000_000, false);
        address bidder = _actor("ask-bidder", 0, 100e6);
        _buy(bidder, seriesJkt, 4, 1_900_000, false); // 4 CU @ 1.90 = $7.60 rests
        // Sell 5: 4 fill against the bid, the 1 CU remainder ($2.10) is dust and returns to the seller.
        vm.prank(seller);
        (uint256 filled, uint256 orderId) = desk.placeAsk(seriesJkt, 5, 1_900_000);
        assertEq(filled, 4);
        assertEq(orderId, 0);
        assertEq(seriesToken.balanceOf(seller, seriesJkt), 6, "5 sold-or-returned: 10 - 4 filled");
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ParonExchangeDesk.OrderTooSmall.selector, 1_900_000, MIN));
        desk.placeAsk(seriesJkt, 1, 1_900_000);
    }

    function test_MakerCannotHoldMoreThanEightOrdersPerSide() public {
        address p = _provider("cap-provider", 100_000e18);
        _fund(p, 0, 100_000e6);
        for (uint256 i; i < 8; ++i) {
            _mint(p, seriesJkt, 10, 2_000_000 + i * 10_000);
        }
        vm.prank(p);
        vm.expectRevert(abi.encodeWithSelector(ParonClobLib.TooManyOrders.selector, p, 8));
        desk.mintPrimarySeries(seriesJkt, 10, 2_090_000);
        // Cancelling frees a slot.
        uint256 orderId = desk.getLot(1).askOrderId;
        vm.prank(p);
        desk.cancelOrder(orderId);
        _mint(p, seriesJkt, 10, 2_090_000); // the freed slot can be reused
    }

    function test_FilledOrdersFreeTheirSlot() public {
        address p = _provider("slot-provider", 0);
        _fund(p, 0, 10_000e6);
        for (uint256 i; i < 8; ++i) {
            _mint(p, seriesJkt, 10, 2_000_000 + i * 10_000);
        }
        address buyer = _actor("slot-buyer", 0, 100e6);
        _buy(buyer, seriesJkt, 10, 2_000_000, false); // fully fills the best ask and frees its slot
        _mint(p, seriesJkt, 10, 2_100_000);
    }

    // ------------------------------------------------------------------
    // Level-flooding attack and eviction
    // ------------------------------------------------------------------

    /// @dev Three funded wallets (the minimum the per-maker cap allows) fill all 24 bid levels, $1.00 - $1.23.
    function _floodBids() internal returns (address[3] memory attackers) {
        for (uint256 w; w < 3; ++w) {
            attackers[w] = _actor(string.concat("attacker-", vm.toString(w)), 0, 1_000e6);
            for (uint256 i; i < 8; ++i) {
                _buy(attackers[w], seriesJkt, 5, 1_000_000 + (w * 8 + i) * 10_000, false);
            }
        }
        (uint256[] memory prices,) = desk.getBookSide(seriesJkt, true, 30);
        assertEq(prices.length, 24, "all 24 levels are taken");
    }

    function test_AttackerCannotLockOutABetterBid() public {
        address[3] memory attackers = _floodBids();
        uint256 before = usdg.balanceOf(attackers[0]);
        address honest = _actor("honest-bidder", 0, 1_000e6);
        (, uint256 orderId) = _buy(honest, seriesJkt, 10, 1_300_000, false);
        assertGt(orderId, 0, "a strictly better bid evicts the worst level instead of reverting");

        (uint256[] memory prices,) = desk.getBookSide(seriesJkt, true, 30);
        assertEq(prices.length, 24);
        assertEq(prices[0], 1_300_000, "the honest bid is now the best price");
        assertEq(prices[23], 1_010_000, "the $1.00 level was evicted");
        assertEq(usdg.balanceOf(attackers[0]) - before, 5_000_000 + 15_000, "evicted escrow (5 CU + 30 bps) is refunded");
        assertFalse(desk.getOrder(1).active);
    }

    function test_NotBetterThanTheWorstLevelStillReverts() public {
        _floodBids();
        address late = _actor("late-bidder", 0, 1_000e6);
        vm.prank(late);
        vm.expectRevert(ParonClobLib.TooManyLevels.selector);
        desk.buySeriesOrPlaceBid(seriesJkt, 10, 900_000, false);
        vm.prank(late);
        vm.expectRevert(ParonClobLib.TooManyLevels.selector);
        desk.buySeriesOrPlaceBid(seriesJkt, 10, 990_000, false); // one tick below the worst level
    }

    function test_JoiningAnExistingLevelWorksWhileFull() public {
        _floodBids();
        address honest = _actor("joiner", 0, 1_000e6);
        (, uint256 orderId) = _buy(honest, seriesJkt, 10, 1_120_000, false);
        assertGt(orderId, 0);
        (uint256[] memory prices, uint256[] memory qtys) = desk.getBookSide(seriesJkt, true, 30);
        assertEq(prices.length, 24, "no level was evicted");
        assertEq(qtys[11], 15, "5 attacker CU + 10 honest CU at $1.12");
    }

    function test_PrimaryAskLevelsAreNeverEvicted() public {
        for (uint256 w; w < 3; ++w) {
            address p = _provider(string.concat("prime-", vm.toString(w)), 0);
            for (uint256 i; i < 8; ++i) {
                _mint(p, seriesJkt, 5, 3_000_000 + (w * 8 + i) * 10_000);
            }
        }
        address seller = _actor("cheap-seller", 0, 1_000e6);
        _buy(seller, seriesJkt, 2, 3_000_000, false); // partial fill: the $3.00 primary level stays
        (uint256[] memory before,) = desk.getBookSide(seriesJkt, false, 30);
        assertEq(before.length, 24);
        vm.prank(seller);
        vm.expectRevert(ParonClobLib.TooManyLevels.selector);
        desk.placeAsk(seriesJkt, 2, 2_990_000); // better than the worst level, but that level is a primary ask
    }

    function test_SecondaryAskEvictionReturnsTheCu() public {
        address p = _provider("deep-provider", 100_000e18);
        _fund(p, 0, 100_000e6);
        _mint(p, seriesJkt, 400, 2_000_000); // one primary level at $2.00
        address[3] memory makers;
        for (uint256 w; w < 3; ++w) {
            makers[w] = _actor(string.concat("ask-maker-", vm.toString(w)), 0, 2_000e6);
            _buy(makers[w], seriesJkt, 80, 2_000_000, false);
            uint256 n = w == 2 ? 7 : 8; // 23 secondary levels + the primary level = 24
            for (uint256 i; i < n; ++i) {
                vm.prank(makers[w]);
                desk.placeAsk(seriesJkt, 5, 3_000_000 + (w * 8 + i) * 10_000);
            }
        }
        address honest = _actor("honest-seller", 0, 1_000e6);
        _buy(honest, seriesJkt, 10, 2_000_000, false);
        uint256 cuBefore = seriesToken.balanceOf(makers[2], seriesJkt);
        vm.prank(honest);
        desk.placeAsk(seriesJkt, 10, 2_500_000); // undercuts the worst secondary ask ($3.22)
        (uint256[] memory prices,) = desk.getBookSide(seriesJkt, false, 30);
        assertEq(prices.length, 24);
        assertEq(seriesToken.balanceOf(makers[2], seriesJkt) - cuBefore, 5, "the evicted ask's CU went back to its maker");
        assertEq(prices[0], 2_000_000);
    }
}
