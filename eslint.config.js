import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const runtimeGlobals = {
  AbortSignal: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "load-tests/results/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...runtimeGlobals, __ENV: "readonly", __VU: "readonly", __ITER: "readonly" } },
  },
);
