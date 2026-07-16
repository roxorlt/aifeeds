import { createSingleFlightRegistry } from "./feedScheduling.ts";

// DrawerProvider instances are route-local, but detail GET ownership is not.
// Keeping this registry at module scope lets the destination provider join the
// request started by the provider that navigation just unmounted.
const detailSingleFlight = createSingleFlightRegistry();

export function runDetailSingleFlight<T>(
  id: string,
  factory: () => Promise<T>,
): Promise<T> {
  return detailSingleFlight.run(id, factory);
}
