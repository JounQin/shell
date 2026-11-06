/**
 * @fileoverview ESLint configuration file.
 * @author Claude Opus 5.5
 */

//------------------------------------------------------------------------------
// Imports
//------------------------------------------------------------------------------

import js from "@eslint/js";
import eslintPlugin from "eslint-plugin-eslint-plugin";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

const eslintPluginRulesRecommendedConfig =
	eslintPlugin.configs["rules-recommended"];
const eslintPluginTestsRecommendedConfig =
	eslintPlugin.configs["tests-recommended"];

//------------------------------------------------------------------------------
// Exports
//------------------------------------------------------------------------------

export default defineConfig(
	globalIgnores(["dist/**", "coverage/**"]),
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_" },
			],
		},
	},
	{
		files: ["src/rules/*.ts"],
		ignores: ["src/rules/*.spec.ts", "src/rules/utils.ts"],
		extends: [eslintPluginRulesRecommendedConfig],
		rules: {
			"eslint-plugin/require-meta-docs-recommended": "error",
			"eslint-plugin/require-meta-schema": "off", // `schema` defaults to []
			"eslint-plugin/require-meta-schema-description": "off",
			"eslint-plugin/prefer-placeholders": "error",
			"eslint-plugin/prefer-replace-text": "error",
			"eslint-plugin/report-message-format": [
				"error",
				"^[^a-z].*\\.(?: \\([^()]*\\))?$",
			],
			"eslint-plugin/require-meta-docs-description": [
				"error",
				{ pattern: "^(Enforce|Require|Disallow) .+[^. ]$" },
			],
			"eslint-plugin/require-meta-docs-url": [
				"error",
				{
					pattern:
						"https://github.com/eslint/shell/blob/main/docs/rules/{{name}}.md",
				},
			],
		},
	},
	{
		files: ["src/rules/*.spec.ts"],
		extends: [eslintPluginTestsRecommendedConfig],
		rules: {
			"eslint-plugin/test-case-property-ordering": [
				"error",
				[
					"name",
					"filename",
					"code",
					"output",
					"language",
					"options",
					"languageOptions",
					"errors",
				],
			],
			"eslint-plugin/test-case-shorthand-strings": "error",
		},
	},
);
