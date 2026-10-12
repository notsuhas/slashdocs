import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["workers/dist/**", "workers/shared/*.generated.ts"] },
  ...tseslint.configs.recommended,
  {
    files: ["workers/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
