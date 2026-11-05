// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {WifTokenMock} from "../src/WifTokenMock.sol";
import {UsdgMock} from "../src/UsdgMock.sol";
import {ParonSeriesToken} from "../src/ParonSeriesToken.sol";
import {WifFlywheelVault} from "../src/WifFlywheelVault.sol";
import {WifSlaJury} from "../src/WifSlaJury.sol";
import {ParonExchangeDesk} from "../src/ParonExchangeDesk.sol";
import {GpuTier} from "../src/libraries/ParonWifTypes.sol";

/// @notice Shared deployment fixture. Parameters match `packages/core/src/constants.ts` (TOUR_PARAMS).
abstract contract ParonWifBase is Test {
    uint256 internal constant T0 = 1_793_836_800; // 2026-11-05T00:00:00Z
    uint256 internal constant WIF_PRICE = 500; // 0.0005 USDG per $WIF (testnet oracle)
    uint256 internal constant CRI_GENESIS = 2_200_000; // 2.20 USDG per CU
    uint64 internal constant VOTING = 15 minutes;
    uint64 internal constant EPOCH = 7 days;
    uint64 internal constant ACK = 2 hours;
    uint64 internal constant DELIVERY = 24 hours;
    uint64 internal constant CHALLENGE = 6 hours;
    uint64 internal constant MAX_INDEX_AGE = 30 days;
    uint256 internal constant MAX = type(uint256).max;

    WifTokenMock internal wif;
    UsdgMock internal usdg;
    ParonSeriesToken internal seriesToken;
    WifFlywheelVault internal vault;
    ParonExchangeDesk internal desk;
    WifSlaJury internal jury;

    address internal deployer = makeAddr("deployer");
    address internal treasury = makeAddr("treasury");
    address internal attestor = makeAddr("criAttestor");

    uint256 internal seriesJkt;
    uint256 internal seriesBtm;
    uint256 internal seriesSgp;

    function setUp() public virtual {
        vm.warp(T0);
        vm.startPrank(deployer);
        wif = new WifTokenMock(deployer, 0);
        usdg = new UsdgMock(deployer, 0);
        seriesToken = new ParonSeriesToken(deployer, "ipfs://paron-wif/series/{id}.json");
        vault = new WifFlywheelVault(deployer, address(wif), address(usdg), true, treasury, WIF_PRICE);
        desk = new ParonExchangeDesk(
            address(seriesToken),
            address(vault),
            address(usdg),
            address(wif),
            attestor,
            ACK,
            DELIVERY,
            CHALLENGE,
            MAX_INDEX_AGE
        );
        jury = new WifSlaJury(
            address(wif), address(usdg), true, address(vault), address(desk), address(seriesToken), VOTING, EPOCH
        );
        desk.setJury(address(jury));
        vault.setModules(address(desk), address(jury));
        seriesToken.setDesk(address(desk));
        seriesToken.registerCorridor("JKT", "Jakarta H100");
        seriesToken.registerCorridor("BTM", "Batam-Singapore H200");
        seriesToken.registerCorridor("JHB", "Johor B200");
        seriesToken.registerCorridor("SGP", "Singapore GB200");
        seriesJkt = seriesToken.createSeries(0, GpuTier.H100, 2611);
        seriesBtm = seriesToken.createSeries(1, GpuTier.H200, 2611);
        seriesSgp = seriesToken.createSeries(3, GpuTier.B200, 2612);
        wif.mint(treasury, 5_000_000e18);
        usdg.mint(treasury, 100_000e6);
        vm.stopPrank();

        vm.startPrank(treasury);
        wif.approve(address(vault), MAX);
        usdg.approve(address(vault), MAX);
        vault.fundBuybackReserve(2_000_000e18);
        vault.fundJuryBonusWif(250_000e18);
        vault.fundJuryRewardPool(100e6);
        vm.stopPrank();

        vm.prank(attestor);
        desk.attestReferenceIndex(CRI_GENESIS, keccak256("CRI-H100 genesis basket"));
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _actor(string memory name, uint256 wifAmount, uint256 usdgAmount) internal returns (address a) {
        a = makeAddr(name);
        _fund(a, wifAmount, usdgAmount);
    }

    function _fund(address a, uint256 wifAmount, uint256 usdgAmount) internal {
        vm.startPrank(deployer);
        if (wifAmount > 0) wif.mint(a, wifAmount);
        if (usdgAmount > 0) usdg.mint(a, usdgAmount);
        vm.stopPrank();
        vm.startPrank(a);
        wif.approve(address(desk), MAX);
        wif.approve(address(vault), MAX);
        wif.approve(address(jury), MAX);
        usdg.approve(address(desk), MAX);
        usdg.approve(address(vault), MAX);
        vm.stopPrank();
    }

    function _provider(string memory name, uint256 stake) internal returns (address p) {
        p = _actor(name, stake + 50_000e18, 50_000e6);
        vm.prank(p);
        desk.registerProviderAndStakeWif(string.concat("ipfs://paron-wif/providers/", name), stake);
    }

    function _mint(address p, uint256 seriesId, uint256 cu, uint256 price) internal returns (uint256 lotId) {
        vm.prank(p);
        (lotId,,) = desk.mintPrimarySeries(seriesId, cu, price);
    }

    function _buy(address who, uint256 seriesId, uint256 cu, uint256 maxPrice, bool wifMode)
        internal
        returns (uint256 filled, uint256 orderId)
    {
        vm.prank(who);
        (filled, orderId) = desk.buySeriesOrPlaceBid(seriesId, cu, maxPrice, wifMode);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
