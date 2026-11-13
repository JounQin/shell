/**
 * @fileoverview Unit tests for ShellLanguage.
 */

import { describe, expect, it } from "vitest";
import { ShellLanguage } from "./shell-language.js";
import { ShellSourceCode } from "./shell-source-code.js";
import type { File } from "@eslint/core";

function createFile(body: string): File {
	return {
		path: "test.sh",
		physicalPath: "test.sh",
		bom: false,
		body,
	};
}

describe("ShellLanguage", () => {
	const language = new ShellLanguage();

	describe("metadata", () => {
		it("should describe itself as a text language", () => {
			expect(language.fileType).toBe("text");
			expect(language.lineStart).toBe(1);
			expect(language.columnStart).toBe(1);
			expect(language.nodeTypeKey).toBe("type");
			expect(language.visitorKeys).toHaveProperty("Program");
			expect(language.defaultLanguageOptions).toEqual({});
		});
	});

	describe("constructor", () => {
		it("should accept valid modes", () => {
			expect(() => new ShellLanguage({ mode: "bash" })).not.toThrow();
			expect(() => new ShellLanguage({ mode: "posix" })).not.toThrow();
			expect(() => new ShellLanguage({ mode: "mksh" })).not.toThrow();
		});

		it("should reject unknown modes", () => {
			expect(
				() =>
					new ShellLanguage({
						// @ts-expect-error -- testing invalid input
						mode: "fish",
					}),
			).toThrow(TypeError);
		});
	});

	describe("validateLanguageOptions", () => {
		it("should accept empty language options", () => {
			expect(() => language.validateLanguageOptions()).not.toThrow();
		});
	});

	describe("parse", () => {
		it("should return ok with an AST for valid input", () => {
			const result = language.parse(createFile("echo hi\n"));

			expect(result.ok).toBe(true);

			if (result.ok) {
				expect(result.ast.type).toBe("Program");
			}
		});

		it("should return errors with location for invalid input", () => {
			const result = language.parse(createFile("echo ok\nif then fi\n"));

			expect(result.ok).toBe(false);

			if (!result.ok) {
				expect(result.errors).toHaveLength(1);
				expect(result.errors[0]?.line).toBe(2);
				expect(result.errors[0]?.column).toBeGreaterThanOrEqual(1);
				expect(result.errors[0]?.message.length).toBeGreaterThan(0);
			}
		});

		it("should parse Bash syntax by default", () => {
			const result = language.parse(
				createFile("diff <(sort a) <(sort b)\n"),
			);

			expect(result.ok).toBe(true);
		});

		it("should reject Bash-only syntax in posix mode", () => {
			const result = new ShellLanguage({ mode: "posix" }).parse(
				createFile("diff <(sort a) <(sort b)\n"),
			);

			expect(result.ok).toBe(false);
		});

		it("should accept mksh-only syntax in mksh mode", () => {
			const code = "case $x in a) echo a ;| b) echo b ;; esac\n";

			expect(language.parse(createFile(code)).ok).toBe(false);
			expect(
				new ShellLanguage({ mode: "mksh" }).parse(createFile(code)).ok,
			).toBe(true);
		});
	});

	describe("createSourceCode", () => {
		it("should create a ShellSourceCode", () => {
			const file = createFile("echo hi\n");
			const result = language.parse(file);

			expect(result.ok).toBe(true);

			if (result.ok) {
				const sourceCode = language.createSourceCode(file, {
					...result,
					comments: [],
				});

				expect(sourceCode).toBeInstanceOf(ShellSourceCode);
				expect(sourceCode.text).toBe("echo hi\n");
			}
		});
	});
});
