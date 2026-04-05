import { defineConfig } from "oxlint"

export default defineConfig({
  plugins: ["typescript", "unicorn"],
  jsPlugins: [{ name: "fp", specifier: "eslint-plugin-functional" }],
  options: {
    typeAware: true,
  },
  rules: {
    // ── Correctness ──────────────────────────────
    "no-var": "error",
    "prefer-const": "error",
    "no-param-reassign": "error",
    "no-unused-vars": "error",
    eqeqeq: "error",

    // ── TypeScript (AST, native Rust) ────────────
    "typescript/no-explicit-any": "error",
    "typescript/consistent-type-definitions": ["error", "type"],
    "typescript/no-namespace": "error",
    "typescript/no-non-null-assertion": "warn",

    // ── TypeScript (type-aware, tsgolint Go) ─────
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/no-unsafe-assignment": "warn",
    "typescript/switch-exhaustiveness-check": "error",

    // ── Unicorn (native Rust) ────────────────────
    "unicorn/prefer-array-flat-map": "error",

    // ── FP rules (jsPlugin, AST-only) ───────────
    "fp/no-classes": "error",
    "fp/no-this-expressions": "error",
    "fp/no-let": "warn",
    "fp/no-loop-statements": "error",
    "fp/no-try-statements": "warn",
    "fp/no-throw-statements": "warn",
    "fp/no-promise-reject": "error",
    "fp/no-class-inheritance": "error",
  },
})
