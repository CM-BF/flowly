// Test tooling only: the plugin's code stays in index.*, client/, server/ and shared/. Plain JavaScript, so the typecheck
// does not pull in Vite's DOM-flavoured types.
export default { test: { setupFiles: ["./server/test-setup.ts"] } };
