/**
 * Captured sandbox output (R4.5): Docker's multiplexed stdout/stderr stream decoded, capped to a byte budget that
 * keeps the head and the tail (where test failures are reported), control sequences stripped, and secrets redacted
 * before anything is stored or shown.
 */
import { redactText } from "@/lib/log";
import { redactSecrets } from "@/lib/security/secret-scan";

/** Keeps the first and last `maxBytes / 2` bytes written and counts what was dropped in between. */
export class OutputCollector {
  private readonly half: number;
  private head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer[] = [];
  private tailSize = 0;
  private total = 0;

  constructor(readonly maxBytes: number) {
    this.half = Math.max(1, Math.floor(maxBytes / 2));
  }

  write(chunk: Uint8Array | string) {
    let buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.total += buf.length;
    if (this.headSize < this.half) {
      const take = buf.subarray(0, this.half - this.headSize);
      this.head.push(take);
      this.headSize += take.length;
      buf = buf.subarray(take.length);
    }
    if (!buf.length) return;
    this.tail.push(buf);
    this.tailSize += buf.length;
    while (this.tailSize - (this.tail[0]?.length ?? 0) >= this.half) this.tailSize -= this.tail.shift()!.length;
    if (this.tailSize > this.half) {
      const first = this.tail[0]!;
      const cut = this.tailSize - this.half;
      this.tail[0] = first.subarray(cut);
      this.tailSize -= cut;
    }
  }

  get bytesWritten() {
    return this.total;
  }

  get truncated() {
    return this.total > this.headSize + this.tailSize;
  }

  /** The kept output, with a marker where bytes were dropped; sanitized (see {@link sanitizeOutput}). */
  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    const dropped = this.total - this.headSize - this.tailSize;
    const joined = dropped > 0 ? `${head}\n… [${dropped.toLocaleString("en-US")} bytes of output omitted] …\n${tail}` : head + tail;
    return sanitizeOutput(joined);
  }
}

const ESC = 0x1b;
const BEL = 0x07;

/** Removes terminal escape sequences (CSI, OSC, two-byte) and control characters other than tab, newline, and CR. */
function stripTerminal(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === ESC) {
      const next = text[i + 1];
      if (next === "[") {
        i += 2;
        while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) i++;
      } else if (next === "]") {
        i += 2;
        while (i < text.length && text.charCodeAt(i) !== BEL && !(text.charCodeAt(i) === ESC && text[i + 1] === "\\")) i++;
        if (text.charCodeAt(i) === ESC) i++;
      } else {
        i++;
      }
      continue;
    }
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) continue;
    out += text[i];
  }
  return out;
}

/** Terminal escapes and control characters removed, carriage-return progress lines collapsed, secrets redacted. */
export function sanitizeOutput(text: string): string {
  const plain = stripTerminal(text)
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r+$/, "").split("\r");
      return parts[parts.length - 1]!;
    })
    .join("\n");
  return redactText(redactSecrets(plain));
}

/**
 * Decodes Docker's multiplexed attach stream (8-byte frame headers: stream type, 3 zero bytes, big-endian length)
 * into `sink`. A stream without frame headers (a TTY) is passed through as is.
 */
export async function demultiplex(stream: AsyncIterable<Uint8Array>, sink: (chunk: Buffer) => void): Promise<void> {
  let pending = Buffer.alloc(0);
  let raw: boolean | null = null;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, Buffer.from(chunk)]) : Buffer.from(chunk);
    if (raw === null && pending.length >= 1) raw = !(pending[0]! <= 2 && (pending.length < 4 || (pending[1] === 0 && pending[2] === 0 && pending[3] === 0)));
    if (raw) {
      sink(pending);
      pending = Buffer.alloc(0);
      continue;
    }
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      sink(pending.subarray(8, 8 + size));
      pending = pending.subarray(8 + size);
    }
  }
  if (pending.length && raw) sink(pending);
}
