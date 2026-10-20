import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 10_000;

/**
 * The bridge exposes no change event, so this re-reads on an interval while
 * anything reads it and the window is visible; failed reads retain the latest
 * successful snapshot, while a successful empty read clears it. The reader
 * returns the same array while nothing changed, so an unchanged poll notifies
 * no one.
 */
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
