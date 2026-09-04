import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SIGNED_RECORD_DELIMITER,
  joinSignedRecord,
  splitSignedRecord,
  stripTrailingNewlines,
} from "./signed-record";

const HEADER = "# flux-hub\nkind:     leased\nborrower: moltentech-test1";

test("a description with no delimiter has no record", () => {
  const { header, record } = splitSignedRecord(HEADER);
  assert.equal(record, null);
  assert.equal(header, HEADER);
});

test("round trip: what is joined is what is split back out", () => {
  const rec = '{"a":1,"b":"x"}';
  const { header, record } = splitSignedRecord(joinSignedRecord(HEADER, rec));
  assert.equal(header, HEADER);
  assert.equal(record, rec);
});

test("trailing newlines are stripped on BOTH sides, so a Proxmox round trip is a no-op", () => {
  // Proxmox strips all trailing newlines. If the writer emitted one, the verifier would hash
  // different bytes than the signer did — the exact failure this normalisation exists to stop.
  const rec = '{"a":1}';
  const written = joinSignedRecord(HEADER, rec + "\n\n\n");
  const asProxmoxReturnsIt = stripTrailingNewlines(written);
  assert.equal(splitSignedRecord(written).record, rec);
  assert.equal(splitSignedRecord(asProxmoxReturnsIt).record, rec);
});

test("leading and interior whitespace SURVIVE — they are part of the signed bytes", () => {
  // Measured: only trailing newlines are lost. Trimming anything else would make the verifier
  // hash something the signer never emitted.
  const rec = "  leading\n\n\tinterior tab\ntrailing spaces   ";
  assert.equal(splitSignedRecord(joinSignedRecord(HEADER, rec)).record, rec);
});

test("the FIRST delimiter wins, so a record cannot be truncated by a second one", () => {
  const rec = `line one\n${SIGNED_RECORD_DELIMITER}\nline two`;
  const { record } = splitSignedRecord(joinSignedRecord(HEADER, rec));
  assert.equal(record, rec);
});

test("a header containing the delimiter is refused, never emitted", () => {
  assert.throws(
    () => joinSignedRecord(`${HEADER}\n${SIGNED_RECORD_DELIMITER}`, "{}"),
    /ambiguous/
  );
});

test("an empty record is still a delimiter with nothing under it", () => {
  assert.equal(splitSignedRecord(joinSignedRecord(HEADER, "")).record, "");
});

test("stripTrailingNewlines touches nothing but trailing \\n", () => {
  assert.equal(stripTrailingNewlines("a\n\n"), "a");
  assert.equal(stripTrailingNewlines("\na"), "\na");
  assert.equal(stripTrailingNewlines("a  "), "a  ");
  assert.equal(stripTrailingNewlines("a\n \n"), "a\n ");
});
