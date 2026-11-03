/**
 * @fileoverview The @eslint/shell plugin: a shell language definition for
 * ESLint, ShellCheck-inspired rules, and a recommended configuration.
 * @author Claude Opus 5.5
 */

//------------------------------------------------------------------------------
// Plugin
//------------------------------------------------------------------------------
import { ShellLanguage } from "./languages/shell-language.js";
import noBackticks from "./rules/no-backticks.js";
import noExpansionsInSingleQuotes from "./rules/no-expansions-in-single-quotes.js";
import noLsIteration from "./rules/no-ls-iteration.js";
import noUnquotedExpansions from "./rules/no-unquoted-expansions.js";
import noUnusedVars from "./rules/no-unused-vars.js";
import noUselessCat from "./rules/no-useless-cat.js";
import noUselessEcho from "./rules/no-useless-echo.js";
import noVariablesInPrintfFormat from "./rules/no-variables-in-printf-format.js";
import requireCdGuard from "./rules/require-cd-guard.js";
import requireReadR from "./rules/require-read-r.js";

const rules = {
	"no-backticks": noBackticks,
	"no-expansions-in-single-quotes": noExpansionsInSingleQuotes,
	"no-ls-iteration": noLsIteration,
	"no-unquoted-expansions": noUnquotedExpansions,
	"no-unused-vars": noUnusedVars,
	"no-useless-cat": noUselessCat,
	"no-useless-echo": noUselessEcho,
	"no-variables-in-printf-format": noVariablesInPrintfFormat,
	"require-cd-guard": requireCdGuard,
	"require-read-r": requireReadR,
};

const plugin = {
	meta: {
		name: "@eslint/shell",
		namespace: "shell",
		version: "0.1.0", // x-release-please-version
	},
	languages: {
		bash: new ShellLanguage({ mode: "bash" }),
		posix: new ShellLanguage({ mode: "posix" }),
		mksh: new ShellLanguage({ mode: "mksh" }),
	},
	rules,
	configs: {
		recommended: {
			name: "shell/recommended",
			files: ["**/*.sh", "**/*.bash"],
			language: "shell/bash",
			plugins: {},
			rules: {
				"shell/no-backticks": "error",
				"shell/no-expansions-in-single-quotes": "warn",
				"shell/no-ls-iteration": "error",
				"shell/no-unquoted-expansions": "error",
				"shell/no-unused-vars": "error",
				"shell/no-useless-cat": "error",
				"shell/no-useless-echo": "error",
				"shell/no-variables-in-printf-format": "error",
				"shell/require-cd-guard": "error",
				"shell/require-read-r": "error",
			},
		},
	},
};

//------------------------------------------------------------------------------
// Exports
//------------------------------------------------------------------------------

// The recommended config must reference the plugin itself.
Object.assign(plugin.configs.recommended.plugins, { shell: plugin });

export default plugin;
export { ShellLanguage } from "./languages/shell-language.js";
export { ShellSourceCode } from "./languages/shell-source-code.js";
export { parseShell, ShellSyntaxError } from "./parser/parse.js";
export { visitorKeys } from "./visitor-keys.js";
export type * from "./types.js";
