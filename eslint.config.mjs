import baseConfig from "@zingage/base-configs-eslint/package/eslint.config.mjs";

export default [
  ...baseConfig,
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs}"],
    rules: {
      // There are too many legacy violations, which aren't worth fixing.
      "no-restricted-syntax": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
];
