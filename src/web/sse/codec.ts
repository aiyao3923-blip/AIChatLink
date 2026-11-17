import type { AIChatLinkEnvelope } from "../../core/envelope.js";

export const SSE_HEARTBEAT_FRAME = ": heartbeat\n\n";

export function assertSseEnvelope(envelope: AIChatLinkEnvelope): void {
  if (typeof envelope.type !== "string" || envelope.type.length === 0) {
    throw new TypeError("A AIChatLink envelope requires a non-empty type");
  }

  if (envelope.durability === "durable") {
    if (!Number.isSafeInteger(envelope.seq) || (envelope.seq ?? 0) <= 0) {
      throw new TypeError("A durable AIChatLink envelope requires a positive integer seq");
    }
    return;
  }

  if (envelope.seq !== null) {
    throw new TypeError("A transient AIChatLink envelope must have seq=null");
  }
}

/** Encode one complete AIChatLink envelope as one SSE event. */
export function encodeSseEnvelope(envelope: AIChatLinkEnvelope): string {
  assertSseEnvelope(envelope);
  const id = envelope.durability === "durable" ? `id: ${envelope.seq}\n` : "";
  // Use the default SSE `message` event so future Envelope types reach the
  // browser without requiring a listener registration round-trip.
  return `${id}data: ${JSON.stringify(envelope)}\n\n`;
}

export function sseFrameBytes(frame: string): number {
  return Buffer.byteLength(frame, "utf8");
}
