import { useQuery } from '@tanstack/react-query';
import { getSnapshotMeta, listConflicts, listSnapshots, pendingCount } from '../db';

/** État local du scanner pour un événement (snapshot, file, conflits) — lu dans IndexedDB, jamais sur le réseau. */
export function useScannerData(eventId: string) {
  const q = useQuery({
    queryKey: ['scanner-local', eventId],
    networkMode: 'always',
    staleTime: 0,
    queryFn: async () => {
      const [meta, pending, conflicts] = await Promise.all([getSnapshotMeta(eventId), pendingCount(eventId), listConflicts(eventId)]);
      return { meta: meta ?? null, pending, conflicts };
    },
  });
  return {
    meta: q.data ? q.data.meta : undefined,
    pending: q.data?.pending ?? 0,
    conflicts: q.data?.conflicts ?? [],
    reload: async () => {
      await q.refetch();
    },
  };
}

export function useLocalSnapshots() {
  return useQuery({ queryKey: ['scanner-local', 'snapshots'], networkMode: 'always', staleTime: 0, queryFn: listSnapshots });
}
