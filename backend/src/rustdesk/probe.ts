/// <reference types="node" />
// Standalone CLI to validate the RustDesk Direct IP Access handshake against a
// real machine before any of this gets wired into the rdm app. Run it from
// wherever the rdm backend will actually run (it needs LAN access to the Mac).
//
// Usage:
//   cd backend && npx ts-node src/rustdesk/probe.ts <mac-ip> <password> [port]
//
// On the Mac: RustDesk > Settings > Security > enable "Direct IP Access", and
// set a permanent password. Note the LAN IP it shows.
//
// This prints the negotiated PeerInfo and logs the shape of the first few
// video frames (which codec field is populated, keyframe flag, byte length)
// WITHOUT decoding them — that's the next stage, gated on what this reports.

import { RustDeskClient } from './client';

async function main() {
  const [host, password, portArg] = process.argv.slice(2);
  if (!host || !password) {
    console.error('usage: ts-node probe.ts <mac-ip> <password> [port]');
    process.exit(1);
  }
  const port = portArg ? Number(portArg) : undefined;

  const client = new RustDeskClient({ host, password, ...(port !== undefined ? { port } : {}) });

  client.on('error', (err) => console.error('[error]', err));
  client.on('close', () => console.log('[close] connection closed'));
  client.on('unhandled', (msg) => console.log('[unhandled message]', JSON.stringify(msg)));

  let frameCount = 0;
  client.on('video-frame', (vf: Record<string, unknown>) => {
    frameCount++;
    if (frameCount > 5) return;
    const codecField = Object.keys(vf).find((k) => k.endsWith('s') && vf[k] != null);
    const frames = codecField ? (vf[codecField] as { frames?: unknown[] }).frames : undefined;
    const first = frames?.[0] as { data?: Uint8Array; key?: boolean; pts?: unknown } | undefined;
    console.log(
      `[video-frame #${frameCount}] codec field=${codecField ?? '?'} frameCount=${frames?.length ?? 0}` +
        (first ? ` firstFrame: key=${first.key} bytes=${first.data?.length ?? 0} pts=${first.pts}` : ''),
    );
  });

  client.on('clipboard', (c: Record<string, unknown>) => {
    console.log('[clipboard]', JSON.stringify(c));
  });

  console.log(`Connecting to ${host}:${port ?? 21118} ...`);
  try {
    const peerInfo = await client.connect();
    console.log('LOGIN OK. PeerInfo:', JSON.stringify(peerInfo, null, 2));
  } catch (err) {
    console.error('LOGIN FAILED:', err);
    process.exit(1);
  }

  console.log('Listening for 15s (watching video frames + clipboard)...');
  await new Promise((resolve) => setTimeout(resolve, 15000));
  console.log(`Total video frames received: ${frameCount}`);
  client.disconnect();
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
