import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import type { LeaderboardResponse } from '@shared';
import { api, errorMessage } from './api';

/** GET /api/leaderboard, reloaded whenever the screen gets the focus. */
export function useLeaderboard() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setPending(true);
    try {
      const res = await api<LeaderboardResponse>('/api/leaderboard');
      if (id !== seq.current) return;
      setData(res);
      setError(null);
    } catch (e) {
      if (id !== seq.current) return;
      setError(errorMessage(e));
    } finally {
      if (id === seq.current) setPending(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return { data, error, pending, reload: load };
}
