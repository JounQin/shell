# Shell Syntax Tree Format

`@eslint/shell` parses shell source code into an ESTree-style syntax tree by
wrapping the [sh-syntax](https://www.npmjs.com/package/sh-syntax) parser (a
WASM build of [mvdan.cc/sh](https://github.com/mvdan/sh), the parser
behind `shfmt`) and translating its output.

## Positions

Every node has three common properties:

```ts
interface ShellNodeBase {
	type: string;
	start: number; // 0-based character offset, inclusive
	end: number; // 0-based character offset, exclusive
}
```

Nodes intentionally do **not** carry `range` or `loc` properties. To get
position information, use the `SourceCode` methods:

```js
const range = sourceCode.getRange(node); // [start, end]
const loc = sourceCode.getLoc(node); // { start: { line, column }, end: ... }
```

Lines and columns are 1-based. Offsets are JavaScript character offsets
(sh-syntax's UTF-8 byte offsets are converted during translation).

### Heredoc bodies

Nodes are otherwise nested the way ESTree nodes are: a child's range sits
inside its parent's. Heredocs break that rule, because the shell splits the
construct in two. The `<<EOF` operator appears inline, but its body cannot
begin until after the newline, so the body sits somewhere the enclosing
nodes do not necessarily reach.

A `Redirect` **never** contains its own `heredoc`, because a `Redirect`
ends at its `target` -- the delimiter word, not the body:

```bash
cat <<EOF
hello
EOF
```

| Node               | Range      | Text         |
| ------------------ | ---------- | ------------ |
| `Redirect`         | `[4, 9]`   | `<<EOF`      |
| `Redirect.target`  | `[6, 9]`   | `EOF`        |
| `Redirect.heredoc` | `[10, 19]` | `hello\nEOF` |

Whether the _enclosing statement_ contains the body varies. A statement
ends where its last component ends, so the body is covered only when
nothing else on the line ends after the `<<` operator:

| Source                | Statement | Heredoc body           | Inside? |
| --------------------- | --------- | ---------------------- | ------- |
| `cat <<EOF`           | `[0, 19]` | `[10, 19]`             | yes     |
| `cat > out.txt <<EOF` | `[0, 29]` | `[20, 29]`             | yes     |
| `cat <<A <<B`         | `[0, 28]` | `[12, 19]`, `[20, 28]` | yes     |
| `cat <<EOF > out.txt` | `[0, 19]` | `[20, 29]`             | **no**  |
| `cat <<EOF \| grep x` | `[0, 18]` | `[19, 28]`             | **no**  |
| `cat <<EOF &`         | `[0, 11]` | `[12, 21]`             | **no**  |

(Each row is the snippet followed by its body on the next lines: `hello` /
`EOF`, except `<<A <<B`, which uses `first` / `A` / `second` / `B`.)

The same effect can push a node past its own parent. In
`cat <<EOF | grep x`, the `Pipeline` spans `[0, 18]` while its first
`Command` spans `[0, 28]`, because that command's range is stretched by the
body it declares.

This is deliberate. `sh-syntax` reports the body's true source position and
the translation preserves it. Stretching every statement to cover its
bodies would be worse: it would make a statement appear to span lines that
hold unrelated later statements.

Consequences for rule authors:

1. **Do not locate nodes by descending on an offset.** "Find the innermost
   node containing offset N" can miss a heredoc body entirely, since no
   ancestor is guaranteed to contain it.
2. **`getText(statement)` may not include the body.** A rule reasoning
   about a command's full text should read `redirect.heredoc` separately
   rather than slicing the statement's range.
3. **Sibling order is not source order.** In `cat <<EOF > out.txt`,
   `redirects[0]` carries a body at `[20, 29]` while `redirects[1]`
   (`> out.txt`) sits at `[10, 19]`, so walking redirects in order yields
   ranges that move backwards.
4. **Fixes need care.** A fix that rewrites a statement's range may
   silently leave the body untouched, and a fix that has to change both
   produces two disjoint ranges, which ESLint will not accept as a single
   fix.

## Statements

Every node usable in statement position also carries:

```ts
interface StatementBase extends ShellNodeBase {
	redirects: Redirect[]; // e.g. `> file`, `2>&1`, heredocs
	negated: boolean; // `! cmd`
	background: boolean; // `cmd &`
}
```

### Program

The root node. `comments` contains every comment in the file in source
order; comments are not part of the traversed tree.

```ts
interface Program extends ShellNodeBase {
	type: "Program";
	body: Statement[];
	comments: Comment[];
}

interface Comment extends ShellNodeBase {
	type: "Comment";
	text: string; // text after `#`
}
```

### Command

A simple command: optional environment assignments, a name, and arguments.
`name` is `null` for assignment-only statements (`x=1`) and redirect-only
statements (`> file`).

```ts
interface Command extends StatementBase {
	type: "Command";
	assignments: VariableAssignment[]; // `FOO=1 cmd`
	name: Word | null;
	arguments: Word[];
}
```

```bash
FOO=1 make -j4 all 2> err.log
```

### Pipeline

Pipelines are flattened: `a | b |& c` produces one `Pipeline` with three
commands. `operators[i]` sits between `commands[i]` and `commands[i + 1]`.

```ts
interface Pipeline extends StatementBase {
	type: "Pipeline";
	commands: Statement[];
	operators: ("|" | "|&")[];
}
```

### LogicalExpression

`&&` and `||` chains. Left-associative, so `a && b || c` is
`(a && b) || c`.

```ts
interface LogicalExpression extends StatementBase {
	type: "LogicalExpression";
	operator: "&&" | "||";
	left: Statement;
	right: Statement;
}
```

### Subshell and BlockStatement

```ts
interface Subshell extends StatementBase {
	type: "Subshell"; // ( ... )
	body: Statement[];
}

interface BlockStatement extends StatementBase {
	type: "BlockStatement"; // { ...; }
	body: Statement[];
}
```

### IfStatement and ElseClause

`elif` chains become nested `IfStatement`s in `alternate`; a plain `else`
becomes an `ElseClause`.

```ts
interface IfStatement extends StatementBase {
	type: "IfStatement";
	test: Statement[];
	consequent: Statement[];
	alternate: IfStatement | ElseClause | null;
}

interface ElseClause extends ShellNodeBase {
	type: "ElseClause";
	body: Statement[];
}
```

### Loops

```ts
interface WhileStatement extends StatementBase {
	type: "WhileStatement";
	test: Statement[];
	body: Statement[];
}

interface UntilStatement extends StatementBase {
	type: "UntilStatement";
	test: Statement[];
	body: Statement[];
}

// `for name in words` and `select name in words`
interface ForStatement extends StatementBase {
	type: "ForStatement";
	variable: Identifier | null;
	words: Word[]; // empty for `for name; do`
	body: Statement[];
	select: boolean; // true for `select`
}

// `for ((init; test; update))`
interface ArithmeticForStatement extends StatementBase {
	type: "ArithmeticForStatement";
	init: ArithmeticExpression | null;
	test: ArithmeticExpression | null;
	update: ArithmeticExpression | null;
	body: Statement[];
}
```

### CaseStatement and CaseClause

```ts
interface CaseStatement extends StatementBase {
	type: "CaseStatement";
	discriminant: Word;
	cases: CaseClause[];
}

interface CaseClause extends ShellNodeBase {
	type: "CaseClause";
	patterns: Word[];
	body: Statement[];
	terminator: string | null; // ";;", ";&", ";;&", ";|" (mksh), or null before `esac`
}
```

### FunctionDeclaration

Both `name() { ...; }` and `function name { ...; }` forms.

```ts
interface FunctionDeclaration extends StatementBase {
	type: "FunctionDeclaration";
	id: Identifier;
	body: Statement; // usually a BlockStatement
}
```

### TestCommand

The `[[ ... ]]` conditional. (Plain `[ ... ]` is an ordinary `Command`
named `[`.)

```ts
interface TestCommand extends StatementBase {
	type: "TestCommand";
	expression: TestExpression;
}

interface BinaryTest extends ShellNodeBase {
	type: "BinaryTest";
	operator: string; // "==", "!=", "=~", "-eq", "&&", ...
	left: TestExpression;
	right: TestExpression;
}

interface UnaryTest extends ShellNodeBase {
	type: "UnaryTest";
	operator: string; // "-f", "-n", "!", ...
	argument: TestExpression;
}

interface ParenthesizedTest extends ShellNodeBase {
	type: "ParenthesizedTest";
	expression: TestExpression;
}

type TestExpression = BinaryTest | UnaryTest | ParenthesizedTest | Word;
```

### Arithmetic commands and expressions

```ts
interface ArithmeticCommand extends StatementBase {
	type: "ArithmeticCommand"; // (( ... ))
	expression: ArithmeticExpression | null;
}

interface LetCommand extends StatementBase {
	type: "LetCommand"; // let x=1+2
	expressions: ArithmeticExpression[];
}

interface BinaryArithmetic extends ShellNodeBase {
	type: "BinaryArithmetic";
	operator: string; // "+", "<=", "=", "?", ":", ...
	left: ArithmeticExpression;
	right: ArithmeticExpression;
}

interface UnaryArithmetic extends ShellNodeBase {
	type: "UnaryArithmetic";
	operator: string; // "++", "--", "-", "!", "~", "+"
	prefix: boolean; // false for `x++`
	argument: ArithmeticExpression;
}

interface ParenthesizedArithmetic extends ShellNodeBase {
	type: "ParenthesizedArithmetic";
	expression: ArithmeticExpression;
}

type ArithmeticExpression =
	BinaryArithmetic | UnaryArithmetic | ParenthesizedArithmetic | Word; // leaf values: `x`, `1`, `$y`
```

### Other statements

```ts
interface DeclarationCommand extends StatementBase {
	type: "DeclarationCommand"; // declare/local/export/readonly/typeset/nameref
	kind: string;
	arguments: (VariableAssignment | Word)[]; // flags become Words
}

interface TimeCommand extends StatementBase {
	type: "TimeCommand";
	posix: boolean; // time -p
	body: Statement | null;
}

interface CoprocCommand extends StatementBase {
	type: "CoprocCommand";
	name: Word | null;
	body: Statement | null;
}
```

## Words

A `Word` is a sequence of parts that are concatenated after expansion.
`echo pre"mid"$x` has one word with three parts.

```ts
interface Word extends ShellNodeBase {
	type: "Word";
	parts: WordPart[];
}

type WordPart =
	| Literal
	| SingleQuotedString
	| DoubleQuotedString
	| ParameterExpansion
	| CommandSubstitution
	| ProcessSubstitution
	| ArithmeticExpansion
	| ExtendedGlob;
```

### Literal

Unquoted text, including glob characters (`*.txt`).

```ts
interface Literal extends ShellNodeBase {
	type: "Literal";
	value: string;
}
```

### Quoted strings

```ts
interface SingleQuotedString extends ShellNodeBase {
	type: "SingleQuotedString";
	value: string; // text between the quotes
	dollar: boolean; // true for $'...'
}

interface DoubleQuotedString extends ShellNodeBase {
	type: "DoubleQuotedString";
	parts: WordPart[]; // literals and expansions
	dollar: boolean; // true for $"..."
}
```

### ParameterExpansion

Covers `$name`, `${name}`, and all `${...}` operator forms. The `operator`
is the operator text exactly as written in the source.

```ts
interface ParameterExpansion extends ShellNodeBase {
	type: "ParameterExpansion";
	name: string; // "foo", "1", "@", "?", ...
	braced: boolean; // ${x} vs $x
	indirect: boolean; // ${!ref}
	lengthOf: boolean; // ${#x}
	index: ArithmeticExpression | null; // ${arr[i]}
	operator: string | null; // ":-", ":=", "##", "%", "/", "//", ":", "*", ...
	word: Word | null; // operand, e.g. default in ${x:-default}
	replacement: Word | null; // ${x/pattern/replacement}
	sliceOffset: ArithmeticExpression | null; // ${x:offset:length}
	sliceLength: ArithmeticExpression | null;
}
```

Examples:

| Source         | Key properties                                            |
| -------------- | --------------------------------------------------------- |
| `$x`           | `name: "x"`, `braced: false`                              |
| `${x}`         | `name: "x"`, `braced: true`                               |
| `${x:-def}`    | `operator: ":-"`, `word` = `def`                          |
| `${path##*/}`  | `operator: "##"`, `word` = `*/`                           |
| `${#arr}`      | `lengthOf: true`                                          |
| `${!ref}`      | `indirect: true`                                          |
| `${arr[1]}`    | `index` = `1`                                             |
| `${x/pat/rep}` | `operator: "/"`, `word` = `pat`, `replacement` = `rep`    |
| `${x:1:2}`     | `operator: ":"`, `sliceOffset` = `1`, `sliceLength` = `2` |
| `${!prefix*}`  | `operator: "*"`                                           |

### Substitutions

```ts
interface CommandSubstitution extends ShellNodeBase {
	type: "CommandSubstitution";
	body: Statement[];
	backquotes: boolean; // `...` vs $(...)
}

interface ProcessSubstitution extends ShellNodeBase {
	type: "ProcessSubstitution";
	operator: "<(" | ">(";
	body: Statement[];
}

interface ArithmeticExpansion extends ShellNodeBase {
	type: "ArithmeticExpansion"; // $(( ... ))
	expression: ArithmeticExpression | null;
}

interface ExtendedGlob extends ShellNodeBase {
	type: "ExtendedGlob"; // @(a|b), *(x), +(x), ?(x), !(x)
	operator: "@(" | "*(" | "+(" | "?(" | "!(";
	pattern: string;
}
```

## Assignments and redirects

```ts
interface VariableAssignment extends ShellNodeBase {
	type: "VariableAssignment";
	name: Identifier | null;
	index: ArithmeticExpression | null; // arr[i]=x
	value: Word | null; // null for `declare x`
	array: ArrayExpression | null; // a=(1 2 3)
	append: boolean; // x+=y
}

interface ArrayExpression extends ShellNodeBase {
	type: "ArrayExpression";
	elements: ArrayElement[];
}

interface ArrayElement extends ShellNodeBase {
	type: "ArrayElement";
	index: ArithmeticExpression | null; // ([5]=x)
	value: Word | null;
}

interface Identifier extends ShellNodeBase {
	type: "Identifier";
	name: string;
}

interface Redirect extends ShellNodeBase {
	type: "Redirect";
	operator: string; // "<", ">", ">>", "<<", "<<-", "<<<", "<&", ">&", "&>", ...
	fd: number | null; // 2 in `2>err`
	target: Word | null; // file, or heredoc delimiter for `<<`
	heredoc: Word | null; // heredoc body for `<<` and `<<-`
}
```

## Traversal

The traversal order for each node type is defined by the exported
`visitorKeys` object. Rules receive nodes by type name and may use `:exit`
suffixes:

```js
export default {
	create(context) {
		return {
			Command(node) {},
			"Program:exit"(node) {},
		};
	},
};
```
