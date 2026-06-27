/**
 * @moltentech/protocol — shared wire contracts for the MoltenTech marketplace.
 *
 * Single source of truth for the JSON exchanged between:
 *   - MT web app (private `moltentech` repo)
 *   - the operator on-prem agent (provisioning, outbound-only)
 *   - the operator Flux App (manifest + stats + payments, inbound)
 *
 * Every schema is a zod object (runtime validation) with an inferred TS type.
 * See ~/.claude/plans/pure-mapping-treehouse.md ("PAYMENTS & NOTIFICATION
 * ARCHITECTURE — REVISED 2026-06-23") for the architecture these encode.
 */
export * from "./common";
export * from "./manifest";
export * from "./messages";
