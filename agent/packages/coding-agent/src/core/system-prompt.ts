/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

const SRC_EXTENSIONS_REGEX = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|cc|h|hpp|cs|rb|php|swift|kt|scala|vue|svelte|md|json|yaml|yml|toml)$/i;
const SRC_EXTENSIONS_GLOB = "ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,cpp,cc,h,hpp,cs,rb,php,swift,kt,scala,vue,svelte,md,json,yaml,yml,toml";

interface ExtractedKeywords {
	backtickTerms: Set<string>;
	identifiers: Set<string>;
	filePaths: Set<string>;
	importPaths: Set<string>;
	errorStrings: Set<string>;
}

/**
 * Extract structured keywords from task text.
 * - backtickTerms: `foo.bar()`, `handleError` — highest confidence from task
 * - identifiers: camelCase, snake_case, PascalCase symbols
 * - filePaths: explicit file paths like src/auth/login.ts
 * - importPaths: from './foo', import { x } from 'y'
 * - errorStrings: quoted error messages
 */
function extractKeywords(taskText: string): ExtractedKeywords {
	const result: ExtractedKeywords = {
		backtickTerms: new Set(),
		identifiers: new Set(),
		filePaths: new Set(),
		importPaths: new Set(),
		errorStrings: new Set(),
	};

	// 1. Backtick-quoted terms (highest confidence from task)
	const backticks = taskText.match(/`([^`]+)`/g);
	if (backticks) {
		for (const m of backticks) {
			const term = m.slice(1, -1).trim();
			if (term.length < 3 || term.length > 120) continue;
			// Whole term if it has no spaces
			if (!term.includes(" ") && !term.includes("\n")) {
				result.backtickTerms.add(term);
			}
			// Also extract embedded identifiers from backtick terms
			const embedded = term.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,60}\b/g);
			if (embedded) for (const id of embedded) result.identifiers.add(id);
		}
	}

	// 2. File paths (src/foo/bar.ts, ./lib/auth, packages/foo/src/x.js, etc.)
	// Terminator includes `.` so sentence-end-adjacent paths still match.
	const filePathRe = /(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|cc|h|hpp|cs|rb|php|swift|kt|scala|vue|svelte|md|json|yaml|yml|toml))(?=$|[\s"'`)\],:;.])/g;
	let fpMatch: RegExpExecArray | null;
	while ((fpMatch = filePathRe.exec(taskText)) !== null) {
		const p = fpMatch[1].replace(/^\.?\//, "");
		if (p.length >= 3 && p.length <= 200) result.filePaths.add(p);
	}

	// 3. Import paths (from './foo', require('./bar'))
	const importRe = /(?:from|require|import)\s*\(?['"`]([^'"`\n]+)['"`]/g;
	let imMatch: RegExpExecArray | null;
	while ((imMatch = importRe.exec(taskText)) !== null) {
		const p = imMatch[1];
		if (p.length >= 2 && p.length <= 200) result.importPaths.add(p);
	}

	// 4. Quoted error-message strings: "something went wrong", 'xyz'
	const stringRe = /["']([^"'\n]{10,120})["']/g;
	let strMatch: RegExpExecArray | null;
	while ((strMatch = stringRe.exec(taskText)) !== null) {
		const s = strMatch[1].trim();
		// Look for error-ish strings (multi-word) but also catch enum-like values
		if (/\s/.test(s) || /^[A-Z_]{3,}$/.test(s)) {
			result.errorStrings.add(s);
		}
	}

	// 5. camelCase / PascalCase identifiers
	const camelMatches = taskText.match(/\b[a-zA-Z][a-zA-Z0-9]{2,40}\b/g);
	if (camelMatches) {
		for (const m of camelMatches) {
			if (/[a-z][A-Z]|[A-Z][a-z]/.test(m)) result.identifiers.add(m);
		}
	}

	// 6. snake_case identifiers
	const snakeMatches = taskText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g);
	if (snakeMatches) {
		for (const m of snakeMatches) {
			if (m.length >= 4) result.identifiers.add(m);
		}
	}

	// 7. SCREAMING_SNAKE_CASE constants
	const screamMatches = taskText.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g);
	if (screamMatches) {
		for (const m of screamMatches) {
			if (m.length >= 4) result.identifiers.add(m);
		}
	}

	return result;
}

/**
 * Shell-escape a string for use inside double-quoted bash argument.
 */
function shellEscape(s: string): string {
	return s.replace(/[\\"`$]/g, "\\$&");
}

/**
 * Run grep across the codebase for a set of keywords and return a Map<file, score>.
 * Score is weighted by keyword type.
 */
function grepKeywords(
	cwd: string,
	keywords: { term: string; weight: number }[],
): Map<string, number> {
	const fileScores = new Map<string, number>();
	for (const { term, weight } of keywords) {
		if (!term || term.length < 2) continue;
		const escaped = shellEscape(term);
		try {
			const result = execSync(
				`grep -rlF "${escaped}" --include="*.{${SRC_EXTENSIONS_GLOB}}" . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/.next/' | grep -v '/target/' | head -30`,
				{ cwd, timeout: 5000, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
			);
			for (const line of result.split("\n")) {
				const file = line.trim().replace(/^\.\//, "");
				if (file) fileScores.set(file, (fileScores.get(file) || 0) + weight);
			}
		} catch {
			// grep returns exit 1 on no match — ignore
		}
	}
	return fileScores;
}

/**
 * Verify and resolve file paths that were literally mentioned in the task.
 * Returns the set of paths that exist in the repo.
 */
function resolveLiteralFilePaths(cwd: string, paths: Set<string>): Set<string> {
	const resolved = new Set<string>();
	for (const p of paths) {
		try {
			const full = resolve(cwd, p);
			if (existsSync(full) && statSync(full).isFile()) {
				resolved.add(p.replace(/^\.\//, ""));
			}
		} catch {
			// ignore
		}
	}
	return resolved;
}

/**
 * Detect code style from a file's first 30 lines.
 * Returns a short description string to inject into the prompt.
 */
function detectFileStyle(cwd: string, relPath: string): string | null {
	try {
		const full = resolve(cwd, relPath);
		if (!existsSync(full)) return null;
		const content = readFileSync(full, "utf8");
		const lines = content.split("\n").slice(0, 40);
		if (lines.length === 0) return null;

		// Indentation
		let usesTabs = 0;
		let usesSpaces = 0;
		const spaceWidths = new Map<number, number>();
		for (const line of lines) {
			if (/^\t/.test(line)) usesTabs++;
			else if (/^ +/.test(line)) {
				usesSpaces++;
				const m = line.match(/^( +)/);
				if (m) {
					const w = m[1].length;
					if (w === 2 || w === 4 || w === 8) spaceWidths.set(w, (spaceWidths.get(w) || 0) + 1);
				}
			}
		}
		let indent = "unknown";
		if (usesTabs > usesSpaces) indent = "tabs";
		else if (usesSpaces > 0) {
			let maxW = 2;
			let maxC = 0;
			for (const [w, c] of spaceWidths) {
				if (c > maxC) {
					maxC = c;
					maxW = w;
				}
			}
			indent = `${maxW}-space`;
		}

		// Quote style
		const singleQuotes = (content.match(/'/g) || []).length;
		const doubleQuotes = (content.match(/"/g) || []).length;
		const backtickQuotes = (content.match(/`/g) || []).length;
		let quotes = "mixed";
		if (singleQuotes > doubleQuotes * 1.5) quotes = "single";
		else if (doubleQuotes > singleQuotes * 1.5) quotes = "double";
		else if (backtickQuotes > singleQuotes && backtickQuotes > doubleQuotes) quotes = "backtick";

		// Semicolons
		let linesWithCode = 0;
		let linesEndingSemi = 0;
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
			linesWithCode++;
			if (trimmed.endsWith(";")) linesEndingSemi++;
		}
		const semis = linesWithCode === 0 ? "unknown" : linesEndingSemi / linesWithCode > 0.3 ? "yes" : "no";

		// Trailing commas
		const trailingCommas = /,\s*[\n\r]\s*[)\]}]/.test(content) ? "yes" : "no";

		return `indent=${indent}, quotes=${quotes}, semicolons=${semis}, trailing-commas=${trailingCommas}`;
	} catch {
		return null;
	}
}

/**
 * Extract acceptance criteria bullets from a task.
 * Looks for markdown bullets, numbered lists, or "Acceptance criteria:" sections.
 */
function extractAcceptanceCriteria(taskText: string): string[] {
	const criteria: string[] = [];
	const lines = taskText.split("\n");
	let inCriteriaSection = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (/^(acceptance criteria|requirements|todo|tasks?):?\s*$/i.test(trimmed)) {
			inCriteriaSection = true;
			continue;
		}
		// Bullet patterns
		const bulletMatch = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.{5,200})/);
		if (bulletMatch) {
			criteria.push(bulletMatch[1].trim());
			continue;
		}
		// Blank line in criteria section ends it
		if (inCriteriaSection && !trimmed) {
			inCriteriaSection = false;
		}
	}
	return criteria.slice(0, 12);
}

/**
 * Main entry: build the auto-discovery prompt section.
 * Combines keyword grep, literal path resolution, style detection, and criteria extraction.
 */
function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	const kw = extractKeywords(taskText);
	if (
		kw.backtickTerms.size === 0 &&
		kw.identifiers.size === 0 &&
		kw.filePaths.size === 0 &&
		kw.errorStrings.size === 0
	) {
		return "";
	}

	// Weighted keyword grep — backtick terms and file path basenames get higher weight
	const weighted: { term: string; weight: number }[] = [];
	for (const t of kw.backtickTerms) weighted.push({ term: t, weight: 3 });
	for (const p of kw.filePaths) {
		// Grep for the basename (without extension) as a strong signal
		const base = p.split("/").pop()?.replace(/\.[^.]+$/, "");
		if (base && base.length >= 3) weighted.push({ term: base, weight: 3 });
	}
	for (const id of kw.identifiers) weighted.push({ term: id, weight: 1 });
	for (const err of kw.errorStrings) {
		if (err.length <= 80) weighted.push({ term: err, weight: 2 });
	}

	// Limit number of grep calls
	const limited = weighted.slice(0, 25);
	const fileScores = grepKeywords(cwd, limited);

	// Literal file paths mentioned in task — boost these heavily
	const literalPaths = resolveLiteralFilePaths(cwd, kw.filePaths);
	for (const p of literalPaths) {
		fileScores.set(p, (fileScores.get(p) || 0) + 10);
	}

	if (fileScores.size === 0 && literalPaths.size === 0) return "";

	const sorted = [...fileScores.entries()]
		.filter(([file]) => SRC_EXTENSIONS_REGEX.test(file))
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15);

	const sections: string[] = [];

	// Literal file paths first — most important signal
	if (literalPaths.size > 0) {
		sections.push("FILES EXPLICITLY NAMED IN THE TASK (start here):");
		for (const p of literalPaths) {
			sections.push(`- ${p}`);
		}
	}

	if (sorted.length > 0) {
		sections.push("\nLIKELY RELEVANT FILES (ranked by keyword matches):");
		for (const [file, score] of sorted) {
			sections.push(`- ${file} (score=${score})`);
		}
	}

	// Style detection for the top file
	const topFile = literalPaths.size > 0 ? [...literalPaths][0] : sorted[0]?.[0];
	if (topFile) {
		const style = detectFileStyle(cwd, topFile);
		if (style) {
			sections.push(`\nDETECTED STYLE of ${topFile}: ${style}`);
			sections.push("Your edits MUST match this style character-for-character.");
		}
	}

	// Acceptance criteria extraction
	const criteria = extractAcceptanceCriteria(taskText);
	if (criteria.length > 0) {
		sections.push(`\nACCEPTANCE CRITERIA (${criteria.length} total — address every one):`);
		criteria.forEach((c, i) => sections.push(`${i + 1}. ${c}`));
	}

	return "\n\n" + sections.join("\n") + "\n";
}

/**
 * Tau scoring preamble — prepended to every system prompt for SN66 scoring optimization.
 *
 * Architecture (tau/src/validate.py + compare.py):
 *   - Validator injects its own scoring-aware prompt via -p flag. That prompt already
 *     covers: scoring formula, "read files IN FULL", "minimal changes", "match style",
 *     "no cosmetic changes", "alphabetical order", "no tests", "when unsure leave as-is".
 *   - This preamble must NOT duplicate those rules (wastes Gemini 2.5 Flash tokens).
 *     It should ONLY contain tactics the injected prompt does not cover.
 *
 * Scoring model (tau/src/compare.py):
 *   - difflib.SequenceMatcher builds changed_sequence per file (autojunk=False).
 *   - Duel winner = whoever has more raw matched_changed_lines vs Cursor baseline.
 *   - Implication: covering MORE of Cursor's files matters more than perfect ratio.
 *     Missing a file Cursor touched = forfeit ALL matched lines for that file.
 *
 * Environment:
 *   - Model: Gemini 2.5 Flash via OpenRouter docker-proxy.
 *   - Cursor baseline: Gemini 3 Flash.
 *   - Time limit: min(2 * cursor_time + 1, 300) seconds — up to 5 minutes.
 *   - Tasks: real GitHub commits, minimum 100 changed code lines.
 *   - Container: node:20-bookworm-slim, 2GB RAM, 2 CPUs.
 */
const TAU_SCORING_PREAMBLE = `You are competing on Bittensor SN66. Your diff is compared against Cursor's diff on the same task using positional line-level exact matching. The duel winner has more raw matched_changed_lines than the opponent. Think "what would Cursor do?" — then produce exactly that diff.

SPEED:
- 40-300 seconds total. Never run tests, builds, linters, servers, or type checkers.
- Your FIRST response MUST be a tool call. Do not write text or plans before acting.
- Max 3 bash calls for file discovery. Prefer reading files directly.

THE TWO WAYS TO LOSE:
1. BLOAT — touching lines Cursor would not touch inflates your denominator.
2. MISS — not touching a file Cursor touched forfeits ALL matches for that file.
MISS is worse than BLOAT. If the task implies multiple files, edit all of them.

FILE DISCOVERY:
- The prompt may include "FILES EXPLICITLY NAMED IN THE TASK" and "LIKELY RELEVANT FILES" sections auto-discovered from task keywords. Trust those — start there.
- If files are literally named in the task text (like src/auth/login.ts), read them immediately.
- Otherwise: find . -type f -name "*.EXT" | grep -v node_modules | head -40
- Or: grep -rl "KEYWORD" --include="*.EXT" . | head -10
- After your first edit, check sibling files: ls $(dirname <path>)/ — related files often need changes too.
- If you read a file, edit it. Reading without editing wastes budget.

STYLE DETECTION (MANDATORY before editing each file):
- Read the first 30 lines. Note: indentation (tabs or N-space), quotes (single/double/backtick), semicolons (yes/no), trailing commas (yes/no), brace style, naming (camelCase/snake_case/PascalCase).
- Every edit must match ALL of these character-for-character.
- A single style mismatch on a line scores 0 for that line.
- If DETECTED STYLE is already in the prompt, trust it — do not re-detect.

EDIT DISCIPLINE:
- Use edit tool for existing files. write tool ONLY for genuinely new files (task must explicitly require a new file).
- oldText anchors: 3-5 lines, uniquely matching. Shorter anchors are more likely to be unique.
- If edit fails, re-read the file before retrying — the file may differ from what you assumed.
- If you try the SAME oldText twice, stop and re-read.
- Implement only what the task literally says. Do NOT extend logically. Do NOT add defensive code.
- Append new entries (array items, switch cases, enum values, list items) to the END of their block.
- Imports: add at the END of the existing import block, matching the style of adjacent imports.
- New functions/methods/classes: add after the last similar existing block in the file.
- No blank lines between your changes unless the surrounding code already has them.
- String literals from the task: copy verbatim. Do not paraphrase.
- Bug fixes: the minimal fix is correct. Do not add validation, error handling, type checks, or logging.

SCOPE:
- Count acceptance criteria. If the prompt includes "ACCEPTANCE CRITERIA", address every one.
- 4+ criteria almost always need 4+ edits across 2+ files.
- Reference solutions are typically 100-500 changed lines across 1-5 files.
- Do not stop after one file if the task implies multiple.
- Process files in alphabetical path order. Edit top-to-bottom within each file.

STOP CONDITIONS:
- Do not re-read files after editing to verify.
- Do not commit, do not summarize, do not explain.
- Stop immediately after the last edit. Every token after the last edit is wasted budget.

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		const discoverySection = buildTaskDiscoverySection(customPrompt, resolvedCwd);
		let prompt = TAU_SCORING_PREAMBLE + discoverySection + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = TAU_SCORING_PREAMBLE + `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
