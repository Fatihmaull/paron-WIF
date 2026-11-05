// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title WifTokenMock
/// @notice Testnet $WIF (18 decimals) with permanent burns and a permissionless judge faucet.
/// @dev Production deployments point the protocol at the canonical $WIF contract instead
///      (`WIF_TOKEN_ADDRESS` in `.env`). Burns here reduce `totalSupply` and are tracked in
///      `totalBurned`, exactly what every Paron flywheel loop relies on.
contract WifTokenMock is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 50_000e18;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    uint256 public totalBurned;
    mapping(address account => uint256 timestamp) public lastFaucetAt;

    event WifBurned(address indexed account, uint256 amount, uint256 totalBurned);
    event FaucetDrip(address indexed account, uint256 amount);

    error FaucetCooldown(uint256 availableAt);

    constructor(address owner_, uint256 initialSupply) ERC20("WIF Test Token", "WIF") Ownable(owner_) {
        if (initialSupply > 0) _mint(owner_, initialSupply);
    }

    /// @notice Permanently destroys `amount` of the caller's $WIF.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        _recordBurn(msg.sender, amount);
    }

    /// @notice Permanently destroys `amount` of `account`'s $WIF, spending the caller's allowance.
    function burnFrom(address account, uint256 amount) external {
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
        _recordBurn(account, amount);
    }

    /// @notice Testnet faucet: 50,000 $WIF per address per hour.
    function faucet() external {
        uint256 availableAt = faucetAvailableAt(msg.sender);
        if (block.timestamp < availableAt) revert FaucetCooldown(availableAt);
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetDrip(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Seeding hook for deployment scripts.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function faucetAvailableAt(address account) public view returns (uint256) {
        uint256 last = lastFaucetAt[account];
        return last == 0 ? 0 : last + FAUCET_COOLDOWN;
    }

    function _recordBurn(address account, uint256 amount) private {
        totalBurned += amount;
        emit WifBurned(account, amount, totalBurned);
    }
}
