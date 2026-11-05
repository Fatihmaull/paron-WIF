// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ParonWifConstants as C} from "./libraries/ParonWifConstants.sol";
import {Corridor, GpuTier, SeriesInfo} from "./libraries/ParonWifTypes.sol";

/// @title ParonSeriesToken
/// @notice ERC-1155 ledger of standardized Compute Unit (CU) series.
///         1 CU = 1 hour of NVIDIA H100-SXM-80GB-equivalent compute, whatever the native hardware.
/// @dev Series are canonical: exactly one per (corridor, hardware, delivery month), derived on-chain.
///      Anyone can list one, nobody can fragment one, so every order book stays deep.
///      The ExchangeDesk is the clearing house for CU: it mints at primary issuance, burns at
///      settlement, and moves CU in and out of custody without per-user approval transactions.
contract ParonSeriesToken is ERC1155, Ownable {
    address public desk;

    Corridor[] private _corridors;
    mapping(uint256 seriesId => SeriesInfo) private _series;
    mapping(bytes32 key => uint256 seriesId) public seriesIdByKey;
    mapping(uint256 seriesId => uint256 supply) public totalSupply;
    uint256 public seriesCount;

    event DeskSet(address indexed desk);
    event CorridorRegistered(uint8 indexed corridorId, string code, string name);
    event SeriesCreated(
        uint256 indexed seriesId,
        string symbol,
        uint8 indexed corridorId,
        GpuTier gpuTier,
        uint16 yymm,
        uint64 deliveryStart,
        uint64 deliveryEnd,
        address indexed creator
    );

    error DeskAlreadySet();
    error OnlyDesk();
    error ZeroAddress();
    error UnknownCorridor(uint8 corridorId);
    error TooManyCorridors();
    error InvalidCode();
    error InvalidDeliveryMonth(uint16 yymm);
    error SeriesExists(uint256 seriesId);
    error UnknownSeries(uint256 seriesId);

    modifier onlyDesk() {
        if (msg.sender != desk) revert OnlyDesk();
        _;
    }

    constructor(address owner_, string memory uri_) ERC1155(uri_) Ownable(owner_) {}

    // ------------------------------------------------------------------
    // Wiring and governance
    // ------------------------------------------------------------------

    function setDesk(address desk_) external onlyOwner {
        if (desk != address(0)) revert DeskAlreadySet();
        if (desk_ == address(0)) revert ZeroAddress();
        desk = desk_;
        emit DeskSet(desk_);
    }

    /// @notice Registers a physical compute corridor (data-center region), e.g. "BTM" / "Batam-Singapore H200".
    function registerCorridor(string calldata code, string calldata name) external onlyOwner returns (uint8 corridorId) {
        uint256 len = bytes(code).length;
        if (len < 2 || len > 4) revert InvalidCode();
        if (_corridors.length >= type(uint8).max) revert TooManyCorridors();
        corridorId = uint8(_corridors.length);
        _corridors.push(Corridor({code: code, name: name}));
        emit CorridorRegistered(corridorId, code, name);
    }

    // ------------------------------------------------------------------
    // Hardware normalization
    // ------------------------------------------------------------------

    /// @notice Weight of one native GPU hour in bps of one H100 hour.
    function weightBps(GpuTier tier) public pure returns (uint16) {
        if (tier == GpuTier.A100) return C.WEIGHT_A100;
        if (tier == GpuTier.H100) return C.WEIGHT_H100;
        if (tier == GpuTier.H200) return C.WEIGHT_H200;
        if (tier == GpuTier.B200) return C.WEIGHT_B200;
        return C.WEIGHT_GB200;
    }

    /// @notice Deterministic hardware-to-CU conversion. `hoursScaled` and the result share any fixed-point scale.
    /// @dev Example: 100e18 A100 hours -> 45e18 CU; 10e18 H200 hours -> 14e18 CU.
    function convertGpuHoursToCu(GpuTier tier, uint256 hoursScaled) public pure returns (uint256 cuScaled) {
        return (hoursScaled * weightBps(tier)) / C.BPS;
    }

    /// @notice Inverse conversion: native GPU hours a provider delivers for `cuScaled` CU.
    function convertCuToGpuHours(GpuTier tier, uint256 cuScaled) public pure returns (uint256 hoursScaled) {
        return (cuScaled * C.BPS) / weightBps(tier);
    }

    function gpuCode(GpuTier tier) public pure returns (string memory) {
        if (tier == GpuTier.A100) return "A100";
        if (tier == GpuTier.H100) return "H100";
        if (tier == GpuTier.H200) return "H200";
        if (tier == GpuTier.B200) return "B200";
        return "GB200";
    }

    // ------------------------------------------------------------------
    // Canonical series
    // ------------------------------------------------------------------

    function seriesKey(uint8 corridorId, GpuTier tier, uint16 yymm) public pure returns (bytes32) {
        return keccak256(abi.encode(corridorId, tier, yymm));
    }

    /// @notice Permissionlessly lists the canonical series for a corridor, hardware and delivery month.
    /// @param yymm Delivery month, e.g. 2611 for November 2026. The window is that UTC calendar month.
    function createSeries(uint8 corridorId, GpuTier tier, uint16 yymm) external returns (uint256 seriesId) {
        if (corridorId >= _corridors.length) revert UnknownCorridor(corridorId);
        uint256 yy = yymm / 100;
        uint256 mm = yymm % 100;
        if (yy < 25 || mm == 0 || mm > 12) revert InvalidDeliveryMonth(yymm);
        bytes32 key = seriesKey(corridorId, tier, yymm);
        if (seriesIdByKey[key] != 0) revert SeriesExists(seriesIdByKey[key]);

        uint64 start = uint64(_monthStart(2000 + yy, mm));
        uint64 end = mm == 12 ? uint64(_monthStart(2001 + yy, 1)) : uint64(_monthStart(2000 + yy, mm + 1));
        string memory symbol =
            string.concat("CU-", _corridors[corridorId].code, "-", gpuCode(tier), "-", _fourDigits(yymm));

        seriesId = ++seriesCount;
        seriesIdByKey[key] = seriesId;
        _series[seriesId] = SeriesInfo({
            symbol: symbol,
            corridorId: corridorId,
            gpuTier: tier,
            yymm: yymm,
            deliveryStart: start,
            deliveryEnd: end,
            creator: msg.sender
        });
        emit SeriesCreated(seriesId, symbol, corridorId, tier, yymm, start, end, msg.sender);
    }

    // ------------------------------------------------------------------
    // Clearing-house hooks (ExchangeDesk only)
    // ------------------------------------------------------------------

    /// @notice Mints new CU into the desk's custody (primary issuance escrow).
    function mint(address to, uint256 seriesId, uint256 amount) external onlyDesk {
        if (seriesId == 0 || seriesId > seriesCount) revert UnknownSeries(seriesId);
        if (to == address(0)) revert ZeroAddress();
        uint256[] memory ids = new uint256[](1);
        uint256[] memory values = new uint256[](1);
        ids[0] = seriesId;
        values[0] = amount;
        _update(address(0), to, ids, values);
    }

    function burn(address from, uint256 seriesId, uint256 amount) external onlyDesk {
        _burn(from, seriesId, amount);
    }

    /// @notice Custody move used by the matching engine. Skips receiver callbacks so a hostile
    ///         contract maker can never block the book.
    function deskTransfer(address from, address to, uint256 seriesId, uint256 amount) external onlyDesk {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        uint256[] memory ids = new uint256[](1);
        uint256[] memory values = new uint256[](1);
        ids[0] = seriesId;
        values[0] = amount;
        _update(from, to, ids, values);
    }

    /// @dev The desk is the canonical CU operator, like a clearing house: no approval transaction to trade.
    function isApprovedForAll(address account, address operator) public view override returns (bool) {
        return (operator == desk && desk != address(0)) || super.isApprovedForAll(account, operator);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getSeries(uint256 seriesId) external view returns (SeriesInfo memory) {
        if (seriesId == 0 || seriesId > seriesCount) revert UnknownSeries(seriesId);
        return _series[seriesId];
    }

    function corridorCount() external view returns (uint256) {
        return _corridors.length;
    }

    function getCorridor(uint8 corridorId) external view returns (Corridor memory) {
        if (corridorId >= _corridors.length) revert UnknownCorridor(corridorId);
        return _corridors[corridorId];
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        super._update(from, to, ids, values);
        if (from == address(0)) {
            for (uint256 i; i < ids.length; ++i) {
                totalSupply[ids[i]] += values[i];
            }
        }
        if (to == address(0)) {
            for (uint256 i; i < ids.length; ++i) {
                totalSupply[ids[i]] -= values[i];
            }
        }
    }

    /// @dev Unix timestamp of 00:00 UTC on the first day of (year, month). Days-from-civil algorithm.
    function _monthStart(uint256 year, uint256 month) private pure returns (uint256) {
        uint256 y = month <= 2 ? year - 1 : year;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = (month + 9) % 12;
        uint256 doy = (153 * mp + 2) / 5;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return (era * 146_097 + doe - 719_468) * 1 days;
    }

    function _fourDigits(uint16 value) private pure returns (string memory) {
        bytes memory out = new bytes(4);
        uint256 v = value;
        for (uint256 i = 4; i > 0; --i) {
            out[i - 1] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(out);
    }
}
