// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IWifToken} from "./interfaces/IParonWif.sol";
import {ParonWifConstants as C} from "./libraries/ParonWifConstants.sol";
import {FlywheelStats} from "./libraries/ParonWifTypes.sol";

/// @title WifFlywheelVault ("The Paron Vault")
/// @notice The $WIF burn engine and capital-efficiency vault behind every Paron WIF loop.
///  - Loop 1: routes every protocol fee 50% to a permanent $WIF burn, 30% to the SLA jury pool,
///    20% to $WIF stakers as provider rebates.
///  - Loop 2: providers stake $WIF to cut their cash margin from 50% to 35% (25k) or 25% (100k).
///  - Loop 3: funds burn-to-vote jurors with USDG and bonus $WIF ("participation should have upside").
/// @dev USDG-paid fee burn legs are executed by the buyback desk: fee USDG buys $WIF from the
///      protocol buyback reserve at the reference price and burns it in the same transaction.
///      Anyone can also sell $WIF into the buyback pool, where it is burned on arrival.
contract WifFlywheelVault is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable wif;
    IERC20 public immutable usdg;
    /// @notice true: burns call `burn()` and shrink totalSupply. false: burns go to 0x...dEaD.
    bool public immutable nativeBurn;

    address public treasury;
    address public priceOracle;
    /// @notice Reference price in USDG (6 decimals) for 1 $WIF. Testnet: oracle-posted. Mainnet: DEX TWAP keeper.
    uint256 public wifPriceUsdg;

    address public desk;
    address public jury;

    // Loop 2 staking
    mapping(address account => uint256 amount) public stakedWif;
    mapping(address account => uint256 amount) public stakeLock;
    uint256 public totalWifStaked;

    // Provider rebate stream (USDG per staked $WIF, REBATE_PRECISION fixed point)
    uint256 public rebatePerWifStored;
    mapping(address account => uint256 paid) public rebatePerWifPaid;
    mapping(address account => uint256 amount) public rebateAccrued;

    // Pools
    uint256 public juryRewardPoolUsdg;
    uint256 public buybackUsdgPool;
    uint256 public buybackReserveWif;
    uint256 public juryBonusWifPool;

    // Telemetry
    uint256 public totalWifBurnedByParon;
    uint256 public totalFeesUsdg;
    uint256 public totalRebatesDistributedUsdg;
    uint256 public burnCount;

    event ModulesSet(address indexed desk, address indexed jury);
    event TreasuryUpdated(address indexed treasury);
    event PriceOracleUpdated(address indexed oracle);
    event WifPriceUpdated(uint256 priceUsdg);
    event WifStaked(address indexed account, uint256 amount, uint256 stakedTotal, uint8 tier);
    event WifUnstaked(address indexed account, uint256 amount, uint256 stakedTotal, uint8 tier);
    event StakeLockUpdated(address indexed provider, uint256 lockAmount);
    event WifFlywheelBurned(
        address indexed actor, uint256 wifBurned, uint256 totalWifBurned, uint256 vaultUsdgAdded, string reason
    );
    event ProtocolFeeRouted(
        address indexed payer, uint256 usdgFee, uint256 burnLeg, uint256 juryLeg, uint256 providerLeg, bool wifMode
    );
    event SlashProceedsRouted(address indexed provider, uint256 burnUsdg, uint256 vaultUsdg, uint256 wifBurned);
    event ProviderRebateClaimed(address indexed account, uint256 amount);
    event BuybackReserveFunded(address indexed from, uint256 amount);
    event JuryBonusFunded(address indexed from, uint256 amount);
    event JuryRewardPoolFunded(address indexed from, uint256 amount);
    event JuryRewardDrawn(uint256 amount, uint256 poolAfter);
    event JuryBonusDrawn(uint256 amount, uint256 poolAfter);
    event WifSoldToBuyback(address indexed seller, uint256 wifAmount, uint256 usdgOut);

    error ZeroAddress();
    error ZeroAmount();
    error ModulesAlreadySet();
    error NotModule();
    error NotJury();
    error NotDesk();
    error NotOracle();
    error InvalidPrice();
    error InsufficientStake(uint256 staked, uint256 requested);
    error StakeLocked(uint256 lockAmount);
    error InsufficientBuybackPool(uint256 available, uint256 needed);
    error Slippage(uint256 out, uint256 minOut);

    modifier onlyModule() {
        if (msg.sender != desk && msg.sender != jury) revert NotModule();
        _;
    }

    constructor(address owner_, address wif_, address usdg_, bool nativeBurn_, address treasury_, uint256 wifPrice_)
        Ownable(owner_)
    {
        if (wif_ == address(0) || usdg_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (wifPrice_ == 0) revert InvalidPrice();
        wif = IERC20(wif_);
        usdg = IERC20(usdg_);
        nativeBurn = nativeBurn_;
        treasury = treasury_;
        priceOracle = owner_;
        wifPriceUsdg = wifPrice_;
    }

    // ------------------------------------------------------------------
    // Governance
    // ------------------------------------------------------------------

    function setModules(address desk_, address jury_) external onlyOwner {
        if (desk != address(0)) revert ModulesAlreadySet();
        if (desk_ == address(0) || jury_ == address(0)) revert ZeroAddress();
        desk = desk_;
        jury = jury_;
        emit ModulesSet(desk_, jury_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setPriceOracle(address oracle) external onlyOwner {
        if (oracle == address(0)) revert ZeroAddress();
        priceOracle = oracle;
        emit PriceOracleUpdated(oracle);
    }

    function setWifPrice(uint256 priceUsdg) external {
        if (msg.sender != priceOracle) revert NotOracle();
        if (priceUsdg == 0) revert InvalidPrice();
        wifPriceUsdg = priceUsdg;
        emit WifPriceUpdated(priceUsdg);
    }

    // ------------------------------------------------------------------
    // Loop 2: $WIF-boosted margin staking
    // ------------------------------------------------------------------

    function stakeWifForMarginBoost(uint256 amount) external nonReentrant {
        _stake(msg.sender, msg.sender, amount);
    }

    /// @notice Desk hook for `registerProviderAndStakeWif`. $WIF is pulled from the desk, credited to `account`.
    function stakeWifFor(address account, uint256 amount) external nonReentrant {
        if (msg.sender != desk) revert NotDesk();
        _stake(msg.sender, account, amount);
    }

    function unstakeWif(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 staked = stakedWif[msg.sender];
        if (amount > staked) revert InsufficientStake(staked, amount);
        uint256 lockAmount = stakeLock[msg.sender];
        if (staked - amount < lockAmount) revert StakeLocked(lockAmount);
        _accrue(msg.sender);
        stakedWif[msg.sender] = staked - amount;
        totalWifStaked -= amount;
        wif.safeTransfer(msg.sender, amount);
        emit WifUnstaked(msg.sender, amount, staked - amount, getProviderTier(msg.sender));
    }

    /// @notice Desk keeps a provider's tier stake locked while lots minted at that tier are open,
    ///         so one $WIF stake can never qualify several providers.
    function setStakeLock(address provider, uint256 lockAmount) external {
        if (msg.sender != desk) revert NotDesk();
        stakeLock[provider] = lockAmount;
        emit StakeLockUpdated(provider, lockAmount);
    }

    function claimProviderRebate() external nonReentrant returns (uint256 amount) {
        _accrue(msg.sender);
        amount = rebateAccrued[msg.sender];
        if (amount == 0) revert ZeroAmount();
        rebateAccrued[msg.sender] = 0;
        usdg.safeTransfer(msg.sender, amount);
        emit ProviderRebateClaimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Loop 1: fee routing and buy-and-burn
    // ------------------------------------------------------------------

    /// @notice Routes a protocol fee through the flywheel. The calling module must have approved this vault.
    /// @param payer The trader or agent who paid the fee (telemetry only).
    /// @param usdgFee Fee value in USDG. Legs: 50% burn, 30% jury pool, 20% staker rebates.
    /// @param wifBurnAmount When > 0 the payer settled the 50% burn leg in $WIF (discount mode) and the module
    ///        forwards exactly `usdgFee - burnLeg` USDG. When 0 the module forwards the full `usdgFee` in USDG and
    ///        the burn leg is executed by the buyback desk.
    function processProtocolFeeAndBurn(address payer, uint256 usdgFee, uint256 wifBurnAmount, string calldata reason)
        external
        onlyModule
        nonReentrant
        returns (uint256 wifBurned)
    {
        if (usdgFee == 0) return 0;
        uint256 burnLeg = (usdgFee * C.FEE_BURN_SHARE_BPS) / C.BPS;
        uint256 juryLeg = (usdgFee * C.FEE_JURY_SHARE_BPS) / C.BPS;
        uint256 providerLeg = usdgFee - burnLeg - juryLeg;
        bool wifMode = wifBurnAmount > 0;

        usdg.safeTransferFrom(msg.sender, address(this), wifMode ? usdgFee - burnLeg : usdgFee);
        totalFeesUsdg += usdgFee;
        juryRewardPoolUsdg += juryLeg;
        _distributeRebate(providerLeg);

        if (wifMode) {
            wif.safeTransferFrom(msg.sender, address(this), wifBurnAmount);
            _burnHeld(wifBurnAmount);
            _recordBurn(payer, wifBurnAmount, juryLeg + providerLeg, reason);
            wifBurned = wifBurnAmount;
        } else {
            wifBurned = _buybackAndBurn(payer, burnLeg, juryLeg + providerLeg, reason);
        }
        emit ProtocolFeeRouted(payer, usdgFee, burnLeg, juryLeg, providerLeg, wifMode);
    }

    /// @notice Routes slashed provider margin: `burnUsdg` buys back and burns $WIF, `vaultUsdg` refills the jury pool.
    function processSlashProceeds(address provider, uint256 burnUsdg, uint256 vaultUsdg, string calldata reason)
        external
        onlyModule
        nonReentrant
        returns (uint256 wifBurned)
    {
        uint256 total = burnUsdg + vaultUsdg;
        if (total == 0) return 0;
        usdg.safeTransferFrom(msg.sender, address(this), total);
        juryRewardPoolUsdg += vaultUsdg;
        wifBurned = _buybackAndBurn(provider, burnUsdg, vaultUsdg, reason);
        emit SlashProceedsRouted(provider, burnUsdg, vaultUsdg, wifBurned);
    }

    /// @notice Records a burn a module executed directly (jury votes, dispute filings, corridor votes).
    function recordWifBurn(address actor, uint256 amount, string calldata reason) external onlyModule {
        if (amount == 0) return;
        _recordBurn(actor, amount, 0, reason);
    }

    /// @notice Permissionless buyback: sell $WIF to the fee-funded pool at the reference price (1% haircut).
    ///         Every $WIF sold here is burned on arrival.
    function sellWifToBuyback(uint256 wifAmount, uint256 minUsdgOut) external nonReentrant returns (uint256 usdgOut) {
        if (wifAmount == 0) revert ZeroAmount();
        uint256 gross = (wifAmount * wifPriceUsdg) / C.WIF_UNIT;
        usdgOut = (gross * (C.BPS - C.BUYBACK_SELL_DISCOUNT_BPS)) / C.BPS;
        if (usdgOut == 0) revert ZeroAmount();
        if (usdgOut < minUsdgOut) revert Slippage(usdgOut, minUsdgOut);
        if (usdgOut > buybackUsdgPool) revert InsufficientBuybackPool(buybackUsdgPool, usdgOut);
        buybackUsdgPool -= usdgOut;
        wif.safeTransferFrom(msg.sender, address(this), wifAmount);
        _burnHeld(wifAmount);
        usdg.safeTransfer(msg.sender, usdgOut);
        _recordBurn(msg.sender, wifAmount, 0, "BUYBACK_SELL");
        emit WifSoldToBuyback(msg.sender, wifAmount, usdgOut);
    }

    /// @notice Stocks the buyback reserve that USDG-paid fee burn legs consume. Flushes any queued buyback.
    function fundBuybackReserve(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        wif.safeTransferFrom(msg.sender, address(this), amount);
        buybackReserveWif += amount;
        emit BuybackReserveFunded(msg.sender, amount);
        _buybackAndBurn(msg.sender, 0, 0, "BUYBACK_FLUSH");
    }

    function fundJuryBonusWif(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        wif.safeTransferFrom(msg.sender, address(this), amount);
        juryBonusWifPool += amount;
        emit JuryBonusFunded(msg.sender, amount);
    }

    /// @notice Sponsors (treasury, grants, integrators) can top up the juror upside pool.
    function fundJuryRewardPool(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        juryRewardPoolUsdg += amount;
        emit JuryRewardPoolFunded(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Loop 3 hooks (jury only)
    // ------------------------------------------------------------------

    function drawJuryReward(uint256 bps) external nonReentrant returns (uint256 usdgOut) {
        if (msg.sender != jury) revert NotJury();
        usdgOut = (juryRewardPoolUsdg * bps) / C.BPS;
        if (usdgOut == 0) return 0;
        juryRewardPoolUsdg -= usdgOut;
        usdg.safeTransfer(msg.sender, usdgOut);
        emit JuryRewardDrawn(usdgOut, juryRewardPoolUsdg);
    }

    function drawJuryBonusWif(uint256 wifWanted) external nonReentrant returns (uint256 wifOut) {
        if (msg.sender != jury) revert NotJury();
        wifOut = wifWanted < juryBonusWifPool ? wifWanted : juryBonusWifPool;
        if (wifOut == 0) return 0;
        juryBonusWifPool -= wifOut;
        wif.safeTransfer(msg.sender, wifOut);
        emit JuryBonusDrawn(wifOut, juryBonusWifPool);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getProviderTier(address provider) public view returns (uint8) {
        uint256 staked = stakedWif[provider];
        if (staked >= C.TIER2_STAKE) return 2;
        if (staked >= C.TIER1_STAKE) return 1;
        return 0;
    }

    /// @notice Required cash margin in bps: 5000 (Tier 0), 3500 (Tier 1, 25k $WIF), 2500 (Tier 2 Prime, 100k $WIF).
    function getRequiredMarginBps(address provider) external view returns (uint16) {
        uint8 tier = getProviderTier(provider);
        if (tier == 2) return C.MARGIN_TIER2_BPS;
        if (tier == 1) return C.MARGIN_TIER1_BPS;
        return C.MARGIN_TIER0_BPS;
    }

    /// @notice true when `trader` holds or stakes at least 10,000 $WIF (10 bps instead of 30 bps).
    function hasWifFeeDiscount(address trader) external view returns (bool) {
        return wif.balanceOf(trader) + stakedWif[trader] >= C.FEE_DISCOUNT_THRESHOLD;
    }

    function earnedRebate(address account) public view returns (uint256) {
        return rebateAccrued[account]
            + (stakedWif[account] * (rebatePerWifStored - rebatePerWifPaid[account])) / C.REBATE_PRECISION;
    }

    function quoteWifForUsdg(uint256 usdgAmount) external view returns (uint256) {
        return (usdgAmount * C.WIF_UNIT) / wifPriceUsdg;
    }

    function getFlywheelStats() external view returns (FlywheelStats memory s) {
        s.totalWifBurned = totalWifBurnedByParon;
        s.totalWifStaked = totalWifStaked;
        s.juryRewardPoolUsdg = juryRewardPoolUsdg;
        s.buybackUsdgPool = buybackUsdgPool;
        s.buybackReserveWif = buybackReserveWif;
        s.juryBonusWifPool = juryBonusWifPool;
        s.totalFeesUsdg = totalFeesUsdg;
        s.totalRebatesDistributedUsdg = totalRebatesDistributedUsdg;
        s.wifPriceUsdg = wifPriceUsdg;
        s.burnCount = burnCount;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _stake(address from, address account, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        _accrue(account);
        wif.safeTransferFrom(from, address(this), amount);
        stakedWif[account] += amount;
        totalWifStaked += amount;
        emit WifStaked(account, amount, stakedWif[account], getProviderTier(account));
    }

    function _accrue(address account) private {
        uint256 stored = rebatePerWifStored;
        uint256 paid = rebatePerWifPaid[account];
        if (stored != paid) {
            rebateAccrued[account] += (stakedWif[account] * (stored - paid)) / C.REBATE_PRECISION;
            rebatePerWifPaid[account] = stored;
        }
    }

    function _distributeRebate(uint256 amount) private {
        if (amount == 0) return;
        if (totalWifStaked == 0) {
            juryRewardPoolUsdg += amount;
            return;
        }
        rebatePerWifStored += (amount * C.REBATE_PRECISION) / totalWifStaked;
        totalRebatesDistributedUsdg += amount;
    }

    /// @dev Adds `usdgAmount` to the buyback pool, then burns as much reserve $WIF as the pool can buy.
    function _buybackAndBurn(address actor, uint256 usdgAmount, uint256 vaultUsdgAdded, string memory reason)
        private
        returns (uint256 wifToBurn)
    {
        buybackUsdgPool += usdgAmount;
        uint256 price = wifPriceUsdg;
        uint256 wifWanted = (buybackUsdgPool * C.WIF_UNIT) / price;
        wifToBurn = wifWanted < buybackReserveWif ? wifWanted : buybackReserveWif;
        if (wifToBurn == 0) return 0;
        uint256 usdgSpent = (wifToBurn * price) / C.WIF_UNIT;
        buybackUsdgPool -= usdgSpent;
        buybackReserveWif -= wifToBurn;
        if (usdgSpent > 0) usdg.safeTransfer(treasury, usdgSpent);
        _burnHeld(wifToBurn);
        _recordBurn(actor, wifToBurn, vaultUsdgAdded, reason);
    }

    function _burnHeld(uint256 amount) private {
        if (nativeBurn) {
            IWifToken(address(wif)).burn(amount);
        } else {
            wif.safeTransfer(C.DEAD, amount);
        }
    }

    function _recordBurn(address actor, uint256 amount, uint256 vaultUsdgAdded, string memory reason) private {
        totalWifBurnedByParon += amount;
        burnCount += 1;
        emit WifFlywheelBurned(actor, amount, totalWifBurnedByParon, vaultUsdgAdded, reason);
    }
}
