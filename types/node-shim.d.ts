// The few Node APIs the relay and its tests use, declared here so that type-checking needs no
// @types/node: the relay has no dependencies, not even for its types.

declare module 'node:net' {
  export interface Socket {
    readonly destroyed: boolean;
    readonly writableLength: number;
    readonly remoteAddress?: string;
    setNoDelay(noDelay?: boolean): this;
    write(data: string | Uint8Array): boolean;
    end(data?: string | Uint8Array): this;
    destroy(): this;
    emit(event: 'data', chunk: Uint8Array): boolean;
    on(event: 'data', cb: (chunk: Uint8Array) => void): this;
    on(event: 'close', cb: () => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    on(event: 'connect', cb: () => void): this;
    once(event: 'close' | 'connect', cb: () => void): this;
  }
  export function connect(port: number, host: string): Socket;
}

declare module 'node:http' {
  import type { Socket } from 'node:net';
  export interface IncomingMessage {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    socket: Socket;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string | number): void;
    end(data?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): Server;
    close(cb?: () => void): void;
    address(): { port: number; address: string } | string | null;
    on(event: 'upgrade', cb: (req: IncomingMessage, socket: Socket, head: Uint8Array) => void): Server;
    on(event: 'clientError', cb: (err: Error, socket: Socket) => void): Server;
    once(event: 'error', cb: (err: Error) => void): Server;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'base64' | 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:url' {
  export function pathToFileURL(path: string): URL;
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:fs' {
  export function existsSync(path: string | URL): boolean;
}

declare module 'node:test' {
  type Fn = (t: { skip(message?: string): void }) => void | Promise<void>;
  export function test(name: string, fn: Fn): Promise<void>;
  export function test(name: string, options: { skip?: string | boolean; timeout?: number }, fn: Fn): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function describe(name: string, options: { skip?: string | boolean }, fn: () => void): void;
  export function it(name: string, fn: Fn): Promise<void>;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, re: RegExp, message?: string): void;
    rejects(fn: Promise<unknown> | (() => Promise<unknown>), message?: string): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  versions: Record<string, string>;
  exit(code?: number): never;
  on(event: 'SIGINT' | 'SIGTERM', cb: () => void): void;
};

declare const Buffer: { byteLength(text: string): number };

interface ImportMeta {
  url: string;
  dirname?: string;
}
