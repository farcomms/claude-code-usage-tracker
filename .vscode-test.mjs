import { defineConfig } from "@vscode/test-cli";
export default defineConfig({
  files: "out-test/test/integration/**/*.test.js",
  version: "stable",
});
