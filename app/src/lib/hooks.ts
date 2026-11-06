import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import type { BoardSummary, MatchSummary } from '@shared';
import { api, errorMessage } from './api';

/** Fetch data whenever the screen gets focus. */
export function useFocusFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  return { data, error, loading, reload, setData };
}

export const useBoards = () => useFocusFetch<BoardSummary[]>('/api/boards');
export const useRunningMatches = () => useFocusFetch<MatchSummary[]>('/api/matches?status=running&limit=10');
