# ESLint Shell Language Plugin

A shell language plugin for [ESLint](https://eslint.org), providing:

- an ESLint-style **parser** for shell scripts (wrapping
  [sh-syntax](https://www.npmjs.com/package/sh-syntax), the parser behind
  `shfmt`) that produces an ESTree-style syntax tree,
- an ESLint **language** implementation so rules can traverse that tree,
- **rules** inspired by [ShellCheck](https://www.shellcheck.net) checks, and
- a **recommended configuration**.

## Installation

```bash
npm install --save-dev eslint @eslint/shell
```

Requires Node.js `^20.19.0 || ^22.13.0 || >=24`. Tested with ESLint v10.

## Usage

Add the plugin to your `eslint.config.js`:

```js
import { defineConfig } from "eslint/config";
import shell from "@eslint/shell";

export default defineConfig([
	{
		// use the recommended rules for *.sh and *.bash files
		files: ["**/*.sh", "**/*.bash"],
		plugins: { shell },
		extends: ["shell/recommended"],
	},
]);
```

Or configure it manually:

```js
import { defineConfig } from "eslint/config";
import shell from "@eslint/shell";

export default defineConfig([
	{
		files: ["**/*.sh"],
		plugins: { shell },
		language: "shell/bash",
		rules: {
			"shell/no-backticks": "error",
			"shell/no-unquoted-expansions": "error",
		},
	},
]);
```

### Languages

The plugin provides one language per shell dialect:

| Language      | Description                           |
| ------------- | ------------------------------------- |
| `shell/bash`  | Bash. Used by the recommended config. |
| `shell/posix` | POSIX `sh`, without Bash extensions.  |
| `shell/mksh`  | MirBSD Korn shell.                    |

```js
import { defineConfig } from "eslint/config";
import shell from "@eslint/shell";

export default defineConfig([
	{
		files: ["**/*.sh"],
		plugins: { shell },
		extends: ["shell/recommended"],
		language: "shell/posix",
	},
]);
```

## Rules

Each rule mirrors a well-known ShellCheck check.

| Rule                                                                               | ShellCheck | Description                                             | Fixable | Recommended |
| ---------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------- | ------- | ----------- |
| [`no-backticks`](./docs/rules/no-backticks.md)                                     | SC2006     | Use `$(...)` instead of legacy backticks                | ✅      | error       |
| [`no-expansions-in-single-quotes`](./docs/rules/no-expansions-in-single-quotes.md) | SC2016     | Expressions don't expand in single quotes               |         | warn        |
| [`no-ls-iteration`](./docs/rules/no-ls-iteration.md)                               | SC2045     | Don't iterate over `ls` output; use globs               |         | error       |
| [`no-unquoted-expansions`](./docs/rules/no-unquoted-expansions.md)                 | SC2086/46  | Quote expansions subject to word splitting and globbing | ✅      | error       |
| [`no-unused-vars`](./docs/rules/no-unused-vars.md)                                 | SC2034     | Disallow variables that are assigned but never used     |         | error       |
| [`no-useless-cat`](./docs/rules/no-useless-cat.md)                                 | SC2002     | Don't pipe from a single-file `cat`                     |         | error       |
| [`no-useless-echo`](./docs/rules/no-useless-echo.md)                               | SC2116     | Disallow `$(echo ...)`                                  |         | error       |
| [`no-variables-in-printf-format`](./docs/rules/no-variables-in-printf-format.md)   | SC2059     | Don't put variables in the `printf` format string       |         | error       |
| [`require-cd-guard`](./docs/rules/require-cd-guard.md)                             | SC2164     | Handle `cd` failure with `\|\| exit` (has suggestions)  |         | error       |
| [`require-read-r`](./docs/rules/require-read-r.md)                                 | SC2162     | Use `read -r` so backslashes aren't mangled             | ✅      | error       |

### Rule options

`shell/no-unused-vars` accepts an object option:

```js
"shell/no-unused-vars": ["error", { allowed: ["MY_GLOBAL"] }]
```

## Configuration comments

Standard ESLint configuration comments work inside shell scripts:

```bash
# eslint-disable-next-line shell/no-backticks
echo `pwd`

echo `pwd` # eslint-disable-line shell/no-backticks -- legacy

# eslint shell/no-useless-echo: "warn"
```

## Syntax tree

The tree format is documented in [docs/syntax-tree.md](docs/syntax-tree.md).
Nodes carry `start`/`end` character offsets instead of `range`/`loc`
properties; use `sourceCode.getRange(node)` and `sourceCode.getLoc(node)`.

The parser is also exported directly:

```js
import { parseShell } from "@eslint/shell";

const { ast, comments } = parseShell('echo "hello"\n');
```

## Development

```bash
npm install
npm test          # unit + integration tests (Vitest)
npm run lint      # ESLint on the plugin's own sources
npm run fmt       # Prettier
npm run build     # compile TypeScript to dist/
```

Pre-commit hooks (via [yorkie](https://www.npmjs.com/package/yorkie) and
lint-staged) run Prettier and ESLint on staged files. Releases are managed
with [release-please](https://github.com/googleapis/release-please) through
GitHub Actions.

## License

Apache-2.0

<!-- NOTE: This section is autogenerated. Do not manually edit.-->
<!--sponsorsstart-->

## Sponsors

The following companies, organizations, and individuals support ESLint's ongoing maintenance and development. [Become a Sponsor](https://eslint.org/donate)
to get your logo on our READMEs and [website](https://eslint.org/sponsors).

<h3>Gold Sponsors</h3>
<p><a href="#"><img src="https://images.opencollective.com/vite-ecosystem-fund/logo.png" alt="Vite Ecosystem Fund" height="96"></a> <a href="https://forceindexer.com"><img src="https://images.opencollective.com/forceindexer/588566e/logo.png" alt="ForceIndexer" height="96"></a> <a href="https://qlty.sh/"><img src="https://images.opencollective.com/qltysh/33d157d/logo.png" alt="Qlty Software" height="96"></a> <a href="https://shopify.engineering/"><img src="https://avatars.githubusercontent.com/u/8085" alt="Shopify" height="96"></a> <a href="https://www.coderabbit.ai/?utm_source=cr_org&utm_medium=github"><img src="https://avatars.githubusercontent.com/u/132028505" alt="CodeRabbit" height="96"></a> <a href="https://automattic.com"><img src="https://avatars.githubusercontent.com/u/887802" alt="Automattic" height="96"></a></p><h3>Silver Sponsors</h3>
<p><a href="https://vite.dev/"><img src="https://images.opencollective.com/vite/d472863/logo.png" alt="Vite" height="64"></a> <a href="https://liftoff.io/"><img src="https://images.opencollective.com/liftoff/2d6c3b6/logo.png" alt="Liftoff" height="64"></a> <a href="https://stackblitz.com"><img src="https://avatars.githubusercontent.com/u/28635252" alt="StackBlitz" height="64"></a></p><h3>Bronze Sponsors</h3>
<p><a href="https://cybozu.co.jp/"><img src="https://images.opencollective.com/cybozu/933e46d/logo.png" alt="Cybozu" height="32"></a> <a href="https://opensource.sap.com"><img src="https://avatars.githubusercontent.com/u/2531208" alt="SAP" height="32"></a> <a href="https://discord.com"><img src="https://images.opencollective.com/discordapp/f9645d9/logo.png" alt="Discord" height="32"></a> <a href="https://www.gitbook.com"><img src="https://avatars.githubusercontent.com/u/7111340" alt="GitBook" height="32"></a> <a href="https://citadel-ai.com"><img src="https://avatars.githubusercontent.com/u/75781367" alt="Citadel AI" height="32"></a> <a href="https://www.testmuai.com"><img src="https://avatars.githubusercontent.com/u/171592363" alt="TestMu AI Open Source Office (Formerly LambdaTest)" height="32"></a></p>
<h3>Technology Sponsors</h3>
Technology sponsors allow us to use their products and services for free as part of a contribution to the open source ecosystem and our work.
<p><a href="https://netlify.com"><img src="https://raw.githubusercontent.com/eslint/eslint.org/main/src/assets/images/techsponsors/netlify-icon.svg" alt="Netlify" height="32"></a> <a href="https://algolia.com"><img src="https://raw.githubusercontent.com/eslint/eslint.org/main/src/assets/images/techsponsors/algolia-icon.svg" alt="Algolia" height="32"></a> <a href="https://1password.com"><img src="https://raw.githubusercontent.com/eslint/eslint.org/main/src/assets/images/techsponsors/1password-icon.svg" alt="1Password" height="32"></a></p>
<!--sponsorsend-->
