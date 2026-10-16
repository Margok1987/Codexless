import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  registerConstructionTools,
  decodeUtf8WithoutLoss,
  sliceAtWholeCodePoint,
  readManyAuthorized,
  preciseEditAuthorized,
} from "../src/construction-tools.mjs";

const cwd = await mkdtemp(path.join(os.tmpdir(), "codexless-construction-utf8-"));
test.after(async () => rm(cwd, { recursive: true, force: true }));
const authorityExecutor = {
  async resolveAuthority({ cwd: requestedCwd, access }) {
    assert.equal(requestedCwd, cwd);
    assert.ok(access === "readOnly" || access === "inherit");
    return { effectiveCwd: cwd, trustedAncestor: cwd, permissionProfile: access };
  },
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const fixture = (name) => path.join(cwd, name);
const read = (name, options = {}) => readManyAuthorized({
  authorityExecutor, cwd, paths: [name], ...options,
});
const edit = (name, expectedText, replacementText, options = {}) => preciseEditAuthorized({
  authorityExecutor, cwd, path: name, expectedText, replacementText, ...options,
});

test("strict UTF-8 decoder preserves all valid raw bytes", () => {
  for (const data of [
    Buffer.alloc(0),
    Buffer.from("A\r\nB"),
    Buffer.from("Gr\u00fc\u00dfe \u03c0 \u6f22\u5b57 \ud83d\ude00\n"),
    Buffer.from([0xEF, 0xBB, 0xBF, 0x41]),
    Buffer.from([0x41, 0x00, 0x42]),
    Buffer.from("A".repeat(999) + "\ud83d\ude00Z"),
    Buffer.from("\u{10ffff}"),
    Buffer.from("e\u0301"),
  ]) {
    assert.ok(Buffer.from(decodeUtf8WithoutLoss(data)).equals(data));
  }
});

test("strict UTF-8 decoder fails closed on malformed bytes", () => {
  for (const bytes of [
    [0x41, 0xFF, 0x42, 0x0A], [0xE2, 0x82], [0xC0, 0xAF],
    [0xED, 0xA0, 0x80], [0xF4, 0x90, 0x80, 0x80],
    [0x80], [0xE9],
  ]) {
    assert.throws(() => decodeUtf8WithoutLoss(Buffer.from(bytes)), /non-roundtrippable UTF-8/);
  }
});

test("bounded prefix never cuts an astral Unicode surrogate pair", () => {
  const astral = "\ud83d\ude00";
  for (const [text, limit, expected] of [
    [astral + "Z", 0, ""], [astral + "Z", 1, ""],
    [astral + "Z", 2, astral], [astral + "Z", 3, astral + "Z"],
    ["ABCDE", 3, "ABC"], ["ABC", 1000, "ABC"],
    ["A".repeat(998) + astral + "Z", 1000, "A".repeat(998) + astral],
    ["A".repeat(999) + astral + "Z", 1000, "A".repeat(999)],
    ["A".repeat(999) + astral + "Z", 1001, "A".repeat(999) + astral],
    ["A".repeat(999) + astral + "Z", 2000, "A".repeat(999) + astral + "Z"],
  ]) {
    const prefix = sliceAtWholeCodePoint(text, limit);
    assert.equal(prefix, expected);
    assert.ok(prefix.length <= limit);
    assert.doesNotMatch(prefix, /[\uD800-\uDBFF]$/);
    JSON.parse(JSON.stringify({ prefix }));
  }
});

test("helper argument contracts reject unsupported values", () => {
  assert.throws(() => decodeUtf8WithoutLoss("raw text"), /expected a Buffer/);
  for (const [text, bound] of [[3, 10], ["A", NaN], ["A", 1.5], ["A", -1], ["A", Infinity]]) {
    assert.throws(() => sliceAtWholeCodePoint(text, bound), /expected text/);
  }
});

test("read_many does not emit corrupted text from malformed UTF-8 files", async () => {
  const name = "read-invalid.bin";
  const before = Buffer.from([0x41, 0xFF, 0x42, 0x0A]);
  await writeFile(fixture(name), before);
  await assert.rejects(read(name), /non-roundtrippable UTF-8/);
  assert.deepEqual(await readFile(fixture(name)), before);
});

test("read_many safely truncates adjacent to a surrogate pair", async () => {
  const first = "unicode-safe.txt";
  const second = "unicode-split.txt";
  await writeFile(fixture(first), "A".repeat(998) + "\ud83d\ude00Z");
  await writeFile(fixture(second), "A".repeat(999) + "\ud83d\ude00Z");

  const safe = (await read(first, { maxCharsPerFile: 1000, maxTotalChars: 1000 })).files[0];
  assert.equal(safe.returnedChars, 1000);
  assert.equal(safe.text, "A".repeat(998) + "\ud83d\ude00");
  assert.equal(safe.truncated, true);

  const split = (await read(second, { maxCharsPerFile: 1000, maxTotalChars: 1000 })).files[0];
  assert.equal(split.returnedChars, 999);
  assert.equal(split.chars, 1002);
  assert.equal(split.byteLength, 1004);
  assert.equal(split.text, "A".repeat(999));
  assert.equal(split.truncated, true);
  JSON.parse(JSON.stringify(split));

  const later = (await read(second, { maxCharsPerFile: 1001, maxTotalChars: 1001 })).files[0];
  assert.equal(later.returnedChars, 1001);
  assert.equal(later.text, "A".repeat(999) + "\ud83d\ude00");
  const full = (await read(second, { maxCharsPerFile: 2000, maxTotalChars: 2000 })).files[0];
  assert.equal(full.returnedChars, 1002);
  assert.equal(full.truncated, false);
  assert.equal(full.text, "A".repeat(999) + "\ud83d\ude00Z");
  assert.equal(later.sha256, full.sha256);
});

test("read_many aggregate character budget and empty second file remain correct", async () => {
  await writeFile(fixture("total-first.txt"), "A".repeat(999) + "\ud83d\ude00Z");
  await writeFile(fixture("total-next.txt"), "Hello");
  const result = await readManyAuthorized({
    authorityExecutor, cwd,
    paths: ["total-first.txt", "total-next.txt"],
    maxCharsPerFile: 1000, maxTotalChars: 1000,
  });
  assert.equal(result.returnedChars, 1000);
  assert.equal(result.files[0].returnedChars, 999);
  assert.equal(result.files[1].returnedChars, 1);
  assert.equal(result.files[1].text, "H");
  const exhausted = await readManyAuthorized({
    authorityExecutor, cwd,
    paths: ["total-next.txt", "total-first.txt"],
    maxCharsPerFile: 1000, maxTotalChars: 1000,
  });
  assert.equal(exhausted.returnedChars, 1000);
});

test("precise_edit refuses malformed file bytes before preview or write", async () => {
  const name = "edit-invalid.bin";
  const before = Buffer.from([0x41, 0xFF, 0x42, 0x0A]);
  await writeFile(fixture(name), before);
  const expectedSha256 = sha256(before);
  await assert.rejects(edit(name, "B", "B", { expectedSha256, previewOnly: true }), /non-roundtrippable UTF-8/);
  await assert.rejects(edit(name, "B", "B", { expectedSha256, previewOnly: false }), /non-roundtrippable UTF-8/);
  const after = await readFile(fixture(name));
  assert.deepEqual(after, before);
  assert.equal(sha256(after), expectedSha256);
});

test("precise_edit preserves a UTF-8 BOM and verifies preview, CAS, and apply", async () => {
  const name = "bom-valid.txt";
  const original = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("Hallo \u03c0\r\n")]);
  await writeFile(fixture(name), original);
  const expectedSha256 = sha256(original);
  const preview = await edit(name, "Hallo", "Gr\u00fc\u00dfe", { expectedSha256, previewOnly: true });
  assert.equal(preview.status, "preview");
  assert.equal(preview.changed, true);
  assert.deepEqual(await readFile(fixture(name)), original);
  await assert.rejects(edit(name, "Hallo", "Gr\u00fc\u00dfe", {
    expectedSha256: "0".repeat(64),
  }), /expectedSha256/);
  const applied = await edit(name, "Hallo", "Gr\u00fc\u00dfe", { expectedSha256 });
  const expected = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("Gr\u00fc\u00dfe \u03c0\r\n")]);
  assert.equal(applied.status, "applied");
  assert.deepEqual(await readFile(fixture(name)), expected);
  assert.equal(applied.afterSha256, sha256(expected));
});

test("identity replacement is byte-identical on valid UTF-8", async () => {
  const name = "edit-identity.txt";
  const data = Buffer.from("A\ud83d\ude00B\n");
  await writeFile(fixture(name), data);
  const result = await edit(name, "B", "B", { expectedSha256: sha256(data) });
  assert.equal(result.changed, false);
  assert.equal(result.beforeSha256, result.afterSha256);
  assert.deepEqual(await readFile(fixture(name)), data);
});

test("precise_edit refuses an unpaired replacement surrogate without writing", async () => {
  const name = "edit-invalid-replacement.txt";
  const original = Buffer.from("valid-TEST\n");
  await writeFile(fixture(name), original);
  await assert.rejects(edit(name, "TEST", "\uD800", { expectedSha256: sha256(original) }), /non-roundtrippable UTF-8 replacement/);
  assert.deepEqual(await readFile(fixture(name)), original);
});

test("precise_edit exact occurrence mismatch fails without writing", async () => {
  const name = "edit-count.txt";
  const original = Buffer.from("ONE-ONE\n");
  await writeFile(fixture(name), original);
  await assert.rejects(edit(name, "ONE", "TWO", { expectedOccurrences: 1, expectedSha256: sha256(original) }), /occurs 2 times/);
  assert.deepEqual(await readFile(fixture(name)), original);
});

test("registered MCP read_many returns JSON-safe complete metadata at surrogate limits", async () => {
  const registered = new Map();
  const server = { registerTool(name, config, handler) { registered.set(name, { config, handler }); } };
  registerConstructionTools(server, { authorityExecutor });
  assert.equal(registered.size, 4);
  const name = "registered-read-unicode.txt";
  await writeFile(fixture(name), "A".repeat(999) + "\ud83d\ude00Z");
  const result = await registered.get("codex.read_many").handler({
    cwd, paths: [name], maxCharsPerFile: 1000, maxTotalChars: 1000,
  });
  assert.equal(result.isError, false);
  const decoded = JSON.parse(result.content[0].text);
  assert.equal(decoded.files[0].returnedChars, 999);
  assert.equal(decoded.files[0].truncated, true);
  assert.equal(decoded.files[0].text, "A".repeat(999));
  assert.deepEqual(decoded, result.structuredContent);
});

test("registered MCP precise_edit fails closed without dispatch on invalid UTF-8", async () => {
  const registered = new Map();
  const server = { registerTool(name, config, handler) { registered.set(name, handler); } };
  registerConstructionTools(server, { authorityExecutor });
  const name = "registered-edit-invalid.bin";
  const original = Buffer.from([0x41, 0xFF, 0x42, 0x0A]);
  await writeFile(fixture(name), original);
  const result = await registered.get("codex.precise_edit")({
    cwd, path: name, expectedText: "B", replacementText: "B",
    expectedSha256: sha256(original), expectedOccurrences: 1, previewOnly: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /non-roundtrippable UTF-8/);
  assert.equal(JSON.parse(result.content[0].text).error, result.structuredContent.error);
  assert.deepEqual(await readFile(fixture(name)), original);
});
