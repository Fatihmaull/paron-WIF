// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IParonSeriesToken, IWifFlywheelVault, IWifSlaJury} from "./interfaces/IParonWif.sol";
import {ParonWifConstants as C} from "./libraries/ParonWifConstants.sol";
import {ParonClobLib} from "./libraries/ParonClobLib.sol";
import {ParonSettlementLib} from "./libraries/ParonSettlementLib.sol";
import {
    Lot, Order, ProviderProfile, Redemption, RedemptionState, SeriesInfo, SeriesMarket
} from "./libraries/ParonWifTypes.sol";

/// @title ParonExchangeDesk
/// @notice Primary issuance, central limit order book and dual settlement for standardized CU series.
///  - Permissionless providers: no KYB gate, no verifier role. Skin in the game is USDG margin + staked $WIF.
///  - Primary mint locks only 25%-50% margin (by $WIF tier) instead of the legacy 150% cash bond.
///    Buyer principal is escrowed per lot and released to the provider on delivery or settlement.
///  - CLOB with price-time priority. Makers holding or staking >= 10k $WIF queue in the priority lane.
///  - Every fill pays 30 bps (10 bps in $WIF discount mode) into the WifFlywheelVault burn engine.
///  - Mode A: cash settlement at the attested Compute Reference Index (CRI-H100).
///  - Mode B: request -> acknowledge -> deliver with signed receipt -> confirm / WifSlaJury dispute.
///  - No owner: after the one-time jury wiring the desk has no admin keys. The only role is the
///    index attestor, which can rotate itself.
contract ParonExchangeDesk is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ParonClobLib for ParonClobLib.Book;

    struct BuyCtx {
        uint256 seriesId;
        address buyer;
        uint256 remaining;
        uint256 maxPrice;
        uint256 filled;
        uint256 notional;
        uint256 primaryCost;
        uint256 fills;
    }

    address public immutable deployer;
    IParonSeriesToken public immutable series;
    IWifFlywheelVault public immutable vault;
    IERC20 public immutable usdg;
    IERC20 public immutable wif;
    uint64 public immutable ackWindow;
    uint64 public immutable deliveryWindow;
    uint64 public immutable challengeWindow;
    uint64 public immutable maxIndexAge;

    IWifSlaJury public jury;
    address public indexAttestor;

    // Compute Reference Index (USDG per CU, 6 decimals)
    uint256 public criH100Usdg;
    uint64 public criUpdatedAt;
    bytes32 public criSourceHash;

    // Providers
    mapping(address provider => ProviderProfile) private _providers;
    mapping(address provider => uint256 amount) public providerClaimableUsdg;
    mapping(address provider => mapping(uint8 tier => uint256 count)) public openLotsAtTier;

    // Lots
    uint256 public lotCount;
    mapping(uint256 lotId => Lot) private _lots;
    mapping(uint256 seriesId => uint256[]) private _seriesLots;
    mapping(uint256 seriesId => uint256 cursor) private _lotCursor;

    // Order book (storage-level CLOB, see ParonClobLib)
    ParonClobLib.Book private _clob;

    // Market telemetry
    mapping(uint256 seriesId => uint256 cu) public unsoldCu;
    mapping(uint256 seriesId => uint256 price) private _lastTradePrice;
    mapping(uint256 seriesId => uint256 cu) private _volumeCu;
    mapping(uint256 seriesId => uint256 usdgAmount) private _volumeUsdg;
    mapping(uint256 seriesId => uint256 count) private _tradeCount;

    // Redemptions
    uint256 public redemptionCount;
    mapping(uint256 redemptionId => Redemption) private _redemptions;

    event JurySet(address indexed jury);
    event IndexAttestorSet(address indexed attestor);
    event ReferenceIndexAttested(uint256 priceUsdgPerCu, bytes32 sourceHash, uint64 timestamp);
    event ProviderRegistered(address indexed provider, string metadataUri, uint256 wifStaked, uint256 totalStaked);
    event AttestationSignerSet(address indexed provider, address indexed signer);
    event LotMinted(
        uint256 indexed lotId,
        uint256 indexed seriesId,
        address indexed provider,
        uint256 cuAmount,
        uint256 askPrice,
        uint16 marginBps,
        uint256 marginLocked
    );
    event OrderPlaced(
        uint256 indexed orderId,
        uint256 indexed seriesId,
        address indexed maker,
        bool isBid,
        uint256 price,
        uint256 qty,
        uint256 lotId,
        uint8 lane
    );
    event OrderCancelled(uint256 indexed orderId, uint256 indexed seriesId, uint256 qtyReturned);
    event Trade(
        uint256 indexed seriesId,
        uint256 indexed makerOrderId,
        address indexed maker,
        address taker,
        bool takerIsBuyer,
        uint256 price,
        uint256 qty,
        uint256 lotId
    );
    event FeeCharged(address indexed payer, uint256 indexed seriesId, uint256 feeUsdg, uint256 wifBurned, bool wifMode);
    event RedemptionRequested(
        uint256 indexed redemptionId,
        uint256 indexed seriesId,
        uint256 indexed lotId,
        address holder,
        address provider,
        uint256 cuAmount,
        uint256 principalUsdg,
        uint256 marginUsdg,
        uint64 ackDeadline
    );
    event RedemptionAcknowledged(uint256 indexed redemptionId, uint64 deliveryDeadline);
    event DeliveryReceiptPosted(
        uint256 indexed redemptionId,
        bytes32 receiptHash,
        uint32 p95LatencyMs,
        uint16 uptimeBps,
        bool slaBreached,
        uint64 challengeDeadline
    );
    event RedemptionDisputed(uint256 indexed redemptionId, uint256 indexed disputeId);
    event CashSettled(
        uint256 indexed seriesId,
        uint256 indexed lotId,
        address indexed holder,
        uint256 cuAmount,
        uint256 indexPrice,
        uint256 payoutUsdg,
        uint256 feeUsdg,
        uint256 providerResidual
    );
    event ProviderWithdrawal(address indexed provider, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error JuryAlreadySet();
    error NotDeployer();
    error NotJury();
    error NotIndexAttestor();
    error NotRegisteredProvider();
    error UnknownLot(uint256 lotId);
    error SeriesNotTradable(uint256 seriesId);
    error InvalidPrice();
    error NotWifDiscountEligible();
    error SelfTrade();
    error OrderNotActive(uint256 orderId);
    error OrderTooSmall(uint256 notional, uint256 minNotional);
    error NotOrderMaker();
    error OutsideDeliveryWindow();
    error OutsideSettlementWindow();
    error StaleIndex();
    error LotCapacity(uint256 lotId);
    error NoLotCapacity(uint256 seriesId, uint256 cuAmount);
    error NotProvider();
    error NotHolder();
    error InvalidState(RedemptionState state);
    error DeadlinePassed();
    error DeadlineNotPassed();
    error ChallengeWindowOpen();
    error EmptyReceipt();
    error InvalidAttestation();

    modifier onlyJury() {
        if (msg.sender != address(jury)) revert NotJury();
        _;
    }

    constructor(
        address series_,
        address vault_,
        address usdg_,
        address wif_,
        address indexAttestor_,
        uint64 ackWindow_,
        uint64 deliveryWindow_,
        uint64 challengeWindow_,
        uint64 maxIndexAge_
    ) {
        if (
            series_ == address(0) || vault_ == address(0) || usdg_ == address(0) || wif_ == address(0)
                || indexAttestor_ == address(0)
        ) revert ZeroAddress();
        deployer = msg.sender;
        series = IParonSeriesToken(series_);
        vault = IWifFlywheelVault(vault_);
        usdg = IERC20(usdg_);
        wif = IERC20(wif_);
        indexAttestor = indexAttestor_;
        ackWindow = ackWindow_;
        deliveryWindow = deliveryWindow_;
        challengeWindow = challengeWindow_;
        maxIndexAge = maxIndexAge_;
        usdg.forceApprove(vault_, type(uint256).max);
        wif.forceApprove(vault_, type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Wiring and the Compute Reference Index
    // ------------------------------------------------------------------

    function setJury(address jury_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(jury) != address(0)) revert JuryAlreadySet();
        if (jury_ == address(0)) revert ZeroAddress();
        jury = IWifSlaJury(jury_);
        emit JurySet(jury_);
    }

    /// @notice The attestor rotates itself (e.g. to a multisig or a decentralized oracle adapter).
    function setIndexAttestor(address attestor) external {
        if (msg.sender != indexAttestor) revert NotIndexAttestor();
        if (attestor == address(0)) revert ZeroAddress();
        indexAttestor = attestor;
        emit IndexAttestorSet(attestor);
    }

    /// @notice Posts the CRI-H100 price (USDG per CU) with a hash of its source data
    ///         (venue prints, on-chain VWAP, rate cards).
    function attestReferenceIndex(uint256 priceUsdgPerCu, bytes32 sourceHash) external {
        if (msg.sender != indexAttestor) revert NotIndexAttestor();
        if (priceUsdgPerCu == 0) revert InvalidPrice();
        criH100Usdg = priceUsdgPerCu;
        criUpdatedAt = uint64(block.timestamp);
        criSourceHash = sourceHash;
        emit ReferenceIndexAttested(priceUsdgPerCu, sourceHash, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------
    // Providers (permissionless)
    // ------------------------------------------------------------------

    /// @notice Registers the caller as a compute provider and optionally stakes $WIF for a margin tier.
    ///         No KYB queue and no verifier approval: margin and staked $WIF are the guarantee.
    function registerProviderAndStakeWif(string calldata metadataUri, uint256 wifStakeAmount) external nonReentrant {
        ProviderProfile storage p = _providers[msg.sender];
        if (!p.registered) {
            p.registered = true;
            p.registeredAt = uint64(block.timestamp);
        }
        p.metadataUri = metadataUri;
        if (wifStakeAmount > 0) {
            wif.safeTransferFrom(msg.sender, address(this), wifStakeAmount);
            vault.stakeWifFor(msg.sender, wifStakeAmount);
        }
        emit ProviderRegistered(msg.sender, metadataUri, wifStakeAmount, vault.stakedWif(msg.sender));
    }

    /// @notice Optional hardware/TEE key whose EIP-191 signature must accompany every delivery receipt.
    function setAttestationSigner(address signer) external {
        ProviderProfile storage p = _providers[msg.sender];
        if (!p.registered) revert NotRegisteredProvider();
        p.attestationSigner = signer;
        emit AttestationSignerSet(msg.sender, signer);
    }

    function withdrawProviderBalance() external nonReentrant returns (uint256 amount) {
        amount = providerClaimableUsdg[msg.sender];
        if (amount == 0) revert ZeroAmount();
        providerClaimableUsdg[msg.sender] = 0;
        usdg.safeTransfer(msg.sender, amount);
        emit ProviderWithdrawal(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Primary issuance
    // ------------------------------------------------------------------

    /// @notice Mints `cuAmount` CU into a new lot, locks only the $WIF-boosted margin (25%-50% of notional)
    ///         and lists the supply as a primary ask. Crosses resting bids at or above `askPriceUsdg` first.
    function mintPrimarySeries(uint256 seriesId, uint256 cuAmount, uint256 askPriceUsdg)
        external
        nonReentrant
        returns (uint256 lotId, uint256 orderId, uint256 filledCu)
    {
        if (!_providers[msg.sender].registered) revert NotRegisteredProvider();
        _requireTradable(seriesId);
        if (cuAmount == 0) revert ZeroAmount();
        _checkPrice(askPriceUsdg);
        _checkMinNotional(cuAmount * askPriceUsdg);

        uint16 marginBps = requiredMarginBpsFor(msg.sender, seriesId);
        uint8 tier = vault.getProviderTier(msg.sender);
        uint256 margin = C.ceilDiv(cuAmount * askPriceUsdg * marginBps, C.BPS);
        usdg.safeTransferFrom(msg.sender, address(this), margin);

        lotId = ++lotCount;
        Lot storage lot = _lots[lotId];
        lot.seriesId = seriesId;
        lot.provider = msg.sender;
        lot.cuMinted = cuAmount;
        lot.cuUnsold = cuAmount;
        lot.askPrice = askPriceUsdg;
        lot.marginBps = marginBps;
        lot.tier = tier;
        lot.marginLocked = margin;
        _seriesLots[seriesId].push(lotId);
        unsoldCu[seriesId] += cuAmount;
        openLotsAtTier[msg.sender][tier] += 1;
        _syncStakeLock(msg.sender);

        series.mint(address(this), seriesId, cuAmount);
        emit LotMinted(lotId, seriesId, msg.sender, cuAmount, askPriceUsdg, marginBps, margin);

        filledCu = _matchAskAgainstBids(seriesId, msg.sender, cuAmount, askPriceUsdg, lotId);
        if (cuAmount > filledCu) {
            orderId = _newOrder(seriesId, msg.sender, false, false, askPriceUsdg, cuAmount - filledCu, 0, lotId);
            lot.askOrderId = orderId;
        }
    }

    // ------------------------------------------------------------------
    // Trading
    // ------------------------------------------------------------------

    /// @notice Buys up to `cuAmount` CU at or below `maxPriceUsdg` (price-time priority) and rests any
    ///         remainder as a bid. Discount mode charges 10 bps and burns the fee's 50% leg from the
    ///         buyer's own $WIF; standard mode charges 30 bps in USDG and burns via the buyback desk.
    function buySeriesOrPlaceBid(uint256 seriesId, uint256 cuAmount, uint256 maxPriceUsdg, bool useWifDiscount)
        external
        nonReentrant
        returns (uint256 filledCu, uint256 orderId)
    {
        _requireTradable(seriesId);
        if (cuAmount == 0) revert ZeroAmount();
        _checkPrice(maxPriceUsdg);
        if (useWifDiscount && !vault.hasWifFeeDiscount(msg.sender)) revert NotWifDiscountEligible();

        BuyCtx memory ctx = BuyCtx({
            seriesId: seriesId,
            buyer: msg.sender,
            remaining: cuAmount,
            maxPrice: maxPriceUsdg,
            filled: 0,
            notional: 0,
            primaryCost: 0,
            fills: 0
        });
        _matchBuy(ctx);
        if (ctx.primaryCost > 0) usdg.safeTransferFrom(msg.sender, address(this), ctx.primaryCost);
        if (ctx.filled > 0) {
            series.deskTransfer(address(this), msg.sender, seriesId, ctx.filled);
            _chargeTakerFee(msg.sender, seriesId, ctx.notional, useWifDiscount);
        }
        filledCu = ctx.filled;
        if (ctx.remaining > 0 && ctx.remaining * maxPriceUsdg < C.MIN_ORDER_NOTIONAL) {
            // A dust remainder never rests. A pure dust order that fills nothing is rejected outright.
            if (filledCu == 0) revert OrderTooSmall(ctx.remaining * maxPriceUsdg, C.MIN_ORDER_NOTIONAL);
        } else if (ctx.remaining > 0) {
            uint256 cost = ctx.remaining * maxPriceUsdg;
            uint256 escrow = cost + (cost * C.STANDARD_FEE_BPS) / C.BPS;
            usdg.safeTransferFrom(msg.sender, address(this), escrow);
            orderId = _newOrder(seriesId, msg.sender, true, useWifDiscount, maxPriceUsdg, ctx.remaining, escrow, 0);
        }
    }

    /// @notice Sells CU on the secondary market: hits resting bids at or above `priceUsdg`, rests the remainder.
    ///         The buyer (bid maker) pays the fee, so sellers receive the full trade price.
    function placeAsk(uint256 seriesId, uint256 cuAmount, uint256 priceUsdg)
        external
        nonReentrant
        returns (uint256 filledCu, uint256 orderId)
    {
        _requireTradable(seriesId);
        if (cuAmount == 0) revert ZeroAmount();
        _checkPrice(priceUsdg);
        series.deskTransfer(msg.sender, address(this), seriesId, cuAmount);
        filledCu = _matchAskAgainstBids(seriesId, msg.sender, cuAmount, priceUsdg, 0);
        uint256 rest = cuAmount - filledCu;
        if (rest > 0) {
            if (rest * priceUsdg >= C.MIN_ORDER_NOTIONAL) {
                orderId = _newOrder(seriesId, msg.sender, false, false, priceUsdg, rest, 0, 0);
            } else {
                if (filledCu == 0) revert OrderTooSmall(rest * priceUsdg, C.MIN_ORDER_NOTIONAL);
                series.deskTransfer(address(this), msg.sender, seriesId, rest); // dust remainder goes back
            }
        }
    }

    /// @notice Cancels a resting order. Bids refund escrow, asks return CU, primary asks burn unsold CU
    ///         and release the matching share of margin to the provider.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage o = _clob.orders[orderId];
        if (!o.active) revert OrderNotActive(orderId);
        if (o.maker != msg.sender) revert NotOrderMaker();
        if (o.lotId == 0) return _clob.cancelSecondary(usdg, series, orderId);
        uint256 qty = o.qtyRemaining;
        _clob.unlink(orderId);
        o.qtyRemaining = 0;
        _cancelPrimary(o.lotId, qty);
        emit OrderCancelled(orderId, o.seriesId, qty);
    }

    // ------------------------------------------------------------------
    // Mode A: cash settlement at the Compute Reference Index
    // ------------------------------------------------------------------

    /// @notice Settles CU purely financially at CRI-H100 so agents can hedge compute price spikes.
    ///         Payout is capped by the lot's escrowed principal plus margin; the residual returns to the provider.
    function settleCashAtIndex(uint256 seriesId, uint256 cuAmount) external nonReentrant returns (uint256 payoutUsdg) {
        SeriesInfo memory s = series.getSeries(seriesId);
        if (block.timestamp < s.deliveryStart || block.timestamp >= uint256(s.deliveryEnd) + C.SETTLEMENT_GRACE) {
            revert OutsideSettlementWindow();
        }
        if (criUpdatedAt == 0 || block.timestamp > uint256(criUpdatedAt) + maxIndexAge) revert StaleIndex();
        if (cuAmount == 0) revert ZeroAmount();

        uint256 lotId = _assignLot(seriesId, cuAmount, 0);
        address provider = _lots[lotId].provider;
        (uint256 principal, uint256 margin) = _takeLotShare(lotId, cuAmount);
        uint256 collateral = principal + margin;
        uint256 gross = cuAmount * criH100Usdg;
        uint256 settleValue = gross < collateral ? gross : collateral;
        uint256 fee =
            (settleValue * (vault.hasWifFeeDiscount(msg.sender) ? C.WIF_FEE_BPS : C.STANDARD_FEE_BPS)) / C.BPS;
        payoutUsdg = settleValue - fee;
        uint256 residual = collateral - settleValue;
        providerClaimableUsdg[provider] += residual;

        series.burn(msg.sender, seriesId, cuAmount);
        usdg.safeTransfer(msg.sender, payoutUsdg);
        if (fee > 0) {
            uint256 burned = vault.processProtocolFeeAndBurn(msg.sender, fee, 0, "CASH_SETTLEMENT");
            emit FeeCharged(msg.sender, seriesId, fee, burned, false);
        }
        emit CashSettled(seriesId, lotId, msg.sender, cuAmount, criH100Usdg, payoutUsdg, fee, residual);
    }

    // ------------------------------------------------------------------
    // Mode B: direct compute redemption
    // ------------------------------------------------------------------

    /// @param preferredLotId Provider lot to redeem against (0 = oldest lot with capacity).
    function requestRedemption(uint256 seriesId, uint256 cuAmount, uint256 preferredLotId, bytes32 deliveryRef)
        external
        nonReentrant
        returns (uint256 redemptionId)
    {
        SeriesInfo memory s = series.getSeries(seriesId);
        if (block.timestamp < s.deliveryStart || block.timestamp >= s.deliveryEnd) revert OutsideDeliveryWindow();
        if (cuAmount == 0) revert ZeroAmount();
        uint256 lotId = _assignLot(seriesId, cuAmount, preferredLotId);
        address provider = _lots[lotId].provider;
        (uint256 principal, uint256 margin) = _takeLotShare(lotId, cuAmount);
        series.deskTransfer(msg.sender, address(this), seriesId, cuAmount);

        redemptionId = ++redemptionCount;
        Redemption storage r = _redemptions[redemptionId];
        r.seriesId = seriesId;
        r.lotId = lotId;
        r.holder = msg.sender;
        r.provider = provider;
        r.cuAmount = cuAmount;
        r.principalUsdg = principal;
        r.marginUsdg = margin;
        r.state = RedemptionState.Requested;
        r.requestedAt = uint64(block.timestamp);
        r.ackDeadline = uint64(block.timestamp) + ackWindow;
        r.deliveryRef = deliveryRef;
        emit RedemptionRequested(
            redemptionId, seriesId, lotId, msg.sender, provider, cuAmount, principal, margin, r.ackDeadline
        );
    }

    function acknowledgeRedemption(uint256 redemptionId) external {
        Redemption storage r = _redemptions[redemptionId];
        if (r.provider != msg.sender) revert NotProvider();
        if (r.state != RedemptionState.Requested) revert InvalidState(r.state);
        if (block.timestamp > r.ackDeadline) revert DeadlinePassed();
        r.state = RedemptionState.Acknowledged;
        r.deliveryDeadline = uint64(block.timestamp) + deliveryWindow;
        emit RedemptionAcknowledged(redemptionId, r.deliveryDeadline);
    }

    /// @notice Posts the cryptographic execution receipt: a hash of the job log plus measured SLA telemetry.
    ///         If the provider registered an attestation signer, `attestationSig` must be its EIP-191 signature
    ///         over `deliveryReceiptDigest`.
    function deliverWithReceipt(
        uint256 redemptionId,
        bytes32 receiptHash,
        uint32 p95LatencyMs,
        uint16 uptimeBps,
        bytes calldata attestationSig
    ) external {
        Redemption storage r = _redemptions[redemptionId];
        if (r.provider != msg.sender) revert NotProvider();
        if (r.state != RedemptionState.Acknowledged) revert InvalidState(r.state);
        if (block.timestamp > r.deliveryDeadline) revert DeadlinePassed();
        if (receiptHash == bytes32(0)) revert EmptyReceipt();
        address signer = _providers[msg.sender].attestationSigner;
        if (signer != address(0)) {
            bytes32 digest = deliveryReceiptDigest(redemptionId, receiptHash, p95LatencyMs, uptimeBps);
            if (ParonSettlementLib.recover(digest, attestationSig) != signer) revert InvalidAttestation();
        }
        r.receiptHash = receiptHash;
        r.p95LatencyMs = p95LatencyMs;
        r.uptimeBps = uptimeBps;
        r.state = RedemptionState.Delivered;
        r.challengeDeadline = uint64(block.timestamp) + challengeWindow;
        bool breach = p95LatencyMs > C.SLA_MAX_P95_LATENCY_MS || uptimeBps < C.SLA_MIN_UPTIME_BPS;
        emit DeliveryReceiptPosted(redemptionId, receiptHash, p95LatencyMs, uptimeBps, breach, r.challengeDeadline);
    }

    /// @notice Holder accepts the delivery early; escrow and margin settle to the provider.
    function confirmDelivery(uint256 redemptionId) external nonReentrant {
        Redemption storage r = _redemptions[redemptionId];
        if (r.holder != msg.sender) revert NotHolder();
        if (r.state != RedemptionState.Delivered) revert InvalidState(r.state);
        _finalize(redemptionId);
    }

    /// @notice Anyone can finalize an unchallenged delivery after its challenge window.
    function finalizeDelivery(uint256 redemptionId) external nonReentrant {
        Redemption storage r = _redemptions[redemptionId];
        if (r.state != RedemptionState.Delivered) revert InvalidState(r.state);
        if (block.timestamp <= r.challengeDeadline) revert ChallengeWindowOpen();
        _finalize(redemptionId);
    }

    /// @notice Objective failure (no acknowledgement or no receipt by the deadline) slashes instantly, no vote needed.
    function claimMissedDeadline(uint256 redemptionId) external nonReentrant {
        Redemption storage r = _redemptions[redemptionId];
        bool missed = (r.state == RedemptionState.Requested && block.timestamp > r.ackDeadline)
            || (r.state == RedemptionState.Acknowledged && block.timestamp > r.deliveryDeadline);
        if (!missed) revert DeadlineNotPassed();
        _slash(redemptionId, false);
    }

    // ------------------------------------------------------------------
    // WifSlaJury hooks
    // ------------------------------------------------------------------

    function isDisputable(uint256 redemptionId) public view returns (bool) {
        Redemption storage r = _redemptions[redemptionId];
        return r.state == RedemptionState.Delivered && block.timestamp <= r.challengeDeadline;
    }

    function onDisputeOpened(uint256 redemptionId, uint256 disputeId) external onlyJury {
        if (!isDisputable(redemptionId)) revert InvalidState(_redemptions[redemptionId].state);
        Redemption storage r = _redemptions[redemptionId];
        r.state = RedemptionState.Disputed;
        r.disputeId = disputeId;
        emit RedemptionDisputed(redemptionId, disputeId);
    }

    function executeSlash(uint256 redemptionId) external onlyJury nonReentrant returns (uint256 voterRewardUsdg) {
        if (_redemptions[redemptionId].state != RedemptionState.Disputed) {
            revert InvalidState(_redemptions[redemptionId].state);
        }
        voterRewardUsdg = _slash(redemptionId, true);
    }

    function executeUphold(uint256 redemptionId) external onlyJury nonReentrant {
        if (_redemptions[redemptionId].state != RedemptionState.Disputed) {
            revert InvalidState(_redemptions[redemptionId].state);
        }
        _finalize(redemptionId);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Provider margin requirement for a series: $WIF tier, minus 2.5% when its corridor won the election.
    function requiredMarginBpsFor(address provider, uint256 seriesId) public view returns (uint16 bps) {
        bps = vault.getRequiredMarginBps(provider);
        if (address(jury) != address(0)) {
            (bool active, uint8 corridorId) = jury.currentBoostedCorridor();
            if (active && series.getSeries(seriesId).corridorId == corridorId) bps -= C.CORRIDOR_BOOST_MARGIN_BPS;
        }
    }

    function deliveryReceiptDigest(uint256 redemptionId, bytes32 receiptHash, uint32 p95LatencyMs, uint16 uptimeBps)
        public
        view
        returns (bytes32)
    {
        return ParonSettlementLib.receiptDigest(address(this), redemptionId, receiptHash, p95LatencyMs, uptimeBps);
    }

    function getProvider(address provider) external view returns (ProviderProfile memory) {
        return _providers[provider];
    }

    function getLot(uint256 lotId) external view returns (Lot memory) {
        return _lots[lotId];
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _clob.orders[orderId];
    }

    function orderCount() external view returns (uint256) {
        return _clob.orderCount;
    }


    function getRedemption(uint256 redemptionId) external view returns (Redemption memory) {
        return _redemptions[redemptionId];
    }

    /// @notice Aggregated depth, best price first.
    function getBookSide(uint256 seriesId, bool isBid, uint256 depth)
        external
        view
        returns (uint256[] memory prices, uint256[] memory qtys)
    {
        return _clob.bookSide(seriesId, isBid, depth);
    }

    function getSeriesMarket(uint256 seriesId) external view returns (SeriesMarket memory m) {
        (m.bestBid, m.bestAsk) = _clob.bestPrices(seriesId);
        m.lastTradePrice = _lastTradePrice[seriesId];
        m.volumeCu = _volumeCu[seriesId];
        m.volumeUsdg = _volumeUsdg[seriesId];
        m.tradeCount = _tradeCount[seriesId];
        m.unsoldCu = unsoldCu[seriesId];
        m.openInterestCu = series.totalSupply(seriesId) - m.unsoldCu;
    }

    /// @notice Pre-trade quote for `buySeriesOrPlaceBid` (ignores the per-tx fill cap and self-trade checks).
    function quoteBuy(uint256 seriesId, uint256 cuAmount, uint256 maxPriceUsdg, bool useWifDiscount)
        external
        view
        returns (uint256 fillableCu, uint256 notionalUsdg, uint256 feeUsdg, uint256 wifBurn)
    {
        (fillableCu, notionalUsdg) = _clob.quoteBuy(seriesId, cuAmount, maxPriceUsdg);
        feeUsdg = (notionalUsdg * (useWifDiscount ? C.WIF_FEE_BPS : C.STANDARD_FEE_BPS)) / C.BPS;
        if (useWifDiscount) {
            // Same two-step rounding as _chargeTakerFee: floor the burn leg, then convert it to $WIF.
            uint256 burnLeg = (feeUsdg * C.FEE_BURN_SHARE_BPS) / C.BPS;
            wifBurn = (burnLeg * C.WIF_UNIT) / vault.wifPriceUsdg();
        }
    }

    // ------------------------------------------------------------------
    // Matching engine
    // ------------------------------------------------------------------

    function _matchBuy(BuyCtx memory ctx) private {
        while (ctx.remaining > 0 && ctx.fills < C.MAX_FILLS_PER_TX) {
            (uint256 price, uint256 oid) = _clob.head(ctx.seriesId, false);
            if (oid == 0 || price > ctx.maxPrice) break;
            Order storage o = _clob.orders[oid];
            address maker = o.maker;
            uint256 lotId = o.lotId;
            if (maker == ctx.buyer) revert SelfTrade();
            uint256 take = ctx.remaining < o.qtyRemaining ? ctx.remaining : o.qtyRemaining;
            uint256 cost = take * price;
            bool done = _clob.fill(oid, take);
            if (lotId != 0) {
                _sellPrimary(lotId, take, cost);
                ctx.primaryCost += cost;
                if (done) _lots[lotId].askOrderId = 0;
            } else {
                usdg.safeTransferFrom(ctx.buyer, maker, cost);
            }
            _recordTrade(ctx.seriesId, oid, maker, ctx.buyer, true, price, take, lotId);
            ctx.remaining -= take;
            ctx.filled += take;
            ctx.notional += cost;
            ctx.fills += 1;
        }
    }

    function _matchAskAgainstBids(uint256 seriesId, address seller, uint256 qty, uint256 minPrice, uint256 lotId)
        private
        returns (uint256 filled)
    {
        uint256 fills;
        while (qty > filled && fills < C.MAX_FILLS_PER_TX) {
            (uint256 price, uint256 oid) = _clob.head(seriesId, true);
            if (oid == 0 || price < minPrice) break;
            Order storage o = _clob.orders[oid];
            address bidder = o.maker;
            if (bidder == seller) revert SelfTrade();
            uint256 take = qty - filled < o.qtyRemaining ? qty - filled : o.qtyRemaining;
            uint256 cost = take * price;
            uint256 fee = (cost * (o.wifDiscount && vault.hasWifFeeDiscount(bidder) ? C.WIF_FEE_BPS : C.STANDARD_FEE_BPS))
                / C.BPS;
            o.escrowUsdg -= cost + fee;
            bool done = _clob.fill(oid, take);
            if (lotId != 0) {
                _sellPrimary(lotId, take, cost);
            } else {
                usdg.safeTransfer(seller, cost);
            }
            series.deskTransfer(address(this), bidder, seriesId, take);
            _recordTrade(seriesId, oid, bidder, seller, false, price, take, lotId);
            if (fee > 0) {
                uint256 burned = vault.processProtocolFeeAndBurn(bidder, fee, 0, "TRADE_FEE");
                emit FeeCharged(bidder, seriesId, fee, burned, false);
            }
            if (done) {
                uint256 refund = o.escrowUsdg;
                o.escrowUsdg = 0;
                if (refund > 0) usdg.safeTransfer(bidder, refund);
            }
            filled += take;
            fills += 1;
        }
    }

    function _chargeTakerFee(address payer, uint256 seriesId, uint256 notional, bool wifMode) private {
        uint256 fee = (notional * (wifMode ? C.WIF_FEE_BPS : C.STANDARD_FEE_BPS)) / C.BPS;
        if (fee == 0) return;
        uint256 wifBurn;
        if (wifMode) {
            uint256 burnLeg = (fee * C.FEE_BURN_SHARE_BPS) / C.BPS;
            wifBurn = (burnLeg * C.WIF_UNIT) / vault.wifPriceUsdg();
            if (wifBurn > 0) {
                wif.safeTransferFrom(payer, address(this), wifBurn);
                usdg.safeTransferFrom(payer, address(this), fee - burnLeg);
            }
        }
        if (wifBurn == 0) usdg.safeTransferFrom(payer, address(this), fee);
        uint256 burned =
            vault.processProtocolFeeAndBurn(payer, fee, wifBurn, wifBurn > 0 ? "TRADE_FEE_WIF" : "TRADE_FEE");
        emit FeeCharged(payer, seriesId, fee, burned, wifBurn > 0);
    }

    function _sellPrimary(uint256 lotId, uint256 qty, uint256 cost) private {
        Lot storage lot = _lots[lotId];
        lot.cuUnsold -= qty;
        lot.cuOutstanding += qty;
        lot.escrowUsdg += cost;
        unsoldCu[lot.seriesId] -= qty;
    }

    function _recordTrade(
        uint256 seriesId,
        uint256 makerOrderId,
        address maker,
        address taker,
        bool takerIsBuyer,
        uint256 price,
        uint256 qty,
        uint256 lotId
    ) private {
        _lastTradePrice[seriesId] = price;
        _volumeCu[seriesId] += qty;
        _volumeUsdg[seriesId] += qty * price;
        _tradeCount[seriesId] += 1;
        emit Trade(seriesId, makerOrderId, maker, taker, takerIsBuyer, price, qty, lotId);
    }

    function _newOrder(
        uint256 seriesId,
        address maker,
        bool isBid,
        bool wifDiscount,
        uint256 price,
        uint256 qty,
        uint256 escrow,
        uint256 lotId
    ) private returns (uint256 orderId) {
        uint8 lane = vault.hasWifFeeDiscount(maker) ? 0 : 1;
        _clob.evictForBetterPrice(usdg, series, seriesId, isBid, price);
        orderId = _clob.place(seriesId, maker, isBid, wifDiscount, lane, price, qty, escrow, lotId);
        emit OrderPlaced(orderId, seriesId, maker, isBid, price, qty, lotId, lane);
    }

    // ------------------------------------------------------------------
    // Lot accounting
    // ------------------------------------------------------------------

    function _assignLot(uint256 seriesId, uint256 cuAmount, uint256 preferredLotId) private returns (uint256) {
        if (preferredLotId != 0) {
            Lot storage p = _lots[preferredLotId];
            if (p.seriesId != seriesId || p.cuOutstanding < cuAmount) revert LotCapacity(preferredLotId);
            return preferredLotId;
        }
        uint256[] storage ids = _seriesLots[seriesId];
        uint256 n = ids.length;
        uint256 scanned;
        for (uint256 i = _lotCursor[seriesId]; i < n && scanned < C.MAX_LOT_SCAN; ++i) {
            Lot storage lot = _lots[ids[i]];
            if (lot.closed && i == _lotCursor[seriesId]) {
                _lotCursor[seriesId] = i + 1;
                continue;
            }
            if (lot.cuOutstanding >= cuAmount) return ids[i];
            ++scanned;
        }
        revert NoLotCapacity(seriesId, cuAmount);
    }

    /// @dev Moves a pro-rata slice of escrowed principal and locked margin out of a lot.
    function _takeLotShare(uint256 lotId, uint256 cuAmount) private returns (uint256 principal, uint256 margin) {
        Lot storage lot = _lots[lotId];
        principal = (lot.escrowUsdg * cuAmount) / lot.cuOutstanding;
        margin = (lot.marginLocked * cuAmount) / (lot.cuOutstanding + lot.cuUnsold);
        lot.escrowUsdg -= principal;
        lot.marginLocked -= margin;
        lot.cuOutstanding -= cuAmount;
        if (lot.cuOutstanding == 0 && lot.cuUnsold == 0) _closeLot(lotId);
    }

    function _cancelPrimary(uint256 lotId, uint256 qty) private {
        Lot storage lot = _lots[lotId];
        uint256 release = (lot.marginLocked * qty) / (lot.cuOutstanding + lot.cuUnsold);
        lot.marginLocked -= release;
        lot.cuUnsold -= qty;
        lot.askOrderId = 0;
        unsoldCu[lot.seriesId] -= qty;
        series.burn(address(this), lot.seriesId, qty);
        providerClaimableUsdg[lot.provider] += release;
        if (lot.cuOutstanding == 0 && lot.cuUnsold == 0) _closeLot(lotId);
    }

    function _closeLot(uint256 lotId) private {
        Lot storage lot = _lots[lotId];
        if (lot.closed) return;
        lot.closed = true;
        uint256 residual = lot.marginLocked + lot.escrowUsdg;
        if (residual > 0) {
            lot.marginLocked = 0;
            lot.escrowUsdg = 0;
            providerClaimableUsdg[lot.provider] += residual;
        }
        openLotsAtTier[lot.provider][lot.tier] -= 1;
        _syncStakeLock(lot.provider);
    }

    function _syncStakeLock(address provider) private {
        ParonSettlementLib.syncStakeLock(openLotsAtTier, vault, provider);
    }

    // ------------------------------------------------------------------
    // Redemption settlement
    // ------------------------------------------------------------------

    function _finalize(uint256 redemptionId) private {
        Redemption storage r = _redemptions[redemptionId];
        ParonSettlementLib.finalize(r, _providers[r.provider], providerClaimableUsdg, series, redemptionId);
    }

    function _slash(uint256 redemptionId, bool viaJury) private returns (uint256 voterShare) {
        Redemption storage r = _redemptions[redemptionId];
        ParonSettlementLib.Env memory env =
            ParonSettlementLib.Env({series: series, usdg: usdg, vault: vault, jury: address(jury)});
        voterShare = ParonSettlementLib.slash(r, _providers[r.provider], env, redemptionId, viaJury);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _requireTradable(uint256 seriesId) private view {
        SeriesInfo memory s = series.getSeries(seriesId);
        if (block.timestamp >= s.deliveryEnd) revert SeriesNotTradable(seriesId);
    }

    function _checkMinNotional(uint256 notional) private pure {
        if (notional < C.MIN_ORDER_NOTIONAL) revert OrderTooSmall(notional, C.MIN_ORDER_NOTIONAL);
    }

    function _checkPrice(uint256 price) private pure {
        if (price == 0 || price % C.PRICE_TICK != 0) revert InvalidPrice();
    }
}
