// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IParonSeriesToken, IWifFlywheelVault} from "../interfaces/IParonWif.sol";
import {ParonWifConstants as C} from "./ParonWifConstants.sol";
import {Lot} from "./ParonWifTypes.sol";

/// @title ParonLotLib
/// @notice Provider lot accounting for ParonExchangeDesk (linked external library, runs in the desk's context).
///         The desk keeps the storage mappings and passes them in, so the storage layout and public getters
///         are unchanged. A lot escrows buyer principal and the provider's margin until delivery or settlement.
library ParonLotLib {
    error LotCapacity(uint256 lotId);
    error NoLotCapacity(uint256 seriesId, uint256 cuAmount);

    /// @notice Picks the lot a redemption or cash settlement draws on: the preferred lot, or the oldest lot
    ///         with enough sold capacity (scanning at most MAX_LOT_SCAN lots, skipping closed lots at the cursor).
    function assignLot(
        mapping(uint256 lotId => Lot) storage lots,
        mapping(uint256 seriesId => uint256[]) storage seriesLots,
        mapping(uint256 seriesId => uint256 cursor) storage lotCursor,
        uint256 seriesId,
        uint256 cuAmount,
        uint256 preferredLotId
    ) external returns (uint256) {
        if (preferredLotId != 0) {
            Lot storage p = lots[preferredLotId];
            if (p.seriesId != seriesId || p.cuOutstanding < cuAmount) revert LotCapacity(preferredLotId);
            return preferredLotId;
        }
        uint256[] storage ids = seriesLots[seriesId];
        uint256 n = ids.length;
        uint256 scanned;
        for (uint256 i = lotCursor[seriesId]; i < n && scanned < C.MAX_LOT_SCAN; ++i) {
            Lot storage lot = lots[ids[i]];
            if (lot.closed && i == lotCursor[seriesId]) {
                lotCursor[seriesId] = i + 1;
                continue;
            }
            if (lot.cuOutstanding >= cuAmount) return ids[i];
            ++scanned;
        }
        revert NoLotCapacity(seriesId, cuAmount);
    }

    /// @notice Moves a pro-rata slice of escrowed principal and locked margin out of a lot.
    function takeShare(
        mapping(uint256 lotId => Lot) storage lots,
        mapping(address provider => uint256 amount) storage claimable,
        mapping(address provider => mapping(uint8 tier => uint256 count)) storage openLots,
        IWifFlywheelVault vault,
        uint256 lotId,
        uint256 cuAmount
    ) external returns (uint256 principal, uint256 margin) {
        Lot storage lot = lots[lotId];
        principal = (lot.escrowUsdg * cuAmount) / lot.cuOutstanding;
        margin = (lot.marginLocked * cuAmount) / (lot.cuOutstanding + lot.cuUnsold);
        lot.escrowUsdg -= principal;
        lot.marginLocked -= margin;
        lot.cuOutstanding -= cuAmount;
        if (lot.cuOutstanding == 0 && lot.cuUnsold == 0) _close(lot, claimable, openLots, vault);
    }

    /// @notice A provider cancels its unsold primary ask: the unsold CU is burned and its margin share released.
    function cancelPrimary(
        mapping(uint256 lotId => Lot) storage lots,
        mapping(address provider => uint256 amount) storage claimable,
        mapping(address provider => mapping(uint8 tier => uint256 count)) storage openLots,
        mapping(uint256 seriesId => uint256 cu) storage unsoldCu,
        IParonSeriesToken series,
        IWifFlywheelVault vault,
        uint256 lotId,
        uint256 qty
    ) external {
        Lot storage lot = lots[lotId];
        uint256 release = (lot.marginLocked * qty) / (lot.cuOutstanding + lot.cuUnsold);
        lot.marginLocked -= release;
        lot.cuUnsold -= qty;
        lot.askOrderId = 0;
        unsoldCu[lot.seriesId] -= qty;
        series.burn(address(this), lot.seriesId, qty);
        claimable[lot.provider] += release;
        if (lot.cuOutstanding == 0 && lot.cuUnsold == 0) _close(lot, claimable, openLots, vault);
    }

    /// @notice Keeps a provider's tier stake locked while lots minted at that tier are open.
    function syncStakeLock(
        mapping(address provider => mapping(uint8 tier => uint256 count)) storage openLots,
        IWifFlywheelVault vault,
        address provider
    ) public {
        uint256 lockAmount;
        if (openLots[provider][2] > 0) lockAmount = C.TIER2_STAKE;
        else if (openLots[provider][1] > 0) lockAmount = C.TIER1_STAKE;
        vault.setStakeLock(provider, lockAmount);
    }

    function _close(
        Lot storage lot,
        mapping(address provider => uint256 amount) storage claimable,
        mapping(address provider => mapping(uint8 tier => uint256 count)) storage openLots,
        IWifFlywheelVault vault
    ) private {
        if (lot.closed) return;
        lot.closed = true;
        uint256 residual = lot.marginLocked + lot.escrowUsdg;
        if (residual > 0) {
            lot.marginLocked = 0;
            lot.escrowUsdg = 0;
            claimable[lot.provider] += residual;
        }
        openLots[lot.provider][lot.tier] -= 1;
        syncStakeLock(openLots, vault, lot.provider);
    }
}
