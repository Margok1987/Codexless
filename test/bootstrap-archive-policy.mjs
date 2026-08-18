import assert from "node:assert/strict";
import { parseMacTarListing, validateArchiveEntries } from "../src/bootstrap-archive.mjs";

const root = "codexless-0.2.0-preview.0";
const good = [
  { path: `${root}/`, type: "directory", size: 0 },
  { path: `${root}/config/`, type: "directory", size: 0 },
  { path: `${root}/config/release-manifest.json`, type: "file", size: 100 },
  { path: `${root}/scripts/install.ps1`, type: "file", size: 200 },
];
const accepted = validateArchiveEntries(good, { platform: "win32", expectedRoot: root });
assert.equal(accepted.expandedBytes, 300);

for (const [label, entry, code] of [
  ["traversal", { path: `${root}/../evil`, type: "file", size: 1 }, "ARCHIVE_TRAVERSAL"],
  ["absolute", { path: "/evil", type: "file", size: 1 }, "ARCHIVE_ABSOLUTE_PATH"],
  ["drive", { path: "C:/evil", type: "file", size: 1 }, "ARCHIVE_ABSOLUTE_PATH"],
  ["UNC", { path: "//server/share/evil", type: "file", size: 1 }, "ARCHIVE_ABSOLUTE_PATH"],
  ["NUL", { path: `${root}/evil\0x`, type: "file", size: 1 }, "ARCHIVE_PATH_INVALID"],
  ["symlink", { path: `${root}/link`, type: "symlink", size: 0 }, "ARCHIVE_SYMLINK_REJECTED"],
  ["hardlink", { path: `${root}/hard`, type: "hardlink", size: 0 }, "ARCHIVE_HARDLINK_REJECTED"],
  ["device", { path: `${root}/device`, type: "device", size: 0 }, "ARCHIVE_SPECIAL_ENTRY_REJECTED"],
  ["sibling", { path: "other-root/evil", type: "file", size: 1 }, "ARCHIVE_SIBLING_PAYLOAD"],
]) {
  assert.throws(
    () => validateArchiveEntries([good[0], entry], { platform: "win32", expectedRoot: root }),
    (error) => error?.code === code,
    `${label} must fail with ${code}`
  );
}

assert.throws(
  () => validateArchiveEntries([good[0], good[2], { ...good[2] }], { platform: "darwin", expectedRoot: root }),
  (error) => error?.code === "ARCHIVE_DUPLICATE_ENTRY"
);
assert.throws(
  () => validateArchiveEntries([good[0], good[2], { ...good[2], path: `${root}/CONFIG/RELEASE-MANIFEST.JSON` }], { platform: "win32", expectedRoot: root }),
  (error) => error?.code === "ARCHIVE_CASE_COLLISION"
);
assert.doesNotThrow(() => validateArchiveEntries([good[0], good[2], { ...good[2], path: `${root}/CONFIG/RELEASE-MANIFEST.JSON` }], { platform: "darwin", expectedRoot: root }));
assert.throws(
  () => validateArchiveEntries(good, { platform: "win32", expectedRoot: root, maxEntries: 2 }),
  (error) => error?.code === "ARCHIVE_TOO_MANY_ENTRIES"
);
assert.throws(
  () => validateArchiveEntries(good, { platform: "win32", expectedRoot: root, maxExpandedBytes: 250 }),
  (error) => error?.code === "ARCHIVE_EXPANDED_TOO_LARGE"
);
assert.throws(
  () => validateArchiveEntries([
    { path: `${root}`, type: "file", size: 1 },
    { path: `${root}/`, type: "directory", size: 0 },
  ], { platform: "win32", expectedRoot: root }),
  (error) => error?.code === "ARCHIVE_CASE_COLLISION",
  "file/directory collision at the same normalized path must fail"
);

const macParsed = parseMacTarListing(
  [
    `drwxr-xr-x  0 user group 0 Jan  1 00:00 ${root}/`,
    `-rw-r--r--  0 user group 123 Jan  1 00:00 ${root}/file.txt`,
    `lrwxr-xr-x  0 user group 0 Jan  1 00:00 ${root}/link -> target`,
    `hrw-r--r--  0 user group 0 Jan  1 00:00 ${root}/hard link to target`,
    `crw-------  0 user group 0 Jan  1 00:00 ${root}/device`,
  ].join("\n"),
  [
    `${root}/`,
    `${root}/file.txt`,
    `${root}/link`,
    `${root}/hard`,
    `${root}/device`,
  ].join("\n")
);
assert.deepEqual(macParsed.map((entry) => entry.type), ["directory", "file", "symlink", "hardlink", "special"]);
assert.throws(() => validateArchiveEntries(macParsed, { platform: "darwin", expectedRoot: root }), /archive entry type is not allowed/);

process.stdout.write("bootstrap archive policy PASS\n");
