import { TRANSACTION_FIELD_KINDS } from './firestore-projection.ts';

type Layout = null | { [key: string]: Layout } | [Layout];
type Container = Exclude<Layout, null>;

const INVALID_RESPONSE = 'Firestore read failed: invalid response';

const TRANSACTION_PAGE: Container = {
  documents: [
    {
      name: null,
      createTime: null,
      updateTime: null,
      fields: Object.fromEntries(
        Object.entries(TRANSACTION_FIELD_KINDS).map(([field, kinds]) => [
          field,
          Object.fromEntries(kinds.map((kind) => [kind, null])),
        ]),
      ),
    },
  ],
  nextPageToken: null,
};

type FrameState =
  | 'key-or-end'
  | 'key'
  | 'colon'
  | 'value-or-end'
  | 'value'
  | 'primitive'
  | 'comma-or-end';

type Frame = { layout: Container; state: FrameState; child?: Layout };

// A key is ASCII and can use up to six bytes per character (\uXXXX).
const MAX_KEY_BYTES = 'timestampValue'.length * 6 + 2;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isPrimitiveStart(byte: number): boolean {
  return (
    byte === 0x2d || // -
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x74 || // t
    byte === 0x66 || // f
    byte === 0x6e // n
  );
}

function isPrimitiveChar(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x2b || // +
    byte === 0x2d || // -
    byte === 0x2e // .
  );
}

class TransactionKeyScanner {
  private frames: Frame[] = [];
  private done = false;
  private inString = false;
  private escaped = false;
  private keyToken: string | undefined;

  scan(bytes: Uint8Array): void {
    for (const byte of bytes) {
      const frame = this.frames.at(-1);
      if (this.inString) {
        this.scanString(byte, frame);
        continue;
      }
      if (frame === undefined) {
        if (isWhitespace(byte)) continue;
        if (!this.done && byte === 0x7b) {
          this.frames.push({ layout: TRANSACTION_PAGE, state: 'key-or-end' });
          continue;
        }
        throw new Error(INVALID_RESPONSE);
      }
      if (frame.state === 'primitive') {
        if (isWhitespace(byte)) {
          frame.state = 'comma-or-end';
          continue;
        }
        if (byte === 0x2c || byte === 0x7d || byte === 0x5d) {
          frame.state = 'comma-or-end';
        } else if (isPrimitiveChar(byte)) {
          continue;
        } else {
          throw new Error(INVALID_RESPONSE);
        }
      }
      if (isWhitespace(byte)) continue;
      this.scanToken(byte, frame);
    }
  }

  finish(): void {
    if (!this.done || this.inString || this.frames.length !== 0) {
      throw new Error(INVALID_RESPONSE);
    }
  }

  private scanToken(byte: number, frame: Frame): void {
    if (frame.state === 'key-or-end' && byte === 0x7d) {
      this.popFrame();
      return;
    }
    if (frame.state === 'key-or-end' || frame.state === 'key') {
      if (byte !== QUOTE) throw new Error(INVALID_RESPONSE);
      this.inString = true;
      this.keyToken = '"';
      return;
    }
    if (frame.state === 'colon') {
      if (byte !== 0x3a) throw new Error(INVALID_RESPONSE);
      frame.state = 'value';
      return;
    }
    if (frame.state === 'value-or-end' && byte === 0x5d) {
      this.popFrame();
      return;
    }
    if (frame.state === 'value-or-end' || frame.state === 'value') {
      const child = Array.isArray(frame.layout) ? frame.layout[0] : frame.child;
      if (byte === QUOTE) {
        if (child !== null) throw new Error(INVALID_RESPONSE);
        this.inString = true;
        return;
      }
      if (byte === 0x7b || byte === 0x5b) {
        if (child == null || Array.isArray(child) !== (byte === 0x5b)) {
          throw new Error(INVALID_RESPONSE);
        }
        frame.state = 'comma-or-end';
        this.frames.push({
          layout: child,
          state: Array.isArray(child) ? 'value-or-end' : 'key-or-end',
        });
        return;
      }
      if (isPrimitiveStart(byte)) {
        if (child !== null) throw new Error(INVALID_RESPONSE);
        frame.state = 'primitive';
        return;
      }
      throw new Error(INVALID_RESPONSE);
    }
    if (byte === 0x2c) {
      if (Array.isArray(frame.layout)) {
        frame.state = 'value';
      } else {
        delete frame.child;
        frame.state = 'key';
      }
      return;
    }
    if (
      (byte === 0x7d && !Array.isArray(frame.layout)) ||
      (byte === 0x5d && Array.isArray(frame.layout))
    ) {
      this.popFrame();
      return;
    }
    throw new Error(INVALID_RESPONSE);
  }

  private popFrame(): void {
    this.frames.pop();
    if (this.frames.length === 0) {
      this.done = true;
    }
  }

  private scanString(byte: number, frame: Frame | undefined): void {
    if (this.keyToken !== undefined) {
      if (byte < 0x20 || byte > 0x7f || this.keyToken.length >= MAX_KEY_BYTES) {
        throw new Error(INVALID_RESPONSE);
      }
      this.keyToken += String.fromCharCode(byte);
    }
    if (this.escaped) {
      this.escaped = false;
    } else if (byte === BACKSLASH) {
      this.escaped = true;
    } else if (byte === QUOTE) {
      this.inString = false;
      if (frame === undefined) {
        throw new Error(INVALID_RESPONSE);
      }
      if (this.keyToken !== undefined) {
        if (Array.isArray(frame.layout)) {
          throw new Error(INVALID_RESPONSE);
        }
        let key: unknown;
        try {
          key = JSON.parse(this.keyToken);
        } catch {
          throw new Error(INVALID_RESPONSE);
        }
        if (typeof key !== 'string' || !Object.hasOwn(frame.layout, key)) {
          throw new Error(INVALID_RESPONSE);
        }
        frame.child = frame.layout[key];
        frame.state = 'colon';
        this.keyToken = undefined;
      } else {
        frame.state = 'comma-or-end';
      }
    }
  }
}

export async function readTransactionResponse(
  response: Response,
): Promise<unknown> {
  if (response.body === null) {
    throw new Error(INVALID_RESPONSE);
  }
  const reader = response.body.getReader();
  const scanner = new TransactionKeyScanner();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) {
        throw new Error(INVALID_RESPONSE);
      }
      let owned: Uint8Array;
      try {
        owned = new Uint8Array(bytes);
      } catch {
        throw new Error(INVALID_RESPONSE);
      }
      scanner.scan(owned);
      chunks.push(owned);
    }
    scanner.finish();
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // A broken source still fails closed.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  // Decode values only after every chunk passes the key scan. JSON.parse
  // handles syntax and the caller validates the projected field values.
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = chunks.map((chunk) => decoder.decode(chunk, { stream: true }));
    text.push(decoder.decode());
    return JSON.parse(text.join('')) as unknown;
  } catch {
    throw new Error(INVALID_RESPONSE);
  }
}
