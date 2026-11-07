/**
 * @fileoverview Parses shell source code into an ESTree-style syntax tree by
 * wrapping the sh-syntax parser (a WASM build of mvdan.cc/sh) and
 * translating its tree. See docs/syntax-tree.md for the tree format.
 * @author Claude Opus 5.5
 */

//------------------------------------------------------------------------------
// Imports
//------------------------------------------------------------------------------

import { LangVariant, NodeType, ParseError, Walk, parseSync } from "sh-syntax";
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

interface ShellPos {
	Offset: number;
	Line: number;
	Col: number;
}

interface ShellNode {
	Pos: ShellPos;
	End: ShellPos;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tree fields vary by node type
	[field: string]: any;
}

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

	#start(node: ShellNode): number {
		return this.#toChar(node.Pos.Offset);
	}

	#end(node: ShellNode): number {
		return this.#toChar(node.End.Offset);
	}

	/**
	 * Extracts the operator token that appears between two child nodes,
	 * e.g. the `&&` in `a && b`. Skips surrounding whitespace and any
	 * comments on either side of the operator.
	 */
	#operatorBetween(left: ShellNode, right: ShellNode): string {
		const slice = this.#text
			.slice(this.#end(left), this.#start(right))
			.replace(LEADING_TRIVIA, "");

		return slice.split(/\s+/u)[0] as string;
	}

	/**
	 * Reads the operator of a `BinaryCmd` at its recorded position.
	 *
	 * This cannot slice between the two operands the way
	 * `#operatorBetween()` does: a heredoc body extends the left operand's
	 * end past the operator, so the slice comes out empty. See the heredoc
	 * section of `docs/syntax-tree.md`.
	 */
	#binaryCommandOperator(binary: ShellNode): string {
		const opPos = binary.OpPos as ShellNode["Pos"];

		return (
			this.#operatorAt(
				this.#toChar(opPos.Offset),
				BINARY_COMMAND_OPERATOR,
			) ?? "||"
		);
	}

	/**
	 * Matches an operator pattern at a character offset.
	 */
	#operatorAt(offset: number, pattern: RegExp): string | null {
		const match = pattern.exec(this.#text.slice(offset, offset + 3));

		return match ? (match[0] as string) : null;
	}

	translateProgram(file: ShellNode): ProgramNode {
		return {
			type: "Program",
			start: 0,
			end: this.#text.length,
			body: (file.Stmts as ShellNode[]).map(stmt =>
				this.translateStatement(stmt),
			),
			comments: this.collectComments(file),
		};
	}

	collectComments(file: ShellNode): CommentNode[] {
		const comments: CommentNode[] = [];

		Walk(file, node => {
			if (node && NodeType(node) === "Comment") {
				const comment = node as ShellNode;

				comments.push({
					type: "Comment",
					start: this.#start(comment),
					end: this.#end(comment),
					text: comment.Text as string,
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
	translateStatement(stmt: ShellNode): StatementNode {
		const node = this.#translateCommand(stmt.Cmd as ShellNode | null);

		node.start = this.#start(stmt);
		node.end = this.#end(stmt);
		node.redirects = ((stmt.Redirs ?? []) as ShellNode[]).map(redirect =>
			this.translateRedirect(redirect),
		);
		node.negated = Boolean(stmt.Negated);
		node.background = Boolean(stmt.Background);

		return node;
	}

	#statementBase(node: ShellNode | null): {
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

	#translateCommand(cmd: ShellNode | null): StatementNode {
		const nodeType = cmd === null ? "nil" : NodeType(cmd);

		switch (nodeType) {
			case "nil":
				// A statement with only redirects, such as `> file`.
				return {
					type: "Command",
					...this.#statementBase(null),
					assignments: [],
					name: null,
					arguments: [],
				};

			case "CallExpr": {
				const call = cmd as ShellNode;
				const args = (call.Args as ShellNode[]).map(word =>
					this.translateWord(word),
				);

				return {
					type: "Command",
					...this.#statementBase(call),
					assignments: (call.Assigns as ShellNode[]).map(assign =>
						this.translateAssignment(assign),
					),
					name: args[0] ?? null,
					arguments: args.slice(1),
				};
			}

			case "BinaryCmd": {
				const binary = cmd as ShellNode;
				const operator = this.#binaryCommandOperator(binary);

				if (operator === "|" || operator === "|&") {
					return this.#translatePipeline(binary);
				}

				return {
					type: "LogicalExpression",
					...this.#statementBase(binary),
					operator: operator === "&&" ? "&&" : "||",
					left: this.translateStatement(binary.X as ShellNode),
					right: this.translateStatement(binary.Y as ShellNode),
				};
			}

			case "IfClause":
				return this.#translateIfClause(cmd as ShellNode);

			case "WhileClause": {
				const clause = cmd as ShellNode;
				const base = this.#statementBase(clause);
				const test = (clause.Cond as ShellNode[]).map(stmt =>
					this.translateStatement(stmt),
				);
				const body = (clause.Do as ShellNode[]).map(stmt =>
					this.translateStatement(stmt),
				);

				return clause.Until
					? { type: "UntilStatement", ...base, test, body }
					: { type: "WhileStatement", ...base, test, body };
			}

			case "ForClause": {
				const clause = cmd as ShellNode;
				const base = this.#statementBase(clause);
				const body = (clause.Do as ShellNode[]).map(stmt =>
					this.translateStatement(stmt),
				);
				const loop = clause.Loop as ShellNode;

				if (NodeType(loop) === "CStyleLoop") {
					return {
						type: "ArithmeticForStatement",
						...base,
						init: loop.Init
							? this.translateArithmetic(loop.Init as ShellNode)
							: null,
						test: loop.Cond
							? this.translateArithmetic(loop.Cond as ShellNode)
							: null,
						update: loop.Post
							? this.translateArithmetic(loop.Post as ShellNode)
							: null,
						body,
					};
				}

				return {
					type: "ForStatement",
					...base,
					variable: loop.Name
						? this.#translateIdentifier(loop.Name as ShellNode)
						: null,
					words: ((loop.Items ?? []) as ShellNode[]).map(word =>
						this.translateWord(word),
					),
					body,
					select: Boolean(clause.Select),
				};
			}

			case "CaseClause": {
				const clause = cmd as ShellNode;

				return {
					type: "CaseStatement",
					...this.#statementBase(clause),
					discriminant: this.translateWord(clause.Word as ShellNode),
					cases: (clause.Items as ShellNode[]).map(item =>
						this.#translateCaseItem(item),
					),
				};
			}

			case "Block":
				return {
					type: "BlockStatement",
					...this.#statementBase(cmd),
					body: ((cmd as ShellNode).Stmts as ShellNode[]).map(stmt =>
						this.translateStatement(stmt),
					),
				};

			case "Subshell":
				return {
					type: "Subshell",
					...this.#statementBase(cmd),
					body: ((cmd as ShellNode).Stmts as ShellNode[]).map(stmt =>
						this.translateStatement(stmt),
					),
				};

			case "FuncDecl": {
				const decl = cmd as ShellNode;

				return {
					type: "FunctionDeclaration",
					...this.#statementBase(decl),
					id: this.#translateIdentifier(decl.Name as ShellNode),
					body: this.translateStatement(decl.Body as ShellNode),
				};
			}

			case "TestClause":
				return {
					type: "TestCommand",
					...this.#statementBase(cmd),
					expression: this.translateTest(
						(cmd as ShellNode).X as ShellNode,
					),
				};

			case "ArithmCmd": {
				const arith = cmd as ShellNode;

				return {
					type: "ArithmeticCommand",
					...this.#statementBase(arith),
					expression: arith.X
						? this.translateArithmetic(arith.X as ShellNode)
						: null,
				};
			}

			case "DeclClause": {
				const decl = cmd as ShellNode;

				return {
					type: "DeclarationCommand",
					...this.#statementBase(decl),
					kind: (decl.Variant as ShellNode).Value as string,
					arguments: (decl.Args as ShellNode[]).map(assign =>
						this.#translateDeclarationArgument(assign),
					),
				};
			}

			case "TimeClause": {
				const clause = cmd as ShellNode;

				return {
					type: "TimeCommand",
					...this.#statementBase(clause),
					posix: Boolean(clause.PosixFormat),
					body: clause.Stmt
						? this.translateStatement(clause.Stmt as ShellNode)
						: null,
				};
			}

			case "CoprocClause": {
				const clause = cmd as ShellNode;

				return {
					type: "CoprocCommand",
					...this.#statementBase(clause),
					name: clause.Name
						? this.translateWord(clause.Name as ShellNode)
						: null,
					body: clause.Stmt
						? this.translateStatement(clause.Stmt as ShellNode)
						: null,
				};
			}

			case "LetClause":
				return {
					type: "LetCommand",
					...this.#statementBase(cmd),
					expressions: ((cmd as ShellNode).Exprs as ShellNode[]).map(
						expr => this.translateArithmetic(expr),
					),
				};

			default:
				throw new Error(
					`Unsupported sh-syntax node type: ${nodeType}.`,
				);
		}
	}

	#translatePipeline(binary: ShellNode): StatementNode {
		const commands: StatementNode[] = [];
		const operators: ("|" | "|&")[] = [];

		const collect = (stmt: ShellNode): void => {
			const inner = stmt.Cmd as ShellNode | null;
			const isBare =
				!stmt.Negated &&
				!stmt.Background &&
				((stmt.Redirs ?? []) as ShellNode[]).length === 0;

			if (inner !== null && isBare && NodeType(inner) === "BinaryCmd") {
				const operator = this.#binaryCommandOperator(inner);

				if (operator === "|" || operator === "|&") {
					collect(inner.X as ShellNode);
					operators.push(operator);
					commands.push(
						this.translateStatement(inner.Y as ShellNode),
					);
					return;
				}
			}

			commands.push(this.translateStatement(stmt));
		};

		const operator = this.#binaryCommandOperator(binary) as "|" | "|&";

		collect(binary.X as ShellNode);
		operators.push(operator);
		commands.push(this.translateStatement(binary.Y as ShellNode));

		return {
			type: "Pipeline",
			...this.#statementBase(binary),
			commands,
			operators,
		};
	}

	#translateIfClause(clause: ShellNode): IfStatementNode {
		let alternate: IfStatementNode | ElseClauseNode | null = null;
		const elseClause = clause.Else as ShellNode | null;

		if (elseClause) {
			if ((elseClause.Cond as ShellNode[]).length > 0) {
				alternate = this.#translateIfClause(elseClause);
			} else {
				alternate = {
					type: "ElseClause",
					start: this.#start(elseClause),
					end: this.#end(elseClause),
					body: (elseClause.Then as ShellNode[]).map(stmt =>
						this.translateStatement(stmt),
					),
				};
			}
		}

		return {
			type: "IfStatement",
			...this.#statementBase(clause),
			test: (clause.Cond as ShellNode[]).map(stmt =>
				this.translateStatement(stmt),
			),
			consequent: (clause.Then as ShellNode[]).map(stmt =>
				this.translateStatement(stmt),
			),
			alternate,
		};
	}

	#translateCaseItem(item: ShellNode): CaseClauseNode {
		const opPos = item.OpPos as ShellNode["Pos"];
		const hasTerminator = opPos.Line !== 0;

		return {
			type: "CaseClause",
			start: this.#start(item),
			end: this.#end(item),
			patterns: (item.Patterns as ShellNode[]).map(word =>
				this.translateWord(word),
			),
			body: (item.Stmts as ShellNode[]).map(stmt =>
				this.translateStatement(stmt),
			),
			terminator: hasTerminator
				? this.#operatorAt(this.#toChar(opPos.Offset), CASE_TERMINATOR)
				: null,
		};
	}

	#translateIdentifier(lit: ShellNode): IdentifierNode {
		return {
			type: "Identifier",
			start: this.#start(lit),
			end: this.#end(lit),
			name: lit.Value as string,
		};
	}

	translateAssignment(assign: ShellNode): VariableAssignmentNode {
		return {
			type: "VariableAssignment",
			start: this.#start(assign),
			end: this.#end(assign),
			name: assign.Name
				? this.#translateIdentifier(assign.Name as ShellNode)
				: null,
			index: assign.Index
				? this.translateArithmetic(assign.Index as ShellNode)
				: null,
			value: assign.Value
				? this.translateWord(assign.Value as ShellNode)
				: null,
			array: assign.Array
				? this.#translateArray(assign.Array as ShellNode)
				: null,
			append: Boolean(assign.Append),
		};
	}

	/**
	 * Declaration command arguments are all `Assign` nodes in sh-syntax;
	 * plain words such as flags (`-x`) become nameless naked assigns.
	 */
	#translateDeclarationArgument(
		assign: ShellNode,
	): VariableAssignmentNode | WordNode {
		if (!assign.Name && assign.Naked && assign.Value) {
			return this.translateWord(assign.Value as ShellNode);
		}

		return this.translateAssignment(assign);
	}

	#translateArray(array: ShellNode): ArrayExpressionNode {
		return {
			type: "ArrayExpression",
			start: this.#start(array),
			end: this.#end(array),
			elements: (array.Elems as ShellNode[]).map(
				(element): ArrayElementNode => ({
					type: "ArrayElement",
					start: this.#start(element),
					end: this.#end(element),
					index: element.Index
						? this.translateArithmetic(element.Index as ShellNode)
						: null,
					value: element.Value
						? this.translateWord(element.Value as ShellNode)
						: null,
				}),
			),
		};
	}

	translateRedirect(redirect: ShellNode): RedirectNode {
		const opPos = redirect.OpPos as ShellNode["Pos"];
		const opStart = this.#toChar(opPos.Offset);
		const operator = this.#operatorAt(opStart, REDIRECT_OPERATOR) ?? ">";
		const fdLit = redirect.N as ShellNode | null;
		const target = redirect.Word as ShellNode | null;

		return {
			type: "Redirect",
			start: fdLit ? this.#start(fdLit) : opStart,
			end: target ? this.#end(target) : opStart + operator.length,
			operator,
			fd: fdLit ? Number.parseInt(fdLit.Value as string, 10) : null,
			target: target ? this.translateWord(target) : null,
			heredoc: redirect.Hdoc
				? this.translateWord(redirect.Hdoc as ShellNode)
				: null,
		};
	}

	translateWord(word: ShellNode): WordNode {
		return {
			type: "Word",
			start: this.#start(word),
			end: this.#end(word),
			parts: (word.Parts as ShellNode[]).map(part =>
				this.translateWordPart(part),
			),
		};
	}

	translateWordPart(part: ShellNode): WordPartNode {
		const nodeType = NodeType(part);
		const start = this.#start(part);
		const end = this.#end(part);

		switch (nodeType) {
			case "Lit":
				return {
					type: "Literal",
					start,
					end,
					value: part.Value as string,
				};

			case "SglQuoted":
				return {
					type: "SingleQuotedString",
					start,
					end,
					value: part.Value as string,
					dollar: Boolean(part.Dollar),
				};

			case "DblQuoted":
				return {
					type: "DoubleQuotedString",
					start,
					end,
					parts: (part.Parts as ShellNode[]).map(inner =>
						this.translateWordPart(inner),
					),
					dollar: Boolean(part.Dollar),
				};

			case "ParamExp":
				return this.#translateParameterExpansion(part);

			case "CmdSubst":
				return {
					type: "CommandSubstitution",
					start,
					end,
					body: (part.Stmts as ShellNode[]).map(stmt =>
						this.translateStatement(stmt),
					),
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
					body: (part.Stmts as ShellNode[]).map(stmt =>
						this.translateStatement(stmt),
					),
				};

			case "ArithmExp":
				return {
					type: "ArithmeticExpansion",
					start,
					end,
					expression: part.X
						? this.translateArithmetic(part.X as ShellNode)
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
					pattern: ((part.Pattern as ShellNode)?.Value ??
						"") as string,
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

	#translateParameterExpansion(part: ShellNode): WordPartNode {
		const start = this.#start(part);
		const end = this.#end(part);
		const param = part.Param as ShellNode;
		const index = part.Index
			? this.translateArithmetic(part.Index as ShellNode)
			: null;

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

		const rbrace = part.Rbrace
			? this.#toChar((part.Rbrace as ShellNode["Pos"]).Offset)
			: end;

		if (part.Slice) {
			const slice = part.Slice as ShellNode;

			operator = ":";
			sliceOffset = slice.Offset
				? this.translateArithmetic(slice.Offset as ShellNode)
				: null;
			sliceLength = slice.Length
				? this.translateArithmetic(slice.Length as ShellNode)
				: null;
		} else if (part.Repl) {
			const repl = part.Repl as ShellNode;
			const orig = repl.Orig as ShellNode | null;
			const origWord =
				orig && (orig.Parts as ShellNode[]).length > 0
					? this.translateWord(orig)
					: null;

			operator = origWord
				? this.#text.slice(operatorStart, origWord.start).trim()
				: (repl.All as boolean)
					? "//"
					: "/";
			word = origWord;
			replacement =
				repl.With &&
				((repl.With as ShellNode).Parts as ShellNode[]).length > 0
					? this.translateWord(repl.With as ShellNode)
					: null;
		} else if (part.Exp) {
			const expansion = part.Exp as ShellNode;
			const expansionWord = expansion.Word as ShellNode | null;

			word = expansionWord ? this.translateWord(expansionWord) : null;
			operator = this.#text
				.slice(operatorStart, word ? word.start : rbrace)
				.trim();
		} else if (part.Names !== 0) {
			operator = this.#text.slice(operatorStart, rbrace).trim();
		}

		return {
			type: "ParameterExpansion",
			start,
			end,
			name: param.Value as string,
			braced: !part.Short,
			indirect: Boolean(part.Excl),
			lengthOf: Boolean(part.Length),
			index,
			operator: operator || null,
			word,
			replacement,
			sliceOffset,
			sliceLength,
		};
	}

	translateArithmetic(expr: ShellNode): ArithmeticExpressionNode {
		const nodeType = NodeType(expr);
		const start = this.#start(expr);
		const end = this.#end(expr);

		switch (nodeType) {
			case "BinaryArithm":
				return {
					type: "BinaryArithmetic",
					start,
					end,
					operator: this.#operatorBetween(
						expr.X as ShellNode,
						expr.Y as ShellNode,
					),
					left: this.translateArithmetic(expr.X as ShellNode),
					right: this.translateArithmetic(expr.Y as ShellNode),
				};

			case "UnaryArithm": {
				const opPos = expr.OpPos as ShellNode["Pos"];

				return {
					type: "UnaryArithmetic",
					start,
					end,
					operator:
						this.#operatorAt(
							this.#toChar(opPos.Offset),
							UNARY_ARITHMETIC_OPERATOR,
						) ?? "+",
					prefix: !expr.Post,
					argument: this.translateArithmetic(expr.X as ShellNode),
				};
			}

			case "ParenArithm":
				return {
					type: "ParenthesizedArithmetic",
					start,
					end,
					expression: this.translateArithmetic(expr.X as ShellNode),
				};

			default:
				return this.translateWord(expr);
		}
	}

	translateTest(expr: ShellNode): TestExpressionNode {
		const nodeType = NodeType(expr);
		const start = this.#start(expr);
		const end = this.#end(expr);

		switch (nodeType) {
			case "BinaryTest":
				return {
					type: "BinaryTest",
					start,
					end,
					operator: this.#operatorBetween(
						expr.X as ShellNode,
						expr.Y as ShellNode,
					),
					left: this.translateTest(expr.X as ShellNode),
					right: this.translateTest(expr.Y as ShellNode),
				};

			case "UnaryTest": {
				const opPos = expr.OpPos as ShellNode["Pos"];
				const opStart = this.#toChar(opPos.Offset);
				const match = /^\S+/u.exec(this.#text.slice(opStart));

				return {
					type: "UnaryTest",
					start,
					end,
					operator: match ? (match[0] as string) : "!",
					argument: this.translateTest(expr.X as ShellNode),
				};
			}

			case "ParenTest":
				return {
					type: "ParenthesizedTest",
					start,
					end,
					expression: this.translateTest(expr.X as ShellNode),
				};

			default:
				return this.translateWord(expr);
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

	let file: ShellNode;

	try {
		file = parseSync(text, {
			keepComments: true,
			variant,
			filepath: options.path ?? "<input>",
		}) as ShellNode;
	} catch (error) {
		if (error instanceof ParseError) {
			const byteOffset = error.Pos?.Offset ?? 0;
			const offset = createByteToCharConverter(text)(byteOffset);
			const { line, column } = locate(text, offset);

			throw new ShellSyntaxError(
				error.Text || error.message,
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
