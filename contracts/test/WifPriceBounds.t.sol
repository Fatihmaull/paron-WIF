// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ParonWifBase} from "./ParonWifBase.sol";
import {WifFlywheelVault} from "../src/WifFlywheelVault.sol";

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
}
