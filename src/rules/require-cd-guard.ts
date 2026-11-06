/**
 * @fileoverview Rule to require handling `cd` failure.
 */

//------------------------------------------------------------------------------
// Imports
//------------------------------------------------------------------------------

import { getCommandName } from "./utils.js";
import type { ShellRuleDefinition, StatementNode } from "../types.js";

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

const rule: ShellRuleDefinition<{
	MessageIds: "uncheckedCd" | "addGuard";
}> = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Require `cd` failures to be handled, e.g. `cd ... || exit`",
			recommended: true,
			url: "https://github.com/eslint/shell/blob/main/docs/rules/require-cd-guard.md",
		},
		hasSuggestions: true,
		schema: [],
		messages: {
			uncheckedCd:
				"Use 'cd ... || exit' or 'cd ... || return' in case cd fails.",
			addGuard: "Add '|| exit' after the cd command.",
		},
	},

	create(context) {
		const { sourceCode } = context;

		return {
			Command(node) {
				if (getCommandName(node) !== "cd") {
					return;
				}

				// `! cd ...` uses the exit status explicitly.
				if (node.negated) {
					return;
				}

				let expression: StatementNode = node;
				let parent = sourceCode.getParent(expression);

				while (parent?.type === "LogicalExpression") {
					// A failed command can propagate through a left-associative
					// chain to an expression whose status is checked.
					if (parent.left === expression) {
						return;
					}

					expression = parent;
					parent = sourceCode.getParent(expression);
				}

				if (parent) {
					// `if cd ...`, `while cd ...`, `until cd ...`
					if (
						(parent.type === "IfStatement" ||
							parent.type === "WhileStatement" ||
							parent.type === "UntilStatement") &&
						parent.test.includes(node)
					) {
						return;
					}
				}

				const canSuggest =
					!node.background && node.redirects.length === 0;

				context.report({
					node,
					messageId: "uncheckedCd",
					suggest: canSuggest
						? [
								{
									messageId: "addGuard",
									fix: fixer =>
										fixer.insertTextAfter(node, " || exit"),
								},
							]
						: [],
				});
			},
		};
	},
};

export default rule;
