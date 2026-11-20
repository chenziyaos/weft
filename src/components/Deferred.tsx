import { Suspense, useState, type ReactNode } from 'react';

/**
 * Mounts a lazily imported panel the first time `when` turns true and keeps it
 * mounted afterwards, so the panel's code stays out of the startup bundle while
 * it behaves as before once opened: it still decides for itself when to render
 * nothing, and its state survives being closed and reopened.
 */
export default function Deferred({ when, children }: { when: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(when);
  if (when && !opened) setOpened(true);
  return opened ? <Suspense fallback={null}>{children}</Suspense> : null;
}
