// Minimal RustDesk peer client for "Direct IP Access" connections (client.rs's
// `is_ip_str(peer)` fast path in rustdesk/rustdesk). That path bypasses the
// rendezvous-server-mediated NAT punch entirely and — confirmed from source
// (client.rs: `is_secured` stays false but `is_direct_ip_access` skips the
// "insecure connection" prompt) — never establishes the NaCl/ECDH session key
// either. So this client speaks plain (unencrypted) framed protobuf directly
// to the peer, same as the real client does for this connection mode. That's
// an acceptable tradeoff only because rdm's Direct IP Access target is always
// on the same trusted LAN the bridge itself runs on.

import net from 'net';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { FrameDecoder, encodeFrame } from './frameCodec';
import { decodeMessage, encodeMessage } from './protocol';

const DEFAULT_PORT = 21118; // hbb_common::config::RELAY_PORT (21117) + 1

export interface RustDeskClientOptions {
  host: string;
  port?: number;
  password: string;
  myId?: string;
  myName?: string;
  connectTimeoutMs?: number;
}

export interface RustDeskPeerInfo {
  username: string;
  hostname: string;
  platform: string;
  version: string;
  currentDisplay: number;
  displays: Array<{ x: number; y: number; width: number; height: number }>;
}

type Resolved = { peerInfo: RustDeskPeerInfo };

export class RustDeskClient extends EventEmitter {
  readonly #opts: Required<RustDeskClientOptions>;
  #socket: net.Socket | null = null;
  #loggedIn = false;

  constructor(opts: RustDeskClientOptions) {
    super();
    this.#opts = {
      port: DEFAULT_PORT,
      myId: 'rdm',
      myName: 'RDM',
      connectTimeoutMs: 8000,
      ...opts,
    };
  }

  get isLoggedIn(): boolean {
    return this.#loggedIn;
  }

  connect(): Promise<RustDeskPeerInfo> {
    return new Promise<RustDeskPeerInfo>((resolve, reject) => {
      let settled = false;
      const settleResolve = (v: Resolved) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v.peerInfo);
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const timer = setTimeout(() => {
        settleReject(new Error(`rustdesk: timed out connecting to ${this.#opts.host}:${this.#opts.port}`));
        this.#socket?.destroy();
      }, this.#opts.connectTimeoutMs);

      const socket = net.createConnection({ host: this.#opts.host, port: this.#opts.port });
      this.#socket = socket;

      socket.on('error', (err) => {
        settleReject(err);
        this.emit('error', err);
      });
      socket.on('close', () => {
        this.#loggedIn = false;
        this.emit('close');
      });

      const decoder = new FrameDecoder();
      socket.pipe(decoder);
      decoder.on('data', (payload: Buffer) => {
        this.#handleFrame(payload, settleResolve, settleReject).catch((err) => this.emit('error', err));
      });
      decoder.on('error', (err) => this.emit('error', err));
    });
  }

  disconnect(): void {
    this.#socket?.end();
    this.#socket?.destroy();
    this.#socket = null;
    this.#loggedIn = false;
  }

  async sendMouseEvent(fields: {
    mask: number;
    x: number;
    y: number;
    modifiers?: number[];
  }): Promise<void> {
    await this.#send({ mouseEvent: { mask: fields.mask, x: fields.x, y: fields.y, modifiers: fields.modifiers ?? [] } });
  }

  async sendKeyEvent(fields: {
    down: boolean;
    press?: boolean;
    controlKey?: number;
    chr?: number;
    modifiers?: number[];
  }): Promise<void> {
    const keyEvent: Record<string, unknown> = {
      down: fields.down,
      press: fields.press ?? false,
      modifiers: fields.modifiers ?? [],
      mode: 0, // KeyboardMode.Legacy
    };
    if (fields.controlKey !== undefined) keyEvent.controlKey = fields.controlKey;
    else if (fields.chr !== undefined) keyEvent.chr = fields.chr;
    await this.#send({ keyEvent });
  }

  async sendClipboardText(text: string): Promise<void> {
    await this.#send({
      clipboard: {
        compress: false,
        content: Buffer.from(text, 'utf8'),
        format: 0, // ClipboardFormat.Text
      },
    });
  }

  async #send(union: Record<string, unknown>): Promise<void> {
    if (!this.#socket) throw new Error('rustdesk: not connected');
    // TEMP DEBUG: remove once modifier-key handling is confirmed working end-to-end.
    if (union.keyEvent) console.log('[rustdesk debug] sending keyEvent', JSON.stringify(union.keyEvent));
    const buf = await encodeMessage(union);
    this.#socket.write(encodeFrame(buf));
  }

  async #handleFrame(
    payload: Buffer,
    resolve: (v: Resolved) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    const msg = await decodeMessage(payload);
    const m = msg as unknown as Record<string, unknown>;

    if (m.hash && typeof m.hash === 'object') {
      const hash = m.hash as { salt: string; challenge: string };
      const passwordHash = hashPassword(this.#opts.password, hash.salt, hash.challenge);
      await this.#send({
        loginRequest: {
          // Server-side validates this against is_direct_ip_access() (server/connection.rs:2864),
          // which requires it to literally be the bare IP/domain:port dialed — not a real username.
          username: this.#opts.host,
          password: passwordHash,
          myId: this.#opts.myId,
          myName: this.#opts.myName,
          myPlatform: 'Linux',
          version: '1.3.9',
          sessionId: Date.now(),
          option: {
            supportedDecoding: {
              abilityVp9: 1,
              abilityH264: 1,
              abilityH265: 0,
              abilityVp8: 0,
              abilityAv1: 0,
              prefer: 2, // SupportedDecoding.PreferCodec.H264
            },
            // OptionMessage.BoolOption: NotSet=0, No=1, Yes=2. Peer only starts
            // streaming CursorData/CursorPosition/CursorId if this is explicitly
            // Yes — left NotSet (the default), the Mac never sends any cursor
            // messages at all, regardless of client-side handling for them.
            showRemoteCursor: 2,
            // video_qos.rs: server starts each connection at INIT_FPS=15 and adapts
            // from there based on measured TestDelay round-trip time, within a ceiling
            // this custom_fps sets (uncapped otherwise it settles low degrees on a LAN
            // hop with even modest jitter). ImageQuality.Best asks for less aggressive
            // compression given we're not bandwidth-constrained on the Mac<->backend hop.
            imageQuality: 4, // OptionMessage.ImageQuality.Best
            customFps: 60,
          },
        },
      });
      return;
    }

    if (m.loginResponse && typeof m.loginResponse === 'object') {
      const lr = m.loginResponse as { error?: string; peerInfo?: Record<string, unknown> };
      if (lr.error) {
        reject(new Error(`rustdesk login failed: ${lr.error}`));
        this.disconnect();
        return;
      }
      if (lr.peerInfo) {
        this.#loggedIn = true;
        const peerInfo = lr.peerInfo as unknown as RustDeskPeerInfo;
        this.emit('login', peerInfo);
        resolve({ peerInfo });
        return;
      }
      return;
    }

    if (m.testDelay && typeof m.testDelay === 'object') {
      const t = m.testDelay as { fromClient?: boolean };
      // Echo server-initiated pings back verbatim (client.rs's handle_test_delay) — the
      // peer treats this as the connection's liveness/latency heartbeat.
      if (!t.fromClient) await this.#send({ testDelay: m.testDelay });
      return;
    }

    if (m.videoFrame) {
      this.emit('video-frame', m.videoFrame);
      return;
    }

    if (m.clipboard) {
      this.emit('clipboard', m.clipboard);
      return;
    }

    if (m.multiClipboards && typeof m.multiClipboards === 'object') {
      const mc = m.multiClipboards as { clipboards?: unknown[] };
      for (const c of mc.clipboards ?? []) this.emit('clipboard', c);
      return;
    }

    if (m.cursorData && typeof m.cursorData === 'object') {
      // TEMP DEBUG: remove once cursor rendering is confirmed working end-to-end.
      console.log('[rustdesk debug] cursorData', JSON.stringify(m.cursorData).slice(0, 200));
      this.emit('cursor-data', m.cursorData);
      return;
    }

    if (m.cursorPosition && typeof m.cursorPosition === 'object') {
      console.log('[rustdesk debug] cursorPosition', JSON.stringify(m.cursorPosition));
      this.emit('cursor-position', m.cursorPosition);
      return;
    }

    // cursor_id is a scalar (uint64) oneof member, so unlike the message-typed branches
    // above it always has a zero-value default even when unset — the oneof's virtual
    // discriminator property (named after the oneof block, "union") is the only reliable
    // way to tell whether this frame actually is a cursor_id switch.
    if ((msg as unknown as { union?: string }).union === 'cursorId') {
      console.log('[rustdesk debug] cursorId', String(m.cursorId));
      this.emit('cursor-id', m.cursorId);
      return;
    }

    // Anything else (misc, audio, ...) is out of scope for the MVP.
    this.emit('unhandled', msg);
  }
}

/** LoginRequest.password = SHA256(SHA256(password + salt) + challenge) — client.rs's `handle_hash`. */
function hashPassword(password: string, salt: string, challenge: string): Buffer {
  const pw1 = crypto.createHash('sha256').update(password, 'utf8').update(Buffer.from(salt, 'utf8')).digest();
  return crypto.createHash('sha256').update(pw1).update(Buffer.from(challenge, 'utf8')).digest();
}
