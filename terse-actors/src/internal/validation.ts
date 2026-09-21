import type { ImageAttachment } from "./types.js"

export const MAX_PROMPT_LENGTH = 4_000
export const MAX_PROMPT_IMAGES = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function validIdentifier(value: unknown): value is string {
    return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value)
}

export function validImageAttachment(attachment: ImageAttachment): boolean {
    return Boolean(
        attachment &&
        attachment.type === "image" &&
        validIdentifier(attachment.id) &&
        typeof attachment.name === "string" &&
        attachment.name.length > 0 &&
        attachment.name.length <= 120 &&
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mimeType) &&
        Number.isSafeInteger(attachment.size) &&
        attachment.size > 0 &&
        attachment.size <= MAX_IMAGE_BYTES &&
        attachment.url === `/v1/assets/${attachment.id}`
    )
}
