'use client';

import { useEffect, useState } from 'react';

export function terminalTransitionNeedsRefresh(previousActive: boolean, nextActive: boolean): boolean {
  return previousActive && !nextActive;
}

export function durablePollingMessage(active: boolean, failedPolls: number, transitionMessage: string | null): string | null {
  if (failedPolls >= 3) return 'Live updates paused; refresh to check durable status.';
  return transitionMessage ?? (active ? 'Safe to refresh; progress is stored.' : null);
}

export function createPollingLifetime() {
  let active = true;
  const controller = new AbortController();
  return {
    signal: controller.signal,
    canApply: () => active && !controller.signal.aborted,
    dispose: () => {
      active = false;
      controller.abort();
    },
  };
}

export function useDurablePolling<T extends { id: string; state: string }>(input: {
  initialValue: T;
  isActive: (state: T['state']) => boolean;
  resourceKey: string;
  endpoint: (id: string) => string;
}): { value: T; liveMessage: string | null };
export function useDurablePolling<T extends { id: string; state: string }>(input: {
  initialValue: T | null;
  isActive: (state: T['state']) => boolean;
  resourceKey: string;
  endpoint: (id: string) => string;
}): { value: T | null; liveMessage: string | null };
export function useDurablePolling<T extends { id: string; state: string }>(input: {
  initialValue: T | null;
  isActive: (state: T['state']) => boolean;
  resourceKey: string;
  endpoint: (id: string) => string;
}): { value: T | null; liveMessage: string | null } {
  const [value, setValue] = useState(input.initialValue);
  const [failedPolls, setFailedPolls] = useState(0);
  const [transitionMessage, setTransitionMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!value || !input.isActive(value.state)) return;
    const lifetime = createPollingLifetime();
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(input.endpoint(value.id), {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: lifetime.signal,
        });
        if (!lifetime.canApply()) return;
        if (!response.ok) throw new Error('poll_unavailable');
        const body = await response.json() as Record<string, unknown>;
        if (!lifetime.canApply()) return;
        const next = body[input.resourceKey] as T | undefined;
        if (!next || next.id !== value.id || typeof next.state !== 'string') throw new Error('poll_invalid');
        setFailedPolls(0);
        if (terminalTransitionNeedsRefresh(true, input.isActive(next.state))) {
          setTransitionMessage('Durable status updated. Loading the next available action.');
          window.location.reload();
        }
        setValue(next);
      } catch {
        if (lifetime.canApply()) setFailedPolls((count) => Math.min(count + 1, 3));
      }
    }, 3_000);
    return () => {
      window.clearInterval(timer);
      lifetime.dispose();
    };
  }, [input, value]);

  return {
    value,
    liveMessage: durablePollingMessage(Boolean(value && input.isActive(value.state)), failedPolls, transitionMessage),
  };
}

export function DurableLiveMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="workflow-live-message" aria-live="polite" aria-atomic="true">{message}</p>;
}
