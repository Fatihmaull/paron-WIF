// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ParonWifConstants as C} from "./ParonWifConstants.sol";
import {Order} from "./ParonWifTypes.sol";

/// @title ParonClobLib
/// @notice Storage-level central limit order book used by ParonExchangeDesk (linked external library).
/// @dev Per series and side, price levels live in a sorted array with the best price LAST
///      (bids ascending, asks descending), so consuming the top of book is a cheap pop.
///      Each level holds two FIFO queues: lane 0 is the $WIF priority lane (makers holding or staking
///      >= 10k $WIF), lane 1 the standard lane. Within a level, lane 0 always fills first.
library ParonClobLib {
    struct Level {
        uint256[2] head;
        uint256[2] tail;
        uint256 qty;
    }

    struct Book {
        uint256 orderCount;
        mapping(uint256 orderId => Order) orders;
        mapping(uint256 seriesId => mapping(bool isBid => uint256[])) levels;
        mapping(uint256 seriesId => mapping(bool isBid => mapping(uint256 price => Level))) levelOf;
    }

    error TooManyLevels();

    /// @notice Creates a resting order and appends it to its level and lane.
    function place(
        Book storage b,
        uint256 seriesId,
        address maker,
        bool isBid,
        bool wifDiscount,
        uint8 lane,
        uint256 price,
        uint256 qty,
        uint256 escrow,
        uint256 lotId
    ) external returns (uint256 orderId) {
        orderId = ++b.orderCount;
        Order storage o = b.orders[orderId];
        o.seriesId = seriesId;
        o.maker = maker;
        o.isBid = isBid;
        o.wifDiscount = wifDiscount;
        o.lane = lane;
        o.active = true;
        o.price = price;
        o.qtyRemaining = qty;
        o.escrowUsdg = escrow;
        o.lotId = lotId;
        o.createdAt = uint64(block.timestamp);

        Level storage level = b.levelOf[seriesId][isBid][price];
        if (level.head[0] == 0 && level.head[1] == 0) _insertPrice(b.levels[seriesId][isBid], isBid, price);
        uint256 tail = level.tail[lane];
        if (tail == 0) {
            level.head[lane] = orderId;
        } else {
            b.orders[tail].next = orderId;
            o.prev = tail;
        }
        level.tail[lane] = orderId;
        level.qty += qty;
    }

    /// @notice Removes `take` CU from an order; unlinks it once empty. Returns true when fully filled.
    function fill(Book storage b, uint256 orderId, uint256 take) external returns (bool done) {
        Order storage o = b.orders[orderId];
        o.qtyRemaining -= take;
        b.levelOf[o.seriesId][o.isBid][o.price].qty -= take;
        done = o.qtyRemaining == 0;
        if (done) _unlink(b, orderId);
    }

    /// @notice Unlinks an active order (cancel path), removing its remaining quantity from the level.
    function unlink(Book storage b, uint256 orderId) external {
        _unlink(b, orderId);
    }

    /// @notice Best price and the order at the head of its queue (priority lane first). (0, 0) when empty.
    function head(Book storage b, uint256 seriesId, bool isBid) external view returns (uint256 price, uint256 orderId) {
        uint256[] storage arr = b.levels[seriesId][isBid];
        if (arr.length == 0) return (0, 0);
        price = arr[arr.length - 1];
        Level storage level = b.levelOf[seriesId][isBid][price];
        orderId = level.head[0] != 0 ? level.head[0] : level.head[1];
    }

    function bestPrices(Book storage b, uint256 seriesId) external view returns (uint256 bestBid, uint256 bestAsk) {
        uint256[] storage bids = b.levels[seriesId][true];
        uint256[] storage asks = b.levels[seriesId][false];
        bestBid = bids.length == 0 ? 0 : bids[bids.length - 1];
        bestAsk = asks.length == 0 ? 0 : asks[asks.length - 1];
    }

    /// @notice Aggregated depth, best price first.
    function bookSide(Book storage b, uint256 seriesId, bool isBid, uint256 depth)
        external
        view
        returns (uint256[] memory prices, uint256[] memory qtys)
    {
        uint256[] storage arr = b.levels[seriesId][isBid];
        uint256 len = arr.length;
        uint256 n = len < depth ? len : depth;
        prices = new uint256[](n);
        qtys = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 p = arr[len - 1 - i];
            prices[i] = p;
            qtys[i] = b.levelOf[seriesId][isBid][p].qty;
        }
    }

    /// @notice Walks the ask side up to `maxPrice` and returns how much of `cuAmount` would fill.
    function quoteBuy(Book storage b, uint256 seriesId, uint256 cuAmount, uint256 maxPrice)
        external
        view
        returns (uint256 fillable, uint256 notional)
    {
        uint256[] storage asks = b.levels[seriesId][false];
        uint256 remaining = cuAmount;
        for (uint256 i = asks.length; i > 0 && remaining > 0; --i) {
            uint256 p = asks[i - 1];
            if (p > maxPrice) break;
            uint256 q = b.levelOf[seriesId][false][p].qty;
            uint256 take = remaining < q ? remaining : q;
            fillable += take;
            notional += take * p;
            remaining -= take;
        }
    }

    function _unlink(Book storage b, uint256 orderId) private {
        Order storage o = b.orders[orderId];
        Level storage level = b.levelOf[o.seriesId][o.isBid][o.price];
        uint8 lane = o.lane;
        if (o.prev == 0) level.head[lane] = o.next;
        else b.orders[o.prev].next = o.next;
        if (o.next == 0) level.tail[lane] = o.prev;
        else b.orders[o.next].prev = o.prev;
        level.qty -= o.qtyRemaining;
        o.prev = 0;
        o.next = 0;
        o.active = false;
        if (level.head[0] == 0 && level.head[1] == 0) _removePrice(b.levels[o.seriesId][o.isBid], o.price);
    }

    function _insertPrice(uint256[] storage arr, bool isBid, uint256 price) private {
        uint256 j = arr.length;
        if (j >= C.MAX_LEVELS) revert TooManyLevels();
        arr.push(price);
        while (j > 0 && (isBid ? arr[j - 1] > price : arr[j - 1] < price)) {
            arr[j] = arr[j - 1];
            --j;
        }
        arr[j] = price;
    }

    function _removePrice(uint256[] storage arr, uint256 price) private {
        uint256 n = arr.length;
        for (uint256 i = n; i > 0; --i) {
            if (arr[i - 1] == price) {
                for (uint256 k = i - 1; k + 1 < n; ++k) {
                    arr[k] = arr[k + 1];
                }
                arr.pop();
                return;
            }
        }
    }
}
