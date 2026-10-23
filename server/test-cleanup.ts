// Test helper only; runtime entries never import this module.
export type Cleanup = () => Promise<unknown> | unknown;

/**
 * Runs and empties `list`, last registered first. Every cleanup runs even when an
 * earlier one fails (a temp directory is still removed after a failed server close);
 * the failures are thrown afterwards: the error itself, or an AggregateError of all.
 */
export async function runCleanups(list: Cleanup[]) {
  const errors: unknown[] = [];
  for (const cleanup of list.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, `${errors.length} test cleanups failed.`);
}
