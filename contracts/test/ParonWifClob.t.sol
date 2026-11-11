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
        assertEq(desk.activeOrdersOf(seriesJkt, false, p), 8);
        vm.prank(p);
        vm.expectRevert(abi.encodeWithSelector(ParonClobLib.TooManyOrders.selector, p, 8));
        desk.mintPrimarySeries(seriesJkt, 10, 2_090_000);
        // Bids are a separate side with their own allowance, and cancelling frees a slot.
        assertEq(desk.activeOrdersOf(seriesJkt, true, p), 0);
        uint256 orderId = desk.getLot(1).askOrderId;
        vm.prank(p);
        desk.cancelOrder(orderId);
        assertEq(desk.activeOrdersOf(seriesJkt, false, p), 7);
        _mint(p, seriesJkt, 10, 2_090_000);
        assertEq(desk.activeOrdersOf(seriesJkt, false, p), 8);
    }

    function test_FilledOrdersFreeTheirSlot() public {
        address p = _provider("slot-provider", 0);
        _fund(p, 0, 10_000e6);
        _mint(p, seriesJkt, 10, 2_000_000);
        assertEq(desk.activeOrdersOf(seriesJkt, false, p), 1);
        address buyer = _actor("slot-buyer", 0, 100e6);
        _buy(buyer, seriesJkt, 10, 2_000_000, false);
        assertEq(desk.activeOrdersOf(seriesJkt, false, p), 0);
    }
}
