import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["coverage", "dist", "dist-electron", "node_modules", "release"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error"
    }
  },
  {
    files: [
      "src/main/**/*.ts",
      "src/preload/**/*.ts",
      "src/shared/**/*.ts",
      "tests/**/*.{ts,tsx}",
      "**/*.{js,mjs,cjs,ts}"
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
        fetch: "readonly"
      }
    },
    rules: {
      "no-control-regex": "off"
    }
  }
);
