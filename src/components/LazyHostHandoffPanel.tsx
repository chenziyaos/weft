import { lazy, Suspense } from 'react';

// Its own chunk: fetched in parallel with startup instead of parsed with the main bundle.
const HostHandoffPanel = lazy(() => import('./HostHandoffPanel'));

export default function LazyHostHandoffPanel() {
  return (
    <Suspense fallback={null}>
      <HostHandoffPanel />
    </Suspense>
  );
}
