// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ComputeReferenceIndex} from "../src/ComputeReferenceIndex.sol";

/// @notice CRI-H100 oracle: M-of-N median, step limit, rate limit, staleness and narrow owner powers.
contract ComputeReferenceIndexTest is Test {
    ComputeReferenceIndex internal cri;
    address internal owner = makeAddr("safe");
    address internal a = makeAddr("attestor-a");
    address internal b = makeAddr("attestor-b");
    address internal c = makeAddr("attestor-c");
    bytes32 internal constant SRC = keccak256("basket");

    function setUp() public {
        vm.warp(1_800_000_000);
        address[] memory att = new address[](3);
        att[0] = a;
        att[1] = b;
        att[2] = c;
        cri = new ComputeReferenceIndex(owner, att, 2, 1_000, 1 hours, 6 hours);
    }

    /// @dev vm.warp(block.timestamp + x) can be folded by the via-IR optimizer across calls in one function;
    ///      reading the cheatcode timestamp each time keeps consecutive skips cumulative.
    function _skip(uint256 seconds_) internal {
        vm.warp(vm.getBlockTimestamp() + seconds_);
    }

    function _submit(address who, uint256 p) internal {
        vm.prank(who);
        cri.submit(p, SRC);
    }

    function test_NothingPublishesBelowQuorum() public {
        _submit(a, 2_200_000);
        assertEq(cri.price(), 0);
        (uint256 median, uint256 fresh) = cri.pendingMedian();
        assertEq(fresh, 1);
        assertEq(median, 2_200_000);
        _submit(b, 2_250_000);
        assertEq(cri.price(), 2_225_000, "two attestors: the average of the two middle values");
        assertEq(cri.updatedAt(), block.timestamp);
    }

    function test_MaliciousMinorityCannotMoveTheMedian() public {
        _submit(a, 2_200_000);
        _submit(b, 2_250_000);
        _skip(1 hours);
        _submit(c, 22_000_000); // 10x outlier from one of three attestors
        (uint256 median, uint256 fresh) = cri.pendingMedian();
        assertEq(fresh, 3);
        assertEq(median, 2_250_000, "the median ignores the outlier");
        assertEq(cri.price(), 2_250_000);
    }

    function test_CapturedQuorumCanOnlyWalkTheIndexOneStepPerInterval() public {
        _submit(a, 2_200_000);
        _submit(b, 2_200_000);
        for (uint256 i = 1; i <= 2; ++i) {
            _skip(1 hours);
            _submit(a, 22_000_000);
            _submit(b, 22_000_000); // both attestors collude
        }
        // 2.20 -> 2.42 -> 2.662: +10% per publication, never the full 10x
        assertEq(cri.price(), 2_662_000);
    }

    function test_AtMostOnePublicationPerInterval() public {
        _submit(a, 2_200_000);
        _submit(b, 2_200_000);
        uint64 first = cri.updatedAt();
        _skip(30 minutes);
        _submit(a, 2_300_000);
        _submit(b, 2_300_000);
        assertEq(cri.price(), 2_200_000);
        assertEq(cri.updatedAt(), first);
        _skip(30 minutes);
        _submit(a, 2_300_000);
        assertEq(cri.price(), 2_300_000, "next submission after the interval publishes");
    }

    function test_StaleSubmissionsAreIgnored() public {
        _submit(a, 2_200_000);
        _skip(6 hours + 1);
        _submit(b, 2_300_000);
        assertEq(cri.price(), 0, "a's submission expired, so the quorum of 2 is not met");
        _submit(a, 2_300_000);
        assertEq(cri.price(), 2_300_000);
    }

    function test_OnlyAttestorsSubmitAndTheOwnerCannotWriteAPrice() public {
        vm.prank(owner);
        vm.expectRevert(ComputeReferenceIndex.NotAttestor.selector);
        cri.submit(1, SRC);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ComputeReferenceIndex.NotAttestor.selector);
        cri.submit(2_200_000, SRC);
        vm.prank(a);
        vm.expectRevert(ComputeReferenceIndex.ZeroPrice.selector);
        cri.submit(0, SRC);
    }

    function test_OwnerManagesTheAttestorSetWithinQuorumLimits() public {
        address d = makeAddr("attestor-d");
        vm.prank(owner);
        cri.addAttestor(d);
        assertEq(cri.attestorCount(), 4);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ComputeReferenceIndex.AlreadyAttestor.selector, d));
        cri.addAttestor(d);

        vm.prank(owner);
        cri.setQuorum(3);
        vm.prank(owner);
        cri.removeAttestor(d); // 3 attestors left, quorum 3 is still satisfiable
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ComputeReferenceIndex.InvalidQuorum.selector, uint8(3), uint256(2)));
        cri.removeAttestor(c);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ComputeReferenceIndex.InvalidQuorum.selector, uint8(5), uint256(3)));
        cri.setQuorum(5);

        vm.prank(a);
        vm.expectRevert();
        cri.addAttestor(makeAddr("self-appointed"));
    }

    function test_RemovedAttestorSubmissionNoLongerCounts() public {
        _submit(a, 2_200_000);
        vm.prank(owner);
        cri.setQuorum(1);
        vm.prank(owner);
        cri.removeAttestor(a);
        (, uint256 fresh) = cri.pendingMedian();
        assertEq(fresh, 0);
    }

    function test_ConstructorRejectsBadParameters() public {
        address[] memory none = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(ComputeReferenceIndex.InvalidQuorum.selector, uint8(1), uint256(0)));
        new ComputeReferenceIndex(owner, none, 1, 1_000, 1 hours, 6 hours);
        address[] memory one = new address[](1);
        one[0] = a;
        vm.expectRevert(ComputeReferenceIndex.InvalidParams.selector);
        new ComputeReferenceIndex(owner, one, 1, 0, 1 hours, 6 hours);
        vm.expectRevert(ComputeReferenceIndex.InvalidParams.selector);
        new ComputeReferenceIndex(owner, one, 1, 10_000, 1 hours, 6 hours);
    }

    function testFuzz_PublishedPriceNeverLeavesTheStepBand(uint256 first, uint256 next, uint8 rounds) public {
        first = bound(first, 1e3, 1e12);
        address[] memory one = new address[](1);
        one[0] = a;
        ComputeReferenceIndex solo = new ComputeReferenceIndex(owner, one, 1, 1_000, 1 hours, 6 hours);
        vm.prank(a);
        solo.submit(first, SRC);
        for (uint256 i; i < bound(rounds, 1, 12); ++i) {
            uint256 before = solo.price();
            next = bound(uint256(keccak256(abi.encode(next, i))), 1, type(uint128).max);
            _skip(1 hours);
            vm.prank(a);
            solo.submit(next, SRC);
            assertLe(solo.price(), (before * 11_000) / 10_000);
            assertGe(solo.price(), (before * 9_000) / 10_000);
        }
    }
}
