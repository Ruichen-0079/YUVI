import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readQQImage } from "./qq-image.js";
it("QQ images use bounded PNG/JPEG bytes and cannot escape granted roots through symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "plunge-images-")),
    other = await mkdtemp(join(tmpdir(), "plunge-outside-"));
  try {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    await writeFile(join(root, "image.png"), png);
    await writeFile(join(other, "other.png"), png);
    await symlink(join(other, "other.png"), join(root, "escape.png"));
    const signal = new AbortController().signal;
    expect(await readQQImage(join(root, "image.png"), [root], signal)).toEqual({
      imageBase64: png.toString("base64"),
      mimeType: "image/png"
    });
    await expect(readQQImage(join(root, "escape.png"), [root], signal)).rejects.toThrow("outside");
    await expect(readQQImage("https://example.com/image.png", [root], signal)).rejects.toThrow(
      "origin"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
