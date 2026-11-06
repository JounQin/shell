/**
 * @fileoverview Rule to flag variables that are assigned but never used.
 */

//------------------------------------------------------------------------------
// Imports
//------------------------------------------------------------------------------

import { getCommandName, getStaticText } from "./utils.js";
import type {
	ArithmeticExpressionNode,
	ShellRuleDefinition,
	IdentifierNode,
	TestExpressionNode,
	WordNode,
} from "../types.js";

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

/** Variables that are meaningful to the shell or to common external tools. */
const SPECIAL_VARIABLES = new Set([
	"BASH_ENV",
	"CDPATH",
	"EDITOR",
	"ENV",
	"GLOBIGNORE",
	"HISTCONTROL",
	"HISTFILE",
	"HISTFILESIZE",
	"HISTSIZE",
	"HOME",
	"IFS",
	"LANG",
	"LD_LIBRARY_PATH",
	"OPTARG",
	"OPTERR",
	"OPTIND",
	"PAGER",
	"PATH",
	"PROMPT_COMMAND",
	"PS1",
	"PS2",
	"PS3",
	"PS4",
	"REPLY",
	"TERM",
	"TMOUT",
	"TZ",
	"VISUAL",
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/u;

/** `read` flags that consume the following word as their argument. */
const READ_FLAGS_WITH_ARGUMENT = /^-[a-zA-Z]*[dinNptu]$/u;

/** `mapfile`/`readarray` flags that consume the following word. */
const MAPFILE_FLAGS_WITH_ARGUMENT = /^-[a-zA-Z]*[cCdnOsu]$/u;

/** Test operators whose operands are evaluated arithmetically. */
const ARITHMETIC_TEST_OPERATORS = new Set([
	"-eq",
	"-ne",
	"-lt",
	"-le",
	"-gt",
	"-ge",
]);

/** Arithmetic operators that assign to their left operand. */
const ARITHMETIC_ASSIGNMENT = /^(?:=|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\^=|\|=)$/u;

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

const rule: ShellRuleDefinition<{
	MessageIds: "unusedVariable";
	RuleOptions: [{ allowed?: string[] }?];
}> = {
	meta: {
		type: "problem",
		docs: {
			description: "Disallow variables that are assigned but never used",
			recommended: true,
			url: "https://github.com/eslint/shell/blob/main/docs/rules/no-unused-vars.md",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowed: {
						type: "array",
						items: { type: "string" },
					},
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{}],
		messages: {
			unusedVariable: "Variable '{{name}}' is assigned but never used.",
		},
	},

	create(context) {
		const [{ allowed = [] } = {}] = context.options;
		const allowedNames = new Set(allowed);
		const writes = new Map<string, IdentifierNode>();
		const reads = new Set<string>();

		// Set when the file uses constructs that can reference variables
		// dynamically (eval, source), making usage analysis unreliable.
		let unsafe = false;

		function addWrite(name: string, node: IdentifierNode): void {
			if (!writes.has(name)) {
				writes.set(name, node);
			}
		}

		function addReadableIdentifier(word: WordNode): void {
			const text = getStaticText(word);
			const match = text === null ? null : IDENTIFIER.exec(text);

			if (match) {
				reads.add(match[0]);
			}
		}

		/**
		 * Records reads/writes for bare identifiers inside arithmetic
		 * expressions, where `x` references the variable without `$`.
		 */
		function scanArithmetic(
			expression: ArithmeticExpressionNode,
			isWrite: boolean,
		): void {
			switch (expression.type) {
				case "Word": {
					const text = getStaticText(expression);
					const match = text === null ? null : IDENTIFIER.exec(text);

					if (match && match[0] === text) {
						if (isWrite) {
							const identifier: IdentifierNode = {
								type: "Identifier",
								start: expression.start,
								end: expression.end,
								name: text as string,
							};

							addWrite(text as string, identifier);
						} else {
							reads.add(match[0]);
						}
					}
					break;
				}

				case "BinaryArithmetic":
					if (ARITHMETIC_ASSIGNMENT.test(expression.operator)) {
						scanArithmetic(expression.left, true);

						// Compound assignments also read the variable.
						if (expression.operator !== "=") {
							scanArithmetic(expression.left, false);
						}
					} else {
						scanArithmetic(expression.left, false);
					}

					scanArithmetic(expression.right, false);
					break;

				case "UnaryArithmetic":
					if (
						expression.operator === "++" ||
						expression.operator === "--"
					) {
						scanArithmetic(expression.argument, true);
					}

					scanArithmetic(expression.argument, false);
					break;

				case "ParenthesizedArithmetic":
					scanArithmetic(expression.expression, false);
					break;

				// no default
			}
		}

		/**
		 * Records reads for bare identifiers used as operands of arithmetic
		 * comparisons in `[[ ... ]]`, such as `[[ x -gt 0 ]]`.
		 */
		function scanTest(expression: TestExpressionNode): void {
			switch (expression.type) {
				case "BinaryTest":
					if (ARITHMETIC_TEST_OPERATORS.has(expression.operator)) {
						for (const operand of [
							expression.left,
							expression.right,
						]) {
							if (operand.type === "Word") {
								scanArithmetic(operand, false);
							}
						}
					} else {
						scanTest(expression.left);
						scanTest(expression.right);
					}
					break;

				case "UnaryTest":
					scanTest(expression.argument);
					break;

				case "ParenthesizedTest":
					scanTest(expression.expression);
					break;

				// no default
			}
		}

		return {
			VariableAssignment(node) {
				if (node.name) {
					const parent = context.sourceCode.getParent(node);

					// Environment prefixes such as `FOO=1 cmd` are passed to
					// the command and therefore used.
					if (parent?.type === "Command" && parent.name !== null) {
						reads.add(node.name.name);
					}

					addWrite(node.name.name, node.name);
				}

				if (node.index) {
					scanArithmetic(node.index, false);
				}
			},

			ArrayElement(node) {
				if (node.index) {
					scanArithmetic(node.index, false);
				}
			},

			ParameterExpansion(node) {
				reads.add(node.name);

				for (const expression of [
					node.index,
					node.sliceOffset,
					node.sliceLength,
				]) {
					if (expression) {
						scanArithmetic(expression, false);
					}
				}
			},

			ForStatement(node) {
				if (node.variable) {
					addWrite(node.variable.name, node.variable);
				}
			},

			TestCommand(node) {
				scanTest(node.expression);
			},

			ArithmeticCommand(node) {
				if (node.expression) {
					scanArithmetic(node.expression, false);
				}
			},

			ArithmeticExpansion(node) {
				if (node.expression) {
					scanArithmetic(node.expression, false);
				}
			},

			ArithmeticForStatement(node) {
				for (const expression of [node.init, node.test, node.update]) {
					if (expression) {
						scanArithmetic(expression, false);
					}
				}
			},

			LetCommand(node) {
				for (const expression of node.expressions) {
					scanArithmetic(expression, false);
				}
			},

			DeclarationCommand(node) {
				let exported = node.kind === "export";
				let nameref = node.kind === "nameref";
				let printed = false;

				for (const argument of node.arguments) {
					if (argument.type === "Word") {
						const text = getStaticText(argument);

						if (text !== null && text.startsWith("-")) {
							if (text.includes("x")) {
								exported = true;
							}

							// `export -n` removes the export attribute
							// rather than creating a nameref.
							if (text.includes("n")) {
								if (node.kind === "export") {
									exported = false;
								} else {
									nameref = true;
								}
							}

							if (text.includes("p")) {
								printed = true;
							}
						}
					}
				}

				if (nameref) {
					unsafe = true;
				}

				for (const argument of node.arguments) {
					if (
						argument.type !== "VariableAssignment" ||
						!argument.name
					) {
						continue;
					}

					// Exported variables are visible to child processes, so
					// consider them used. Naming an existing variable in
					// `readonly x` or `declare -p x` also references it.
					if (
						exported ||
						(argument.value === null &&
							argument.array === null &&
							(node.kind === "readonly" || printed))
					) {
						reads.add(argument.name.name);
					}
				}
			},

			Command(node) {
				const name = getCommandName(node);

				switch (name) {
					case "eval":
					case "source":
					case ".":
						unsafe = true;
						break;

					case "unset":
					case "export":
					case "readonly":
						for (const argument of node.arguments) {
							addReadableIdentifier(argument);
						}
						break;

					case "getopts": {
						const variable = node.arguments[1];

						if (variable) {
							const text = getStaticText(variable);

							if (text !== null && IDENTIFIER.test(text)) {
								addWrite(text, {
									type: "Identifier",
									start: variable.start,
									end: variable.end,
									name: text,
								});
							}
						}
						break;
					}

					case "read":
					case "mapfile":
					case "readarray": {
						let skipNext = false;

						for (const argument of node.arguments) {
							if (skipNext) {
								skipNext = false;
								continue;
							}

							const text = getStaticText(argument);

							if (text === null) {
								continue;
							}

							if (text.startsWith("-")) {
								skipNext =
									name === "read"
										? READ_FLAGS_WITH_ARGUMENT.test(text)
										: MAPFILE_FLAGS_WITH_ARGUMENT.test(
												text,
											);
								continue;
							}

							if (IDENTIFIER.test(text)) {
								addWrite(text, {
									type: "Identifier",
									start: argument.start,
									end: argument.end,
									name: text,
								});
							}
						}
						break;
					}

					// no default
				}
			},

			"Program:exit"() {
				if (unsafe) {
					return;
				}

				for (const [name, identifier] of writes) {
					if (
						reads.has(name) ||
						SPECIAL_VARIABLES.has(name) ||
						name.startsWith("LC_") ||
						allowedNames.has(name) ||
						name.startsWith("_")
					) {
						continue;
					}

					context.report({
						node: identifier,
						messageId: "unusedVariable",
						data: { name },
					});
				}
			},
		};
	},
};

export default rule;
