import { useEffect, useRef } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { ComposerState, OutgoingImage } from "../shared/composer";

const key = ["ultra", "composer"] as const;

/**
 * Daemon-persisted drafts and queued follow-ups (survive plugin reload / app
 * refresh). Mutations update the cache optimistically, then reconcile.
 */
export function useComposer(enabled = true) {
  const client = useQueryClient();
  const read = useRpc(rpc.readComposer),
    save = useRpc(rpc.saveDraft),
    push = useRpc(rpc.queueMessage),
    unqueue = useRpc(rpc.unqueueMessage),
    sendNow = useRpc(rpc.sendQueuedNow);
  const query = useQuery({ queryKey: key, queryFn: () => read({}), refetchInterval: 3000, enabled });
  const patch = (update: (state: ComposerState) => ComposerState) =>
    client.setQueryData<ComposerState>(key, (current) => update(current ?? { version: 1, sessions: {} }));
  const refresh = () => void client.invalidateQueries({ queryKey: key });
  const timers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; flush(): void }>());
  useEffect(
    () => () => {
      // Flush pending draft saves on unmount so nothing typed is lost.
      timers.current.forEach(({ timer, flush }) => {
        clearTimeout(timer);
        flush();
      });
      timers.current.clear();
    },
    [],
  );
  return {
    query,
    state: query.data,
    entry: (agentId: string) => query.data?.sessions[agentId],
    /** Debounced draft persistence (keyed per session). */
    saveDraft(taskId: string, agentId: string, text: string, immediate = false) {
      const pending = timers.current.get(agentId);
      if (pending) clearTimeout(pending.timer);
      const flush = () => {
        timers.current.delete(agentId);
        void save({ taskId, agentId, text }).catch(() => undefined);
      };
      if (immediate) return flush();
      timers.current.set(agentId, { timer: setTimeout(flush, 500), flush });
    },
    async queue(taskId: string, agentId: string, text: string, images: OutgoingImage[] = []) {
      const temp = {
        id: `pending-${Date.now()}`,
        text,
        at: new Date().toISOString(),
        ...(images.length ? { images: images.map((image, i) => ({ file: `pending-${i}.png`, mimeType: image.mimeType })) } : {}),
      };
      patch((s) => ({
        ...s,
        sessions: {
          ...s.sessions,
          [agentId]: {
            ...(s.sessions[agentId] ?? { taskId, draft: "", draftAt: null, lastError: null }),
            queue: [...(s.sessions[agentId]?.queue || []), temp],
          },
        },
      }));
      try {
        return await push({ taskId, agentId, text, ...(images.length ? { images } : {}) });
      } finally {
        refresh();
      }
    },
    async remove(agentId: string, id: string) {
      patch((s) => {
        const e = s.sessions[agentId];
        return e ? { ...s, sessions: { ...s.sessions, [agentId]: { ...e, queue: e.queue.filter((m) => m.id !== id) } } } : s;
      });
      try {
        await unqueue({ agentId, id });
      } finally {
        refresh();
      }
    },
    async sendNow(taskId: string, agentId: string, id: string) {
      try {
        await sendNow({ taskId, agentId, id });
      } finally {
        refresh();
      }
    },
  };
}
