import { useEffect, useState } from 'react';

/**
 * An object URL for a Blob, revoked when the blob changes or the caller unmounts.
 *
 * Every `createObjectURL` pins its blob in memory until revoked, so a list of
 * receipts that forgot to clean up would hold on to every image it had ever
 * scrolled past. Keeping the create/revoke pair inside one effect makes that
 * impossible to get wrong at the call site.
 *
 * The URL is created in an effect rather than during render on purpose, which
 * makes this the second justified `setState`-in-an-effect in the codebase after
 * the allocation pair in `modals/category.jsx`. Deriving it during render with
 * `useMemo` is the obvious alternative and is worse: it makes render impure,
 * and under StrictMode's double render it leaks one URL per mount, because only
 * the committed one is ever revoked. The effect version is StrictMode-correct —
 * cleanup revokes, the re-run recreates — and costs one extra render when a
 * blob appears, not the cascade the rule exists to catch.
 *
 * "No blob means no URL" is derived at the return rather than written back
 * through state, so a revoked URL can never survive a render as a stale value,
 * and the effect stays down to a single assignment.
 */
export function useBlobUrl(blob) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!blob) return undefined;
    const next = URL.createObjectURL(blob);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);

  return blob ? url : null;
}
