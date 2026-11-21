# LONGYU watchtower

Runs apart from the chain, the API and the signer, in a Railway project of its own, with its own node and its own two keys. It checks two things every 30 seconds and acts on a wrong one without a person.

| What | Checked against | On a wrong one | Key |
|---|---|---|---|
| State roots posted on BSC, before they finalize | its own node, which derives LONGYU from the batches on BSC and trusts nothing the sequencer says; where that node is behind, the root rebuilt from a LONGYU RPC's data | deletes it and every root after it (`deleteL2Outputs`) | the output oracle's challenger |
| Mining roots waiting out their 12-hour delay | the root's data file, the contract's own limits and this service's own copy of the active root | pauses claims, then vetoes the root | holds only the distributor's guardian role |

A state root that cannot be checked by the time it is close to finalizing is deleted as well: deleting a right root only costs the proposer a re-post. A mining root that cannot be checked before its delay runs short is stopped as well. Only the admin unpauses.

What a mining root must satisfy:

- its data file is the one whose hash is on chain, and its leaves rebuild exactly the root posted;
- the leaves add up to no more than the root's total, and none is above the contract's bound per account (`maxRewardPerDay` for every day since day 0);
- an account that went down or left since the active root was frozen at exactly what it has claimed on chain, and no more than `FREEZES_PER_ROOT` accounts are frozen in one root;
- no more than `NEW_ACCOUNTS_PER_DAY` new accounts per day, a fixed number set here.

What it cannot see: someone who controls both the API and the publisher key can still steer new rewards to accounts of their own within those limits, because the rewards are computed from the API's records. The limits cap how much.

`GET /health` answers 200, or 503 while anything is critical, with each check and its detail.

## Settings

| Setting | |
|---|---|
| `L1_RPC_URLS`, `L1_CHAIN_ID`, `L1_OUTPUT_ORACLE` | BSC endpoints (a provider other than the proposer's), 56 or 97, and the output oracle |
| `VERIFIER_NODE_URL`, `VERIFIER_GETH_URL` | its own node: `chain/railway/op-node` and `op-geth` with `ROLE=verifier`, private addresses only |
| `FALLBACK_RPC_URL` | a LONGYU RPC, for roots past its own node's head |
| `L2_SEND_URL`, `L2_CHAIN_ID` | where its LONGYU transactions go, and the chain |
| `DISTRIBUTOR_ADDRESS`, `DATA_ORIGINS` | the mining distributor, and the only origins data files are read from |
| `CHALLENGER_KEY`, `GUARDIAN_KEY` | its two keys, sealed; without them it reports and acts on nothing |
| `OUTPUT_LATE_SECONDS`, `VETO_MARGIN_SECONDS` | when an unchecked root is acted on (defaults 1,200 s, at most half the wait, and 2 hours) |
| `NEW_ACCOUNTS_PER_DAY`, `FREEZES_PER_ROOT` | the mining limits above (defaults 5,000 and 20) |
| `STATE_DIR` | a volume: the roots it accepted |

At start-up it refuses to run if its node follows another chain, if `CHALLENGER_KEY` is not the oracle's challenger, or if `GUARDIAN_KEY` lacks the guardian role.

## Tests

`npm test`: the decisions above, on stand-ins for the chains, including files crafted to pass the hash and fail parsing, lowered and dropped leaves, a flood of new accounts, a node that is behind and one that answers two different roots.
