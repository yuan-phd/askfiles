import fs from 'node:fs';
import path from 'node:path';

/**
 * Line-oriented log file. Each line gets an ISO timestamp. When a write would push the file
 * past maxBytes, the file moves to <name>.1 (replacing an older one) and a new file starts.
 * The last `keepLines` lines stay in memory for error reports.
 */
export class RotatingLog {
  readonly file: string;
  private readonly maxBytes: number;
  private readonly keepLines: number;
  private fd: number | null = null;
  private size = 0;
  private carry = '';
  private lines: string[] = [];

  constructor(file: string, maxBytes: number, keepLines = 50) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keepLines = keepLines;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** Raw output from a child; split into lines, a trailing partial line waits for the next chunk. */
  write(chunk: Buffer | string): void {
    const parts = (this.carry + chunk.toString()).split(/\r?\n/);
    this.carry = parts.pop() ?? '';
    for (const p of parts) this.line(p);
  }

  line(text: string): void {
    const out = `${new Date().toISOString()} ${text}\n`;
    const bytes = Buffer.byteLength(out);
    if (this.fd === null) this.open();
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    fs.writeSync(this.fd!, out);
    this.size += bytes;
    this.lines.push(text);
    if (this.lines.length > this.keepLines) this.lines.shift();
  }

  tail(): string[] {
    return this.carry ? [...this.lines, this.carry].slice(-this.keepLines) : [...this.lines];
  }

  close(): void {
    if (this.carry) {
      const rest = this.carry;
      this.carry = '';
      this.line(rest);
    }
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  private open(): void {
    this.fd = fs.openSync(this.file, 'a');
    this.size = fs.fstatSync(this.fd).size;
  }

  private rotate(): void {
    fs.closeSync(this.fd!);
    fs.renameSync(this.file, `${this.file}.1`);
    this.fd = fs.openSync(this.file, 'a');
    this.size = 0;
  }
}
