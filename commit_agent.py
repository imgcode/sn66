#!/usr/bin/env python3
"""Commit your agent repo to the Bittensor subnet 66 chain.

Usage:
    python commit_agent.py --repo your-username/your-repo --commit abc1234def
    
    # Or with custom wallet names:
    python commit_agent.py --repo your-username/your-repo --commit abc1234def --wallet miner --hotkey default
"""

import argparse
import sys
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger()

NETUID = 66


def main():
    parser = argparse.ArgumentParser(description="Commit miner agent to SN66 chain")
    parser.add_argument("--repo", required=True, help="GitHub repo in owner/repo format")
    parser.add_argument("--commit", required=True, help="Commit SHA (short or full)")
    parser.add_argument("--wallet", default="miner", help="Wallet name (default: miner)")
    parser.add_argument("--hotkey", default="default", help="Hotkey name (default: default)")
    args = parser.parse_args()

    import bittensor as bt

    wallet = bt.Wallet(name=args.wallet, hotkey=args.hotkey)
    hk = wallet.hotkey.ss58_address
    log.info(f"Miner hotkey: {hk}")

    sub = bt.Subtensor()
    meta = sub.metagraph(NETUID)

    if hk not in meta.hotkeys:
        log.error("Miner not registered on subnet 66. Register first with btcli.")
        sys.exit(1)

    uid = meta.hotkeys.index(hk)
    log.info(f"Miner registered at UID {uid}")

    data = f"{args.repo}@{args.commit}"
    if len(data.encode()) > 128:
        log.error(f"Commitment too long ({len(data.encode())} bytes, max 128)")
        sys.exit(1)

    log.info(f"Committing: {data}")
    try:
        result = sub.set_commitment(
            wallet=wallet,
            netuid=NETUID,
            data=data,
        )
        log.info(f"Commitment result: {result}")
    except Exception as e:
        log.error(f"Failed to commit: {e}")
        sys.exit(1)

    try:
        commitments = sub.get_all_commitments(netuid=NETUID)
        if hk in commitments:
            log.info(f"Verified on chain: {commitments[hk]}")
        else:
            log.warning("Commitment not found yet (may need a block to confirm)")
    except Exception as e:
        log.warning(f"Could not verify: {e}")


if __name__ == "__main__":
    main()
