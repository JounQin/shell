/**
 * @fileoverview Rule to disallow legacy backtick command substitution.
 */

//------------------------------------------------------------------------------
// Imports
//------------------------------------------------------------------------------

import type { ShellRuleDefinition } from "../types.js";

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

const rule: ShellRuleDefinition<{ MessageIds: "useDollarParen" }> = {
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Disallow legacy backtick command substitution in favor of `$(...)`",
			recommended: true,
			url: "https://github.com/eslint/shell/blob/main/docs/rules/no-backticks.md",
		},
		fixable: "code",
		schema: [],
		messages: {
			useDollarParen: "Use $(...) notation instead of legacy backticks.",
		},
	},

	create(context) {
		const { sourceCode } = context;

		return {
			CommandSubstitution(node) {
				if (!node.backquotes) {
					return;
				}

				const [start, end] = sourceCode.getRange(node);
				const inner = sourceCode.text.slice(start + 1, end - 1);

				context.report({
					node,
					messageId: "useDollarParen",

					// Escapes behave differently inside backticks, so only
					// fix substitutions without backslashes or nesting.
					fix: /[\\`]/u.test(inner)
						? undefined
						: fixer => [
								fixer.replaceTextRange(
									[start, start + 1],
									"$(",
								),
								fixer.replaceTextRange([end - 1, end], ")"),
							],
				});
			},
		};
	},
};

export default rule;
