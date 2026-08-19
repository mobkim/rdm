// Decodes RustDesk's raw VP9 video frames (probe.ts confirmed the Mac sends `vp9s`,
// not h264s — its PeerInfo.encoding never advertised h264 support) into a stream of
// JPEG images, via an `ffmpeg` subprocess.
//
// EncodedVideoFrame.data is a bare libvpx-compressed VP9 frame with no container —
// that's fine for scrap's own decoder (which calls vpx_codec_decode directly), but
// ffmpeg has no "raw VP9 elementary stream" demuxer (unlike H264's Annex-B). So each
// frame gets wrapped in a minimal per-frame IVF container (one 32-byte file header,
// then a 12-byte frame header per frame) written to ffmpeg's stdin; ffmpeg's `-f ivf`
// demuxer reads that natively. See https://wiki.multimedia.cx/index.php/IVF

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

// A few frames' worth of backlog is enough to absorb a brief stall without
// visibly dropping anything; beyond that we're just adding latency.
const MAX_STDIN_BUFFERED_BYTES = 2 * 1024 * 1024;

function buildIvfFileHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(32);
  header.write('DKIF', 0, 'ascii');
  header.writeUInt16LE(0, 4); // version
  header.writeUInt16LE(32, 6); // header length
  header.write('VP90', 8, 'ascii'); // FourCC
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header.writeUInt32LE(30, 16); // framerate numerator (nominal; real pacing comes from pts)
  header.writeUInt32LE(1, 20); // framerate denominator
  header.writeUInt32LE(0, 24); // frame count: 0 = unknown/streaming
  header.writeUInt32LE(0, 28); // reserved
  return header;
}

function buildIvfFrameHeader(byteLength: number, frameIndex: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(byteLength, 0);
  // Deliberately NOT RustDesk's own EncodedVideoFrame.pts: that's in whatever clock/units
  // the peer's encoder uses, which doesn't correspond to this file's declared 30fps
  // timebase. Feeding it in directly made ffmpeg see huge (bogus) gaps in presentation
  // time between frames and duplicate the last decoded frame dozens of times to fill
  // each one — measured as ~130x frame amplification (29 real frames in, 3771 JPEGs
  // out over 5s), which is what was actually burning the CPU and causing the lag. A
  // plain sequential index sidesteps this: 1 input frame in, 1 output frame out, always.
  header.writeUInt32LE(frameIndex >>> 0, 4);
  header.writeUInt32LE(Math.floor(frameIndex / 0x100000000), 8);
  return header;
}

export declare interface Vp9JpegDecoder {
  on(event: 'jpeg', listener: (frame: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
}

export class Vp9JpegDecoder extends EventEmitter {
  #proc: ChildProcessWithoutNullStreams;
  #stdoutBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #headerWritten = false;
  #frameIndex = 0;

  constructor(width: number, height: number) {
    super();
    this.#proc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      // Without this, ffmpeg's default decode lookahead held ~16 frames
      // before emitting the first one, growing without bound — this is what
      // "typing takes seconds to show up" was: buffered video latency, not
      // slow input. Measured -flags low_delay alone: 44/45 frames decoded
      // correctly, near-zero added latency. Two things that look like they'd
      // help but actively corrupt decoding instead — verified, not guessed:
      // -fflags nobuffer makes ffmpeg parse whatever's arrived at each pipe
      // read() rather than a complete frame, misaligning frame boundaries
      // (0/45 decoded, bitstream errors); shrinking -probesize/-analyzeduration
      // broke IVF demuxing outright the same way. Left alone.
      '-flags', 'low_delay',
      '-f', 'ivf',
      '-i', 'pipe:0',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      // Was bumped to 10 (lower quality) as a preemptive bandwidth mitigation for a
      // hypothesized WireGuard-constrained remote hop — reverted now that the actual
      // lag turned out to be the ffmpeg frame-duplication bug (see buildIvfFrameHeader),
      // not bandwidth. The ws.bufferedAmount backpressure check in sessionManager.ts
      // still exists as a real safety net if a slow link does show up again.
      '-q:v', '5',
      'pipe:1',
    ]);
    this.#proc.stdin.write(buildIvfFileHeader(width, height));
    this.#headerWritten = true;

    this.#proc.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    this.#proc.stderr.on('data', (chunk: Buffer) => {
      this.emit('error', new Error(`ffmpeg: ${chunk.toString('utf8').trim()}`));
    });
    this.#proc.on('error', (err) => this.emit('error', err));
    this.#proc.on('exit', (code) => this.emit('exit', code));
  }

  pushFrame(data: Buffer): void {
    if (!this.#headerWritten || this.#proc.stdin.destroyed) return;
    // Drop the frame rather than let ffmpeg's stdin buffer grow unbounded when the
    // JPEG re-encode can't keep up (CPU-bound) — an unchecked write() here queues
    // forever and reproduces the exact "growing multi-second lag" symptom that
    // -flags low_delay above already fixed for ffmpeg's *internal* decode buffering;
    // this is the same failure mode one stage upstream, at the Node<->ffmpeg pipe.
    if (this.#proc.stdin.writableLength > MAX_STDIN_BUFFERED_BYTES) {
      // TEMP DEBUG: remove once the lag report is resolved.
      console.log(`[rustdesk debug] dropping VP9 frame at ffmpeg stdin, writableLength=${this.#proc.stdin.writableLength}`);
      return;
    }
    // One write, not two: a frame header written separately from its payload was
    // observed to get parsed before the payload half had arrived, corrupting frame
    // boundaries.
    this.#proc.stdin.write(Buffer.concat([buildIvfFrameHeader(data.length, this.#frameIndex++), data]));
  }

  stop(): void {
    this.#proc.stdin.end();
    this.#proc.kill();
  }

  #onStdout(chunk: Buffer): void {
    this.#stdoutBuf = this.#stdoutBuf.length === 0 ? chunk : Buffer.concat([this.#stdoutBuf, chunk]);
    while (true) {
      const start = this.#stdoutBuf.indexOf(JPEG_SOI);
      if (start === -1) {
        // No SOI yet; keep at most 1 byte (in case a split FF|D8 straddles chunks).
        if (this.#stdoutBuf.length > 1) this.#stdoutBuf = this.#stdoutBuf.subarray(this.#stdoutBuf.length - 1);
        return;
      }
      if (start > 0) this.#stdoutBuf = this.#stdoutBuf.subarray(start);
      const end = this.#stdoutBuf.indexOf(JPEG_EOI, JPEG_SOI.length);
      if (end === -1) return; // wait for more data
      const frameEnd = end + JPEG_EOI.length;
      this.emit('jpeg', Buffer.from(this.#stdoutBuf.subarray(0, frameEnd)));
      this.#stdoutBuf = this.#stdoutBuf.subarray(frameEnd);
    }
  }
}
