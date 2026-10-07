import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderErrorCode } from "../types/errors.js";
import { XAIVisionProvider } from "./XAIVisionProvider.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  stat: vi.fn(async () => ({ size: 3 }))
}));

const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;
const statMock = stat as unknown as ReturnType<typeof vi.fn>;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function createProvider(timeoutMs = 100, includeRawResponse = false): XAIVisionProvider {
  return new XAIVisionProvider({
    apiKey: "xai-key",
    baseUrl: "https://xai.test/v1",
    model: "xai-vision",
    timeoutMs,
    includeRawResponse
  });
}

function visionPayload(content = "scene", usage: unknown = undefined): Record<string, unknown> {
  return {
    model: "xai-vision-model",
    choices: [{ message: { content } }],
    ...(usage !== undefined ? { usage } : {})
  };
}

function stubFetch(payload: unknown = visionPayload("scene")): {
  fetchMock: ReturnType<typeof vi.fn>;
  body(): Record<string, unknown>;
} {
  let requestBody: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    body(): Record<string, unknown> {
      if (!requestBody) throw new Error("The fetch body was not captured.");
      return requestBody;
    }
  };
}

function expectUnsupported(result: Promise<unknown>): Promise<void> {
  return expect(result).rejects.toMatchObject({
    capability: "vision",
    code: ProviderErrorCode.UnsupportedInput,
    retryable: false,
    fallbackEligible: false,
    effectState: "not_started"
  });
}

function expectMalformed(result: Promise<unknown>): Promise<void> {
  return expect(result).rejects.toMatchObject({
    capability: "vision",
    code: ProviderErrorCode.MalformedResponse,
    retryable: false,
    fallbackEligible: true,
    effectState: "unknown"
  });
}

describe("xAI Vision provider normalization", () => {
  it("uses official DeepSeek Flash for bounded non-thinking visual evidence", async () => {
    const { body } = stubFetch();
    const provider = new XAIVisionProvider({
      provider: "alice-vision",
      apiKey: "fixture",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash"
    });
    await provider.analyzeImage({ imageBase64: "AQID", mimeType: "image/png" });
    expect(body()).toMatchObject({
      model: "deepseek-flash",
      thinking: { type: "disabled" },
      max_tokens: 1024
    });
    expect(provider.name).toBe("alice-vision");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    readFileMock.mockReset();
    statMock.mockReset();
    statMock.mockResolvedValue({ size: 3 });
  });

  it("preserves URL-first source precedence without validating ignored base64", async () => {
    const { body, fetchMock } = stubFetch();

    await createProvider().analyzeImage({
      imageUrl: "https://public.example/image.png",
      imageBase64: "not-base64",
      mimeType: "image/png"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body()["messages"]).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "https://public.example/image.png" }
          },
          { type: "text", text: "Analyze this image." }
        ]
      }
    ]);
  });

  it("uses base64 before imageBuffer and ignores the lower-precedence buffer", async () => {
    const { body } = stubFetch();

    await createProvider().analyzeImage({
      imageBase64: "AQID",
      mimeType: "image/png",
      imageBuffer: new Uint8Array()
    });

    expect(body()["messages"]).toMatchObject([
      {
        content: expect.arrayContaining([
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }
        ])
      }
    ]);
  });

  it("uses imageBuffer before image and localFilePath", async () => {
    const { body } = stubFetch();

    await createProvider().analyzeImage({
      imageBuffer: new Uint8Array([1, 2, 3]),
      image: new Uint8Array([4, 5, 6]),
      localFilePath: "/tmp/ignored.webp",
      mimeType: "image/png"
    });

    expect(body()["messages"]).toMatchObject([
      {
        content: expect.arrayContaining([
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }
        ])
      }
    ]);
    expect(statMock).not.toHaveBeenCalled();
  });

  it("uses image before localFilePath", async () => {
    const { body } = stubFetch();

    await createProvider().analyzeImage({
      image: new Uint8Array([4, 5, 6]),
      localFilePath: "/tmp/ignored.webp",
      mimeType: "image/png"
    });

    expect(body()["messages"]).toMatchObject([
      {
        content: expect.arrayContaining([
          { type: "image_url", image_url: { url: "data:image/png;base64,BAUG" } }
        ])
      }
    ]);
    expect(statMock).not.toHaveBeenCalled();
  });

  it("rejects missing source before fetch with the pre-start input policy", async () => {
    const { fetchMock } = stubFetch();

    await expectUnsupported(createProvider().analyzeImage({}));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start fetch when the caller aborts at the pre-fetch boundary", async () => {
    const caller = new AbortController();
    const { fetchMock } = stubFetch();
    const input = {
      get imageUrl(): string {
        caller.abort();
        return "https://public.example/image.png";
      }
    };

    await expect(
      createProvider().analyzeImage(input, { signal: caller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["file:///tmp/image.png", "ftp://public.example/image.png", "mailto:image@example.com"])(
    "rejects unsupported imageUrl scheme %s before fetch",
    async (imageUrl) => {
      const { fetchMock } = stubFetch();

      await expectUnsupported(createProvider().analyzeImage({ imageUrl }));
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(["http://public.example/image.png", "https://public.example/image.png"])(
    "forwards supported remote URL %s without downloading it",
    async (imageUrl) => {
      const { body, fetchMock } = stubFetch();

      await createProvider().analyzeImage({ imageUrl });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body()["messages"]).toMatchObject([
        {
          content: expect.arrayContaining([{ type: "image_url", image_url: { url: imageUrl } }])
        }
      ]);
      expect(statMock).not.toHaveBeenCalled();
      expect(readFileMock).not.toHaveBeenCalled();
    }
  );

  it("normalizes raw JPEG alias MIME and preserves canonical base64", async () => {
    const { body } = stubFetch();

    await createProvider().analyzeImage({
      imageBase64: "BAUG",
      mimeType: " IMAGE/JPG; charset=binary "
    });

    expect(body()["messages"]).toMatchObject([
      {
        content: expect.arrayContaining([
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,BAUG" } }
        ])
      }
    ]);
  });

  it("requires a supported MIME for raw base64", async () => {
    const { fetchMock } = stubFetch();

    await expectUnsupported(createProvider().analyzeImage({ imageBase64: "AQID" }));
    await expectUnsupported(
      createProvider().analyzeImage({ imageBase64: "AQID", mimeType: "image/webp" })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "hello", "====", "AB=="])("rejects malformed raw base64 %j", async (imageBase64) => {
    const { fetchMock } = stubFetch();

    await expectUnsupported(createProvider().analyzeImage({ imageBase64, mimeType: "image/png" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects raw base64 over 20 MiB without decoding the oversized payload", async () => {
    const { fetchMock } = stubFetch();
    const oversized = "A".repeat(Math.ceil(((MAX_IMAGE_BYTES + 1) * 4) / 3));

    await expectUnsupported(
      createProvider().analyzeImage({ imageBase64: oversized, mimeType: "image/png" })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes supported data URLs and rejects unsupported data URL forms", async () => {
    const { body } = stubFetch();

    await createProvider().analyzeImage({ imageBase64: "data:image/jpg;base64,BAUG" });
    expect(body()["messages"]).toMatchObject([
      {
        content: expect.arrayContaining([
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,BAUG" } }
        ])
      }
    ]);

    const { body: urlBody } = stubFetch();
    await createProvider().analyzeImage({ imageUrl: "data:image/png;base64,AQID" });
    expect(urlBody()["messages"]).toMatchObject([
      {
        content: expect.arrayContaining([
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }
        ])
      }
    ]);

    const { fetchMock } = stubFetch();
    for (const imageBase64 of [
      "data:image/png;base64,",
      "data:text/plain;base64,AQID",
      "data:image/png,not-base64",
      "data:image/png;base64,AB=="
    ]) {
      await expectUnsupported(createProvider().analyzeImage({ imageBase64 }));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the decoded size limit for data URLs", async () => {
    const { fetchMock } = stubFetch();
    const oversized = "A".repeat(Math.ceil(((MAX_IMAGE_BYTES + 1) * 4) / 3));

    await expectUnsupported(
      createProvider().analyzeImage({
        imageBase64: `data:image/png;base64,${oversized}`
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["image/webp", "image/gif", "image/bmp", "image/avif", "text/plain"])(
    "rejects unsupported byte MIME %s",
    async (mimeType) => {
      const { fetchMock } = stubFetch();

      await expectUnsupported(
        createProvider().analyzeImage({ imageBuffer: new Uint8Array([1, 2, 3]), mimeType })
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("rejects empty and oversized byte inputs before fetch", async () => {
    const { fetchMock } = stubFetch();

    await expectUnsupported(
      createProvider().analyzeImage({ image: new Uint8Array(), mimeType: "image/png" })
    );
    await expectUnsupported(
      createProvider().analyzeImage({
        imageBuffer: new Uint8Array(MAX_IMAGE_BYTES + 1),
        mimeType: "image/png"
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["/tmp/image.png", "image/png", "data:image/png;base64,AQID"],
    ["/tmp/image.JPG", undefined, "data:image/jpeg;base64,AQID"],
    ["/tmp/image.jpeg", "image/jpeg", "data:image/jpeg;base64,AQID"]
  ])("normalizes supported local file %s", async (localFilePath, mimeType, expectedUrl) => {
    statMock.mockResolvedValue({ size: 3 });
    readFileMock.mockResolvedValue(Buffer.from([1, 2, 3]));
    const { body } = stubFetch();

    await createProvider().analyzeImage({
      localFilePath,
      ...(mimeType ? { mimeType } : {})
    });

    expect(body()["messages"]).toMatchObject([
      {
        content: expect.arrayContaining([{ type: "image_url", image_url: { url: expectedUrl } }])
      }
    ]);
  });

  it.each([
    "/tmp/image.webp",
    "/tmp/image.gif",
    "/tmp/image.bmp",
    "/tmp/image.avif",
    "/tmp/image.bin"
  ])("rejects unsupported local extension %s before stat/read/fetch", async (localFilePath) => {
    const { fetchMock } = stubFetch();

    await expectUnsupported(createProvider().analyzeImage({ localFilePath }));
    expect(statMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty, oversized, and extension-inconsistent local files", async () => {
    const { fetchMock } = stubFetch();

    statMock.mockResolvedValueOnce({ size: 0 });
    await expectUnsupported(createProvider().analyzeImage({ localFilePath: "/tmp/empty.png" }));
    expect(readFileMock).not.toHaveBeenCalled();

    statMock.mockResolvedValueOnce({ size: MAX_IMAGE_BYTES + 1 });
    await expectUnsupported(createProvider().analyzeImage({ localFilePath: "/tmp/large.png" }));
    expect(readFileMock).not.toHaveBeenCalled();

    await expectUnsupported(
      createProvider().analyzeImage({ localFilePath: "/tmp/image.png", mimeType: "image/jpeg" })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves local read failures without relabeling them as network failures", async () => {
    const localError = new Error("local file read failed");
    statMock.mockResolvedValue({ size: 3 });
    readFileMock.mockRejectedValue(localError);
    const { fetchMock } = stubFetch();

    await expect(createProvider().analyzeImage({ localFilePath: "/tmp/missing.png" })).rejects.toBe(
      localError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the transport signal into local file reads and maps caller abort to Cancelled", async () => {
    let resolveRead: ((value: Buffer) => void) | undefined;
    let readSignal: AbortSignal | undefined;
    const readStarted = new Promise<void>((resolve) => {
      readFileMock.mockImplementation((_path: string, options?: { signal?: AbortSignal }) => {
        readSignal = options?.signal;
        return new Promise<Buffer>((resolveReadPromise) => {
          resolveRead = resolveReadPromise;
          resolve();
        });
      });
    });
    statMock.mockResolvedValue({ size: 3 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    const pending = createProvider().analyzeImage(
      { localFilePath: "/tmp/cancellable.png" },
      { signal: caller.signal }
    );

    await readStarted;
    caller.abort();
    expect(readSignal?.aborted).toBe(true);
    resolveRead?.(Buffer.from([1, 2, 3]));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps timeout classification when local preprocessing outlives the timeout", async () => {
    vi.useFakeTimers();
    let resolveRead: ((value: Buffer) => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      readFileMock.mockImplementation(
        () =>
          new Promise<Buffer>((resolveReadPromise) => {
            resolveRead = resolveReadPromise;
            resolve();
          })
      );
    });
    statMock.mockResolvedValue({ size: 3 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pending = createProvider(10).analyzeImage({ localFilePath: "/tmp/slow.png" });

    await readStarted;
    vi.advanceTimersByTime(10);
    resolveRead?.(Buffer.from([1, 2, 3]));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      retryable: true,
      fallbackEligible: true,
      effectState: "unknown"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves default, empty, and whitespace prompt semantics and message ordering", async () => {
    const { body } = stubFetch();
    await createProvider().analyzeImage({ imageBase64: "AQID", mimeType: "image/png" });
    expect(body()["messages"]).toMatchObject([
      { content: expect.arrayContaining([{ type: "text", text: "Analyze this image." }]) }
    ]);

    const { body: emptyBody } = stubFetch();
    await createProvider().analyzeImage({
      imageBase64: "AQID",
      mimeType: "image/png",
      prompt: "",
      messages: [
        { role: "system", content: "system instruction" },
        { role: "assistant", content: "previous answer" }
      ]
    });
    expect(emptyBody()["messages"]).toEqual([
      { role: "system", content: "system instruction" },
      { role: "assistant", content: "previous answer" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
          { type: "text", text: "" }
        ]
      }
    ]);

    const { body: whitespaceBody } = stubFetch();
    await createProvider().analyzeImage({
      imageBase64: "AQID",
      mimeType: "image/png",
      prompt: "  \n"
    });
    expect(whitespaceBody()["messages"]).toMatchObject([
      { content: expect.arrayContaining([{ type: "text", text: "  \n" }]) }
    ]);
  });

  it("preserves meaningful response text and normalizes valid token usage", async () => {
    stubFetch(
      visionPayload("  scene\n", { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
    );

    await expect(
      createProvider().analyzeImage({ imageBase64: "AQID", mimeType: "image/png" })
    ).resolves.toMatchObject({
      text: "  scene\n",
      sceneSummary: "  scene\n",
      model: "xai-vision-model",
      tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    });
  });

  it("omits malformed optional token counts without discarding valid analysis", async () => {
    stubFetch(
      visionPayload("scene", { prompt_tokens: "2", completion_tokens: -1, total_tokens: 5 })
    );

    await expect(
      createProvider().analyzeImage({ imageBase64: "AQID", mimeType: "image/png" })
    ).resolves.toMatchObject({ tokenUsage: { totalTokens: 5 } });
  });

  it.each([
    {},
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: { content: null } }] },
    { choices: [{ message: { content: "" } }] },
    { choices: [{ message: { content: "  \n" } }] },
    { choices: [{ message: { content: { text: "structured" } } }] }
  ])("rejects malformed or meaningless response %#", async (payload) => {
    stubFetch(payload);

    await expectMalformed(
      createProvider().analyzeImage({ imageBase64: "AQID", mimeType: "image/png" })
    );
  });

  it("preserves opt-in raw response debug behavior only at the provider boundary", async () => {
    const payload = visionPayload("scene");
    stubFetch(payload);

    await expect(
      createProvider(100, true).analyzeImage({ imageBase64: "AQID", mimeType: "image/png" })
    ).resolves.toMatchObject({ debug: { rawResponse: payload } });
  });
});
