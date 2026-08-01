import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "prefer-const": "error",
    },
  },
  {
    // Adversarial tests deliberately construct malformed payloads.
    files: ["**/tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/*.tsx"],
    rules: {
      // React components legitimately return JSX from arrow handlers.
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
