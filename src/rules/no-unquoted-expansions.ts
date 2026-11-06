/**
 * @fileoverview Rule to require quoting expansions that undergo word
 * splitting and globbing.
 */

//------------------------------------------------------------------------------
// Imports
//------------------------------------------------------------------------------

import type { ShellRuleDefinition, WordNode } from "../types.js";
import { startsWithCommand } from "./utils.js";

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

/**
 * Parameters that always expand to values that cannot split, so quoting is
 * unnecessary.
 */
const SAFE_PARAMETERS = new Set(["?", "$", "!", "#", "-"]);

/** Heredoc-style redirect operators whose targets never word-split. */
const NON_SPLITTING_REDIRECTS = new Set(["<<", "<<-", "<<<"]);

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

const rule: ShellRuleDefinition<{
	MessageIds: "unquotedParameterExpansion" | "unquotedCommandSubstitution";
}> = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Require quoting parameter expansions and command substitutions that are subject to word splitting",
			recommended: true,
			url: "https://github.com/eslint/shell/blob/main/docs/rules/no-unquoted-expansions.md",
		},
		fixable: "code",
		schema: [],
		messages: {
			unquotedParameterExpansion:
				'Double quote "{{expansion}}" to prevent word splitting and globbing.',
			unquotedCommandSubstitution:
				"Quote this command substitution to prevent word splitting.",
		},
	},

	create(context) {
		const { sourceCode } = context;

		function checkWord(word: WordNode, isForWord = false): void {
			for (const part of word.parts) {
				if (
					part.type !== "ParameterExpansion" &&
					part.type !== "CommandSubstitution"
				) {
					continue;
				}

				if (part.type === "ParameterExpansion") {
					if (part.lengthOf || SAFE_PARAMETERS.has(part.name)) {
						continue;
					}
				}

				// Only offer a fix when the expansion is the entire word.
				const isWholeWord =
					word.parts.length === 1 &&
					word.start === part.start &&
					word.end === part.end;
				const isLsIteration =
					isForWord &&
					part.type === "CommandSubstitution" &&
					startsWithCommand(part.body, "ls");

				context.report({
					node: part,
					messageId:
						part.type === "ParameterExpansion"
							? "unquotedParameterExpansion"
							: "unquotedCommandSubstitution",
					data:
						part.type === "ParameterExpansion"
							? { expansion: sourceCode.getText(part) }
							: {},
					fix:
						isWholeWord && !isLsIteration
							? fixer =>
									fixer.replaceText(
										word,
										`"${sourceCode.getText(word)}"`,
									)
							: undefined,
				});
			}
		}

		return {
			Command(node) {
				if (node.name) {
					checkWord(node.name);
				}

				for (const argument of node.arguments) {
					checkWord(argument);
				}
			},

			ForStatement(node) {
				for (const word of node.words) {
					checkWord(word, true);
				}
			},

			Redirect(node) {
				if (
					node.target &&
					!NON_SPLITTING_REDIRECTS.has(node.operator)
				) {
					checkWord(node.target);
				}
			},
		};
	},
};

export default rule;
