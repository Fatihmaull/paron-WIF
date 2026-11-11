// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SeriesInfo, Redemption} from "../libraries/ParonWifTypes.sol";

/// @notice $WIF with permanent, supply-reducing burns.
interface IWifToken is IERC20 {
    function burn(uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
}

interface IParonSeriesToken {
    function getSeries(uint256 seriesId) external view returns (SeriesInfo memory);
    function seriesCount() external view returns (uint256);
    function corridorCount() external view returns (uint256);
    function totalSupply(uint256 seriesId) external view returns (uint256);
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function mint(address to, uint256 seriesId, uint256 amount) external;
    function burn(address from, uint256 seriesId, uint256 amount) external;
    function deskTransfer(address from, address to, uint256 seriesId, uint256 amount) external;
}

interface IWifFlywheelVault {
    function wifPriceUsdg() external view returns (uint256);
    function stakedWif(address account) external view returns (uint256);
    function hasWifFeeDiscount(address trader) external view returns (bool);
    function getRequiredMarginBps(address provider) external view returns (uint16);
    function getProviderTier(address provider) external view returns (uint8);
    function stakeWifFor(address account, uint256 amount) external;
    function setStakeLock(address provider, uint256 lockAmount) external;
    function processProtocolFeeAndBurn(address payer, uint256 usdgFee, uint256 wifBurnAmount, string calldata reason)
        external
        returns (uint256 wifBurned);
    function processSlashProceeds(address provider, uint256 burnUsdg, uint256 vaultUsdg, string calldata reason)
        external
        returns (uint256 wifBurned);
    function recordWifBurn(address actor, uint256 amount, string calldata reason) external;
    function drawJuryReward(uint256 bps, uint256 cap) external returns (uint256 usdgOut);
    function drawJuryBonusWif(uint256 wifWanted) external returns (uint256 wifOut);
}

interface IParonExchangeDesk {
    function getRedemption(uint256 redemptionId) external view returns (Redemption memory);
    function isDisputable(uint256 redemptionId) external view returns (bool);
    function onDisputeOpened(uint256 redemptionId, uint256 disputeId) external;
    function executeSlash(uint256 redemptionId) external returns (uint256 voterRewardUsdg);
    function executeUphold(uint256 redemptionId) external;
}

/// @notice Multi-attestor Compute Reference Index (see ComputeReferenceIndex).
interface IComputeReferenceIndex {
    function latest() external view returns (uint256 price, uint64 updatedAt);
}

interface IWifSlaJury {
    function currentBoostedCorridor() external view returns (bool active, uint8 corridorId);
}
