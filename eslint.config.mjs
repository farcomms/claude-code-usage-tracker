import js from "@eslint/js";
export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: { "no-unused-vars": "off" },
  },
  { ignores: ["out/**", "node_modules/**", "media/dashboard.js"] },
];
