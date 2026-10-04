# Oven Setup

## Supported platforms
- Linux (x64, arm64)
- macOS (x64, arm64)  
- Windows (x64, arm64)

Remote setup only. Local oven does not receive full setup or package upgrades.

## Setup phases
1. Preflight - read-only checks
2. Bootstrap - platform preparation
3. Prerequisites - Git, curl, Node, npm
4. Harnesses - install selected
5. Accounts - synchronize
6. Git - SSH configuration
7. Finalize - verification

## Security
- Dedicated Git SSH keys separate from machine login
- Secrets never in logs or progress records
- Host key verification required

## Recovery
- Completed steps skipped on retry
- Interrupted operations rechecked
- Cancellation safe for interruptible operations
