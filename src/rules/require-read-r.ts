/**
 * @fileoverview Rule to require the `-r` flag when using `read`.
 */

//------------------------------------------------------------------------------
// Imports
//------------------------------------------------------------------------------

import { getCommandName, getStaticText } from "./utils.js";
import type { ShellRuleDefinition } from "../types.js";

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

const optionsWithArguments = new Set(["a", "d", "i", "n", "N", "p", "t", "u"]);

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

const rule: ShellRuleDefinition<{ MessageIds: "missingR" }> = {
	meta: {
		type: "problem",
		docs: {
			description: "Require `read -r` so backslashes are not mangled",
			recommended: true,
			url: "https://github.com/eslint/shell/blob/main/docs/rules/require-read-r.md",
		},
		fixable: "code",
		schema: [],
		messages: {
			missingR: "Using read without -r will mangle backslashes.",
		},
	},

	create(context) {
		return {
			Command(node) {
				if (getCommandName(node) !== "read" || !node.name) {
					return;
				}

				let hasRawOption = false;

				for (let index = 0; index < node.arguments.length; index++) {
					const argument = node.arguments[index];
					if (!argument) {
						continue;
					}

					const text = getStaticText(argument);
					if (text === "--") {
						break;
					}

					if (
						text === null ||
						!text.startsWith("-") ||
						text === "-"
					) {
						continue;
					}

					for (
						let optionIndex = 1;
						optionIndex < text.length;
						optionIndex++
					) {
						const option = text[optionIndex];
						if (!option) {
							break;
						}

						if (option === "r") {
							hasRawOption = true;
							break;
						}

						if (optionsWithArguments.has(option)) {
							if (optionIndex === text.length - 1) {
								index++;
							}

							break;
						}
					}

					if (hasRawOption) {
						break;
					}
				}

				if (hasRawOption) {
					return;
				}

				const name = node.name;

				context.report({
					node: name,
					messageId: "missingR",
					fix: fixer => fixer.insertTextAfter(name, " -r"),
				});
			},
		};
	},
};

export default rule;
