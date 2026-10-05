"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IMAGE_ACCEPT, IMAGE_ERRORS, MAX_IMAGE_BYTES, sniffImage } from "@/lib/storage/images";

type Upload = { name: string; size: number; preview: string; progress: number; url?: string };
type Live = { xhr: XMLHttpRequest | null; preview: string | null; generation: number };

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// Same rules as /api/upload, so most mistakes are caught before any bytes are sent.
async function check(file: File): Promise<string | null> {
  if (file.size === 0) return IMAGE_ERRORS.empty;
  if (!sniffImage(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) return IMAGE_ERRORS.type;
  if (file.size > MAX_IMAGE_BYTES) return `That image is ${size(file.size)}. ${IMAGE_ERRORS.size}`;
  return null;
}

function release(live: Live) {
  live.xhr?.abort();
  if (live.preview) URL.revokeObjectURL(live.preview);
  live.xhr = null;
  live.preview = null;
  live.generation++;
}

// The launch form's image: an uploaded file, or a pasted link as a fallback. `url` goes
// into the coin's metadata; `preview` shows the image instantly, before the upload ends.
export function useImagePicker() {
  const [mode, setMode] = useState<"upload" | "link">("upload");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The in-flight upload and preview URL, released when replaced or when the page closes.
  const live = useRef<Live>({ xhr: null, preview: null, generation: 0 });

  useEffect(() => {
    const current = live.current;
    return () => release(current);
  }, []);

  function remove() {
    release(live.current);
    setUpload(null);
    setError(null);
  }

  function fail(message: string) {
    remove();
    setError(message);
  }

  // XHR rather than fetch: only XHR reports upload progress.
  async function pick(file: File) {
    const generation = ++live.current.generation;
    const problem = await check(file);
    // A newer pick, a removal or leaving the page while the file was being checked wins.
    if (generation !== live.current.generation) return;
    if (problem) return setError(problem);
    release(live.current);
    const preview = URL.createObjectURL(file);
    const xhr = new XMLHttpRequest();
    live.current.xhr = xhr;
    live.current.preview = preview;
    setError(null);
    setUpload({ name: file.name, size: file.size, preview, progress: 0 });

    const update = (patch: Partial<Upload>) => setUpload((u) => (u?.preview === preview ? { ...u, ...patch } : u));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) update({ progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      if (live.current.xhr !== xhr) return;
      live.current.xhr = null;
      const body = xhr.response as { url?: string; error?: string } | null;
      if (xhr.status === 200 && body?.url) update({ progress: 1, url: body.url });
      else fail(body?.error ?? `Upload failed (error ${xhr.status}). Try again.`);
    };
    xhr.onerror = () => {
      if (live.current.xhr === xhr) fail("Upload failed. Check your connection and try again.");
    };
    xhr.open("POST", "/api/upload");
    xhr.responseType = "json";
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  }

  function toggleMode() {
    setError(null);
    setMode((m) => (m === "upload" ? "link" : "upload"));
  }

  const pasted = link.trim();
  return {
    mode,
    upload,
    link,
    setLink,
    error,
    pick,
    remove,
    toggleMode,
    url: mode === "link" ? pasted : (upload?.url ?? ""),
    preview: mode === "link" ? (pasted.startsWith("https://") ? pasted : undefined) : upload?.preview,
    uploading: mode === "upload" && upload !== null && !upload.url,
  };
}

export function ImagePicker({
  picker,
  disabled,
  inputClassName,
}: {
  picker: ReturnType<typeof useImagePicker>;
  disabled?: boolean;
  inputClassName: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const errorId = useId();
  const { upload } = picker;
  const pct = upload ? Math.round(upload.progress * 100) : 0;

  // A file dropped next to the zone would otherwise open in the tab, losing the form.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  const choose = () => fileInput.current?.click();
  const dropTarget = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = disabled ? "none" : "copy";
      if (!disabled) setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file && !disabled) void picker.pick(file);
    },
  };

  return (
    <div>
      <input
        ref={fileInput}
        type="file"
        accept={IMAGE_ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // so choosing the same file again still fires
          if (file) void picker.pick(file);
        }}
      />

      {picker.mode === "link" ? (
        <input
          type="url"
          value={picker.link}
          onChange={(e) => picker.setLink(e.target.value)}
          disabled={disabled}
          placeholder="https://…"
          aria-label="Image link"
          autoFocus
          className={inputClassName}
        />
      ) : upload ? (
        <div {...dropTarget} className={`flex items-center gap-3 rounded-xl border bg-panel p-3 ${dragging ? "border-accent" : "border-line"}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, before upload */}
          <img src={upload.preview} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{upload.name}</div>
            <div className="text-xs text-muted" aria-live="polite">
              {size(upload.size)} · {upload.url ? <span className="text-up">Uploaded</span> : `Uploading ${pct}%`}
            </div>
            {!upload.url && (
              <div
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2"
                role="progressbar"
                aria-label="Upload progress"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-3 text-xs">
            <button type="button" disabled={disabled} onClick={choose} className="text-muted hover:text-text disabled:opacity-50">
              Replace
            </button>
            <button type="button" disabled={disabled} onClick={picker.remove} className="text-muted hover:text-down disabled:opacity-50">
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          {...dropTarget}
          onClick={choose}
          disabled={disabled}
          aria-describedby={picker.error ? errorId : undefined}
          className={`flex h-28 w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 text-sm transition-colors disabled:opacity-50 ${
            dragging ? "border-accent bg-accent/10" : "border-line bg-panel hover:border-accent/60"
          }`}
        >
          <svg aria-hidden viewBox="0 0 24 24" className="mb-1 h-5 w-5 text-muted" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
          <span>
            <span className="font-medium text-accent">Choose an image</span> or drag it here
          </span>
          <span className="text-xs text-muted">PNG, JPEG, GIF or WebP, up to 2 MB</span>
        </button>
      )}

      {picker.error && (
        <p id={errorId} role="alert" className="mt-2 text-sm text-down">
          {picker.error}
        </p>
      )}
      <button type="button" disabled={disabled} onClick={picker.toggleMode} className="mt-2 text-xs text-muted hover:text-text disabled:opacity-50">
        {picker.mode === "upload" ? "or paste a link" : "or upload a file"}
      </button>
    </div>
  );
}
