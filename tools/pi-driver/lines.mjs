// Byte-level JSONL line reader for the pi RPC channel.
//
// Why not readline: pi's docs warn that Node's readline also splits on U+2028 /
// U+2029, which are legal inside JSON strings, so a message containing them
// would be cut in half and fail to parse. This reader splits on LF only and
// keeps a StringDecoder so multi-byte UTF-8 characters never straddle a chunk.
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_LINE_BYTES = 1_048_000;

/**
 * @param {NodeJS.ReadableStream & {on: Function, once: Function, removeListener: Function}} stream
 * @param {{ maxLineBytes?: number, onLine: (line: string) => void, onError?: (error: Error & {code?: string}) => void }} options
 */
export function createLineReader(stream, options) {
  const { onLine, onError } = options;
  if (typeof onLine !== "function") throw new TypeError("onLine is required");
  const maxLineBytes = positive(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES);

  const decoder = new StringDecoder("utf8");
  // Bytes of the current, not-yet-terminated line. Kept as an array so a long
  // line does not repeatedly re-concatenate a growing Buffer.
  let chunks = [];
  let pendingBytes = 0;
  let closed = false;

  function emit(line) {
    if (line.length === 0) return;
    onLine(line);
  }

  function fail(code, detail) {
    if (closed) return;
    closed = true;
    detach();
    const error = new Error(detail);
    error.code = code;
    onError?.(error);
  }

  function onData(chunk) {
    if (closed) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline === -1) break;
      const tail = buffer.subarray(start, newline);
      // Tolerate CRLF.
      const end = tail.length > 0 && tail[tail.length - 1] === 0x0d ? tail.subarray(0, tail.length - 1) : tail;
      pendingBytes += end.length;
      if (pendingBytes > maxLineBytes) {
        pendingBytes = 0;
        chunks = [];
        fail("line_too_large", `record exceeded ${maxLineBytes} bytes`);
        return;
      }
      chunks.push(end);
      const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, pendingBytes);
      // Decode with the shared decoder so a split multi-byte sequence that
      // began in an earlier line still resolves before we flush.
      const text = decoder.write(bytes);
      pendingBytes = 0;
      chunks = [];
      start = newline + 1;
      emit(text);
      if (closed) return;
    }
    if (start < buffer.length) {
      const rest = buffer.subarray(start);
      pendingBytes += rest.length;
      if (pendingBytes > maxLineBytes) {
        pendingBytes = 0;
        chunks = [];
        fail("line_too_large", `record exceeded ${maxLineBytes} bytes`);
        return;
      }
      chunks.push(rest);
    }
  }

  function onEnd() {
    if (closed) return;
    // A final line without LF still counts: some CLIs exit right after writing.
    if (pendingBytes > 0) {
      const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, pendingBytes);
      pendingBytes = 0;
      chunks = [];
      emit(decoder.write(bytes));
    }
    const tail = decoder.end();
    if (tail.length > 0) emit(tail);
    if (closed) return;
    closed = true;
    detach();
  }

  function onErrorEvent(error) {
    fail("stream_error", error?.message ?? "stream error");
  }

  function detach() {
    stream.removeListener("data", onData);
    stream.removeListener("end", onEnd);
    stream.removeListener("error", onErrorEvent);
  }

  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("error", onErrorEvent);

  return {
    get closed() {
      return closed;
    },
    dispose() {
      if (closed) return;
      closed = true;
      detach();
    },
  };
}

/** Serialize one record as a single LF-terminated JSON line. */
export function encodeRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Write one record and respect backpressure.
 * @returns {Promise<void>} resolves when the chunk was accepted by the stream.
 */
export function writeRecord(stream, record) {
  if (!record || typeof record !== "object") throw new TypeError("record must be an object");
  const payload = encodeRecord(record);
  const ok = stream.write(payload);
  if (ok) return Promise.resolve();
  return new Promise((resolve) => stream.once("drain", resolve));
}

function positive(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("maxLineBytes must be a positive integer");
  return value;
}
