// Bridges a browser WebSocket (frontend/src/RustDeskClient.tsx, not yet built) to a
// RustDeskClient connection + Vp9JpegDecoder. Mirrors guacamole-lite's own shape:
// POST /api/connect mints a short-lived, single-use credential (there: an encrypted
// token; here: a sessionId), and the actual protocol connection is only opened once
// the browser's WebSocket attaches.

import crypto from 'crypto';
import zlib from 'zlib';
import type { WebSocket } from 'ws';
import { RustDeskClient } from './client';
import { Vp9JpegDecoder } from './videoDecoder';

interface PendingSession {
  host: string;
  port?: number;
  password: string;
  createdAt: number;
}

// A rustdesk session is claimed within seconds of /api/connect returning it (the
// frontend opens the WebSocket immediately) — this only guards against a stale
// sessionId being replayed later.
const PENDING_TTL_MS = 30_000;
const pending = new Map<string, PendingSession>();

export function createRustDeskSession(opts: { host: string; port?: number; password: string }): string {
  const id = crypto.randomUUID();
  pending.set(id, { ...opts, createdAt: Date.now() });
  return id;
}

function takePendingSession(id: string): PendingSession | undefined {
  const session = pending.get(id);
  if (!session) return undefined;
  pending.delete(id);
  if (Date.now() - session.createdAt > PENDING_TTL_MS) return undefined;
  return session;
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// cursor_data.id / cursor_id are protobuf uint64, which protobufjs hands back as a
// Long (from the `long` package) rather than a plain number.
function longToNumber(v: unknown): number {
  if (v && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  return Number(v ?? 0);
}

// A slow/bandwidth-constrained WebSocket peer (e.g. a browser reached over a WireGuard
// tunnel rather than the LAN the backend/Mac hop uses) can't be allowed to queue frames
// indefinitely in ws's internal send buffer — that reproduces the same "growing lag"
// symptom as the ffmpeg buffering issues, just one stage further downstream. Better to
// drop a frame outright and let the next one (which will be more current) through.
const MAX_WS_BUFFERED_BYTES = 2 * 1024 * 1024;

export async function attachRustDeskSession(id: string, ws: WebSocket): Promise<void> {
  const session = takePendingSession(id);
  if (!session) {
    ws.close(4404, 'unknown or expired rustdesk session');
    return;
  }

  const client = new RustDeskClient({
    host: session.host,
    ...(session.port !== undefined ? { port: session.port } : {}),
    password: session.password,
    myName: 'RDM',
  });
  let decoder: Vp9JpegDecoder | null = null;
  // TEMP DEBUG: remove once the lag/quality report is resolved — distinguishes "the
  // Mac isn't sending frames fast enough" from problems further down the pipeline.
  let recvCount = 0;
  const recvStatsInterval = setInterval(() => {
    if (recvCount) console.log(`[rustdesk debug] video-frame from peer: ${recvCount}/5s`);
    recvCount = 0;
  }, 5000);

  const cleanup = () => {
    clearInterval(recvStatsInterval);
    decoder?.stop();
    client.disconnect();
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);

  client.on('error', (err: Error) => sendJson(ws, { type: 'error', message: err.message }));
  client.on('close', () => {
    sendJson(ws, { type: 'disconnected' });
    ws.close();
  });

  client.on('video-frame', (vf: Record<string, unknown>) => {
    // MVP only decodes VP9 (see videoDecoder.ts) — the only codec field probe.ts
    // ever observed the Mac send, since its PeerInfo.encoding never advertised h264.
    const vp9s = vf.vp9s as { frames?: Array<{ data: Uint8Array; pts?: unknown }> } | undefined;
    if (!vp9s?.frames || !decoder) return;
    recvCount += vp9s.frames.length;
    for (const frame of vp9s.frames) {
      decoder.pushFrame(Buffer.from(frame.data));
    }
  });

  client.on('clipboard', (c: { content?: Uint8Array; format?: number }) => {
    if (c.format !== 0 /* ClipboardFormat.Text */ || !c.content) return;
    sendJson(ws, { type: 'clipboard', text: Buffer.from(c.content).toString('utf8') });
  });

  client.on('cursor-data', (c: { id?: unknown; hotx?: number; hoty?: number; width?: number; height?: number; colors?: Uint8Array }) => {
    // CursorData.colors is zstd-compressed (hbb_common::compress::compress, confirmed
    // against source — its magic bytes 28 B5 2F FD gave it away) raw RGBA, not raw RGBA
    // directly. Decompressing straight to width*height*4 bytes, same as the real client.
    let rgba = '';
    if (c.colors && c.colors.length > 0) {
      try {
        rgba = zlib.zstdDecompressSync(Buffer.from(c.colors)).toString('base64');
      } catch (err) {
        console.error('[rustdesk] failed to zstd-decompress cursor data:', err);
      }
    }
    sendJson(ws, {
      type: 'cursor-image',
      id: longToNumber(c.id),
      hotx: c.hotx ?? 0,
      hoty: c.hoty ?? 0,
      width: c.width ?? 0,
      height: c.height ?? 0,
      rgba,
    });
  });

  client.on('cursor-position', (p: { x?: number; y?: number }) => {
    sendJson(ws, { type: 'cursor-pos', x: p.x ?? 0, y: p.y ?? 0 });
  });

  client.on('cursor-id', (id: unknown) => {
    sendJson(ws, { type: 'cursor-id', id: longToNumber(id) });
  });

  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    if (raw.length > 64 * 1024) return; // 64 KB cap — control messages are tiny
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    handleClientMessage(client, msg).catch((err) => sendJson(ws, { type: 'error', message: err.message }));
  });

  try {
    const peerInfo = await client.connect();
    const display = peerInfo.displays?.[0];
    console.log(`[rustdesk debug] display ${display?.width}x${display?.height}`);
    decoder = new Vp9JpegDecoder(display?.width ?? 1920, display?.height ?? 1080);
    // TEMP DEBUG: remove once the lag/quality report is resolved. Distinguishes
    // "peer isn't sending frames fast enough" from "we're dropping frames we did get".
    let sentCount = 0;
    let droppedCount = 0;
    let totalBytes = 0;
    const statsInterval = setInterval(() => {
      if (sentCount || droppedCount) {
        console.log(`[rustdesk debug] video: sent=${sentCount} dropped=${droppedCount} avgBytes=${sentCount ? Math.round(totalBytes / sentCount) : 0} wsBuffered=${ws.bufferedAmount}`);
      }
      sentCount = 0;
      droppedCount = 0;
      totalBytes = 0;
    }, 5000);
    ws.on('close', () => clearInterval(statsInterval));
    decoder.on('jpeg', (jpeg) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
        droppedCount++;
        return;
      }
      sentCount++;
      totalBytes += jpeg.length;
      ws.send(jpeg, { binary: true });
    });
    decoder.on('error', (err) => sendJson(ws, { type: 'error', message: err.message }));
    sendJson(ws, { type: 'connected', peerInfo });
  } catch (err) {
    sendJson(ws, { type: 'error', message: (err as Error).message });
    ws.close();
  }
}

async function handleClientMessage(client: RustDeskClient, msg: Record<string, unknown>): Promise<void> {
  switch (msg.type) {
    case 'mouse':
      await client.sendMouseEvent({
        mask: Number(msg.mask ?? 0),
        x: Number(msg.x ?? 0),
        y: Number(msg.y ?? 0),
        ...(Array.isArray(msg.modifiers) ? { modifiers: msg.modifiers.map(Number) } : {}),
      });
      return;
    case 'key':
      await client.sendKeyEvent({
        down: Boolean(msg.down),
        press: Boolean(msg.press),
        ...(msg.controlKey !== undefined ? { controlKey: Number(msg.controlKey) } : {}),
        ...(msg.chr !== undefined ? { chr: Number(msg.chr) } : {}),
        ...(Array.isArray(msg.modifiers) ? { modifiers: msg.modifiers.map(Number) } : {}),
      });
      return;
    case 'clipboard':
      if (typeof msg.text === 'string') await client.sendClipboardText(msg.text);
      return;
  }
}
