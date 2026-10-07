import { realpath, readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { RuntimeImageAttachment } from "@companion/core";

const LIMIT = 20 * 1024 * 1024;
export async function readQQImage(
  reference: string,
  roots: readonly string[],
  signal: AbortSignal
): Promise<RuntimeImageAttachment> {
  let bytes: Buffer;
  if (/^https?:\/\//i.test(reference)) {
    const url = new URL(reference);
    // SnowLuma can expose legacy QQ CDN http URLs. Fetch the same resource over TLS.
    if (url.protocol === "http:") url.protocol = "https:";
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !(
        url.hostname === "multimedia.nt.qq.com.cn" ||
        ["qpic.cn", "qq.com"].some(
          (domain) => url.hostname === domain || url.hostname.endsWith("." + domain)
        )
      )
    )
      throw Error("Unsupported QQ media origin.");
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: "error"
    });
    if (
      !response.ok ||
      Number(response.headers.get("content-length") ?? 0) > LIMIT ||
      !response.body
    )
      throw Error("QQ media unavailable.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.length;
        if (total > LIMIT) throw Error("QQ image exceeds size limit.");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    bytes = Buffer.concat(chunks);
  } else {
    const file = await realpath(reference);
    const safeRoots = await Promise.all(roots.map((root) => realpath(resolve(root))));
    if (!safeRoots.some((root) => file.startsWith(root + sep)))
      throw Error("QQ media path is outside host-granted roots.");
    const size = (await stat(file)).size;
    if (!size || size > LIMIT) throw Error("QQ image exceeds size limit.");
    bytes = await readFile(file, { signal });
  }
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > LIMIT) throw Error("Invalid QQ image size.");
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : undefined;
  if (!mimeType) throw Error("Only PNG/JPEG QQ images are admitted to the visual path.");
  return { imageBase64: bytes.toString("base64"), mimeType };
}
