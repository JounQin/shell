/**
 * @fileoverview Parses shell source code into an ESTree-style syntax tree by
 * wrapping the sh-syntax parser (a WASM build of mvdan.cc/sh) and
 * translating its tree. See docs/syntax-tree.md for the tree format.
 * @author Claude Opus 5.5
 */

//------------------------------------------------------------------------------
// Imports
//------------------------------------------------------------------------------

import { LangVariant, ParseError, parseSync, walk } from "sh-syntax";
import type {
	ArithmExpr,
	Assign,
	ArrayExpr,
	CaseItem,
	Command,
	File,
	IfClause,
	Lit,
	Node,
	ParamExp,
	Redirect,
	Stmt,
	TestExpr,
	Word,
	WordPart,
} from "sh-syntax";
import type {
	ArithmeticExpressionNode,
	ArrayElementNode,
	ArrayExpressionNode,
	ShellVariant,
	CaseClauseNode,
	CommentNode,
	IdentifierNode,
	IfStatementNode,
	ElseClauseNode,
	ProgramNode,
	RedirectNode,
	StatementNode,
	TestExpressionNode,
	VariableAssignmentNode,
	WordNode,
	WordPartNode,
} from "../types.js";

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

type NodeOf<T extends Node["type"]> = Extract<Node, { type: T }>;

const required = <T>(value: T | null, field: string): T => {
	if (value === null) {
		throw new TypeError(`Missing sh-syntax field ${field}.`);
	}

	return value;
};

const REDIRECT_OPERATOR = /^(?:&>>|&>|>\||>>|>&|<<<|<<-|<<|<&|<>|<|>)/u;
const UNARY_ARITHMETIC_OPERATOR = /^(?:\+\+|--|[-+!~])/u;
const PROCESS_SUBSTITUTION_OPERATOR = /^[<>]\(/u;
const EXTENDED_GLOB_OPERATOR = /^[?*+@!]\(/u;
const BINARY_COMMAND_OPERATOR = /^(?:\|&|\|\||&&|\|)/u;
const CASE_TERMINATOR = /^(?:;;&|;;|;&|;\|)/u;
const LEADING_TRIVIA = /^(?:\s|#.*)*/u;
// eslint-disable-next-line no-control-regex -- intentionally matches the full ASCII range.
const NON_ASCII = /[^\x00-\x7f]/u;

const VARIANTS = new Map<ShellVariant, LangVariant>([
	["bash", LangVariant.LangBash],
	["posix", LangVariant.LangPOSIX],
	["mksh", LangVariant.LangMirBSDKorn],
]);

/**
 * The error thrown when shell source code cannot be parsed.
 */
export class ShellSyntaxError extends SyntaxError {
	line: number;
	column: number;

	/** The file path passed to the parser, when there was one. */
	path: string | undefined;

	constructor(message: string, line: number, column: number, path?: string) {
		super(message);
		this.name = "ShellSyntaxError";
		this.line = line;
		this.column = column;
		this.path = path;
	}
}

export interface ShellParseOptions {
	/** The shell dialect to parse. Defaults to `"bash"`. */
	variant?: ShellVariant;

	/** The file path reported as `ShellSyntaxError#path` on syntax errors. */
	path?: string;
}

export interface ShellParseResult {
	ast: ProgramNode;
	comments: CommentNode[];
}

/**
 * Creates a converter from sh-syntax byte offsets to JavaScript character
 * offsets. sh-syntax reports positions as UTF-8 byte offsets, which only
 * match string indexes for ASCII-only sources.
 */
function createByteToCharConverter(text: string): (byte: number) => number {
	if (!NON_ASCII.test(text)) {
		return byte => byte;
	}

	const map: number[] = [];
	let charIndex = 0;

	for (const char of text) {
		const codePoint = char.codePointAt(0) as number;
		const byteLength =
			codePoint <= 0x7f
				? 1
				: codePoint <= 0x7ff
					? 2
					: codePoint <= 0xffff
						? 3
						: 4;

		for (let i = 0; i < byteLength; i++) {
			map.push(charIndex);
		}

		charIndex += char.length;
	}

	map.push(charIndex);

	return byte => map[Math.min(byte, map.length - 1)] as number;
}

/**
 * Computes a 1-based line and column pair for a character offset.
 */
function locate(
	text: string,
	offset: number,
): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;

	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === "\n") {
			line++;
			lineStart = i + 1;
		}
	}

	return { line, column: offset - lineStart + 1 };
}

//------------------------------------------------------------------------------
// Translator
//------------------------------------------------------------------------------

/**
 * Translates a sh-syntax tree into the ESTree-style tree documented
 * in docs/syntax-tree.md.
 */
class Translator {
	#text: string;
	#toChar: (byte: number) => number;

	constructor(text: string) {
		this.#text = text;
		this.#toChar = createByteToCharConverter(text);
	}

	#start(node: Node): number {
		return this.#toChar(node.start);
	}

	#end(node: Node): number {
		return this.#toChar(node.end);
	}

	/**
	 * Extracts the operator token that appears between two child nodes,
	 * e.g. the `&&` in `a && b`. Skips surrounding whitespace and any
	 * comments on either side of the operator.
	 */
	#operatorBetween(left: Node, right: Node): string {
		const slice = this.#text
			.slice(this.#end(left), this.#start(right))
			.replace(LEADING_TRIVIA, "");

		return slice.split(/\s+/u)[0] ?? "";
	}

	/**
	 * Reads the operator of a `BinaryCmd` at its recorded position.
	 *
	 * This cannot slice between the two operands the way
	 * `#operatorBetween()` does: a heredoc body extends the left operand's
	 * end past the operator, so the slice comes out empty. See the heredoc
	 * section of `docs/syntax-tree.md`.
	 */
	#binaryCommandOperator(binary: NodeOf<"BinaryCmd">): string {
		const opPos = binary.opPos;

		return (
			this.#operatorAt(
				this.#toChar(opPos.offset),
				BINARY_COMMAND_OPERATOR,
			) ?? "||"
		);
	}

	/**
	 * Matches an operator pattern at a character offset.
	 */
	#operatorAt(offset: number, pattern: RegExp): string | null {
		const match = pattern.exec(this.#text.slice(offset, offset + 3));

		return match ? match[0] : null;
	}

	translateProgram(file: File): ProgramNode {
		return {
			type: "Program",
			start: 0,
			end: this.#text.length,
			body: file.stmts.map(stmt => this.translateStatement(stmt)),
			comments: this.collectComments(file),
		};
	}

	collectComments(file: File): CommentNode[] {
		const comments: CommentNode[] = [];

		walk(file, node => {
			if (node.type === "Comment") {
				const comment = node;

				comments.push({
					type: "Comment",
					start: this.#start(comment),
					end: this.#end(comment),
					text: comment.text,
				});
			}

			return true;
		});

		comments.sort((a, b) => a.start - b.start);

		return comments;
	}

	/**
	 * Translates a `Stmt`, folding its statement-level properties
	 * (redirects, negation, background) into the command node.
	 */
	translateStatement(stmt: Stmt): StatementNode {
		const node = this.#translateCommand(stmt.cmd);

		node.start = this.#start(stmt);
		node.end = this.#end(stmt);
		node.redirects = (stmt.redirs ?? []).map(redirect =>
			this.translateRedirect(redirect),
		);
		node.negated = Boolean(stmt.negated);
		node.background = Boolean(stmt.background);

		return node;
	}

	#statementBase(node: Node | null): {
		start: number;
		end: number;
		redirects: RedirectNode[];
		negated: boolean;
		background: boolean;
	} {
		return {
			start: node ? this.#start(node) : 0,
			end: node ? this.#end(node) : 0,
			redirects: [],
			negated: false,
			background: false,
		};
	}

	#translateCommand(cmd: Command | null): StatementNode {
		if (cmd === null) {
			// A statement with only redirects, such as `> file`.
			return {
				type: "Command",
				...this.#statementBase(null),
				assignments: [],
				name: null,
				arguments: [],
			};
		}

		switch (cmd.type) {
			case "CallExpr": {
				const call = cmd;
				const args = call.args.map(word => this.translateWord(word));

				return {
					type: "Command",
					...this.#statementBase(call),
					assignments: call.assigns.map(assign =>
						this.translateAssignment(assign),
					),
					name: args[0] ?? null,
					arguments: args.slice(1),
				};
			}

			case "BinaryCmd": {
				const binary = cmd;
				const operator = this.#binaryCommandOperator(binary);

				if (operator === "|" || operator === "|&") {
					return this.#translatePipeline(binary);
				}

				return {
					type: "LogicalExpression",
					...this.#statementBase(binary),
					operator: operator === "&&" ? "&&" : "||",
					left: this.translateStatement(
						required(binary.x, "BinaryCmd.x"),
					),
					right: this.translateStatement(
						required(binary.y, "BinaryCmd.y"),
					),
				};
			}

			case "IfClause":
				return this.#translateIfClause(cmd);

			case "WhileClause": {
				const clause = cmd;
				const base = this.#statementBase(clause);
				const test = clause.cond.map(stmt =>
					this.translateStatement(stmt),
				);
				const body = clause.do.map(stmt =>
					this.translateStatement(stmt),
				);

				return clause.until
					? { type: "UntilStatement", ...base, test, body }
					: { type: "WhileStatement", ...base, test, body };
			}

			case "ForClause": {
				const clause = cmd;
				const base = this.#statementBase(clause);
				const body = clause.do.map(stmt =>
					this.translateStatement(stmt),
				);
				const loop = required(clause.loop, "ForClause.loop");

				if (loop.type === "CStyleLoop") {
					return {
						type: "ArithmeticForStatement",
						...base,
						init: loop.init
							? this.translateArithmetic(loop.init)
							: null,
						test: loop.cond
							? this.translateArithmetic(loop.cond)
							: null,
						update: loop.post
							? this.translateArithmetic(loop.post)
							: null,
						body,
					};
				}

				return {
					type: "ForStatement",
					...base,
					variable: loop.name
						? this.#translateIdentifier(loop.name)
						: null,
					words: (loop.items ?? []).map(word =>
						this.translateWord(word),
					),
					body,
					select: Boolean(clause.select),
				};
			}

			case "CaseClause": {
				const clause = cmd;

				return {
					type: "CaseStatement",
					...this.#statementBase(clause),
					discriminant: this.translateWord(
						required(clause.word, "CaseClause.word"),
					),
					cases: clause.items.map(item =>
						this.#translateCaseItem(item),
					),
				};
			}

			case "Block":
				return {
					type: "BlockStatement",
					...this.#statementBase(cmd),
					body: cmd.stmts.map(stmt => this.translateStatement(stmt)),
				};

			case "Subshell":
				return {
					type: "Subshell",
					...this.#statementBase(cmd),
					body: cmd.stmts.map(stmt => this.translateStatement(stmt)),
				};

			case "FuncDecl": {
				const decl = cmd;

				return {
					type: "FunctionDeclaration",
					...this.#statementBase(decl),
					id: this.#translateIdentifier(
						required(decl.name, "FuncDecl.name"),
					),
					body: this.translateStatement(
						required(decl.body, "FuncDecl.body"),
					),
				};
			}

			case "TestClause":
				return {
					type: "TestCommand",
					...this.#statementBase(cmd),
					expression: this.translateTest(
						required(cmd.x, "TestClause.x"),
					),
				};

			case "ArithmCmd": {
				const arith = cmd;

				return {
					type: "ArithmeticCommand",
					...this.#statementBase(arith),
					expression: arith.x
						? this.translateArithmetic(arith.x)
						: null,
				};
			}

			case "DeclClause": {
				const decl = cmd;

				return {
					type: "DeclarationCommand",
					...this.#statementBase(decl),
					kind: required(decl.variant, "DeclClause.variant").value,
					arguments: decl.args.map(assign =>
						this.#translateDeclarationArgument(assign),
					),
				};
			}

			case "TimeClause": {
				const clause = cmd;

				return {
					type: "TimeCommand",
					...this.#statementBase(clause),
					posix: Boolean(clause.posixFormat),
					body: clause.stmt
						? this.translateStatement(clause.stmt)
						: null,
				};
			}

			case "CoprocClause": {
				const clause = cmd;

				return {
					type: "CoprocCommand",
					...this.#statementBase(clause),
					name: clause.name ? this.translateWord(clause.name) : null,
					body: clause.stmt
						? this.translateStatement(clause.stmt)
						: null,
				};
			}

			case "LetClause":
				return {
					type: "LetCommand",
					...this.#statementBase(cmd),
					expressions: cmd.exprs.map(expr =>
						this.translateArithmetic(expr),
					),
				};

			default:
				throw new Error(
					`Unsupported sh-syntax node type: ${cmd.type}.`,
				);
		}
	}

	#translatePipeline(binary: NodeOf<"BinaryCmd">): StatementNode {
		const commands: StatementNode[] = [];
		const operators: ("|" | "|&")[] = [];

		const collect = (stmt: Stmt): void => {
			const inner = stmt.cmd;
			const isBare =
				!stmt.negated &&
				!stmt.background &&
				(stmt.redirs ?? []).length === 0;

			if (inner !== null && isBare && inner.type === "BinaryCmd") {
				const operator = this.#binaryCommandOperator(inner);

				if (operator === "|" || operator === "|&") {
					collect(required(inner.x, "BinaryCmd.x"));
					operators.push(operator);
					commands.push(
						this.translateStatement(
							required(inner.y, "BinaryCmd.y"),
						),
					);
					return;
				}
			}

			commands.push(this.translateStatement(stmt));
		};

		const operator = this.#binaryCommandOperator(binary) as "|" | "|&";

		collect(required(binary.x, "BinaryCmd.x"));
		operators.push(operator);
		commands.push(
			this.translateStatement(required(binary.y, "BinaryCmd.y")),
		);

		return {
			type: "Pipeline",
			...this.#statementBase(binary),
			commands,
			operators,
		};
	}

	#translateIfClause(clause: IfClause): IfStatementNode {
		let alternate: IfStatementNode | ElseClauseNode | null = null;
		const elseClause = clause.else;

		if (elseClause) {
			if (elseClause.cond.length > 0) {
				alternate = this.#translateIfClause(elseClause);
			} else {
				alternate = {
					type: "ElseClause",
					start: this.#start(elseClause),
					end: this.#end(elseClause),
					body: elseClause.then.map(stmt =>
						this.translateStatement(stmt),
					),
				};
			}
		}

		return {
			type: "IfStatement",
			...this.#statementBase(clause),
			test: clause.cond.map(stmt => this.translateStatement(stmt)),
			consequent: clause.then.map(stmt => this.translateStatement(stmt)),
			alternate,
		};
	}

	#translateCaseItem(item: CaseItem): CaseClauseNode {
		const opPos = item.opPos;
		const hasTerminator = opPos.line !== 0;

		return {
			type: "CaseClause",
			start: this.#start(item),
			end: this.#end(item),
			patterns: item.patterns.map(word => this.translateWord(word)),
			body: item.stmts.map(stmt => this.translateStatement(stmt)),
			terminator: hasTerminator
				? this.#operatorAt(this.#toChar(opPos.offset), CASE_TERMINATOR)
				: null,
		};
	}

	#translateIdentifier(lit: Lit): IdentifierNode {
		return {
			type: "Identifier",
			start: this.#start(lit),
			end: this.#end(lit),
			name: lit.value,
		};
	}

	translateAssignment(assign: Assign): VariableAssignmentNode {
		return {
			type: "VariableAssignment",
			start: this.#start(assign),
			end: this.#end(assign),
			name: assign.name ? this.#translateIdentifier(assign.name) : null,
			index: assign.index ? this.translateArithmetic(assign.index) : null,
			value: assign.value ? this.translateWord(assign.value) : null,
			array: assign.array ? this.#translateArray(assign.array) : null,
			append: Boolean(assign.append),
		};
	}

	/**
	 * Declaration command arguments are all `Assign` nodes in sh-syntax;
	 * plain words such as flags (`-x`) become nameless naked assigns.
	 */
	#translateDeclarationArgument(
		assign: Assign,
	): VariableAssignmentNode | WordNode {
		if (!assign.name && assign.naked && assign.value) {
			return this.translateWord(assign.value);
		}

		return this.translateAssignment(assign);
	}

	#translateArray(array: ArrayExpr): ArrayExpressionNode {
		return {
			type: "ArrayExpression",
			start: this.#start(array),
			end: this.#end(array),
			elements: array.elems.map((element): ArrayElementNode => ({
				type: "ArrayElement",
				start: this.#start(element),
				end: this.#end(element),
				index: element.index
					? this.translateArithmetic(element.index)
					: null,
				value: element.value ? this.translateWord(element.value) : null,
			})),
		};
	}

	translateRedirect(redirect: Redirect): RedirectNode {
		const opPos = redirect.opPos;
		const opStart = this.#toChar(opPos.offset);
		const operator = this.#operatorAt(opStart, REDIRECT_OPERATOR) ?? ">";
		const fdLit = redirect.n;
		const target = redirect.word;

		return {
			type: "Redirect",
			start: fdLit ? this.#start(fdLit) : opStart,
			end: target ? this.#end(target) : opStart + operator.length,
			operator,
			fd: fdLit ? Number.parseInt(fdLit.value, 10) : null,
			target: target ? this.translateWord(target) : null,
			heredoc: redirect.hdoc ? this.translateWord(redirect.hdoc) : null,
		};
	}

	translateWord(word: Word): WordNode {
		return {
			type: "Word",
			start: this.#start(word),
			end: this.#end(word),
			parts: word.parts.map(part => this.translateWordPart(part)),
		};
	}

	translateWordPart(part: WordPart): WordPartNode {
		const start = this.#start(part);
		const end = this.#end(part);

		switch (part.type) {
			case "Lit":
				return {
					type: "Literal",
					start,
					end,
					value: part.value,
				};

			case "SglQuoted":
				return {
					type: "SingleQuotedString",
					start,
					end,
					value: part.value as string,
					dollar: Boolean(part.dollar),
				};

			case "DblQuoted":
				return {
					type: "DoubleQuotedString",
					start,
					end,
					parts: part.parts.map(inner =>
						this.translateWordPart(inner),
					),
					dollar: Boolean(part.dollar),
				};

			case "ParamExp":
				return this.#translateParameterExpansion(part);

			case "CmdSubst":
				return {
					type: "CommandSubstitution",
					start,
					end,
					body: part.stmts.map(stmt => this.translateStatement(stmt)),
					backquotes: this.#text[start] === "`",
				};

			case "ProcSubst":
				return {
					type: "ProcessSubstitution",
					start,
					end,
					operator:
						(this.#operatorAt(
							start,
							PROCESS_SUBSTITUTION_OPERATOR,
						) as "<(" | ">(") ?? "<(",
					body: part.stmts.map(stmt => this.translateStatement(stmt)),
				};

			case "ArithmExp":
				return {
					type: "ArithmeticExpansion",
					start,
					end,
					expression: part.x
						? this.translateArithmetic(part.x)
						: null,
				};

			case "ExtGlob":
				return {
					type: "ExtendedGlob",
					start,
					end,
					operator:
						(this.#operatorAt(start, EXTENDED_GLOB_OPERATOR) as
							"@(" | "*(" | "+(" | "?(" | "!(") ?? "@(",
					pattern: (part.pattern?.value ?? "") as string,
				};

			default:
				// Unknown word parts (e.g. BraceExp when enabled) degrade to
				// literals covering their source text.
				return {
					type: "Literal",
					start,
					end,
					value: this.#text.slice(start, end),
				};
		}
	}

	#translateParameterExpansion(part: ParamExp): WordPartNode {
		const start = this.#start(part);
		const end = this.#end(part);
		const param = required(part.param, "ParamExp.param");
		const index = part.index ? this.translateArithmetic(part.index) : null;

		let operator: string | null = null;
		let word: WordNode | null = null;
		let replacement: WordNode | null = null;
		let sliceOffset: ArithmeticExpressionNode | null = null;
		let sliceLength: ArithmeticExpressionNode | null = null;

		// Character offset where an operator would begin: after the
		// parameter name, or after the `]` that closes a subscript.
		let operatorStart = this.#end(param);

		if (index) {
			const bracket = this.#text.indexOf("]", index.end);

			operatorStart = bracket === -1 ? index.end : bracket + 1;
		}

		const rbrace = part.rbrace ? this.#toChar(part.rbrace.offset) : end;

		if (part.slice) {
			const slice = part.slice;

			operator = ":";
			sliceOffset = slice.offset
				? this.translateArithmetic(slice.offset)
				: null;
			sliceLength = slice.length
				? this.translateArithmetic(slice.length)
				: null;
		} else if (part.repl) {
			const repl = part.repl;
			const orig = repl.orig;
			const origWord =
				orig && orig.parts.length > 0 ? this.translateWord(orig) : null;

			operator = origWord
				? this.#text.slice(operatorStart, origWord.start).trim()
				: repl.all
					? "//"
					: "/";
			word = origWord;
			replacement =
				repl.with && repl.with.parts.length > 0
					? this.translateWord(repl.with)
					: null;
		} else if (part.exp) {
			const expansion = part.exp;
			const expansionWord = expansion.word;

			word = expansionWord ? this.translateWord(expansionWord) : null;
			operator = this.#text
				.slice(operatorStart, word ? word.start : rbrace)
				.trim();
		} else if (part.names !== 0) {
			operator = this.#text.slice(operatorStart, rbrace).trim();
		}

		return {
			type: "ParameterExpansion",
			start,
			end,
			name: param.value,
			braced: !part.short,
			indirect: Boolean(part.excl),
			lengthOf: Boolean(part.length),
			index,
			operator: operator || null,
			word,
			replacement,
			sliceOffset,
			sliceLength,
		};
	}

	translateArithmetic(expr: ArithmExpr): ArithmeticExpressionNode {
		const start = this.#start(expr);
		const end = this.#end(expr);

		switch (expr.type) {
			case "BinaryArithm":
				return {
					type: "BinaryArithmetic",
					start,
					end,
					operator: this.#operatorBetween(
						required(expr.x, "BinaryArithm.x"),
						required(expr.y, "BinaryArithm.y"),
					),
					left: this.translateArithmetic(
						required(expr.x, "ArithmExpr.x"),
					),
					right: this.translateArithmetic(
						required(expr.y, "ArithmExpr.y"),
					),
				};

			case "UnaryArithm": {
				const opPos = expr.opPos;

				return {
					type: "UnaryArithmetic",
					start,
					end,
					operator:
						this.#operatorAt(
							this.#toChar(opPos.offset),
							UNARY_ARITHMETIC_OPERATOR,
						) ?? "+",
					prefix: !expr.post,
					argument: this.translateArithmetic(
						required(expr.x, "UnaryArithm.x"),
					),
				};
			}

			case "ParenArithm":
				return {
					type: "ParenthesizedArithmetic",
					start,
					end,
					expression: this.translateArithmetic(
						required(expr.x, "ParenArithm.x"),
					),
				};

			default:
				return this.translateWord(expr as Word);
		}
	}

	translateTest(expr: TestExpr): TestExpressionNode {
		const start = this.#start(expr);
		const end = this.#end(expr);

		switch (expr.type) {
			case "BinaryTest":
				return {
					type: "BinaryTest",
					start,
					end,
					operator: this.#operatorBetween(
						required(expr.x, "BinaryTest.x"),
						required(expr.y, "BinaryTest.y"),
					),
					left: this.translateTest(required(expr.x, "TestExpr.x")),
					right: this.translateTest(required(expr.y, "TestExpr.y")),
				};

			case "UnaryTest": {
				const opPos = expr.opPos;
				const opStart = this.#toChar(opPos.offset);
				const match = /^\S+/u.exec(this.#text.slice(opStart));

				return {
					type: "UnaryTest",
					start,
					end,
					operator: match ? (match[0] as string) : "!",
					argument: this.translateTest(
						required(expr.x, "UnaryTest.x"),
					),
				};
			}

			case "ParenTest":
				return {
					type: "ParenthesizedTest",
					start,
					end,
					expression: this.translateTest(
						required(expr.x, "ParenTest.x"),
					),
				};

			default:
				return this.translateWord(expr as Word);
		}
	}
}

//------------------------------------------------------------------------------
// Public API
//------------------------------------------------------------------------------

/**
 * Parses shell source code into an ESTree-style syntax tree.
 * @throws {ShellSyntaxError} When the source code contains a syntax error.
 */
export function parseShell(
	text: string,
	options: ShellParseOptions = {},
): ShellParseResult {
	const variant = VARIANTS.get(options.variant ?? "bash");

	if (variant === undefined) {
		throw new TypeError(
			`Unknown shell variant "${options.variant}". Expected "bash", "posix", or "mksh".`,
		);
	}

	let file: File;

	try {
		file = parseSync(text, {
			keepComments: true,
			variant,
			filepath: options.path ?? "<input>",
		});
	} catch (error) {
		if (error instanceof ParseError) {
			const byteOffset = error.pos?.offset ?? 0;
			const offset = createByteToCharConverter(text)(byteOffset);
			const { line, column } = locate(text, offset);

			throw new ShellSyntaxError(
				error.text || error.message,
				line,
				column,
				options.path,
			);
		}

		throw error;
	}

	const translator = new Translator(text);
	const ast = translator.translateProgram(file);

	return { ast, comments: ast.comments };
}
