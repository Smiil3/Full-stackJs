import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { getScannerAccess, getSnapshotMeta, listConflicts, listQueue, listSnapshots, ownerHash } from '../db';

/** Empreinte du compte qui scanne : utilisateur connecté, ou dernier compte validé (démarrage hors-ligne). */
export function useOwner(): string | null | undefined {
  const { user, status } = useAuth();
  const q = useQuery({
    queryKey: ['scanner-local', 'owner', user?.id ?? null, status],
    networkMode: 'always',
    queryFn: async () => (user ? ownerHash(user.id) : ((await getScannerAccess())?.ownerHash ?? null)),
  });
  return q.data;
}

/** État local d'un événement (liste, file, conflits) — lu dans IndexedDB, jamais sur le réseau. */
export function useScannerData(eventId: string, owner: string | null | undefined) {
  const q = useQuery({
    queryKey: ['scanner-local', eventId, owner ?? null],
    networkMode: 'always',
    staleTime: 0,
    queryFn: async () => {
      const [meta, queue, conflicts] = await Promise.all([getSnapshotMeta(eventId), listQueue(eventId), listConflicts(eventId)]);
      return {
        meta: meta ?? null,
        pending: queue.filter((s) => s.ownerHash === owner).length,
        otherPending: queue.filter((s) => s.ownerHash !== owner).length,
        conflicts,
      };
    },
  });
  return {
    meta: q.data ? q.data.meta : undefined,
    pending: q.data?.pending ?? 0,
    otherPending: q.data?.otherPending ?? 0,
    conflicts: q.data?.conflicts ?? [],
    reload: async () => {
      await q.refetch();
    },
  };
}

export function useLocalSnapshots() {
  return useQuery({ queryKey: ['scanner-local', 'snapshots'], networkMode: 'always', staleTime: 0, queryFn: listSnapshots });
}

export function useScannerAccess() {
  return useQuery({ queryKey: ['scanner-local', 'access'], networkMode: 'always', staleTime: 0, queryFn: getScannerAccess });
}
