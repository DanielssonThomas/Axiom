import typescript from "@typescript-eslint/parser";

export default [{
  files: ["apps/**/*.ts", "libs/**/*.ts"],
  languageOptions: { parser: typescript },
  rules: { "no-debugger": "error" },
}];
