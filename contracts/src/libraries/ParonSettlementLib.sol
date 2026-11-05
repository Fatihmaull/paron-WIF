// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IParonSeriesToken, IWifFlywheelVault} from "../interfaces/IParonWif.sol";
import {ParonWifConstants as C} from "./ParonWifConstants.sol";
import {ProviderProfile, Redemption, RedemptionState} from "./ParonWifTypes.sol";

/// @title ParonSettlementLib
/// @notice Mode B settlement maths for ParonExchangeDesk (linked external library, runs in the desk's context).
library ParonSettlementLib {
    using SafeERC20 for IERC20;

    struct Env {
        IParonSeriesToken series;
        IERC20 usdg;
        IWifFlywheelVault vault;
        address jury;
    }

    event RedemptionFinalized(uint256 indexed redemptionId, address indexed provider, uint256 releasedUsdg);
    event ProviderSlashed(
        uint256 indexed redemptionId,
        address indexed provider,
        address indexed holder,
        uint256 principalRefund,
        uint256 slaCompensation,
        uint256 voterShare,
        uint256 burnShare,
        uint256 vaultShare,
        bool viaJury
    );

    /// @notice Delivery accepted: escrowed principal and the redemption's margin slice go to the provider.
    function finalize(
        Redemption storage r,
        ProviderProfile storage p,
        mapping(address => uint256) storage claimable,
        IParonSeriesToken series,
        uint256 redemptionId
    ) external {
        r.state = RedemptionState.Finalized;
        uint256 released = r.principalUsdg + r.marginUsdg;
        claimable[r.provider] += released;
        p.deliveredCu += r.cuAmount;
        p.deliveredCount += 1;
        series.burn(address(this), r.seriesId, r.cuAmount);
        emit RedemptionFinalized(redemptionId, r.provider, released);
    }

    /// @notice Slash waterfall. Holder: 100% principal + 15% compensation (from margin, capped).
    ///         Remaining margin: 50% winning jurors (vault jury pool when no vote was needed),
    ///         25% $WIF buyback-and-burn, 25% The Paron Vault jury pool.
    function slash(Redemption storage r, ProviderProfile storage p, Env memory env, uint256 redemptionId, bool viaJury)
        external
        returns (uint256 voterShare)
    {
        r.state = RedemptionState.Slashed;
        uint256 compensation = (r.principalUsdg * C.SLA_COMPENSATION_BPS) / C.BPS;
        if (compensation > r.marginUsdg) compensation = r.marginUsdg;
        uint256 remainder = r.marginUsdg - compensation;
        voterShare = (remainder * C.SLASH_VOTER_SHARE_BPS) / C.BPS;
        uint256 burnShare = (remainder * C.SLASH_BURN_SHARE_BPS) / C.BPS;
        uint256 vaultShare = remainder - voterShare - burnShare;

        p.slashedCu += r.cuAmount;
        p.slashedCount += 1;
        env.series.burn(address(this), r.seriesId, r.cuAmount);
        env.usdg.safeTransfer(r.holder, r.principalUsdg + compensation);
        if (viaJury) {
            if (voterShare > 0) env.usdg.safeTransfer(env.jury, voterShare);
        } else {
            vaultShare += voterShare;
            voterShare = 0;
        }
        if (burnShare + vaultShare > 0) {
            env.vault.processSlashProceeds(
                r.provider, burnShare, vaultShare, viaJury ? "SLA_SLASH_JURY" : "SLA_SLASH_MISSED_DEADLINE"
            );
        }
        emit ProviderSlashed(
            redemptionId, r.provider, r.holder, r.principalUsdg, compensation, voterShare, burnShare, vaultShare, viaJury
        );
    }

    /// @notice EIP-191 personal-sign digest for a delivery receipt, bound to chain and desk.
    function receiptDigest(
        address desk,
        uint256 redemptionId,
        bytes32 receiptHash,
        uint32 p95LatencyMs,
        uint16 uptimeBps
    ) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(block.chainid, desk, redemptionId, receiptHash, p95LatencyMs, uptimeBps));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /// @notice ecrecover with low-s and v checks. Returns address(0) for any malformed signature.
    function recover(bytes32 digest, bytes calldata sig) external pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
