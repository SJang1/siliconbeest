import functional from "eslint-plugin-functional"
import oxlint from "eslint-plugin-oxlint"
import tseslint from "typescript-eslint"

const inScopeFiles = [
  "server/worker/services/**/*.ts",
  "server/worker/repositories/**/*.ts",
  "server/worker/middleware/**/*.ts",
  "server/worker/utils/**/*.ts",
  "server/worker/webpush/**/*.ts",
  "server/worker/types/**/*.ts",
]

// Binary/crypto files that are inherently imperative — exempt from FP rules
const imperativeFiles = [
  "server/worker/utils/cbor.ts",
  "server/worker/utils/crypto.ts",
  "server/worker/utils/webauthn.ts",
  "server/worker/utils/totp.ts",
  "server/worker/utils/sanitize.ts",
  "server/worker/utils/defaultImages.ts",
  "server/worker/utils/statusEnrichment.ts",
  "server/worker/utils/mastodonSerializer.ts",
  "server/worker/utils/reblogResolver.ts",
  "server/worker/utils/vapid.ts",
  "server/worker/webpush/vapid.ts",
  "server/worker/webpush/encrypt.ts",
  "server/worker/middleware/errorHandler.ts",
  "server/worker/services/ogFetcher.ts",
]

export default tseslint.config(
  ...oxlint.buildFromOxlintConfigFile("./oxlint.config.ts"),
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: inScopeFiles,
  })),

  {
    files: inScopeFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { functional },
    rules: {
      // disable rules already handled by oxlint
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // type-aware FP rules
      "functional/type-declaration-immutability": "warn",
      "functional/no-mixed-types": "warn",
      "functional/no-return-void": "warn",
      "functional/no-throw-statements": "error",
    },
  },

  // Exempt imperative files from FP rules
  {
    files: imperativeFiles,
    rules: {
      "functional/no-throw-statements": "off",
      "functional/no-return-void": "off",
      "functional/no-mixed-types": "off",
    },
  },

  // Don't error on eslint-disable comments for oxlint-only rules (fp/*)
  {
    files: inScopeFiles,
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },

  {
    ignores: ["src/**", "node_modules/**", "dist/**", "public/**"],
  },
)
