// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ComputeReferenceIndex (CRI-H100)
/// @notice Multi-attestor price index for one H100-equivalent compute hour, in USDG (6 decimals).
///  - M-of-N: the index only updates when at least `quorum` distinct attestors have a fresh submission,
///    and the published value is the MEDIAN, so a minority of faulty or malicious attestors cannot move it.
///  - Step-limited: each publication can move the index by at most `maxStepBps` from the previous one
///    (the median is clamped), so even a captured quorum can only walk the price slowly.
///  - Rate-limited: at most one publication per `minInterval`.
///  - Stale submissions (older than `submissionWindow`) are ignored.
/// @dev The owner (a Safe multisig in production) manages the attestor set and quorum only. It cannot
///      write a price. Deployed behind ParonExchangeDesk, which settles Mode A at `latest()`.
contract ComputeReferenceIndex is Ownable {
    struct Submission {
        uint256 price;
        uint64 at;
        bytes32 sourceHash;
    }

    uint256 public constant MAX_ATTESTORS = 9;
    uint256 private constant BPS = 10_000;

    uint16 public immutable maxStepBps;
    uint64 public immutable minInterval;
    uint64 public immutable submissionWindow;

    address[] private _attestors;
    mapping(address attestor => bool) public isAttestor;
    mapping(address attestor => Submission) public submissionOf;
    uint8 public quorum;

    uint256 public price;
    uint64 public updatedAt;
    bytes32 public sourceHash;

    event AttestorAdded(address indexed attestor);
    event AttestorRemoved(address indexed attestor);
    event QuorumSet(uint8 quorum);
    event IndexSubmitted(address indexed attestor, uint256 priceUsdgPerCu, bytes32 sourceHash);
    event ReferenceIndexAttested(uint256 priceUsdgPerCu, bytes32 sourceHash, uint64 timestamp);
    event IndexClamped(uint256 median, uint256 published);

    error NotAttestor();
    error ZeroAddress();
    error ZeroPrice();
    error AlreadyAttestor(address attestor);
    error UnknownAttestor(address attestor);
    error TooManyAttestors();
    error InvalidQuorum(uint8 quorum, uint256 attestors);
    error InvalidParams();

    constructor(
        address owner_,
        address[] memory attestors_,
        uint8 quorum_,
        uint16 maxStepBps_,
        uint64 minInterval_,
        uint64 submissionWindow_
    ) Ownable(owner_) {
        if (maxStepBps_ == 0 || maxStepBps_ >= BPS || submissionWindow_ == 0) revert InvalidParams();
        maxStepBps = maxStepBps_;
        minInterval = minInterval_;
        submissionWindow = submissionWindow_;
        for (uint256 i; i < attestors_.length; ++i) {
            _add(attestors_[i]);
        }
        if (quorum_ == 0 || quorum_ > attestors_.length) revert InvalidQuorum(quorum_, attestors_.length);
        quorum = quorum_;
    }

    // ------------------------------------------------------------------
    // Attestor set (owner: Safe multisig)
    // ------------------------------------------------------------------

    function addAttestor(address attestor) external onlyOwner {
        _add(attestor);
    }

    function removeAttestor(address attestor) external onlyOwner {
        if (!isAttestor[attestor]) revert UnknownAttestor(attestor);
        if (_attestors.length - 1 < quorum) revert InvalidQuorum(quorum, _attestors.length - 1);
        isAttestor[attestor] = false;
        delete submissionOf[attestor];
        uint256 n = _attestors.length;
        for (uint256 i; i < n; ++i) {
            if (_attestors[i] == attestor) {
                _attestors[i] = _attestors[n - 1];
                _attestors.pop();
                break;
            }
        }
        emit AttestorRemoved(attestor);
    }

    function setQuorum(uint8 quorum_) external onlyOwner {
        if (quorum_ == 0 || quorum_ > _attestors.length) revert InvalidQuorum(quorum_, _attestors.length);
        quorum = quorum_;
        emit QuorumSet(quorum_);
    }

    // ------------------------------------------------------------------
    // Submissions
    // ------------------------------------------------------------------

    /// @notice An attestor posts its view of the index with a hash of the source data (venue prints, VWAP, rate cards).
    ///         Publication happens automatically once the quorum condition holds.
    function submit(uint256 priceUsdgPerCu, bytes32 sourceHash_) external {
        if (!isAttestor[msg.sender]) revert NotAttestor();
        if (priceUsdgPerCu == 0) revert ZeroPrice();
        submissionOf[msg.sender] = Submission({price: priceUsdgPerCu, at: uint64(block.timestamp), sourceHash: sourceHash_});
        emit IndexSubmitted(msg.sender, priceUsdgPerCu, sourceHash_);
        _publish(sourceHash_);
    }

    /// @notice (price, updatedAt) in one call for the desk.
    function latest() external view returns (uint256, uint64) {
        return (price, updatedAt);
    }

    function attestors() external view returns (address[] memory) {
        return _attestors;
    }

    function attestorCount() external view returns (uint256) {
        return _attestors.length;
    }

    /// @notice The median of currently fresh submissions and how many there are (view for monitors and UIs).
    function pendingMedian() external view returns (uint256 median, uint256 fresh) {
        (uint256[] memory prices, uint256 n) = _freshPrices();
        if (n == 0) return (0, 0);
        return (_median(prices, n), n);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _add(address attestor) private {
        if (attestor == address(0)) revert ZeroAddress();
        if (isAttestor[attestor]) revert AlreadyAttestor(attestor);
        if (_attestors.length >= MAX_ATTESTORS) revert TooManyAttestors();
        isAttestor[attestor] = true;
        _attestors.push(attestor);
        emit AttestorAdded(attestor);
    }

    function _publish(bytes32 src) private {
        if (updatedAt != 0 && block.timestamp < uint256(updatedAt) + minInterval) return;
        (uint256[] memory prices, uint256 n) = _freshPrices();
        if (n < quorum) return;
        uint256 median = _median(prices, n);
        uint256 published = median;
        uint256 last = price;
        if (last != 0) {
            uint256 hi = (last * (BPS + maxStepBps)) / BPS;
            uint256 lo = (last * (BPS - maxStepBps)) / BPS;
            if (median > hi) published = hi;
            else if (median < lo) published = lo;
            if (published != median) emit IndexClamped(median, published);
        }
        price = published;
        updatedAt = uint64(block.timestamp);
        sourceHash = src;
        emit ReferenceIndexAttested(published, src, uint64(block.timestamp));
    }

    function _freshPrices() private view returns (uint256[] memory prices, uint256 n) {
        uint256 total = _attestors.length;
        prices = new uint256[](total);
        for (uint256 i; i < total; ++i) {
            Submission storage s = submissionOf[_attestors[i]];
            if (s.at != 0 && block.timestamp <= uint256(s.at) + submissionWindow) prices[n++] = s.price;
        }
    }

    /// @dev Insertion sort (N <= 9). Even counts average the two middle values (floored).
    function _median(uint256[] memory a, uint256 n) private pure returns (uint256) {
        for (uint256 i = 1; i < n; ++i) {
            uint256 key = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > key) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = key;
        }
        return n % 2 == 1 ? a[n / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
    }
}
