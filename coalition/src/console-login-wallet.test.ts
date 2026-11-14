import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mintSessionCookie, verifySession, parseLoginWallet } from "./session";
import { loginWalletFilter } from "./console";

/**
 * The sign pages show only the wallet the console login was signed with: every console
 * signature comes from the same owner address. Display-only — nothing here decides what
 * is accepted.
 */
const SECRET = "s".repeat(32);
const ADDR = "1L1wz2wExampleOwnerAddress";
const asHeaders = (setCookie: string) => ({ cookie: setCookie.split(";")[0] });

test("the session cookie carries the login wallet", () => {
  for (const w of ["ssp", "zelcore"] as const) {
    const s = verifySession(SECRET, asHeaders(mintSessionCookie(SECRET, ADDR, 60_000, w)));
    assert.deepEqual(s, { addr: ADDR, wallet: w });
  }
});

test("a pasted login, or a cookie from before this release, carries no wallet", () => {
  const s = verifySession(SECRET, asHeaders(mintSessionCookie(SECRET, ADDR, 60_000)));
  assert.deepEqual(s, { addr: ADDR });
});

test("parseLoginWallet drops anything but the two apps", () => {
  assert.equal(parseLoginWallet("ssp"), "ssp");
  assert.equal(parseLoginWallet("zelcore"), "zelcore");
  for (const v of [null, undefined, "", "SSP", "manual", 1]) assert.equal(parseLoginWallet(v), undefined);
});

test("no login wallet → no filter (both wallets show)", () => {
  assert.equal(loginWalletFilter(undefined), "");
});

test("an SSP login hides Zelcore, offers it back, and reveals it when SSP is missing", () => {
  const js = loginWalletFilter("ssp");
  assert.match(js, /var keep="ssp"/);
  assert.match(js, /Use Zelcore instead/);
  assert.match(js, /typeof window\.ssp==='undefined'\) reveal\(\)/);
});

test("a Zelcore login hides SSP and offers it back", () => {
  const js = loginWalletFilter("zelcore");
  assert.match(js, /var keep="zelcore"/);
  assert.match(js, /Use SSP Wallet instead/);
});

const src = readFileSync(fileURLToPath(new URL("./console.ts", import.meta.url)), "utf8");
const server = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");

test("both sign pages apply the filter, fed from the session", () => {
  assert.equal(src.match(/\$\{loginWalletFilter\(wallet\)\}/g)?.length, 2);
  assert.match(server, /handleConsoleSign\(cfg, query, reqOrigin, consoleSession\?\.wallet\)/);
  assert.match(server, /handleConsoleSignPrice\(cfg, query, reqOrigin, consoleSession\?\.wallet\)/);
});

test("the login records SSP from the auto-submit and Zelcore from the callback poll", () => {
  assert.match(src, /loginSig\('ssp'\)/);
  assert.match(src, /mintSessionCookie\(secret, owner, cfg\.sessionTtlMs, parseLoginWallet\(params\.get\("wallet"\)\)\)/);
  assert.match(src, /mintSessionCookie\(secret, c\.authedAddr, cfg\.sessionTtlMs, "zelcore"\)/);
});
