# Runbook — admitting Foundation collateral

**Audience: Flux Hub admins.** This is the operational procedure for getting a Flux Foundation
collateral into the idle-fill pool at `/admin/foundation-collateral`. It is not a donor-facing
document; nobody outside the admin console ever runs any of it.

## What the program is

The **Flux Foundation** supplies the collateral. Supporters and Operators donate the *hardware* —
idle node slots that would otherwise earn nothing. Flux Hub matches the two: it places a
Foundation collateral onto an idle slot and brings up a node there.

Block rewards go to the collateral's own address, which is the Foundation's. **The Foundation
earns; the hardware donor does not.** What the donor gets is the thing the Foundation wants in
return — their idle capacity keeps the network size stable instead of sitting dark.

Flux Hub never holds Foundation wallet keys. It holds a **delegate key**, registered on chain by
the collateral's own START, which authorizes exactly one operation: starting a node on that
collateral. It cannot spend the collateral, move FLUX, or change where rewards go. That key is
what lets the hub restart an expired node or move it to different hardware when a donated machine
goes away, without going back to the Foundation's wallet each time.

The hub's delegate pubkey is printed at the top of the admin page. The engineering rationale for
all of this is the `expressive-marinating-curry` plan, §7.

## The two ways in

Both paths end with the same evidence on file: a validated type-1 registration naming Flux Hub's
delegate. They differ in what they prove about *who submitted it* (curry §7.4).

| Mode | Proves | Use when |
|---|---|---|
| **Ceremony (arm & watch)** — default | The submitter **controls** the collateral | Normal case. Always prefer this. |
| **Import an existing registration** | A valid registration exists for that outpoint — nothing about the submitter | The ceremony cannot serve: the Foundation registered the collateral earlier with no node ever placed, so it is on no list and there is nothing to watch. The registering START's txid is then the only way in. |

Import is weaker on purpose and it is not a fallback for "the ceremony was inconvenient." Anyone
can read a txid off the chain and type it.

## The ceremony

### Before you arm

- **Have a free slot of the right tier ready.** The ceremony's START *is* the node's first START —
  the same broadcast, not a test burn. Arm when a slot is available so the node deploys inside the
  same window and the collateral goes straight to earning. Arming with no slot free lets the START
  lapse to DOS.
- **Have the four fields.** Collateral txid, output index (usually 0), FluxID, identity key. The
  SSP / Zelcore lookup box fills all four from one token — use it. Nobody should be hand-typing a
  52-character WIF; transcription caused nearly every failure in the first from-zero onboarding run.
- **The collateral must be ≥100 confirmations old** (~50 min at 30 s/block). Measured on SSP
  2026-08-15: the node STARTed at exactly 100.

### The sequence

1. **Arm.** The hub checks maturity, checks the outpoint is unspent, and proves it is on **none**
   of the three lists — then records the chain tip as `baselineHeight`. The row is created
   `awaiting_start`, out of the pool.
2. **Broadcast the START** from the Foundation's wallet, registering Flux Hub's delegate key.
3. **Watch.** The page polls the start list for the outpoint, for 15 minutes.
4. **Capture.** A forward scan from the baseline finds the transaction, validates that it really
   registers *our* delegate, and stores the anchor. Status → `available`, and the collateral is in
   the pool.

### Why the order is the whole point

Absence from all three lists **at the baseline** is what makes step 4 mean anything. Because
absence was proven first, a START appearing after that height was provably caused by the request
just made — it cannot be a pre-existing pending START, someone else's, or a stale artifact from
months ago.

Nobody signs a challenge string. Nothing secret is stored. **The sequence itself is the proof.**

> ⚠️ Delete the pre-check and the watch proves nothing. `judgeArm` fails closed on every branch,
> including an unreadable list — "the daemon did not tell us" is never "it is absent."

### Two guards that look identical and are not

`judgeArm` **refuses** a pending START. §7.2's `judgeCollateral` **allows** one. Same chain state,
opposite verdicts, because they ask different questions: at deploy time a pending START is an
invitation, because deploying is what answers it; at arm time it is the exact artifact the
baseline exists to rule out. Pinned by a test. **Do not "unify" them.**

## Arm refusals

Every one of these leaves **no row behind** — the row and its baseline are created in the same
statement or not at all. There is never a half-armed row carrying a baseline that was never
established.

| Refusal | Meaning | Action |
|---|---|---|
| `spent` | The outpoint is gone from the UTXO set. No START on it can ever confirm. | Terminal. Retire the entry. Reported before maturity on purpose — telling someone to wait 50 minutes on a spent outpoint sends them off to do something that can never work. |
| `unknown-confirmations` | Could not read the confirmation count. | Retry. Fails closed. |
| `immature` | Under 100 confirmations. The wallet would refuse the broadcast. | Wait the stated number of blocks, then arm. Checked pre-arm so the clock never starts on a doomed attempt. |
| `in-use` | On the deterministic list — a node is already served on it somewhere. | Do not proceed. A START would relocate a running node. |
| `dos` | On the DOS list. | Wait the stated blocks. |
| `start-pending` | A START is already in flight. | Wait for it to clear, or deploy against it, then arm. |

## After arming

| Situation | What happens |
|---|---|
| The 15-minute window lapses | **Re-arm on the row.** Nothing is re-entered. It re-runs the *full* pre-check, not just a clock reset — a stale baseline is worse than none, because it looks like proof. |
| The START lands late, after the window | Still captured. The window governs **waiting**, never recording. The proof is the baseline height, not the timer. |
| Re-arm reports `start-pending` | Not a dead end — that may be your own late START. Let the watch capture it against the old baseline, which is still valid. |
| A plain owner START was broadcast | Captured, then refused: a v5 owner START carries no delegate fields, so it authorizes nothing. Broadcast the right one, then Re-arm once the wrong one has cleared the start list. |
| The START registers someone else's delegate | Settled refusal, not a wait. It would provision but never start. |
| The registration is unrecoverable | Destroy the collateral and re-make it — **0 FLUX**, ~50 min re-maturing. Never a dead end. |

> 🧹 **Delete abandoned armed rows.** Capture is deliberately allowed outside the window, which
> means a stale armed row will capture a START broadcast for some *other* purpose and call it
> proof. Seen on staging. A hard outer bound is the eventual fix; until then this is hygiene you
> perform by hand.

> ⛔ **Never run the real ceremony on staging.** There is no test chain — the START is real either
> way, and staging has no provisioner poller to answer it, so it lapses into DOS on a real
> collateral. Rehearse the non-broadcast half there (arm → let it lapse → re-arm, zero chain
> cost); run the real thing on prod.

## Row lifecycle

```
                 ┌──────────────── ceremony ────────────────┐
   (arm) ──▶ awaiting_start ──(capture)──▶ available ──(idle-fill)──▶ assigned
                                  ▲                  ◀──(reconciler)──┘
   (import) ──▶ pending_delegate ─┘
                     │
                     └──▶ reclaimed  ◀──(retire)──  available
                                     ──(restore)──▶ pending_delegate
   any ──(chain says gone)──▶ spent
```

- `available` — in the pool. Idle-fill selects on `status = 'available' AND assignedRentalId IS NULL`.
- `assigned` — backing a live node. **Retire is refused here**, deliberately, so a node can never
  vanish out from under the slot it is running on.
- `reclaimed` (retired) — out of service, reversible. `restore` returns it to `pending_delegate`,
  never straight to `available`: whether the delegate is still readable has to be re-established.
- `spent` — the chain says the outpoint is gone. Shown in **red**, not the grey `reclaimed` wears,
  because only one of the two is worth trying to bring back.

**To take a live one out:** use **Recycle node** / evict first — that returns the slot to
`available` and the reconciler releases the collateral — then retire. `delete` is allowed only
from `reclaimed`, `pending_delegate`, `awaiting_start` or `spent`, and only with no
`assignedRentalId`. An `available` entry must be retired first; that two-step is intentional.

**Withdrawal by the Foundation** is the same operation: retire the entry. It leaves the pool and
is never matched to another slot. If a node is live on it, that node comes down first. Nothing on
chain needs undoing.

## Known rough edge

The page is a server component and only re-renders on `router.refresh()`, which fires after an
action *you* took. Everything driven by background loops — idle-fill placing a collateral, the
reconciler releasing one, a node reaching `active` — is invisible until you reload. **The page can
sit confidently wrong for minutes.** Reload before concluding anything from it.
