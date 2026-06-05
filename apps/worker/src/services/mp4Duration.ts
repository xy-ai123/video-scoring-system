/**
 * Minimal MP4 / MOV duration extractor.
 *
 * Walks the ISO BMFF atom tree to find `moov` → `mvhd` and reads the
 * timescale + duration fields. Returns duration in seconds, or null if the
 * file isn't a parseable MP4 (e.g. WebM, AVI, corrupt header).
 *
 * Implementation is best-effort: we don't validate every atom, just the
 * structural fields we need. The function buffers the stream up to `capBytes`
 * — moov is often at the start (faststart-enabled) but smartphone recordings
 * commonly place it at the end of the file, so for those we need to read the
 * whole file to find it.
 */

export function findMoovRange(
  buf: Buffer,
): { start: number; end: number } | null {
  let off = 0;
  while (off + 8 <= buf.length) {
    const size32 = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    let payloadStart: number;
    let atomEnd: number;

    if (size32 === 0) {
      // size==0 means "extends to end of file"
      payloadStart = off + 8;
      atomEnd = buf.length;
    } else if (size32 === 1) {
      // size==1 means 64-bit size follows the type
      if (off + 16 > buf.length) return null;
      const sizeHi = buf.readUInt32BE(off + 8);
      const sizeLo = buf.readUInt32BE(off + 12);
      const size = sizeHi * 0x100000000 + sizeLo;
      if (!Number.isFinite(size) || size < 16) return null;
      payloadStart = off + 16;
      atomEnd = off + size;
    } else {
      if (size32 < 8) return null;
      payloadStart = off + 8;
      atomEnd = off + size32;
    }

    if (type === "moov") {
      return { start: payloadStart, end: atomEnd };
    }
    if (atomEnd <= off) return null;
    off = atomEnd;
  }
  return null;
}

export function parseDurationFromMoov(
  buf: Buffer,
  moovStart: number,
  moovEnd: number,
): number | null {
  const end = Math.min(moovEnd, buf.length);
  let off = moovStart;
  while (off + 8 <= end) {
    const size = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    if (size < 8) return null;
    if (type === "mvhd") {
      const payload = off + 8;
      if (payload + 4 > end) return null;
      const version = buf.readUInt8(payload);
      let p = payload + 4; // version(1) + flags(3)
      let timescale: number;
      let durationRaw: number;
      if (version === 1) {
        if (p + 8 + 8 + 4 + 8 > end) return null;
        p += 8 + 8; // creation_time, modification_time (each 64-bit)
        timescale = buf.readUInt32BE(p);
        p += 4;
        const hi = buf.readUInt32BE(p);
        const lo = buf.readUInt32BE(p + 4);
        durationRaw = hi * 0x100000000 + lo;
      } else {
        if (p + 4 + 4 + 4 + 4 > end) return null;
        p += 4 + 4; // creation_time, modification_time (each 32-bit)
        timescale = buf.readUInt32BE(p);
        p += 4;
        durationRaw = buf.readUInt32BE(p);
      }
      if (!Number.isFinite(timescale) || timescale === 0) return null;
      const sec = durationRaw / timescale;
      return Number.isFinite(sec) && sec >= 0 ? sec : null;
    }
    off += size;
  }
  return null;
}

/**
 * Drain `stream` up to `capBytes` and look for the moov atom. We need the
 * whole moov in memory to read mvhd reliably, so we buffer until either the
 * stream ends, we hit the cap, or we have a complete moov atom.
 */
export async function parseMp4DurationFromStream(
  stream: NodeJS.ReadableStream,
  capBytes = 512 * 1024 * 1024,
): Promise<number | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  let nextCheckAt = 256 * 1024; // first scan once we have ~256KB
  let buf: Buffer | null = null;

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    total += chunk.length;

    if (total >= capBytes) break;

    if (total >= nextCheckAt) {
      buf = Buffer.concat(chunks);
      const moov = findMoovRange(buf);
      if (moov && moov.end <= buf.length) {
        return parseDurationFromMoov(buf, moov.start, moov.end);
      }
      // Try again after another ~4MB arrives.
      nextCheckAt = total + 4 * 1024 * 1024;
    }
  }

  buf = Buffer.concat(chunks);
  const moov = findMoovRange(buf);
  if (!moov) return null;
  return parseDurationFromMoov(buf, moov.start, moov.end);
}

/**
 * Parse duration from a buffer that contains the *tail* of an MP4 file —
 * i.e. we don't know where any atom starts because we may be mid-`mdat`.
 *
 * Many smartphone recordings put `moov` at the very end (no "faststart"),
 * so for huge files the cheap approach is to fetch the last N MB via a
 * Drive ranged-GET and call this. We brute-force search for the `moov`
 * 4-character code; the 4 bytes immediately before it are the atom size.
 */
export function parseMp4DurationFromTailBuffer(buf: Buffer): number | null {
  for (let i = 4; i + 8 <= buf.length; i++) {
    // Cheap byte check before the slice → string comparison.
    if (
      buf[i] !== 0x6d /* m */ ||
      buf[i + 1] !== 0x6f /* o */ ||
      buf[i + 2] !== 0x6f /* o */ ||
      buf[i + 3] !== 0x76 /* v */
    ) {
      continue;
    }
    const sizePos = i - 4;
    const size32 = buf.readUInt32BE(sizePos);

    let payloadStart: number;
    let atomEnd: number;
    if (size32 >= 8) {
      payloadStart = sizePos + 8;
      atomEnd = sizePos + size32;
    } else if (size32 === 1) {
      if (sizePos + 16 > buf.length) continue;
      const hi = buf.readUInt32BE(sizePos + 8);
      const lo = buf.readUInt32BE(sizePos + 12);
      const ext = hi * 0x100000000 + lo;
      if (!Number.isFinite(ext) || ext < 16) continue;
      payloadStart = sizePos + 16;
      atomEnd = sizePos + ext;
    } else {
      continue;
    }

    // moov payload contents (mvhd, traks, …) must fit within our tail buffer
    // for this to be parseable. If atomEnd overshoots, mvhd might still be at
    // the front of the payload, so try parsing within whatever portion we have.
    const end = Math.min(atomEnd, buf.length);
    const sec = parseDurationFromMoov(buf, payloadStart, end);
    if (sec != null) return sec;
  }
  return null;
}
