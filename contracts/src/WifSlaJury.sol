// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IParonExchangeDesk, IParonSeriesToken, IWifFlywheelVault, IWifToken} from "./interfaces/IParonWif.sol";
import {ParonWifConstants as C} from "./libraries/ParonWifConstants.sol";
import {Dispute, DisputeStatus, Redemption} from "./libraries/ParonWifTypes.sol";

/// @title WifSlaJury
/// @notice Burn-to-vote SLA arbitration and compute-corridor elections. Replaces the legacy
///         centralized verifier: 1 $WIF burned = 1 permanent vote, and winners share real USDG
///         from slashed provider margin plus bonus $WIF from The Paron Vault.
contract WifSlaJury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable wif;
    IERC20 public immutable usdg;
    bool public immutable nativeBurn;
    IWifFlywheelVault public immutable vault;
    IParonExchangeDesk public immutable desk;
    IParonSeriesToken public immutable seriesToken;
    uint64 public immutable votingPeriod;
    uint64 public immutable epochLength;
    uint64 public immutable genesisTime;

    uint256 public disputeCount;
    mapping(uint256 disputeId => Dispute) private _disputes;
    mapping(uint256 disputeId => string) public disputeReason;
    mapping(uint256 disputeId => mapping(address voter => uint256 weight)) public slashWeightOf;
    mapping(uint256 disputeId => mapping(address voter => uint256 weight)) public upholdWeightOf;
    mapping(uint256 disputeId => mapping(address voter => bool)) public hasClaimed;

    mapping(uint256 epoch => mapping(uint8 corridorId => uint256 votes)) public corridorVotes;
    mapping(uint256 epoch => mapping(address voter => uint256 votes)) public corridorVotesOf;
    mapping(uint256 epoch => uint256 votes) public epochTotalVotes;
    mapping(uint256 epoch => bool) public epochFinalized;
    mapping(uint256 epoch => uint8 corridorId) public epochWinner;

    event DisputeOpened(
        uint256 indexed disputeId,
        uint256 indexed redemptionId,
        address indexed challenger,
        bytes32 evidenceHash,
        string reason,
        uint64 votingEndsAt,
        uint256 filingBurn
    );
    event BurnVoteCast(
        uint256 indexed disputeId,
        address indexed voter,
        bool supportSlash,
        uint256 wifBurned,
        uint256 slashVotes,
        uint256 upholdVotes
    );
    event DisputeResolved(
        uint256 indexed disputeId,
        uint256 indexed redemptionId,
        bool slashed,
        uint256 slashVotes,
        uint256 upholdVotes,
        uint256 rewardPoolUsdg,
        uint256 rewardPoolWif
    );
    event VoterUpsideClaimed(uint256 indexed disputeId, address indexed voter, uint256 usdgAmount, uint256 wifAmount);
    event CorridorVoteCast(
        uint256 indexed epoch, uint8 indexed corridorId, address indexed voter, uint256 wifBurned, uint256 corridorTotal
    );
    event CorridorElected(uint256 indexed epoch, uint8 indexed corridorId, uint256 votes);

    error ZeroAddress();
    error ZeroAmount();
    error NotRedemptionHolder();
    error NotDisputable(uint256 redemptionId);
    error EmptyEvidence();
    error DisputeNotOpen(uint256 disputeId);
    error VotingClosed(uint64 votingEndsAt);
    error VotingStillOpen(uint64 votingEndsAt);
    error CannotVoteBothSides();
    error DisputeNotResolved(uint256 disputeId);
    error NotWinningVoter();
    error AlreadyClaimed();
    error UnknownCorridor(uint8 corridorId);
    error EpochNotEnded(uint256 epoch);
    error EpochAlreadyFinalized(uint256 epoch);
    error NoVotes(uint256 epoch);

    constructor(
        address wif_,
        address usdg_,
        bool nativeBurn_,
        address vault_,
        address desk_,
        address seriesToken_,
        uint64 votingPeriod_,
        uint64 epochLength_
    ) {
        if (
            wif_ == address(0) || usdg_ == address(0) || vault_ == address(0) || desk_ == address(0)
                || seriesToken_ == address(0)
        ) revert ZeroAddress();
        if (votingPeriod_ == 0 || epochLength_ == 0) revert ZeroAmount();
        wif = IERC20(wif_);
        usdg = IERC20(usdg_);
        nativeBurn = nativeBurn_;
        vault = IWifFlywheelVault(vault_);
        desk = IParonExchangeDesk(desk_);
        seriesToken = IParonSeriesToken(seriesToken_);
        votingPeriod = votingPeriod_;
        epochLength = epochLength_;
        genesisTime = uint64(block.timestamp);
    }

    // ------------------------------------------------------------------
    // SLA disputes
    // ------------------------------------------------------------------

    /// @notice Contests a delivered redemption (latency, downtime, wrong hardware) inside its challenge window.
    ///         Filing burns 100 $WIF, counted as the challenger's own SLASH votes.
    function openSlaDispute(uint256 redemptionId, bytes32 evidenceHash, string calldata reason)
        external
        nonReentrant
        returns (uint256 disputeId)
    {
        Redemption memory r = desk.getRedemption(redemptionId);
        if (r.holder != msg.sender) revert NotRedemptionHolder();
        if (!desk.isDisputable(redemptionId)) revert NotDisputable(redemptionId);
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();

        _burnFrom(msg.sender, C.DISPUTE_FILING_BURN);
        disputeId = ++disputeCount;
        Dispute storage d = _disputes[disputeId];
        d.redemptionId = redemptionId;
        d.challenger = msg.sender;
        d.evidenceHash = evidenceHash;
        d.openedAt = uint64(block.timestamp);
        d.votingEndsAt = uint64(block.timestamp) + votingPeriod;
        d.status = DisputeStatus.Open;
        d.voterCount = 1;
        d.slashVotes = C.DISPUTE_FILING_BURN;
        slashWeightOf[disputeId][msg.sender] = C.DISPUTE_FILING_BURN;
        disputeReason[disputeId] = reason;

        desk.onDisputeOpened(redemptionId, disputeId);
        vault.recordWifBurn(msg.sender, C.DISPUTE_FILING_BURN, "SLA_DISPUTE_FILING");
        emit DisputeOpened(
            disputeId, redemptionId, msg.sender, evidenceHash, reason, d.votingEndsAt, C.DISPUTE_FILING_BURN
        );
    }

    /// @notice Burns `wifBurnAmount` $WIF permanently and adds it as votes. 1 $WIF burned = 1 vote.
    function voteOnDisputeWithWifBurn(uint256 disputeId, bool supportSlash, uint256 wifBurnAmount)
        external
        nonReentrant
    {
        Dispute storage d = _disputes[disputeId];
        if (d.status != DisputeStatus.Open) revert DisputeNotOpen(disputeId);
        if (block.timestamp >= d.votingEndsAt) revert VotingClosed(d.votingEndsAt);
        if (wifBurnAmount == 0) revert ZeroAmount();

        uint256 slashWeight = slashWeightOf[disputeId][msg.sender];
        uint256 upholdWeight = upholdWeightOf[disputeId][msg.sender];
        if (supportSlash ? upholdWeight != 0 : slashWeight != 0) revert CannotVoteBothSides();
        if (slashWeight == 0 && upholdWeight == 0) d.voterCount += 1;

        _burnFrom(msg.sender, wifBurnAmount);
        if (supportSlash) {
            slashWeightOf[disputeId][msg.sender] = slashWeight + wifBurnAmount;
            d.slashVotes += wifBurnAmount;
        } else {
            upholdWeightOf[disputeId][msg.sender] = upholdWeight + wifBurnAmount;
            d.upholdVotes += wifBurnAmount;
        }
        vault.recordWifBurn(msg.sender, wifBurnAmount, "SLA_JURY_VOTE");
        emit BurnVoteCast(disputeId, msg.sender, supportSlash, wifBurnAmount, d.slashVotes, d.upholdVotes);
    }

    /// @notice Executes the majority outcome once voting ends. Permissionless.
    ///  SLASH: buyer refunded 100% principal + 15% from margin; remaining margin 50% to winning voters,
    ///         25% bought back and burned as $WIF, 25% to The Paron Vault jury pool.
    ///  UPHOLD: escrow and margin released to the provider.
    ///  Either way winners also share 20% of the vault jury pool and a 10% $WIF bonus.
    function resolveDispute(uint256 disputeId) external nonReentrant {
        Dispute storage d = _disputes[disputeId];
        if (d.status != DisputeStatus.Open) revert DisputeNotOpen(disputeId);
        if (block.timestamp < d.votingEndsAt) revert VotingStillOpen(d.votingEndsAt);

        bool slash = d.slashVotes > d.upholdVotes;
        d.status = slash ? DisputeStatus.ResolvedSlash : DisputeStatus.ResolvedUphold;
        uint256 rewardUsdg;
        if (slash) {
            rewardUsdg = desk.executeSlash(d.redemptionId);
        } else {
            desk.executeUphold(d.redemptionId);
        }
        rewardUsdg += vault.drawJuryReward(C.JURY_POOL_DRAW_BPS);
        uint256 winningVotes = slash ? d.slashVotes : d.upholdVotes;
        uint256 bonusWif = vault.drawJuryBonusWif((winningVotes * C.JURY_WIF_BONUS_BPS) / C.BPS);
        d.rewardPoolUsdg = rewardUsdg;
        d.rewardPoolWif = bonusWif;
        emit DisputeResolved(disputeId, d.redemptionId, slash, d.slashVotes, d.upholdVotes, rewardUsdg, bonusWif);
    }

    /// @notice Winning burn-voters claim their pro-rata USDG upside and bonus $WIF.
    function claimVoterUpside(uint256 disputeId) external nonReentrant returns (uint256 usdgOut, uint256 wifOut) {
        Dispute storage d = _disputes[disputeId];
        bool slashWon = d.status == DisputeStatus.ResolvedSlash;
        if (!slashWon && d.status != DisputeStatus.ResolvedUphold) revert DisputeNotResolved(disputeId);
        uint256 weight = slashWon ? slashWeightOf[disputeId][msg.sender] : upholdWeightOf[disputeId][msg.sender];
        if (weight == 0) revert NotWinningVoter();
        if (hasClaimed[disputeId][msg.sender]) revert AlreadyClaimed();
        hasClaimed[disputeId][msg.sender] = true;

        uint256 winningVotes = slashWon ? d.slashVotes : d.upholdVotes;
        usdgOut = (d.rewardPoolUsdg * weight) / winningVotes;
        wifOut = (d.rewardPoolWif * weight) / winningVotes;
        d.claimedUsdg += usdgOut;
        d.claimedWif += wifOut;
        if (usdgOut > 0) usdg.safeTransfer(msg.sender, usdgOut);
        if (wifOut > 0) wif.safeTransfer(msg.sender, wifOut);
        emit VoterUpsideClaimed(disputeId, msg.sender, usdgOut, wifOut);
    }

    // ------------------------------------------------------------------
    // Corridor election (weekly Vault liquidity boost)
    // ------------------------------------------------------------------

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesisTime) / epochLength;
    }

    /// @notice Burns $WIF to vote for the compute corridor that receives the next epoch's margin boost.
    function voteForComputeCorridor(uint8 corridorId, uint256 wifBurnAmount) external nonReentrant {
        if (corridorId >= seriesToken.corridorCount()) revert UnknownCorridor(corridorId);
        if (wifBurnAmount == 0) revert ZeroAmount();
        uint256 epoch = currentEpoch();
        _burnFrom(msg.sender, wifBurnAmount);
        uint256 total = corridorVotes[epoch][corridorId] + wifBurnAmount;
        corridorVotes[epoch][corridorId] = total;
        corridorVotesOf[epoch][msg.sender] += wifBurnAmount;
        epochTotalVotes[epoch] += wifBurnAmount;
        vault.recordWifBurn(msg.sender, wifBurnAmount, "CORRIDOR_ELECTION");
        emit CorridorVoteCast(epoch, corridorId, msg.sender, wifBurnAmount, total);
    }

    /// @notice Closes a finished epoch and crowns its corridor. Ties go to the lower corridor id. Permissionless.
    function finalizeCorridorEpoch(uint256 epoch) external returns (uint8 winner) {
        if (epoch >= currentEpoch()) revert EpochNotEnded(epoch);
        if (epochFinalized[epoch]) revert EpochAlreadyFinalized(epoch);
        if (epochTotalVotes[epoch] == 0) revert NoVotes(epoch);
        uint256 count = seriesToken.corridorCount();
        uint256 best;
        for (uint8 i; i < count; ++i) {
            uint256 v = corridorVotes[epoch][i];
            if (v > best) {
                best = v;
                winner = i;
            }
        }
        epochFinalized[epoch] = true;
        epochWinner[epoch] = winner;
        emit CorridorElected(epoch, winner, best);
    }

    /// @notice The corridor elected in the previous epoch is boosted for the current one.
    function currentBoostedCorridor() external view returns (bool active, uint8 corridorId) {
        uint256 epoch = currentEpoch();
        if (epoch == 0 || !epochFinalized[epoch - 1]) return (false, 0);
        return (true, epochWinner[epoch - 1]);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        return _disputes[disputeId];
    }

    function getCorridorTally(uint256 epoch) external view returns (uint256[] memory votes) {
        uint256 count = seriesToken.corridorCount();
        votes = new uint256[](count);
        for (uint8 i; i < count; ++i) {
            votes[i] = corridorVotes[epoch][i];
        }
    }

    function pendingVoterUpside(uint256 disputeId, address voter) external view returns (uint256 usdgOut, uint256 wifOut) {
        Dispute storage d = _disputes[disputeId];
        bool slashWon = d.status == DisputeStatus.ResolvedSlash;
        if ((!slashWon && d.status != DisputeStatus.ResolvedUphold) || hasClaimed[disputeId][voter]) return (0, 0);
        uint256 weight = slashWon ? slashWeightOf[disputeId][voter] : upholdWeightOf[disputeId][voter];
        if (weight == 0) return (0, 0);
        uint256 winningVotes = slashWon ? d.slashVotes : d.upholdVotes;
        usdgOut = (d.rewardPoolUsdg * weight) / winningVotes;
        wifOut = (d.rewardPoolWif * weight) / winningVotes;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _burnFrom(address account, uint256 amount) private {
        if (nativeBurn) {
            IWifToken(address(wif)).burnFrom(account, amount);
        } else {
            wif.safeTransferFrom(account, C.DEAD, amount);
        }
    }
}
