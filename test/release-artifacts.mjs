import assert from "node:assert/strict";
import { buildDeterministicTarGz, buildDeterministicZip, readDeterministicTarGz, readDeterministicZip, sha256 } from "../scripts/release-artifacts-lib.mjs";

const entries = [
  { path: "codexless-test/z.txt", bytes: Buffer.from("z\n") },
  { path: "codexless-test/a.txt", bytes: Buffer.from("a\n") },
];
for (const [label, build, read] of [["zip", buildDeterministicZip, readDeterministicZip], ["tar.gz", buildDeterministicTarGz, readDeterministicTarGz]]) {
  const first = build(entries);
  const second = build([...entries].reverse());
  assert.equal(sha256(first), sha256(second), `${label} must be byte-for-byte deterministic independent of caller order`);
  assert.deepEqual(read(first).map((entry) => [entry.path, entry.bytes.toString("utf8")]), [["codexless-test/a.txt", "a\n"], ["codexless-test/z.txt", "z\n"]]);
}
const zip = buildDeterministicZip(entries);
const corrupted = Buffer.from(zip);
corrupted[corrupted.indexOf(Buffer.from("a\n"))] ^= 0xff;
assert.throws(() => readDeterministicZip(corrupted), /CRC mismatch/, "tampered ZIP payload must fail closed");
process.stdout.write("release artifacts PASS\n");
