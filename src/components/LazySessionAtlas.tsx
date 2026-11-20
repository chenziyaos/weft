import { lazy, Suspense, type ComponentProps } from 'react';

// The atlas (and the memory page inside it) loads on first open, not at startup.
const SessionAtlas = lazy(() => import('./SessionAtlas'));

export default function LazySessionAtlas(props: ComponentProps<typeof SessionAtlas>) {
  return (
    <Suspense fallback={null}>
      <SessionAtlas {...props} />
    </Suspense>
  );
}
