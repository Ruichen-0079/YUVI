const testPlaybackAccounting = { authorize: async () => ({ report: async () => {} }) };
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSpeechPlayer,
  SpeechPlaybackQueue,
  type SpeechQueueItem
} from "./speech-queue.js";

const segment = (sequence: number, requestId = "turn-a") => ({ requestId, sequence });
const segmentKey = (value: { requestId: string; sequence: number }) =>
  `${value.requestId}:${value.sequence}`;

describe("SpeechPlaybackQueue", () => {
  it("synthesizes and plays queued segments in order", async () => {
    const events: string[] = [];
    const synthesize = vi.fn(async (item: SpeechQueueItem) => {
      events.push(`synth:${item.text}`);
      return { audioBase64: "", mimeType: "audio/wav" } as never;
    });
    const play = vi.fn(async (output: unknown) => {
      void output;
      events.push(`play:${events.filter((value) => value.startsWith("synth:")).length}`);
    });
    const queue = new SpeechPlaybackQueue(synthesize, play);
    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.enqueue({ text: "two", language: "en" }, segment(1));
    queue.finish();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(events).toEqual(["synth:one", "play:1", "synth:two", "play:2"]);
  });

  it("starts synthesizing the next segment while the previous audio is playing", async () => {
    const events: string[] = [];
    let releaseFirstPlayback: (() => void) | undefined;
    const synthesize = vi.fn(async (item: SpeechQueueItem) => {
      events.push(`synth:${item.text}`);
      return { audioBase64: item.text, mimeType: "audio/wav" } as never;
    });
    const play = vi.fn(async (output: { audioBase64: string }) => {
      events.push(`play:${output.audioBase64}`);
      if (output.audioBase64 === "one") {
        await new Promise<void>((resolve) => {
          releaseFirstPlayback = resolve;
        });
      }
    });
    const queue = new SpeechPlaybackQueue(synthesize, play);

    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.enqueue({ text: "two", language: "en" }, segment(1));
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    expect(play).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["synth:one", "play:one", "synth:two"]);

    releaseFirstPlayback?.();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(events).toEqual(["synth:one", "play:one", "synth:two", "play:two"]);
  });

  it("reports a completed synthesis before that segment starts playing", async () => {
    const events: string[] = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async (output: { audioBase64: string }) => {
        events.push(`play:${output.audioBase64}`);
      },
      {
        onSynthesisCompleted: (item) => events.push(`ready:${item.sequence}:${item.item.text}`)
      }
    );
    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.finish();
    await vi.waitFor(() => expect(events).toEqual(["ready:0:one", "play:one"]));
  });

  it("does not synthesize pending work after cancellation", async () => {
    let release: (() => void) | undefined;
    const synthesize = vi.fn(
      () => new Promise<never>((resolve) => void (release = () => resolve(undefined as never)))
    );
    const play = vi.fn(async () => undefined);
    const queue = new SpeechPlaybackQueue(synthesize, play);
    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.enqueue({ text: "two", language: "en" }, segment(1));
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    queue.cancel();
    release?.();
    await Promise.resolve();
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
  });

  it("reports playback failure without affecting the text queue caller", async () => {
    const errors: unknown[] = [];
    const states: string[] = [];
    const queue = new SpeechPlaybackQueue(
      async () => ({ audioBase64: "audio", mimeType: "audio/wav" }) as never,
      async () => {
        throw new Error("audio failed");
      },
      {
        onError: (error) => errors.push(error),
        onState: (state) => states.push(state)
      }
    );
    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.finish();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(states).toContain("error");
    expect(errors[0]).toMatchObject({ message: "audio failed" });
  });

  it("reports per-item lifecycle states through completion", async () => {
    const states: Array<[string | undefined, string]> = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async () => undefined,
      { onItemState: (item, state) => states.push([segmentKey(item), state]) }
    );
    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.enqueue({ text: "two", language: "en" }, segment(1));
    queue.finish();
    await vi.waitFor(() => expect(states).toContainEqual(["turn-a:1", "completed"]));
    const stateFor = (id: string) =>
      states.filter(([itemId]) => itemId === id).map(([, state]) => state);
    expect(stateFor("turn-a:0")).toEqual([
      "queued",
      "synthesizing",
      "ready",
      "playing",
      "completed"
    ]);
    expect(stateFor("turn-a:1")).toEqual([
      "queued",
      "synthesizing",
      "ready",
      "playing",
      "completed"
    ]);
  });

  it("skips a failed synthesis and continues with remaining segments", async () => {
    const errors: unknown[] = [];
    const states: Array<[string | undefined, string]> = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => {
        if (item.text === "bad") throw new Error("upstream rejected");
        return { audioBase64: item.text, mimeType: "audio/wav" } as never;
      },
      async () => undefined,
      {
        onError: (error) => errors.push(error),
        onItemState: (item, state) => states.push([segmentKey(item), state])
      }
    );
    queue.enqueue({ text: "bad", language: "en" }, segment(0));
    queue.enqueue({ text: "good", language: "en" }, segment(1));
    queue.finish();
    await vi.waitFor(() => expect(states).toContainEqual(["turn-a:1", "completed"]));
    expect(errors).toHaveLength(1);
    const stateFor = (id: string) =>
      states.filter(([itemId]) => itemId === id).map(([, state]) => state);
    expect(stateFor("turn-a:0").at(-1)).toBe("failed");
    expect(stateFor("turn-a:1").at(-1)).toBe("completed");
  });

  it("marks first play failure as failed and continues later sequences", async () => {
    const states: Array<[string | undefined, string]> = [];
    const errors: unknown[] = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async (output: { audioBase64: string }) => {
        if (output.audioBase64 === "one") throw new DOMException("NotAllowedError");
      },
      {
        onItemState: (item, state) => states.push([segmentKey(item), state]),
        onError: (error) => errors.push(error)
      }
    );
    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.enqueue({ text: "two", language: "en" }, segment(1));
    queue.finish();
    await vi.waitFor(() => expect(states).toContainEqual(["turn-a:1", "completed"]));
    expect(states.filter(([id, state]) => id === "turn-a:0" && state === "failed")).toHaveLength(1);
    expect(states.filter(([id, state]) => id === "turn-a:0" && state === "completed")).toHaveLength(
      0
    );
    expect(errors).toHaveLength(1);
  });

  it("plays ready segments in ascending sequence order", async () => {
    const played: string[] = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => {
        // Resolve sequence 1 before sequence 0 artificially via delay on first.
        if (item.text === "zero") await new Promise((resolve) => setTimeout(resolve, 30));
        return { audioBase64: item.text, mimeType: "audio/wav" } as never;
      },
      async (output: { audioBase64: string }) => {
        played.push(output.audioBase64);
      }
    );
    // Synthesis is serial in the queue, so order is natural; assert completion order.
    queue.enqueue({ text: "zero", language: "en" }, segment(0));
    queue.enqueue({ text: "one", language: "en" }, segment(1));
    queue.finish();
    await vi.waitFor(() => expect(played).toEqual(["zero", "one"]));
  });

  it("marks every unfinished segment cancelled and leaves none pending", async () => {
    let release: (() => void) | undefined;
    const states: Array<[string | undefined, string]> = [];
    const queue = new SpeechPlaybackQueue(
      () =>
        new Promise<never>((resolve) => {
          release = () => resolve(undefined as never);
        }),
      async () => undefined,
      { onItemState: (item, state) => states.push([segmentKey(item), state]) }
    );
    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.enqueue({ text: "two", language: "en" }, segment(1));
    await vi.waitFor(() => expect(release).toBeDefined());
    queue.cancel();
    release?.();
    await Promise.resolve();
    const cancelled = states.filter(([, state]) => state === "cancelled").length;
    expect(cancelled).toBe(2);
    expect(states.map(([, state]) => state)).not.toContain("completed");
    expect(states.map(([, state]) => state)).not.toContain("ready");
  });

  it("restarts sequence state independently for a fresh turn", async () => {
    const firstStates: Array<[string | undefined, string]> = [];
    const first = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async () => undefined,
      { onItemState: (item, state) => firstStates.push([segmentKey(item), state]) }
    );
    first.enqueue({ text: "one", language: "en" }, segment(0, "first"));
    first.finish();
    await vi.waitFor(() => expect(firstStates).toContainEqual(["first:0", "completed"]));

    const secondStates: Array<[string | undefined, string]> = [];
    const second = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async () => undefined,
      { onItemState: (item, state) => secondStates.push([segmentKey(item), state]) }
    );
    second.enqueue({ text: "two", language: "en" }, segment(0, "second"));
    second.finish();
    await vi.waitFor(() => expect(secondStates).toContainEqual(["second:0", "completed"]));
    expect(secondStates.filter(([id]) => id === "second:0").length).toBeGreaterThan(0);
    expect(firstStates.filter(([id]) => id === "first:0").length).toBeGreaterThan(0);
  });

  it("exposes playback lifecycle only after the player starts", async () => {
    const audio = {} as HTMLAudioElement;
    const events: string[] = [];
    const queue = new SpeechPlaybackQueue(
      async () => ({ audioBase64: "", mimeType: "audio/wav" }) as never,
      async (_output, _signal, lifecycle) => {
        lifecycle?.emit({ type: "audioElementAttached", audio });
        lifecycle?.emit({ type: "playbackStarted", audio });
        lifecycle?.emit({ type: "playbackEnded", audio });
      },
      { onPlaybackEvent: (event) => events.push(event.type) }
    );
    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.finish();
    await vi.waitFor(() =>
      expect(events).toEqual(["audioElementAttached", "playbackStarted", "playbackEnded"])
    );
  });

  it("keeps queue ordering separate from stable product segment identity", async () => {
    const playback: Array<{ sequence: number; requestId: string; segmentSequence: number }> = [];
    const queue = new SpeechPlaybackQueue(
      async () => ({ audioBase64: "", mimeType: "audio/wav" }) as never,
      async (_output, _signal, lifecycle) => {
        lifecycle?.emit({ type: "playbackStarted", audio: {} as HTMLAudioElement });
        lifecycle?.emit({ type: "playbackEnded", audio: {} as HTMLAudioElement });
      },
      {
        onPlaybackEvent: (event) =>
          playback.push({
            sequence: event.sequence,
            requestId: event.segment.requestId,
            segmentSequence: event.segment.sequence
          })
      }
    );
    queue.enqueue({ text: "one", language: "en" }, segment(42));
    queue.finish();

    await vi.waitFor(() => expect(playback).toHaveLength(2));
    expect(playback).toEqual([
      { sequence: 0, requestId: "turn-a", segmentSequence: 42 },
      { sequence: 0, requestId: "turn-a", segmentSequence: 42 }
    ]);
  });

  it("does not emit playbackStarted after a cancelled play promise settles", async () => {
    let resolvePlay: (() => void) | undefined;
    const playPromise = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    const audio = {
      play: vi.fn(() => playPromise),
      pause: vi.fn(),
      onended: null,
      onerror: null
    } as unknown as HTMLAudioElement;
    vi.stubGlobal(
      "Audio",
      vi.fn(() => audio)
    );
    vi.stubGlobal(
      "atob",
      vi.fn(() => "")
    );
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn()
    });
    const controller = new AbortController();
    const events: string[] = [];
    const player = createBrowserSpeechPlayer(testPlaybackAccounting);
    const playback = player(
      { audioBase64: "", mimeType: "audio/wav" } as never,
      controller.signal,
      { sequence: 0, segment: segment(0), emit: (event) => events.push(event.type) }
    );
    await vi.waitFor(() => expect(events).toContain("audioElementAttached"));
    controller.abort();
    resolvePlay?.();
    await expect(playback).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["audioElementAttached", "playbackStopped", "audioElementDetached"]);
    expect(audio.pause).toHaveBeenCalledTimes(1);
  });

  it("reports browser play rejection as playbackError without starting speech", async () => {
    const audio = {
      play: vi.fn(() => Promise.reject(new Error("autoplay blocked"))),
      pause: vi.fn(),
      onended: null,
      onerror: null
    } as unknown as HTMLAudioElement;
    vi.stubGlobal(
      "Audio",
      vi.fn(() => audio)
    );
    vi.stubGlobal(
      "atob",
      vi.fn(() => "")
    );
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn()
    });
    try {
      const events: string[] = [];
      const player = createBrowserSpeechPlayer(testPlaybackAccounting);
      await expect(
        player({ audioBase64: "", mimeType: "audio/wav" } as never, new AbortController().signal, {
          sequence: 0,
          segment: segment(0),
          emit: (event) => events.push(event.type)
        })
      ).rejects.toThrow("autoplay blocked");
      expect(events).toEqual(["audioElementAttached", "playbackError", "audioElementDetached"]);
      expect(events).not.toContain("playbackStarted");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("does not report completion after a cancelled player resolves late", async () => {
  let release!: () => void;
  const states: string[] = [];
  const queue = new SpeechPlaybackQueue(
    async () => ({ audioBase64: "", mimeType: "audio/wav" }) as never,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    { onItemState: (_segment, state) => states.push(state) }
  );
  queue.enqueue({ text: "one", language: "en" }, segment(0));
  await vi.waitFor(() => expect(release).toBeDefined());
  queue.cancel();
  release();
  await Promise.resolve();
  expect(states.at(-1)).toBe("cancelled");
  expect(states).not.toContain("completed");
});

it("keeps an open stream alive between speech segments", async () => {
  const onState = vi.fn();
  const play = vi.fn(async () => undefined);
  const queue = new SpeechPlaybackQueue(
    async () => ({ audioBase64: "", mimeType: "audio/wav" }) as never,
    play,
    { onState }
  );
  queue.enqueue({ text: "first", language: "en" }, segment(0));
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  expect(onState).not.toHaveBeenCalledWith("idle");
  queue.enqueue({ text: "next", language: "en" }, segment(1));
  queue.finish();
  await vi.waitFor(() => expect(onState).toHaveBeenCalledWith("idle"));
  expect(play).toHaveBeenCalledTimes(2);
});

it("finish seals input while active synthesis and buffered FIFO playback drain completely", async () => {
  const resolvers: Array<() => void> = [];
  const states = new Map<number, string>();
  const played: string[] = [];
  let finishFirst!: () => void;
  const queueStates: string[] = [];
  const queue = new SpeechPlaybackQueue(
    (item) =>
      new Promise((resolve) =>
        resolvers.push(() => resolve({ audioBase64: item.text, mimeType: "audio/wav" } as never))
      ),
    async (output) => {
      played.push(output.audioBase64);
      if (played.length === 1)
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
    },
    {
      onItemState: (item, state) => states.set(item.sequence, state),
      onState: (state) => queueStates.push(state)
    }
  );
  for (let sequence = 0; sequence < 3; sequence += 1)
    queue.enqueue({ text: String(sequence), language: "en" }, segment(sequence));
  queue.finish();
  queue.enqueue({ text: "after finish", language: "en" }, segment(3));
  expect(queue.signal.aborted).toBe(false);
  resolvers[0]!();
  await vi.waitFor(() => expect(resolvers).toHaveLength(2));
  resolvers[1]!();
  await vi.waitFor(() => expect(resolvers).toHaveLength(3));
  resolvers[2]!();
  await vi.waitFor(() => expect(states.get(2)).toBe("ready"));
  expect(played).toEqual(["0"]);
  expect(queueStates).not.toContain("idle");
  finishFirst();
  await vi.waitFor(() => expect(queueStates.at(-1)).toBe("idle"));
  expect(played).toEqual(["0", "1", "2"]);
  expect([...states.values()]).toEqual(["completed", "completed", "completed"]);
});

it("offline lip-sync decode failure does not fail FIFO playback or the queue", async () => {
  const { AudioMouthEnvelope } = await import("./lumi-audio.js");
  const audio = {
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    load: vi.fn(),
    remove: vi.fn(),
    removeAttribute: vi.fn(),
    onended: null as (() => void) | null,
    onerror: null,
    duration: 2,
    currentTime: 0,
    paused: false,
    ended: false,
    muted: false,
    volume: 1,
    readyState: 4
  };
  vi.stubGlobal(
    "Audio",
    vi.fn(() => audio)
  );
  vi.stubGlobal("URL", { createObjectURL: () => "blob:speech", revokeObjectURL: vi.fn() });
  vi.stubGlobal("document", { body: { appendChild: vi.fn() } });
  try {
    let open = 0;
    let form = 0.6;
    const envelope = new AudioMouthEnvelope(
      {
        setMouthOpen: (value) => {
          open = value;
        },
        setMouthForm: (value) => {
          form = value;
        },
        resetMouth: () => {
          open = 0;
          form = 0;
        }
      },
      undefined,
      () => ({
        decodeAudioData: () => Promise.reject(new Error("offline decode failed")),
        createMediaElementSource: () => {
          throw new Error("must never route playback");
        },
        close: () => {
          throw new Error("must never close playback");
        }
      })
    );
    const states: string[] = [];
    const itemStates: string[] = [];
    const queue = new SpeechPlaybackQueue(
      async () => ({ audioBase64: "UklGRg==", mimeType: "audio/wav" }) as never,
      createBrowserSpeechPlayer(testPlaybackAccounting),
      {
        onState: (state) => states.push(state),
        onItemState: (_item, state) => itemStates.push(state),
        onPlaybackEvent: (event) => {
          if (event.type === "audioElementAttached") envelope.attach(event.audio);
          if (event.type === "playbackStarted") envelope.startPlayback(event.audio);
          if (event.type === "playbackEnded" || event.type === "playbackError") envelope.stop();
          if (event.type === "audioElementDetached") envelope.detach();
        }
      }
    );
    queue.enqueue({ text: "one", language: "en" }, segment(0));
    queue.enqueue({ text: "two", language: "en" }, segment(1));
    queue.finish();
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    audio.currentTime = 2;
    audio.onended?.();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
    audio.currentTime = 2;
    audio.onended?.();
    await vi.waitFor(() => expect(states.at(-1)).toBe("idle"));
    expect(itemStates.filter((state) => state === "completed")).toHaveLength(2);
    expect(itemStates).not.toContain("failed");
    expect(open).toBe(0);
    expect(form).toBe(0.6);
    envelope.dispose();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not release media resources or resolve until natural ended", async () => {
  const audio = {
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    load: vi.fn(),
    remove: vi.fn(),
    removeAttribute: vi.fn(),
    onended: null as (() => void) | null,
    onplaying: null as (() => void) | null,
    onerror: null,
    duration: 4,
    currentTime: 0
  };
  const revoke = vi.fn();
  vi.stubGlobal(
    "Audio",
    vi.fn(() => audio)
  );
  vi.stubGlobal("URL", { createObjectURL: () => "blob:complete", revokeObjectURL: revoke });
  try {
    const events: string[] = [];
    let resolved = false;
    const promise = createBrowserSpeechPlayer(testPlaybackAccounting)(
      { audioBase64: "UklGRg==", mimeType: "audio/wav" } as never,
      new AbortController().signal,
      { sequence: 0, segment: segment(0), emit: (e) => events.push(e.type) }
    ).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(events).toEqual(["audioElementAttached"]));
    audio.onplaying!();
    await vi.waitFor(() => expect(events).toEqual(["audioElementAttached", "playbackStarted"]));
    expect(resolved).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    expect(audio.removeAttribute).not.toHaveBeenCalled();
    expect(audio.load).not.toHaveBeenCalled();
    audio.currentTime = 4;
    audio.onended!();
    await promise;
    expect(events).toEqual([
      "audioElementAttached",
      "playbackStarted",
      "playbackEnded",
      "audioElementDetached"
    ]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(audio.load).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
