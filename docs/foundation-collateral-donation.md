# Donating Collateral to the Foundation

This is for someone donating Flux collateral to the **MoltenTech Foundation**. Operators
donate hardware; you donate the collateral that lets a node run on it. Together those two
halves make a free Flux node for someone who could not otherwise afford one.

It takes about two minutes of your time, and it is one action, not several.

> Written for the person handing over the collateral — no blockchain vocabulary required.
> The engineering rationale lives in the `expressive-marinating-curry` plan, §7.3.

## The short version

**You keep your FLUX.** It never moves, and we never touch your wallet. All we need is proof
that you are actually the person who controls the collateral — and one action from you gives
us both that proof *and* the thing that turns your collateral into a running node. It is the
same broadcast; you do not do it twice.

## What actually happens

You give us four things:

| Thing | Where it comes from |
|---|---|
| Collateral transaction ID | your wallet |
| Which output it is (usually 0) | your wallet |
| FluxID | your wallet |
| Node identity key | your wallet |

If you are on **SSP or Zelcore**, one lookup fills all four in. Nobody types a 52-character
key by hand — transcription is what caused nearly every failure in the first from-zero
onboarding run we ever did.

Then we press **Arm**. That does two things in about a second:

1. asks the Flux network whether anything is currently running on your collateral, and
2. writes down the current block number.

Think of that block number as a timestamp on a photograph: *as of right now, this collateral
is idle and unclaimed.*

Then **you broadcast the START** from your own wallet. That is the normal thing you would do
to bring a Flux node online, with one difference: it points at Flux Hub's delegate key, so we
can keep the node alive for you afterwards without ever needing your wallet again.

We watch for it. It shows up in about a minute. We find the transaction, check it says what it
should, and your collateral is in the pool.

## Why the order matters

This is the whole trick, and it is worth thirty seconds.

If you simply handed us a transaction ID and said *"here, this is already registered, go look
it up"* — we would find a perfectly valid registration. But we would have no idea whether
**you** own it. Anyone can read the blockchain and copy a number off it. That proves a
registration exists; it proves nothing about the person in the room.

Because we checked **first** that nothing was pending, and wrote down the block number
**before** asking you, a START that appears afterwards can only have come from the person we
just asked. It cannot be something that was already in flight, it cannot be someone else's,
and it cannot be a leftover from months ago.

Nobody signs a challenge string. We store no secret. You prove nothing twice. **The sequence
itself is the proof.**

## What it costs you

Nothing extra. The START you broadcast for us **is** your node's first START — we are not
asking you to burn one on a test. We arm when a slot is ready, so the node goes up inside the
same window and your collateral goes straight from donated to earning with no idle penalty.

Block rewards go to the collateral's own address automatically. That is your address. The
Foundation does not take them and we do not store a payout wallet, because there is nothing
to store — Flux pays the collateral.

## If something goes wrong

Two things have to be true before you broadcast, and we check both up front rather than
letting you find out at the wallet:

- **The collateral must be at least 100 confirmations old** — roughly 50 minutes after you
  funded it. If it is not, we tell you how many blocks are left *before* any clock starts.
- **Nothing can already be running on it.** If a node is live on that collateral somewhere,
  we cannot touch it — the ingest refuses it outright, and nothing is recorded.

After that:

| Situation | What happens |
|---|---|
| You get distracted and the 15 minutes lapse | One click to re-arm. You re-enter nothing. |
| The START lands late, after the timer | We still take it. The proof is the block number we wrote down, not the timer on our screen. |
| You broadcast a plain owner START by mistake | We tell you so, and you broadcast the right one. Nothing is stuck. |
| The registration is somehow unrecoverable | Destroy the collateral and re-make it: **0 FLUX**, about 50 minutes of re-maturing. It is never a dead end. |

## What we can and cannot do afterwards

**Can:** restart your node after it expires, and move it to different hardware if an operator's
machine goes away. That is what the delegate key is for, and it is why the START you broadcast
registers it.

**Cannot:** spend your collateral, move your FLUX, or change where rewards go. The delegate key
authorizes exactly one thing — starting a node on that collateral — and nothing else. Your
wallet keys never leave your wallet.

**You can withdraw at any time.** Tell us and we retire the entry: it is withdrawn from the
pool and never matched to another slot. If a node is live on it at that moment we take that
node down first — a retire is refused while it is still backing one, deliberately, so a
customer's node can never vanish underneath them. After that the collateral is entirely
yours again, and nothing on chain needs undoing.
