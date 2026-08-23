import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLanNetwork,
  slotLanIp,
  allocateApiPort,
  DEFAULT_API_PORT,
  API_PORT_STRIDE,
  MAX_API_PORT,
  API_PORTS_PER_WAN,
  isFluxApiPort,
} from "./scaffold";

/**
 * Two questions that used to be four, and one that used to be asked once per slot.
 *
 * `lanIp` and `gateway` were separate free-text answers, which is how a `lanIp` ends up
 * without its `/NN` — and a bare lanIp silently becomes /32, so the node boots with no
 * route out and is reachable by nobody. `doctor` catches that after the fact; taking the
 * prefix from the gateway answer means an inventory without one cannot be written.
 */

test("one answer yields gateway, prefix and the base to build host addresses on", () => {
  const net = parseLanNetwork("192.168.87.1/24");
  assert.deepEqual(net, { gateway: "192.168.87.1", prefix: 24, base: "192.168.87." });
});

test("surrounding whitespace is not an error the operator has to see", () => {
  assert.equal(parseLanNetwork("  10.0.0.1/22  ").prefix, 22);
});

test("⭐ a gateway with NO prefix is refused — that omission is the whole bug", () => {
  assert.throws(() => parseLanNetwork("192.168.87.1"), /192\.168\.87\.1\/24/);
});

test("nonsense is refused with the shape that was wanted", () => {
  assert.throws(() => parseLanNetwork("not-an-ip"), /expected a gateway with prefix/);
  assert.throws(() => parseLanNetwork("192.168.999.1/24"), /valid IPv4/);
  assert.throws(() => parseLanNetwork("192.168.87.1/31"), /not usable/);
});

test("a host NUMBER is completed from the gateway's own network", () => {
  const net = parseLanNetwork("192.168.87.1/24");
  assert.equal(slotLanIp("5", net), "192.168.87.5/24");
  assert.equal(slotLanIp(" 12 ", net), "192.168.87.12/24");
});

test("a full address is kept, and always carries the prefix", () => {
  const net = parseLanNetwork("192.168.87.1/24");
  assert.equal(slotLanIp("192.168.88.9", net), "192.168.88.9/24", "a different subnet is the operator's call");
  assert.equal(slotLanIp("192.168.87.9/32", net), "192.168.87.9/24", "a typed prefix does not override the LAN's");
});

test("⭐ every produced lanIp has a prefix — the property doctor exists to check", () => {
  const net = parseLanNetwork("10.1.2.1/22");
  for (const input of ["7", "10.1.2.7", " 10.1.2.7 ", "10.1.2.7/32"]) {
    assert.match(slotLanIp(input, net), /\/\d{1,2}$/, `"${input}" must produce a prefixed address`);
  }
});

test("garbage in a slot address is refused rather than written out", () => {
  const net = parseLanNetwork("192.168.87.1/24");
  assert.throws(() => slotLanIp("", net), /neither a host number nor an IPv4 address/);
  assert.throws(() => slotLanIp("host-2", net), /neither a host number nor an IPv4 address/);
});

test("API ports are allocated in tens, matching the live fleet", () => {
  // Measured on prod (Slot.apiPort, 2026-08-22): 16127, 16137 … 16197. Flux takes a small
  // block of consecutive ports per node, so consecutive node ports would collide.
  assert.equal(API_PORT_STRIDE, 10);
  const ports = [0, 1, 2, 7].map((i) => allocateApiPort(DEFAULT_API_PORT, i));
  assert.deepEqual(ports, [16127, 16137, 16147, 16197]);
});

test("⭐ the block ENDS at 16197 — which is why a WAN IP carries eight slots", () => {
  // Not a style rule: it is the same fact as [[project_flux_wan_ip_expansion]]'s "+8 slots
  // per WAN IP". If this ever disagrees with the port range, one of the two is wrong.
  assert.equal(MAX_API_PORT, 16197);
  assert.equal(API_PORTS_PER_WAN, 8);
  assert.equal(allocateApiPort(DEFAULT_API_PORT, API_PORTS_PER_WAN - 1), MAX_API_PORT);
});

test("⭐ a port off the stride is refused — it overlaps the previous node's block", () => {
  // The failure this prevents is silent and lands on the WRONG node: Flux serves a small
  // run of consecutive ports from its base, so 16130 eats into 16127's block and 16127
  // goes unreachable. Nothing in the error would mention the port typed here.
  for (const bad of [16128, 16130, 16126, 16121]) assert.equal(isFluxApiPort(bad), false, String(bad));
  for (const good of [16127, 16137, 16167, 16197]) assert.equal(isFluxApiPort(good), true, String(good));
});

test("every usable port ends in 7, and nothing outside the block is usable", () => {
  for (let p = 16127; p <= 16197; p += 10) assert.ok(isFluxApiPort(p) && p % 10 === 7);
  for (const outside of [16117, 16207, 8080, 0, -16127, 16127.5]) {
    assert.equal(isFluxApiPort(outside), false, String(outside));
  }
});

test("ports are unique WITHIN one WAN IP; across WAN IPs they repeat by design", () => {
  // Two nodes on 16127 are only a collision when they share a public address — which is
  // why the wizard restarts the block at every WAN IP rather than running one counter
  // across the whole scaffold.
  const oneWan = Array.from({ length: API_PORTS_PER_WAN }, (_, i) => allocateApiPort(DEFAULT_API_PORT, i));
  assert.equal(new Set(oneWan).size, oneWan.length);
  assert.ok(oneWan.every(isFluxApiPort));
});

test("a custom base is honoured, so a second WAN IP can use its own block", () => {
  assert.deepEqual([0, 1].map((i) => allocateApiPort(26127, i)), [26127, 26137]);
});
