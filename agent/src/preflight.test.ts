import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRotational, checkManifestKey, runPreflight, formatPreflight } from "./preflight";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import type { AgentConfig } from "./config";

/** The whole point of preflight is catching failures that are otherwise SILENT, so
 * each check is asserted in both directions — a check that never fires is worse than
 * no check, because it reads as a clean bill of health. */

test("classifyRotational: an all-spinning node is rotational", () => {
  const { rotational } = classifyRotational([{ devpath: "/dev/sda", type: "hdd", rpm: 7200 }], "local-lvm");
  assert.equal(rotational, true);
});

test("classifyRotational: an all-SSD node is not", () => {
  const { rotational } = classifyRotational([{ devpath: "/dev/nvme0n1", type: "nvme" }], "ssd");
  assert.equal(rotational, false);
});

test("classifyRotational: a mixed node is INDETERMINATE, not a guess", () => {
  // pve30's real shape. Reporting "cannot tell" beats a confident wrong answer,
  // because the failure being prevented already presents as having no cause.
  const { rotational, why } = classifyRotational(
    [
      { devpath: "/dev/sda", type: "hdd", rpm: 7200 },
      { devpath: "/dev/sdb", type: "ssd" },
    ],
    "ssd"
  );
  assert.equal(rotational, null);
  assert.match(why, /cannot attribute/);
});

test("classifyRotational: a storage named after the spinning device is flagged", () => {
  const { rotational, why } = classifyRotational(
    [
      { devpath: "/dev/sda3", type: "hdd", rpm: 7200 },
      { devpath: "/dev/nvme0n1", type: "nvme" },
    ],
    "sda3"
  );
  assert.equal(rotational, true);
  assert.match(why, /spinning device/);
});

test("checkManifestKey: a literal shell expansion is named as such", () => {
  const r = checkManifestKey("$(base64 -w0 manifest-key.pem)");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /env files run no shell/);
});

test("checkManifestKey: base64 of something that is not a PEM", () => {
  const r = checkManifestKey(Buffer.from("hello").toString("base64"));
  assert.equal(r.status, "fail");
  assert.match(r.detail, /does not decode to a PEM/);
});

test("checkManifestKey: missing entirely", () => {
  assert.equal(checkManifestKey(undefined).status, "fail");
});

test("checkManifestKey: a real key with no pin is reported, not failed", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const r = checkManifestKey(Buffer.from(pem).toString("base64"));
  assert.equal(r.status, "skip");
  assert.match(r.detail, /nothing pinned/);
});

test("checkManifestKey: a real key that does NOT match the pin fails loudly", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const r = checkManifestKey(Buffer.from(pem).toString("base64"), "someOtherPubkeyBase64=");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /NOT the pinned one/);
});

test("checkManifestKey: matching the pin passes", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const pinned = createPublicKey({ key: pem, format: "pem" })
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  assert.equal(checkManifestKey(Buffer.from(pem).toString("base64"), pinned).status, "pass");
});

const CFG = {
  proxmox: { url: "https://pve30:8006", tokenId: "mt-agent@pve!agent", tokenSecret: "x" },
  host: { storageImages: "ssd", storageIso: "pve55-shared", arcaneIso: "FluxLive-1775071308.iso" },
} as unknown as AgentConfig;

function fakeGet(routes: Record<string, unknown>) {
  // Most-specific match wins. Insertion order would let "/storage" swallow
  // ".../storage/<id>/content" and hand the ISO check a storage list — which is how
  // this fake briefly made a healthy host look broken.
  const entries = Object.entries(routes);
  return async <T>(_cfg: AgentConfig, path: string): Promise<T> => {
    // endsWith first, then includes: ".../storage/<id>/content" must not be caught by
    // the "/storage" route, which is how this fake briefly made a healthy host look
    // broken (the ISO check received a storage list instead of its contents).
    for (const match of [
      (k: string) => path.endsWith(k),
      (k: string) => path.includes(k),
    ]) {
      for (const [k, v] of entries) {
        if (match(k)) {
          if (v instanceof Error) throw v;
          return v as T;
        }
      }
    }
    throw new Error("HTTP 404");
  };
}

test("an unreachable hypervisor stops the run and says so", async () => {
  const results = await runPreflight(CFG, [{ nodeName: "pve30" }], {
    get: fakeGet({ version: new Error("HTTP 401") }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.status, "fail");
  assert.match(results[0]!.detail, /token id or secret is wrong/);
});

test("a loopback PROXMOX_URL gets the container-loopback hint", async () => {
  const loopback = { ...CFG, proxmox: { ...CFG.proxmox, url: "https://127.0.0.1:8006" } } as AgentConfig;
  const results = await runPreflight(loopback, [{ nodeName: "pve30" }], {
    get: fakeGet({ version: new Error("connect ECONNREFUSED") }),
  });
  assert.match(results[0]!.detail, /container itself/);
});

test("a missing storage id lists what IS available", async () => {
  const results = await runPreflight(CFG, [{ nodeName: "pve30", storageImages: "nope" }], {
    get: fakeGet({
      version: {},
      "/storage": [{ storage: "ssd" }, { storage: "local" }],
      "disks/list": [],
    }),
  });
  const f = results.find((r) => r.name.includes('"nope" exists'));
  assert.equal(f!.status, "fail");
  assert.match(f!.detail, /Available: ssd, local/);
});

test("a rotational images pool FAILS rather than warns", async () => {
  const results = await runPreflight(CFG, [{ nodeName: "pve30", storageImages: "local-lvm" }], {
    get: fakeGet({
      version: {},
      "/storage": [{ storage: "local-lvm" }],
      "disks/list": [{ devpath: "/dev/sda3", type: "hdd", rpm: 7200 }],
      content: [],
    }),
  });
  const rot = results.find((r) => r.name.includes("not rotational"));
  assert.equal(rot!.status, "fail");
  assert.match(rot!.detail, /benchmarks will fail with no visible cause/);
  assert.equal(formatPreflight(results).ok, false);
});

test("an ISO storage that does not hold the named ISO fails", async () => {
  const results = await runPreflight(CFG, [{ nodeName: "pve30" }], {
    get: fakeGet({
      version: {},
      "/storage": [{ storage: "ssd" }, { storage: "pve55-shared" }],
      "disks/list": [{ devpath: "/dev/nvme0n1", type: "nvme" }],
      content: [{ volid: "pve55-shared:iso/SomethingElse.iso" }],
    }),
  });
  const isoCheck = results.find((r) => r.name.includes("holds"));
  assert.equal(isoCheck!.status, "fail");
  assert.match(isoCheck!.detail, /fail at boot media/);
});

test("a fully healthy host passes everything", async () => {
  const results = await runPreflight(CFG, [{ nodeName: "pve30" }], {
    get: fakeGet({
      version: {},
      "/storage": [{ storage: "ssd" }, { storage: "pve55-shared" }],
      "disks/list": [{ devpath: "/dev/nvme0n1", type: "nvme" }],
      content: [{ volid: "pve55-shared:iso/FluxLive-1775071308.iso" }],
    }),
  });
  assert.deepEqual(
    results.filter((r) => r.status === "fail"),
    []
  );
  assert.equal(formatPreflight(results).ok, true);
});
