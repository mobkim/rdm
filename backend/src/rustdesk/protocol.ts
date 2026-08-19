// Loads hbb_common's protobuf schema (proto/message.proto, vendored from rustdesk/hbb_common)
// and exposes the top-level `hbb.Message` type used to encode/decode every frame on the wire.

import path from 'path';
import protobuf from 'protobufjs';

let rootPromise: Promise<protobuf.Root> | null = null;

function loadRoot(): Promise<protobuf.Root> {
  if (!rootPromise) {
    rootPromise = protobuf.load(path.join(__dirname, 'proto/message.proto'));
  }
  return rootPromise;
}

export async function getMessageType(): Promise<protobuf.Type> {
  const root = await loadRoot();
  return root.lookupType('hbb.Message');
}

export async function encodeMessage(fields: Record<string, unknown>): Promise<Buffer> {
  const MessageType = await getMessageType();
  const err = MessageType.verify(fields);
  if (err) throw new Error(`invalid rustdesk Message: ${err}`);
  const msg = MessageType.create(fields);
  return Buffer.from(MessageType.encode(msg).finish());
}

export async function decodeMessage(payload: Buffer): Promise<protobuf.Message<Record<string, unknown>>> {
  const MessageType = await getMessageType();
  return MessageType.decode(payload) as protobuf.Message<Record<string, unknown>>;
}
