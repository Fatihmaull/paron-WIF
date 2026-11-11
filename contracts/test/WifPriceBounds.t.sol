// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ParonWifBase} from "./ParonWifBase.sol";
import {WifFlywheelVault} from "../src/WifFlywheelVault.sol";
import {ParonExchangeDesk} from "../src/ParonExchangeDesk.sol";

/// @notice The $WIF reference price source is bounded: +-10% per update, one update per hour.
contract WifPriceBoundsTest is ParonWifBase {
    function _skip(uint256 s) internal {
        vm.warp(vm.getBlockTimestamp() + s);
    }

    function test_PriceCannotBeUpdatedTwiceWithinAnHour() public {
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(WifFlywheelVault.PriceUpdateTooSoon.selector, T0 + 1 hours));
        vault.setWifPrice(WIF_PRICE + 1);
        _skip(1 hours);
        vm.prank(deployer);
        vault.setWifPrice(WIF_PRICE * 11 / 10);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(WifFlywheelVault.PriceUpdateTooSoon.selector, T0 + 2 hours));
        vault.setWifPrice(WIF_PRICE);
    }

    function test_PriceMovesAreCappedAtTenPercent() public {
        _skip(1 hours);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(WifFlywheelVault.PriceMoveTooLarge.selector, WIF_PRICE, 551));
        vault.setWifPrice(551);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(WifFlywheelVault.PriceMoveTooLarge.selector, WIF_PRICE, 449));
        vault.setWifPrice(449);
        vm.prank(deployer);
        vault.setWifPrice(450);
        assertEq(vault.wifPriceUsdg(), 450);
        // A compromised source that wants 1 wei needs dozens of hourly steps; a single call cannot do it.
        _skip(1 hours);
        vm.prank(deployer);
        vm.expectRevert();
        vault.setWifPrice(1);
    }

    function test_OnlyTheOracleSetsThePriceAndZeroIsRejected() public {
        _skip(1 hours);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(WifFlywheelVault.NotOracle.selector);
        vault.setWifPrice(WIF_PRICE);
        vm.prank(deployer);
        vm.expectRevert(WifFlywheelVault.InvalidPrice.selector);
        vault.setWifPrice(0);
    }

    // ------------------------------------------------------------------
    // maxWifBurn slippage protection
    // ------------------------------------------------------------------

    function test_MaxWifBurnStopsAPriceMoveBetweenQuoteAndExecution() public {
        address p = _provider("slip-provider", 100_000e18);
        _mint(p, seriesJkt, 100, 2_000_000);
        address buyer = _actor("slip-buyer", 20_000e18, 1_000e6);
        (,,, uint256 quotedBurn) = desk.quoteBuy(seriesJkt, 10, 2_000_000, true);
        assertEq(quotedBurn, 20e18);

        // The oracle price legitimately falls 10% before the transaction lands: the burn grows to 22.2 $WIF.
        _skip(1 hours);
        vm.prank(deployer);
        vault.setWifPrice(450);

        uint256 wifBefore = wif.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ParonExchangeDesk.WifBurnExceedsMax.selector, 22_222_222_222_222_222_222, quotedBurn));
        desk.buySeriesOrPlaceBid(seriesJkt, 10, 2_000_000, true, quotedBurn);
        assertEq(wif.balanceOf(buyer), wifBefore, "nothing was taken");

        // A 10% price fall raises the burn by 11.1%, so a caller who accepts 20% slippage still gets filled.
        vm.prank(buyer);
        (uint256 filled,) = desk.buySeriesOrPlaceBid(seriesJkt, 10, 2_000_000, true, (quotedBurn * 12) / 10);
        assertEq(filled, 10);
        assertEq(wifBefore - wif.balanceOf(buyer), 22_222_222_222_222_222_222);
    }

    function test_AnUnlimitedCapIsTheCallersExplicitChoiceAndStandardModeIgnoresIt() public {
        address p = _provider("cap-provider-2", 100_000e18);
        _mint(p, seriesJkt, 100, 2_000_000);
        address plain = _actor("plain-buyer", 0, 1_000e6);
        vm.prank(plain);
        (uint256 filled,) = desk.buySeriesOrPlaceBid(seriesJkt, 10, 2_000_000, false, 0);
        assertEq(filled, 10, "no $WIF is taken in standard mode, so a zero cap is fine");

        address holder = _actor("zero-cap-holder", 20_000e18, 1_000e6);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(ParonExchangeDesk.WifBurnExceedsMax.selector, 20e18, 0));
        desk.buySeriesOrPlaceBid(seriesJkt, 10, 2_000_000, true, 0);
    }
}
