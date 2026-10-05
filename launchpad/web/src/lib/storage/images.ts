// Image rules shared by the launch form (instant feedback) and /api/upload (enforcement).
// No Node imports: this file is bundled into the browser too.

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export const IMAGE_ERRORS = {
  type: "Only PNG, JPEG, GIF or WebP images can be uploaded.",
  size: "Images must be 2 MB or smaller.",
  empty: "That file is empty.",
};

export type ImageKind = { ext: "png" | "jpg" | "gif" | "webp"; mime: string };

// Identifies an image by its first bytes, never by its file name or declared type.
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const has = (signature: number[], at = 0) => signature.every((b, i) => bytes[at + i] === b);
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", mime: "image/png" };
  if (has([0xff, 0xd8, 0xff])) return { ext: "jpg", mime: "image/jpeg" };
  if (has([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { ext: "gif", mime: "image/gif" }; // GIF87a / GIF89a
  }
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) return { ext: "webp", mime: "image/webp" }; // RIFF....WEBP
  return null;
}
