import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 10_000;

const desktopLocalBootstrapsAtom = Atom.make((get) => {
  let interval: ReturnType<typeof setInterval> | undefined;
  const read = () => get.setSelf(readDesktopSecondaryBootstraps());
  const start = () => {
    if (interval !== undefined) return;
    read();
    interval = setInterval(read, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
  };
  const stop = () => {
    if (interval === undefined) return;
    clearInterval(interval);
    interval = undefined;
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      start();
    } else {
      stop();
    }
  };
  onVisibilityChange();
  document.addEventListener("visibilitychange", onVisibilityChange);
  get.addFinalizer(() => {
    stop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });
  return readDesktopSecondaryBootstraps();
}).pipe(Atom.withLabel("desktop-local-bootstraps"));

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}
