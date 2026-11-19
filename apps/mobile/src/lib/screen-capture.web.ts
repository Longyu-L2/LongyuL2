/**
 * The browser's screen-capture.ts, with the same exports. Metro picks this file for the web build.
 * A page cannot keep itself out of a screenshot, so there is nothing to do.
 */

export function hideFromCapture(_key: string): Promise<void> {
  return Promise.resolve();
}

export function showToCapture(_key: string): void {}
