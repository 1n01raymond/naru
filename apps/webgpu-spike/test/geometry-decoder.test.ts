import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type * as DecoderModule from "../src/geometry-decoder.js";
import type { GeometryWorkerResponse } from "../src/geometry.worker.js";

type Listener = (event: unknown) => void;

/** Records what the decoder sends and lets a test answer on the Worker's behalf. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly posted: { message: Record<string, unknown>; transfer: unknown[] }[] = [];
  terminated = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: Record<string, unknown>, transfer: unknown[] = []): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Deliver a Worker response the way the real Worker would. */
  respond(data: GeometryWorkerResponse): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

const decoderModule = async (): Promise<typeof DecoderModule> =>
  import("../src/geometry-decoder.js");

const initialized = (requestId: number): GeometryWorkerResponse => ({
  type: "initialized",
  requestId,
  targetChunkResidencyCosts: new Map(),
});

describe("GeometryDecoder lifecycle", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  });

  afterEach(() => {
    delete (globalThis as { Worker?: unknown }).Worker;
  });

  it("transfers the document bytes once and releases them on dispose", async () => {
    const { GeometryDecoder } = await decoderModule();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const controller = new AbortController();
    const decoder = new GeometryDecoder({ kind: "bytes", bytes }, controller.signal);
    const worker = FakeWorker.instances[0];
    if (!worker) throw new TypeError("The decoder did not construct a Worker.");

    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]?.message["type"]).toBe("initialize");
    // The document crosses the boundary once: transferred, never copied.
    expect(worker.posted[0]?.transfer).toEqual([bytes]);

    worker.respond(initialized(1));
    decoder.dispose();
    expect(worker.terminated).toBe(1);
    expect(worker.listenerCount).toBe(0);
  });

  it("rejects in-flight work and terminates the Worker when the load is cancelled", async () => {
    const { GeometryDecoder } = await decoderModule();
    const controller = new AbortController();
    const decoder = new GeometryDecoder(
      { kind: "bytes", bytes: new Uint8Array([1]).buffer },
      controller.signal,
    );
    const worker = FakeWorker.instances[0];
    if (!worker) throw new TypeError("The decoder did not construct a Worker.");
    worker.respond(initialized(1));
    const pending = decoder.decode({ kind: "url", href: "https://example.test/a.bin" }, "target");
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(1);
    // A request made after cancellation never reaches the terminated Worker.
    const posted = worker.posted.length;
    await expect(
      decoder.decode({ kind: "url", href: "https://example.test/b.bin" }, "target"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.posted).toHaveLength(posted);
  });

  it("ignores a Worker response that arrives after disposal", async () => {
    const { GeometryDecoder } = await decoderModule();
    const controller = new AbortController();
    const decoder = new GeometryDecoder(
      { kind: "bytes", bytes: new Uint8Array([1]).buffer },
      controller.signal,
    );
    const worker = FakeWorker.instances[0];
    if (!worker) throw new TypeError("The decoder did not construct a Worker.");
    worker.respond(initialized(1));
    const pending = decoder.decode({ kind: "url", href: "https://example.test/c.bin" }, "target");
    decoder.dispose();
    await expect(pending).rejects.toThrow();

    // The late response has no pending request and no listener left to reach.
    expect(() => worker.respond({
      type: "ready",
      requestId: 2,
      scene: undefined,
      decodeMilliseconds: 1,
    } as unknown as GeometryWorkerResponse)).not.toThrow();
  });

  it("replaces a scene by disposing the previous decoder and its Worker", async () => {
    const { GeometryDecoder } = await decoderModule();
    const first = new AbortController();
    const previous = new GeometryDecoder(
      { kind: "bytes", bytes: new Uint8Array([1]).buffer },
      first.signal,
    );
    FakeWorker.instances[0]?.respond(initialized(1));
    previous.dispose();

    const second = new AbortController();
    const next = new GeometryDecoder(
      { kind: "bytes", bytes: new Uint8Array([2]).buffer },
      second.signal,
    );
    FakeWorker.instances[1]?.respond(initialized(1));
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0]?.terminated).toBe(1);
    expect(FakeWorker.instances[1]?.terminated).toBe(0);

    next.dispose();
    // Disposal is idempotent: a second scene replacement cannot terminate twice.
    next.dispose();
    expect(FakeWorker.instances[1]?.terminated).toBe(1);
  });

  it("fails the session when the Worker reports an error", async () => {
    const { GeometryDecoder } = await decoderModule();
    const controller = new AbortController();
    const decoder = new GeometryDecoder(
      { kind: "bytes", bytes: new Uint8Array([1]).buffer },
      controller.signal,
    );
    const worker = FakeWorker.instances[0];
    if (!worker) throw new TypeError("The decoder did not construct a Worker.");
    worker.respond({
      type: "error",
      requestId: 1,
      message: "decode failed",
      name: "Error",
    });
    await expect(
      decoder.decode({ kind: "url", href: "https://example.test/d.bin" }, "target"),
    ).rejects.toThrow("decode failed");
    decoder.dispose();
  });

  it("survives repeated open, replace, cancel, and dispose cycles", async () => {
    const { GeometryDecoder } = await decoderModule();
    const cycles = 3;

    for (let cycle = 0; cycle < cycles; cycle += 1) {
      // Open: one session, one Worker, one transferred document.
      const openControl = new AbortController();
      const open = new GeometryDecoder(
        { kind: "bytes", bytes: new Uint8Array([cycle]).buffer },
        openControl.signal,
      );
      const openWorker = FakeWorker.instances[cycle * 2];
      if (!openWorker) throw new TypeError("The decoder did not construct a Worker.");
      openWorker.respond(initialized(1));
      const openWork = open.decode(
        { kind: "url", href: "https://example.test/open.bin" },
        "target",
      );

      // Replace: the replacement session exists before the open one is disposed,
      // which is the overlap the Studio accepts so a failed load keeps the scene.
      const replaceControl = new AbortController();
      const replacement = new GeometryDecoder(
        { kind: "bytes", bytes: new Uint8Array([cycle, 1]).buffer },
        replaceControl.signal,
      );
      const replacementWorker = FakeWorker.instances[cycle * 2 + 1];
      if (!replacementWorker) throw new TypeError("The decoder did not construct a Worker.");
      expect(openWorker.terminated).toBe(0);
      open.dispose();
      await expect(openWork).rejects.toThrow();
      expect(openWorker.terminated).toBe(1);
      expect(openWorker.listenerCount).toBe(0);

      // Cancel: in-flight work on the replacement fails as a cancellation.
      replacementWorker.respond(initialized(1));
      const replacementWork = replacement.decode(
        { kind: "url", href: "https://example.test/replacement.bin" },
        "target",
      );
      replaceControl.abort();
      await expect(replacementWork).rejects.toMatchObject({ name: "AbortError" });

      // Dispose: idempotent after a cancellation already terminated the Worker.
      replacement.dispose();
      expect(replacementWorker.terminated).toBe(1);
      expect(replacementWorker.listenerCount).toBe(0);

      // A Worker response that arrives after both sessions are gone is ignored.
      for (const worker of [openWorker, replacementWorker]) {
        expect(() => worker.respond({
          type: "ready",
          requestId: 2,
          scene: undefined,
          decodeMilliseconds: 1,
        } as unknown as GeometryWorkerResponse)).not.toThrow();
      }
    }

    // Every cycle left exactly one terminated Worker per session and no listener.
    expect(FakeWorker.instances).toHaveLength(cycles * 2);
    for (const worker of FakeWorker.instances) {
      expect(worker.terminated).toBe(1);
      expect(worker.listenerCount).toBe(0);
    }
  });
});
