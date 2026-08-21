import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const ZIP_EPOCH_DATE = 0x21;
const ZIP_EPOCH_TIME = 0;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildDeterministicZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of normalizedEntries(entries)) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.bytes);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(ZIP_EPOCH_TIME, 10);
    local.writeUInt16LE(ZIP_EPOCH_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(ZIP_EPOCH_TIME, 12);
    central.writeUInt16LE(ZIP_EPOCH_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

export function readDeterministicZip(bytes) {
  const buffer = Buffer.from(bytes);
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    if (method !== 0) throw new Error("release ZIP must use stored entries");
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error("truncated release ZIP entry");
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    if (crc32(data) !== expectedCrc) throw new Error("release ZIP CRC mismatch");
    entries.push({ path: buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"), bytes: Buffer.from(data) });
    offset = dataStart + size;
  }
  if (!entries.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid release ZIP structure");
  return entries;
}

export function buildDeterministicTarGz(entries) {
  const chunks = [];
  for (const entry of normalizedEntries(entries)) {
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.bytes.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    writeTarOctal(header, 148, 8, header.reduce((sum, value) => sum + value, 0));
    chunks.push(header, entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

export function readDeterministicTarGz(bytes) {
  const tar = gunzipSync(bytes);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const type = header[156];
    if (type !== 0 && type !== 0x30) throw new Error("release tar contains a non-file entry");
    const name = readTarString(header, 0, 100);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error("truncated release tar entry");
    entries.push({ path: name, bytes: Buffer.from(data) });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!entries.length) throw new Error("release tar contains no files");
  return entries;
}

function normalizedEntries(entries) {
  const normalized = entries.map(({ path, bytes }) => ({ path: String(path).replace(/\\/g, "/"), bytes: Buffer.from(bytes) }));
  normalized.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (normalized.some((entry, index) => !entry.path || entry.path.startsWith("/") || entry.path.includes("..") || (index && entry.path === normalized[index - 1].path))) {
    throw new Error("release archive paths must be unique safe relative paths");
  }
  return normalized;
}

function writeTarString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`release tar field is too long: ${value}`);
  encoded.copy(buffer, offset);
}

function readTarString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function writeTarOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  buffer.write(text, offset, length, "ascii");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
