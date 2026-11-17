import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, Share } from 'react-native';
import type { FriendsOverview } from '@shared';
import { api, errorMessage, getApiBase } from './api';
import { useLiveMessages } from './live';
import { getItem, setItem } from './storage';

const EMPTY: FriendsOverview = { friends: [], incoming: [], outgoing: [] };
const PENDING_INVITE_KEY = 'autodarter.pendingInvite';

/** Friends with live online status (presence messages from the server). */
export function useFriends() {
  const [data, setData] = useState<FriendsOverview>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await api<FriendsOverview>('/api/friends'));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  useLiveMessages((msg) => {
    if (msg.type === 'friends_changed') void reload();
    else if (msg.type === 'presence') {
      setData((d) => {
        const friends = d.friends.map((f) => (f.id === msg.userId ? { ...f, online: msg.online } : f));
        friends.sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName, 'de'));
        return { ...d, friends };
      });
    }
  });

  return { ...data, loaded, error, reload };
}

/** Link that opens the app and sends me a friend request (after login / registration). */
export function inviteLink(username: string): string {
  let base = getApiBase();
  if (!base && typeof window !== 'undefined' && window.location) base = window.location.origin;
  return `${base}/invite/${encodeURIComponent(username)}`;
}

/** Share or copy the invite link; returns a short status text. */
export async function shareInvite(username: string): Promise<string> {
  const url = inviteLink(username);
  const text = `Spiel mit mir Darts auf Autodarter: ${url}`;
  if (Platform.OS === 'web') {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.share) {
      try {
        await nav.share({ title: 'Autodarter', text, url });
        return 'Link geteilt';
      } catch {
        // cancelled or not allowed – fall back to copying
      }
    }
    if (nav?.clipboard) {
      await nav.clipboard.writeText(url);
      return 'Link kopiert';
    }
    return url;
  }
  await Share.share({ message: text, url });
  return 'Link geteilt';
}

export async function rememberInvite(username: string) {
  await setItem(PENDING_INVITE_KEY, username);
}

/** After login / registration: send the friend request from an invite link that was opened before. */
export async function processPendingInvite(): Promise<string | null> {
  const username = await getItem(PENDING_INVITE_KEY);
  if (!username) return null;
  await setItem(PENDING_INVITE_KEY, null);
  try {
    const res = await api<{ status: string; user: { displayName: string } }>('/api/friends', { body: { username } });
    return res.status === 'accepted'
      ? `Du bist jetzt mit ${res.user.displayName} befreundet`
      : `Freundschaftsanfrage an ${res.user.displayName} gesendet`;
  } catch (e) {
    return errorMessage(e);
  }
}
