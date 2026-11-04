import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/** false на сервері й під час гідратації, true після неї — для прогресивного покращення. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}
