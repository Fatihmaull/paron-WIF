// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WifTokenMock} from "../src/WifTokenMock.sol";
import {UsdgMock} from "../src/UsdgMock.sol";
import {ParonSeriesToken} from "../src/ParonSeriesToken.sol";
import {WifFlywheelVault} from "../src/WifFlywheelVault.sol";
import {WifSlaJury} from "../src/WifSlaJury.sol";
import {ParonExchangeDesk} from "../src/ParonExchangeDesk.sol";
import {ComputeReferenceIndex} from "../src/ComputeReferenceIndex.sol";
import {GpuTier} from "../src/libraries/ParonWifTypes.sol";

/// @title DeployParonWif
/// @notice Deterministic deployment of the Paron WIF protocol plus a pre-seeded market.
/// @dev Usage (see README "Deploy"):
///        forge script script/DeployParonWif.s.sol --rpc-url $RPC_URL --broadcast
///      Env (all optional except PARON_DEPLOYER_PK):
///        WIF_TOKEN_ADDRESS   existing $WIF (default: deploy WifTokenMock)
///        WIF_NATIVE_BURN     true if $WIF exposes burn()/burnFrom() (default: true for the mock, false otherwise -> 0x...dEaD)
///        USDG_TOKEN_ADDRESS  existing USDG (default: deploy UsdgMock)
///        TREASURY_ADDRESS, INDEX_ATTESTORS (comma-separated CRI attestors, default: deployer), CRI_QUORUM (default 1)
///        WIF_PRICE_USDG (default 500 = $0.0005), CRI_H100_USDG (default 2200000 = $2.20)
///        SEED_MARKET (default true; needs mock tokens or a funded deployer)
///      Writes deployments/<chainId>.json, consumed by the indexer and the web app.
contract DeployParonWif is Script {
    struct Deployment {
        address wif;
        address usdg;
        address criOracle;
        address seriesToken;
        address vault;
        address desk;
        address jury;
        bool wifIsMock;
        bool usdgIsMock;
        bool nativeBurn;
        uint256 seriesJkt;
        uint256 seriesBtm;
        uint256 seriesSgp;
    }

    uint64 internal constant VOTING_PERIOD = 15 minutes;
    uint64 internal constant EPOCH_LENGTH = 7 days;
    uint64 internal constant ACK_WINDOW = 2 hours;
    uint64 internal constant DELIVERY_WINDOW = 24 hours;
    uint64 internal constant CHALLENGE_WINDOW = 6 hours;
    uint64 internal constant MAX_INDEX_AGE = 30 days;
    uint16 internal constant CRI_MAX_STEP_BPS = 1_000; // each publication moves the index at most +-10%
    uint64 internal constant CRI_MIN_INTERVAL = 1 hours;
    uint64 internal constant CRI_WINDOW = 6 hours;

    function run() external returns (Deployment memory d) {
        uint256 pk = vm.envUint("PARON_DEPLOYER_PK");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address[] memory defaultAttestors = new address[](1);
        defaultAttestors[0] = deployer;
        address[] memory attestors = vm.envOr("INDEX_ATTESTORS", ",", defaultAttestors);
        uint8 quorum = uint8(vm.envOr("CRI_QUORUM", uint256(1)));
        uint256 wifPrice = vm.envOr("WIF_PRICE_USDG", uint256(500));
        uint256 cri = vm.envOr("CRI_H100_USDG", uint256(2_200_000));
        address wifEnv = vm.envOr("WIF_TOKEN_ADDRESS", address(0));
        address usdgEnv = vm.envOr("USDG_TOKEN_ADDRESS", address(0));
        d.wifIsMock = wifEnv == address(0);
        d.usdgIsMock = usdgEnv == address(0);
        d.nativeBurn = vm.envOr("WIF_NATIVE_BURN", d.wifIsMock);

        vm.startBroadcast(pk);
        d.wif = d.wifIsMock ? address(new WifTokenMock(deployer, 0)) : wifEnv;
        d.usdg = d.usdgIsMock ? address(new UsdgMock(deployer, 0)) : usdgEnv;
        ParonSeriesToken seriesToken = new ParonSeriesToken(deployer, "ipfs://paron-wif/series/{id}.json");
        WifFlywheelVault vault = new WifFlywheelVault(deployer, d.wif, d.usdg, d.nativeBurn, treasury, wifPrice);
        ComputeReferenceIndex criOracle =
            new ComputeReferenceIndex(deployer, attestors, quorum, CRI_MAX_STEP_BPS, CRI_MIN_INTERVAL, CRI_WINDOW);
        d.criOracle = address(criOracle);
        ParonExchangeDesk desk = new ParonExchangeDesk(
            address(seriesToken),
            address(vault),
            d.usdg,
            d.wif,
            address(criOracle),
            ACK_WINDOW,
            DELIVERY_WINDOW,
            CHALLENGE_WINDOW,
            MAX_INDEX_AGE
        );
        WifSlaJury jury = new WifSlaJury(
            d.wif, d.usdg, d.nativeBurn, address(vault), address(desk), address(seriesToken), VOTING_PERIOD, EPOCH_LENGTH
        );
        desk.setJury(address(jury));
        vault.setModules(address(desk), address(jury));
        seriesToken.setDesk(address(desk));

        seriesToken.registerCorridor("JKT", "Jakarta H100");
        seriesToken.registerCorridor("BTM", "Batam-Singapore H200");
        seriesToken.registerCorridor("JHB", "Johor B200");
        seriesToken.registerCorridor("SGP", "Singapore GB200");
        (uint16 thisMonth, uint16 nextMonth) = _deliveryMonths(block.timestamp);
        d.seriesJkt = seriesToken.createSeries(0, GpuTier.H100, thisMonth);
        d.seriesBtm = seriesToken.createSeries(1, GpuTier.H200, thisMonth);
        d.seriesSgp = seriesToken.createSeries(3, GpuTier.B200, nextMonth);
        // The first publication needs the quorum. With the default single-attestor testnet setup the deployer seeds it;
        // with several attestors they submit their own prices after deployment.
        if (attestors.length == 1 && attestors[0] == deployer && quorum == 1) {
            criOracle.submit(cri, keccak256(abi.encode("CRI-H100", block.timestamp, cri)));
        }

        d.seriesToken = address(seriesToken);
        d.vault = address(vault);
        d.desk = address(desk);
        d.jury = address(jury);

        if (vm.envOr("SEED_MARKET", true) && d.wifIsMock && d.usdgIsMock) {
            _seed(d, deployer);
        }
        vm.stopBroadcast();

        _writeManifest(d, deployer, treasury, attestors, quorum, wifPrice);
        console2.log("ParonExchangeDesk", d.desk);
        console2.log("WifFlywheelVault", d.vault);
        console2.log("WifSlaJury", d.jury);
    }

    /// @dev Genesis liquidity from the deployer acting as the Paron market-making desk: a Tier-2 Prime
    ///      provider stake, primary asks on every canonical series, resting bids below them, a stocked
    ///      buyback reserve and a juror upside pool.
    function _seed(Deployment memory d, address deployer) internal {
        WifTokenMock wif = WifTokenMock(d.wif);
        UsdgMock usdg = UsdgMock(d.usdg);
        WifFlywheelVault vault = WifFlywheelVault(d.vault);
        ParonExchangeDesk desk = ParonExchangeDesk(d.desk);

        wif.mint(deployer, 5_000_000e18);
        usdg.mint(deployer, 250_000e6);
        IERC20(d.wif).approve(d.vault, type(uint256).max);
        IERC20(d.wif).approve(d.desk, type(uint256).max);
        IERC20(d.wif).approve(d.jury, type(uint256).max);
        IERC20(d.usdg).approve(d.vault, type(uint256).max);
        IERC20(d.usdg).approve(d.desk, type(uint256).max);

        vault.fundBuybackReserve(2_000_000e18);
        vault.fundJuryBonusWif(250_000e18);
        vault.fundJuryRewardPool(500e6);
        desk.registerProviderAndStakeWif("ipfs://paron-wif/providers/genesis-market-maker", 250_000e18);

        // Primary asks (H100-equivalent USDG per CU)
        desk.mintPrimarySeries(d.seriesJkt, 600, 2_180_000);
        desk.mintPrimarySeries(d.seriesJkt, 400, 2_210_000);
        desk.mintPrimarySeries(d.seriesBtm, 500, 2_240_000);
        desk.mintPrimarySeries(d.seriesBtm, 300, 2_270_000);
        desk.mintPrimarySeries(d.seriesSgp, 400, 2_310_000);
        desk.mintPrimarySeries(d.seriesSgp, 250, 2_350_000);
        // Resting bids below the asks
        desk.buySeriesOrPlaceBid(d.seriesJkt, 300, 2_140_000, true, type(uint256).max);
        desk.buySeriesOrPlaceBid(d.seriesJkt, 500, 2_110_000, true, type(uint256).max);
        desk.buySeriesOrPlaceBid(d.seriesBtm, 250, 2_190_000, true, type(uint256).max);
        desk.buySeriesOrPlaceBid(d.seriesBtm, 400, 2_160_000, true, type(uint256).max);
        desk.buySeriesOrPlaceBid(d.seriesSgp, 200, 2_260_000, true, type(uint256).max);
        desk.buySeriesOrPlaceBid(d.seriesSgp, 300, 2_220_000, true, type(uint256).max);
    }

    function _writeManifest(
        Deployment memory d,
        address deployer,
        address treasury,
        address[] memory attestors,
        uint8 quorum,
        uint256 wifPrice
    )
        internal
    {
        string memory c = "contracts";
        vm.serializeAddress(c, "WifToken", d.wif);
        vm.serializeAddress(c, "Usdg", d.usdg);
        vm.serializeAddress(c, "ParonSeriesToken", d.seriesToken);
        vm.serializeAddress(c, "WifFlywheelVault", d.vault);
        vm.serializeAddress(c, "WifSlaJury", d.jury);
        vm.serializeAddress(c, "ComputeReferenceIndex", d.criOracle);
        string memory contractsJson = vm.serializeAddress(c, "ParonExchangeDesk", d.desk);

        string memory s = "series";
        vm.serializeUint(s, "jkt", d.seriesJkt);
        vm.serializeUint(s, "btm", d.seriesBtm);
        string memory seriesJson = vm.serializeUint(s, "sgp", d.seriesSgp);

        string memory root = "manifest";
        vm.serializeString(root, "schema", "paron-wif-deployment/v1");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deployedAt", block.timestamp);
        vm.serializeUint(root, "startBlock", block.number);
        vm.serializeAddress(root, "deployer", deployer);
        vm.serializeAddress(root, "treasury", treasury);
        vm.serializeAddress(root, "indexAttestors", attestors);
        vm.serializeUint(root, "criQuorum", quorum);
        vm.serializeBool(root, "wifIsMock", d.wifIsMock);
        vm.serializeBool(root, "usdgIsMock", d.usdgIsMock);
        vm.serializeBool(root, "nativeBurn", d.nativeBurn);
        vm.serializeUint(root, "wifPriceUsdg", wifPrice);
        vm.serializeString(root, "series", seriesJson);
        string memory json = vm.serializeString(root, "contracts", contractsJson);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }

    /// @dev (YYMM of the current UTC month, YYMM of the next month) using the civil-from-days algorithm.
    function _deliveryMonths(uint256 ts) internal pure returns (uint16 current, uint16 next) {
        uint256 z = ts / 1 days + 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        uint256 y = yoe + era * 400 + (m <= 2 ? 1 : 0);
        // Years 2025-2099 keep YYMM below 10_000, far inside uint16.
        // forge-lint: disable-next-line(unsafe-typecast)
        current = uint16((y - 2000) * 100 + m);
        // forge-lint: disable-next-line(unsafe-typecast)
        next = m == 12 ? uint16((y - 1999) * 100 + 1) : uint16((y - 2000) * 100 + m + 1);
    }
}
