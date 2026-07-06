import { describe, expect, it } from "vitest";
import { LineSplitter } from "../src/frames.js";

const buf = (s: string) => Buffer.from(s, "utf8");

describe("LineSplitter", () => {
  it("emits a single complete line", () => {
    const s = new LineSplitter();
    expect(s.push(buf('{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it("emits multiple lines from one chunk", () => {
    const s = new LineSplitter();
    expect(s.push(buf("one\ntwo\nthree\n"))).toEqual(["one", "two", "three"]);
  });

  it("buffers a partial line across chunks", () => {
    const s = new LineSplitter();
    expect(s.push(buf('{"a"'))).toEqual([]);
    expect(s.push(buf(':1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(s.push(buf(":2}\n"))).toEqual(['{"b":2}']);
  });

  it("reassembles a multi-byte utf8 character split across chunks", () => {
    const s = new LineSplitter();
    const bytes = buf("héllo\n");
    expect(s.push(bytes.subarray(0, 2))).toEqual([]); // splits é in half
    expect(s.push(bytes.subarray(2))).toEqual(["héllo"]);
  });

  it("flush returns the trailing partial line", () => {
    const s = new LineSplitter();
    s.push(buf("complete\npartial"));
    expect(s.flush()).toBe("partial");
    expect(s.flush()).toBeNull();
  });

  it("handles a 1MB line split into small chunks", () => {
    const s = new LineSplitter();
    const big = JSON.stringify({ data: "x".repeat(1024 * 1024) });
    const bytes = buf(`${big}\n`);
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += 4096) {
      out.push(...s.push(bytes.subarray(i, i + 4096)));
    }
    expect(out).toEqual([big]);
  });
});
