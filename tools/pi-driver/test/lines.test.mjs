import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createLineReader, encodeRecord, writeRecord } from "../lines.mjs";

function collect(stream, options = {}) {
  const lines = [];
  const errors = [];
  const reader = createLineReader(stream, {
    ...options,
    onLine: (line) => lines.push(line),
    onError: (error) => errors.push(error),
  });
  return { lines, errors, reader };
}

test("splits LF records and ignores a trailing CR", () => {
  const stream = new PassThrough();
  const { lines } = collect(stream);
  stream.write('{"a":1}\r\n{"a":2}\n');
  stream.end();
  assert.deepEqual(lines, ['{"a":1}', '{"a":2}']);
});

test("keeps a record whole when it spans chunks", () => {
  const stream = new PassThrough();
  const { lines } = collect(stream);
  stream.write('{"a":');
  stream.write('"hel');
  stream.write('lo"}\n');
  stream.end();
  assert.deepEqual(lines, ['{"a":"hello"}']);
});

test("decodes multi-byte UTF-8 split mid-character", async () => {
  const stream = new PassThrough();
  const { lines } = collect(stream);
  const payload = Buffer.from(encodeRecord({ text: "中文测试" }), "utf8");
  // Cut inside the first Chinese character (3 bytes).
  stream.write(payload.subarray(0, 10));
  await new Promise((resolve) => {
    stream.once("end", resolve);
    stream.end(payload.subarray(10));
  });
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, "中文测试");
});

test("does not split on U+2028 / U+2029 inside a JSON string", () => {
  const stream = new PassThrough();
  const { lines } = collect(stream);
  const record = { text: "上\u2028下\u2029尾" };
  const encoded = encodeRecord(record);
  assert.ok(encoded.includes("\u2028"), "the record must really contain the separator");
  stream.write(encoded);
  stream.end();
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, record.text);
});

test("emits a final record that has no trailing LF", async () => {
  const stream = new PassThrough();
  const { lines } = collect(stream);
  stream.write('{"tail":true}');
  await new Promise((resolve) => {
    stream.once("end", resolve);
    stream.end();
  });
  assert.deepEqual(lines, ['{"tail":true}']);
});

test("reports line_too_large instead of buffering forever", () => {
  const stream = new PassThrough();
  const { lines, errors } = collect(stream, { maxLineBytes: 32 });
  stream.write(`${"x".repeat(64)}\n`);
  assert.deepEqual(lines, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "line_too_large");
});

test("skips empty lines", () => {
  const stream = new PassThrough();
  const { lines } = collect(stream);
  stream.write("\n\n{\"a\":1}\n\n");
  stream.end();
  assert.deepEqual(lines, ['{"a":1}']);
});

test("writeRecord serializes one LF-terminated JSON object", async () => {
  const stream = new PassThrough();
  const seen = [];
  stream.on("data", (chunk) => seen.push(chunk.toString("utf8")));
  await writeRecord(stream, { type: "prompt", message: "hi" });
  assert.deepEqual(seen, ['{"type":"prompt","message":"hi"}\n']);
});
