import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageAttachment, ImageAttachmentInput } from "./backend.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const STORE_DIRECTORY = fileURLToPath(new URL("../.data/images/", import.meta.url));

type StoredImageMetadata = ImageAttachment & {
  agentId: string;
};

export class LocalImageStore {
  async save(
    agentId: string,
    name: string,
    declaredMimeType: string,
    bytes: Uint8Array,
  ): Promise<ImageAttachment> {
    if (bytes.byteLength === 0) throw clientError(400, "The selected image is empty.");
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw clientError(413, "Images must be 5 MB or smaller.");
    }

    const mimeType = detectedMimeType(bytes);
    if (!mimeType || (declaredMimeType && declaredMimeType !== mimeType)) {
      throw clientError(415, "Use a PNG, JPEG, WebP, or GIF image.");
    }

    const id = randomUUID();
    const attachment: ImageAttachment = {
      id,
      type: "image",
      name: cleanName(name, mimeType),
      mimeType,
      size: bytes.byteLength,
      url: `/v1/assets/${id}`,
    };
    const metadata: StoredImageMetadata = { ...attachment, agentId };

    await mkdir(STORE_DIRECTORY, { recursive: true });
    await Promise.all([
      writeFile(join(STORE_DIRECTORY, `${id}.bin`), bytes),
      writeFile(join(STORE_DIRECTORY, `${id}.json`), JSON.stringify(metadata), "utf8"),
    ]);
    return attachment;
  }

  async get(id: string): Promise<{ metadata: StoredImageMetadata; bytes: Buffer } | null> {
    try {
      const [metadata, bytes] = await Promise.all([
        readFile(join(STORE_DIRECTORY, `${id}.json`), "utf8"),
        readFile(join(STORE_DIRECTORY, `${id}.bin`)),
      ]);
      return { metadata: JSON.parse(metadata) as StoredImageMetadata, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async forPrompt(agentId: string, ids: string[]): Promise<ImageAttachmentInput[]> {
    return await Promise.all(
      ids.map(async (id) => {
        const stored = await this.get(id);
        if (!stored || stored.metadata.agentId !== agentId) {
          throw clientError(400, "One of the attached images is unavailable.");
        }
        const { agentId: _agentId, ...attachment } = stored.metadata;
        return {
          ...attachment,
          bytes: stored.bytes,
        };
      }),
    );
  }

  async deleteMany(ids: string[]): Promise<void> {
    await Promise.all(
      [...new Set(ids)].flatMap((id) => {
        if (!validImageId(id)) return [];
        return ["bin", "json"].map(async (extension) => {
          try {
            await unlink(join(STORE_DIRECTORY, `${id}.${extension}`));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        });
      }),
    );
  }
}

function validImageId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function detectedMimeType(bytes: Uint8Array): ImageAttachment["mimeType"] | null {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    textAt(bytes, 0, 4) === "RIFF" &&
    textAt(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(textAt(bytes, 0, 6))) {
    return "image/gif";
  }
  return null;
}

function textAt(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function cleanName(value: string, mimeType: ImageAttachment["mimeType"]): string {
  const fallbackExtension = mimeType.split("/")[1].replace("jpeg", "jpg");
  return basename(value).trim().slice(0, 120) || `image.${fallbackExtension}`;
}

function clientError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
