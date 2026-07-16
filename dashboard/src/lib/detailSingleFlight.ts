import { createSingleFlightRegistry } from "./feedScheduling.ts";

// DrawerProvider instances are route-local, but detail GET ownership is not.
// Keeping this registry at module scope lets the destination provider join the
// request started by the provider that navigation just unmounted. A successful
// request remains joinable briefly because a very fast response can settle
// before React mounts the destination provider on a CPU-constrained device.
// The normal refresh flow waits 800 ms before refetching, so this lease cannot
// mask the newer post-refresh value.
export const DETAIL_ROUTE_HANDOFF_GRACE_MS = 500;
const detailSingleFlight = createSingleFlightRegistry({
  successRetentionMs: DETAIL_ROUTE_HANDOFF_GRACE_MS,
});

export function runDetailSingleFlight<T>(
  id: string,
  factory: () => Promise<T>,
): Promise<T> {
  return detailSingleFlight.run(id, factory);
}
