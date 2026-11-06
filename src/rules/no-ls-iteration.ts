/**
 * @fileoverview Rule to disallow iterating over `ls` output.
 */

//------------------------------------------------------------------------------
// Imports
//------------------------------------------------------------------------------

import { startsWithCommand } from "./utils.js";
import type { ShellRuleDefinition } from "../types.js";

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

const rule: ShellRuleDefinition<{ MessageIds: "lsIteration" }> = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow iterating over `ls` output, which breaks on special characters",
			recommended: true,
			url: "https://github.com/eslint/shell/blob/main/docs/rules/no-ls-iteration.md",
		},
		schema: [],
		messages: {
			lsIteration:
				"Iterating over ls output is fragile. Use globs (e.g. *) instead.",
		},
	},

	create(context) {
		return {
			ForStatement(node) {
				for (const word of node.words) {
					for (const part of word.parts) {
						if (
							part.type === "CommandSubstitution" &&
							startsWithCommand(part.body, "ls")
						) {
							context.report({
								node: part,
								messageId: "lsIteration",
							});
						}
					}
				}
			},
		};
	},
};

export default rule;
