import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteFootage, footageKey, FootageStoreError, getFootage, putFootage, renameFootage } from './footageStore';
import type { ShortScript } from '../types';

/**
 * The user's own copy of the source video, as the player uses it. `offset`: source time at which the file starts
 * (a downloaded YouTube section starts before the clip; a full local copy starts at 0). `blob` is only set on the
 * value handed to `setSourceFile` (it is what gets stored); `restored` marks footage read back from this browser.
 */
export interface SourceFootage {
  url: string;
  name: string;
  offset: number;
  end?: number;
  blob?: Blob;
  restored?: boolean;
  /** Set when the footage could not be kept in this browser (it still works until the page is closed). */
  storageNote?: string;
}

const DRAFT_KEY_STORAGE = 'forge_footage_draft';

/** Stable per-tab key for unsaved work, so a reload in the same tab still finds the footage. */
export function draftFootageKey(): string {
  try {
    const existing = sessionStorage.getItem(DRAFT_KEY_STORAGE);
    if (existing) return existing;
    const created = `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(DRAFT_KEY_STORAGE, created);
    return created;
  } catch {
    return 'draft_session';
  }
}

/** Which source video the script is cut from, or null when it has none (idea-prompt Shorts). */
export function sourceVideoKey(script: Pick<ShortScript, 'sourceYouTubeId' | 'sourceLocalVideo'> | null | undefined): string | null {
  if (script?.sourceYouTubeId) return `yt:${script.sourceYouTubeId}`;
  if (script?.sourceLocalVideo?.name) return `local:${script.sourceLocalVideo.name}`;
  return null;
}

/** The footage store key for a project (or the unsaved draft when projectId is undefined) and its source video. */
export function footageKeyFor(projectId: string | undefined, script: Parameters<typeof sourceVideoKey>[0]): string | null {
  const video = sourceVideoKey(script);
  return video ? footageKey(projectId || draftFootageKey(), video) : null;
}

const storageNoteFor = (e: unknown) =>
  e instanceof FootageStoreError && e.reason === 'too_large'
    ? `${e.message} It is attached for this session only; add it again after reopening the project.`
    : e instanceof FootageStoreError && e.reason === 'quota'
    ? 'Browser storage is full, so this video is attached for this session only. Add it again after reopening the project.'
    : "This browser can't keep the video (storage unavailable), so it is attached for this session only.";

/**
 * Source footage held above the studio steps (so switching steps does not drop it) and mirrored to IndexedDB (so a
 * reload or reopening the project restores it). Entries are cached per key for the session; storage operations run
 * one at a time so a quick "attach → save project" cannot rename before the write has landed.
 */
export function useSourceFootage(key: string | null, draftKey: string | null = null) {
  const cache = useRef(new Map<string, SourceFootage>());
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = (op: () => Promise<unknown>) => {
    queue.current = queue.current.then(op, op);
    return queue.current;
  };
  const keyRef = useRef(key);
  keyRef.current = key;

  // Restore from this browser when a project / source is opened.
  useEffect(() => {
    if (!key || cache.current.has(key)) return;
    let alive = true;
    void enqueue(async () => {
      let rec = await getFootage(key);
      // A reload right after saving can interrupt moving the draft's footage to the project: finish the move.
      if (!rec && draftKey && draftKey !== key && (await getFootage(draftKey))) {
        await renameFootage(draftKey, key);
        rec = await getFootage(key);
      }
      if (!alive || !rec || cache.current.has(key)) return;
      cache.current.set(key, { url: URL.createObjectURL(rec.blob), name: rec.name, offset: rec.offset, end: rec.end, restored: true });
      bump();
    });
    return () => {
      alive = false;
    };
  }, [key, draftKey]);

  /** Attach (with `blob`, which is stored) or remove (null, which deletes it from the store) the footage. */
  const setSourceFile = useCallback((next: SourceFootage | null, targetKey: string | null = keyRef.current) => {
    if (!targetKey) return;
    const prev = cache.current.get(targetKey);
    if (prev && prev.url !== next?.url) URL.revokeObjectURL(prev.url);
    if (!next) {
      cache.current.delete(targetKey);
      bump();
      void enqueue(() => deleteFootage(targetKey));
      return;
    }
    const { blob, ...entry } = next;
    cache.current.set(targetKey, entry);
    bump();
    if (!blob) return;
    void enqueue(() =>
      putFootage(targetKey, { blob, name: next.name, offset: next.offset, end: next.end }).catch((e) => {
        const current = cache.current.get(targetKey);
        if (current?.url !== next.url) return;
        cache.current.set(targetKey, { ...current, storageNote: storageNoteFor(e) });
        bump();
      }),
    );
  }, []);

  /** An unsaved draft became a saved project: carry its footage over to the project's key. */
  const moveFootage = useCallback((fromKey: string | null, toKey: string | null) => {
    if (!fromKey || !toKey || fromKey === toKey) return;
    const entry = cache.current.get(fromKey);
    if (entry) {
      cache.current.set(toKey, entry);
      cache.current.delete(fromKey);
      bump();
    }
    void enqueue(() => renameFootage(fromKey, toKey));
  }, []);

  return { sourceFile: key ? cache.current.get(key) ?? null : null, setSourceFile, moveFootage };
}
