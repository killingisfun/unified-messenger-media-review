// Small browser-only ZIP writer. Keeping this here avoids a dependency on a
// CDN or server archive; Blob parts are reused instead of copied into one
// large byte array before the download.
const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function zipCrc32(bytes, crc = 0xffffffff) {
  let c = crc;
  for (const b of bytes) c = ZIP_CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}
function zipU16(value) { return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]); }
function zipU32(value) { return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]); }

async function zipBlobCrc32(blob) {
  const reader = blob.stream().getReader();
  let crc = 0xffffffff;
  let sinceYield = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      crc = zipCrc32(value, crc);
      sinceYield += value.byteLength;
      if (sinceYield >= 1024 * 1024) {
        sinceYield = 0;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function buildZipBlob(entries) {
  if (entries.length > 0xffff) throw new Error('В архиве слишком много файлов для ZIP.');
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(String(entry.name || 'file'));
    const data = entry.data instanceof Blob ? entry.data : new Blob([entry.data]);
    if (data.size > 0xffffffff || offset + 30 + name.length + data.size > 0xffffffff) {
      throw new Error('Размер архива превышает лимит ZIP (4 ГБ).');
    }
    const crc = await zipBlobCrc32(data);
    const local = new Uint8Array(30 + name.length);
    local.set([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
    // General-purpose bit 11 marks the entry name as UTF-8. Without it
    // Windows/WinRAR decode Cyrillic filenames as mojibake.
    local.set(zipU16(0x0800), 6);
    local.set(zipU32(crc), 14); local.set(zipU32(data.size), 18); local.set(zipU32(data.size), 22);
    local.set(zipU16(name.length), 26); local.set(zipU16(0), 28); local.set(name, 30);
    chunks.push(local, data);
    const cd = new Uint8Array(46 + name.length);
    cd.set([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0], 0);
    cd.set(zipU16(0x0800), 8);
    cd.set(zipU32(crc), 16); cd.set(zipU32(data.size), 20); cd.set(zipU32(data.size), 24);
    cd.set(zipU16(name.length), 28); cd.set(zipU16(0), 30); cd.set(zipU16(0), 32); cd.set(zipU16(0), 34); cd.set(zipU16(0), 36);
    cd.set(zipU32(0), 38); cd.set(zipU32(offset), 42); cd.set(name, 46);
    central.push(cd); offset += local.length + data.size;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize + 22 > 0xffffffff) throw new Error('Размер архива превышает лимит ZIP (4 ГБ).');
  const end = new Uint8Array(22);
  end.set([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0], 0);
  end.set(zipU16(entries.length), 8); end.set(zipU16(entries.length), 10);
  end.set(zipU32(centralSize), 12); end.set(zipU32(offset), 16);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}
