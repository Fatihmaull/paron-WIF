# Vendored Solidity dependencies

`forge build` and `forge test` read these trees directly, so the contracts compile
offline with no `forge install`, git submodules or `node_modules`.

| Path | Package | Version | License |
| --- | --- | --- | --- |
| `forge-std/src/` | `forge-std` | 1.17.0 | MIT / Apache-2.0 (`forge-std/LICENSE-*`) |
| `openzeppelin-contracts/` | `@openzeppelin/contracts` (minimal subset: ERC20, ERC1155, SafeERC20, ReentrancyGuard, Ownable and their imports) | 5.6.1 | MIT (`openzeppelin-contracts/LICENSE`) |

Remappings live in `contracts/remappings.txt`. Files are copied unmodified from the
upstream releases; only the files reachable from Paron WIF imports are included.
