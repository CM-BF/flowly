import { perfNow } from "./perf";

/**
 * Imported first by the plugin entry, so this runs before the rest of the
 * bundle's modules: the time from here to the end of `contribute` is the
 * plugin's own start-up cost (`plugin.load` in the timing log).
 */
export const bootAt = perfNow();
