// Port of hbb_common's BytesCodec (libs/hbb_common/src/bytes_codec.rs, rustdesk/hbb_common, AGPL-3.0).
//
// Frame = [1-4 byte little-endian length header][payload bytes].
// The low 2 bits of the first header byte encode (header_len - 1); the remaining
// bits, right-shifted by 2 across however many header bytes are present, are the
// payload length. This lets short frames (the vast majority — input events,
// clipboard) use a single header byte.

import { Transform, type TransformCallback } from 'stream';

const MAX_PACKET_LENGTH = 256 * 1024 * 1024; // generous cap; real payloads are frames/clipboard, not GB-scale

export function encodeFrame(payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len <= 0x3f) {
    header = Buffer.from([len << 2]);
  } else if (len <= 0x3fff) {
    header = Buffer.alloc(2);
    header.writeUInt16LE((len << 2) | 0x1, 0);
  } else if (len <= 0x3fffff) {
    const h = (len << 2) | 0x2;
    header = Buffer.alloc(3);
    header.writeUInt16LE(h & 0xffff, 0);
    header.writeUInt8((h >>> 16) & 0xff, 2);
  } else if (len <= 0x3fffffff) {
    header = Buffer.alloc(4);
    header.writeUInt32LE((len << 2) | 0x3, 0);
  } else {
    throw new Error('rustdesk frame payload too large to encode');
  }
  return Buffer.concat([header, payload]);
}

/** Decodes a stream of hbb_common-framed bytes into whole payload Buffers. */
export class FrameDecoder extends Transform {
  #buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(
    chunk: Buffer<ArrayBufferLike>,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    try {
      while (true) {
        const frame = this.#tryDecodeOne();
        if (frame === null) break;
        this.push(frame);
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  #tryDecodeOne(): Buffer | null {
    if (this.#buf.length < 1) return null;
    const headLen = (this.#buf[0]! & 0x3) + 1;
    if (this.#buf.length < headLen) return null;

    let n = this.#buf[0]!;
    if (headLen > 1) n |= this.#buf[1]! << 8;
    if (headLen > 2) n |= this.#buf[2]! << 16;
    if (headLen > 3) n |= (this.#buf[3]! << 24) >>> 0;
    n >>>= 2;

    if (n > MAX_PACKET_LENGTH) {
      throw new Error(`rustdesk frame too big: ${n} bytes`);
    }
    if (this.#buf.length < headLen + n) return null;

    const payload = this.#buf.subarray(headLen, headLen + n);
    this.#buf = this.#buf.subarray(headLen + n);
    return Buffer.from(payload);
  }
}
