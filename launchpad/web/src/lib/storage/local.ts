// Development backend: files under .data/ (gitignored), served by our own API routes.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(process.cwd(), ".data");

export async function putLocal(key: string, body: Buffer | string): Promise<void> {
  const file = path.join(ROOT, key);
  await mkdir(path.dirname(file), { recursive: true });
  // Write then rename, so a concurrent read never sees a half-written file.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, file);
}

export async function readLocal(key: string): Promise<Buffer<ArrayBuffer> | null> {
  try {
    return await readFile(path.join(ROOT, key));
  } catch {
    return null;
  }
}
