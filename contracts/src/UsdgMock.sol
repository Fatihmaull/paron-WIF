// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title UsdgMock
/// @notice Testnet USDG settlement stablecoin (6 decimals) with a permissionless judge faucet.
/// @dev Set `USDG_TOKEN_ADDRESS` to settle in an existing USDG deployment instead.
contract UsdgMock is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 10_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    mapping(address account => uint256 timestamp) public lastFaucetAt;

    event FaucetDrip(address indexed account, uint256 amount);

    error FaucetCooldown(uint256 availableAt);

    constructor(address owner_, uint256 initialSupply) ERC20("USDG Test Dollar", "USDG") Ownable(owner_) {
        if (initialSupply > 0) _mint(owner_, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Testnet faucet: 10,000 USDG per address per hour.
    function faucet() external {
        uint256 availableAt = faucetAvailableAt(msg.sender);
        if (block.timestamp < availableAt) revert FaucetCooldown(availableAt);
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetDrip(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function faucetAvailableAt(address account) public view returns (uint256) {
        uint256 last = lastFaucetAt[account];
        return last == 0 ? 0 : last + FAUCET_COOLDOWN;
    }
}
