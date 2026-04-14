/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

// Common English stop words to filter out of keyword extraction
const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"should",
	"must",
	"when",
	"each",
	"into",
	"also",
	"have",
	"been",
	"will",
	"they",
	"them",
	"their",
	"there",
	"which",
	"what",
	"where",
	"while",
	"would",
	"could",
	"these",
	"those",
	"then",
	"than",
	"some",
	"more",
	"other",
	"only",
	"just",
	"like",
	"such",
	"make",
	"made",
	"does",
	"doing",
	"being",
]);

/**
 * Count acceptance criteria bullets in a task description.
 */
function countAcceptanceCriteria(taskText: string): number {
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (!section) {
		// Fallback: count top-level bullets anywhere
		const allBullets = taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		return allBullets ? Math.min(allBullets.length, 20) : 0;
	}
	const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
	return bullets ? bullets.length : 0;
}

/**
 * Extract file-like names from backticks (e.g. `foo.ts`).
 */
function extractNamedFiles(taskText: string): string[] {
	const matches = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	return [...new Set(matches.map((f) => f.replace(/`/g, "").trim()))];
}

/**
 * Detect code style from a file's first 30 lines.
 * Returns a short description string.
 */
function detectFileStyle(cwd: string, relPath: string): string | null {
	try {
		const full = resolve(cwd, relPath);
		if (!existsSync(full)) return null;
		const stat = statSync(full);
		if (!stat.isFile() || stat.size > 1_000_000) return null;
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
		const single = (content.match(/'/g) || []).length;
		const double = (content.match(/"/g) || []).length;
		let quotes = "mixed";
		if (single > double * 1.5) quotes = "single";
		else if (double > single * 1.5) quotes = "double";

		// Semicolons
		let codeLines = 0;
		let semiLines = 0;
		for (const line of lines) {
			const t = line.trim();
			if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
			codeLines++;
			if (t.endsWith(";")) semiLines++;
		}
		const semis = codeLines === 0 ? "unknown" : semiLines / codeLines > 0.3 ? "yes" : "no";

		const trailing = /,\s*[\n\r]\s*[)\]}]/.test(content) ? "yes" : "no";

		return `indent=${indent}, quotes=${quotes}, semicolons=${semis}, trailing-commas=${trailing}`;
	} catch {
		return null;
	}
}

/**
 * Shell-escape a keyword for use inside double-quoted bash arguments.
 */
function shellEscape(s: string): string {
	return s.replace(/[\\"`$]/g, "\\$&");
}

/**
 * Analyze the task text and produce a discovery section prepended to the prompt.
 * - Extracts keywords (backtick, camelCase, snake_case, kebab-case, path-like, SCREAMING_SNAKE).
 * - Greps the codebase and ranks files by match count.
 * - Resolves literal file paths (exists-checked) and boosts them.
 * - Detects style of the top-ranked file.
 * - Extracts acceptance criteria bullets.
 *
 * Output format uses "FILES EXPLICITLY NAMED IN THE TASK" and "LIKELY RELEVANT FILES"
 * section headers so that parseExpectedFiles() in agent-loop.ts can parse them.
 */
function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	const keywords = new Set<string>();

	// Backtick-quoted terms (highest signal)
	const backticks = taskText.match(/`([^`]{2,80})`/g) || [];
	for (const b of backticks) {
		const term = b.slice(1, -1).trim();
		if (term.length >= 2 && term.length <= 80) keywords.add(term);
	}

	// camelCase / PascalCase
	const camel = taskText.match(/\b[A-Za-z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g) || [];
	for (const c of camel) keywords.add(c);

	// snake_case
	const snake = taskText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
	for (const s of snake) keywords.add(s);

	// kebab-case
	const kebab = taskText.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || [];
	for (const k of kebab) keywords.add(k);

	// SCREAMING_SNAKE_CASE
	const scream = taskText.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
	for (const s of scream) keywords.add(s);

	// Path-like tokens (src/foo/bar.ts, packages/x/y.js)
	const pathLike = taskText.match(/(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g) || [];
	const paths = new Set<string>();
	for (const p of pathLike) {
		const cleaned = p.trim().replace(/^[\s"'`(\[]/, "").replace(/^\.\//, "");
		paths.add(cleaned);
		keywords.add(cleaned);
	}

	// Also extract file paths from inside backticks
	for (const b of backticks) {
		const inner = b.slice(1, -1).trim();
		if (/^[\w./-]+\.[a-zA-Z0-9]{1,6}$/.test(inner) && inner.length < 200) {
			paths.add(inner.replace(/^\.\//, ""));
		}
	}

	const filtered = [...keywords]
		.filter((k) => k.length >= 3 && k.length <= 80)
		.filter((k) => !/["']/.test(k))
		.filter((k) => !STOP_WORDS.has(k.toLowerCase()))
		.slice(0, 20);

	if (filtered.length === 0 && paths.size === 0) return "";

	// Grep each keyword for file hits
	const fileHits = new Map<string, Set<string>>();
	const includeGlobs =
		'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.scala" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';

	for (const kw of filtered) {
		try {
			const escaped = shellEscape(kw);
			const result = execSync(
				`grep -rlF "${escaped}" ${includeGlobs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/\\.next/' | grep -v '/target/' | head -12`,
				{ cwd, timeout: 3000, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
			).trim();
			if (result) {
				for (const line of result.split("\n")) {
					const file = line.trim().replace(/^\.\//, "");
					if (!file) continue;
					if (!fileHits.has(file)) fileHits.set(file, new Set());
					fileHits.get(file)!.add(kw);
				}
			}
		} catch {
			// grep exit 1 on no match — ignore
		}
	}

	// Resolve literal paths (exists-checked)
	const literalPaths: string[] = [];
	for (const p of paths) {
		try {
			const full = resolve(cwd, p);
			if (existsSync(full) && statSync(full).isFile()) {
				literalPaths.push(p.replace(/^\.\//, ""));
			}
		} catch {
			// ignore
		}
	}

	if (fileHits.size === 0 && literalPaths.length === 0) return "";

	const sorted = [...fileHits.entries()]
		.sort((a, b) => b[1].size - a[1].size)
		.slice(0, 15);

	const sections: string[] = [];

	if (literalPaths.length > 0) {
		sections.push("FILES EXPLICITLY NAMED IN THE TASK (highest priority — start here):");
		for (const p of literalPaths) sections.push(`- ${p}`);
	}

	if (sorted.length > 0) {
		sections.push("\nLIKELY RELEVANT FILES (ranked by task keyword matches):");
		for (const [file, kws] of sorted) {
			sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		}
	}

	// Style detection for the top file
	const topFile = literalPaths[0] || sorted[0]?.[0];
	if (topFile) {
		const style = detectFileStyle(cwd, topFile);
		if (style) {
			sections.push(`\nDETECTED STYLE of ${topFile}: ${style}`);
			sections.push("Your edits MUST match this style character-for-character.");
		}
	}

	// Acceptance criteria count
	const criteriaCount = countAcceptanceCriteria(taskText);
	if (criteriaCount > 0) {
		sections.push(`\nThis task has ${criteriaCount} acceptance criteria.`);
		if (criteriaCount >= 3) {
			sections.push(
				`Tasks with ${criteriaCount}+ criteria almost always require edits across multiple files. Do not stop after editing one file.`,
			);
		}
	}

	// Named files in backticks (additional hint)
	const namedFiles = extractNamedFiles(taskText);
	if (namedFiles.length > 0) {
		sections.push(`\nFiles named in the task text: ${namedFiles.map((f) => `\`${f}\``).join(", ")}.`);
		sections.push("Each named file likely needs an edit.");
	}

	return "\n\n" + sections.join("\n") + "\n";
}

/**
 * Tau scoring preamble — prepended to every system prompt for SN66 duel optimization.
 *
 * Scoring model (tau/src/compare.py):
 *   difflib.SequenceMatcher builds a changed-line sequence per file, then counts
 *   positional matches against a reference diff produced by Cursor on the same task.
 *   Score = matched_changed_lines / max(seq_a, seq_b). The duel winner has more raw
 *   matched lines (not ratio) against the baseline.
 *
 * Environment:
 *   Model: Gemini 2.5 Flash via OpenRouter docker-proxy.
 *   Baseline: Cursor running Gemini 3 Flash.
 *   Time: min(2 * cursor_time + 1, 300) seconds.
 *   Tasks: real GitHub commits, >= 100 changed code lines.
 *
 * Two failure modes:
 *   1. MISS — not touching a file the reference touches. Forfeits all matched lines for that file.
 *   2. BLOAT — touching extra lines. Inflates the denominator.
 *   MISS is worse. Breadth-first coverage beats depth-first perfection.
 */
const TAU_SCORING_PREAMBLE = `You are competing on Bittensor SN66. Your diff is scored position-by-position against a reference diff produced by Cursor on the same task. The duel winner has more raw matched changed lines, not a better ratio. Think "what would Cursor do?" and produce exactly that diff.

## Time Budget
You have 40-300 seconds. Empty diff = zero score. A partial diff touching 3 of 5 target files always beats a perfect diff touching 1 of 5. Never run tests, builds, linters, formatters, servers, or git — the sandbox has no services. Limit bash to 2-3 calls for discovery. Your first response MUST be a tool call. Prose output is ignored.

## Phase 1 — Locate All Target Files
If the prompt includes FILES EXPLICITLY NAMED or LIKELY RELEVANT FILES sections (auto-discovered from task keywords), those are your starting targets. Trust them.

Otherwise run ONE bash call:
  find . -type f \\( -name "*.EXT" -o -name "*.json" \\) | grep -v node_modules | grep -v .git | head -50
Or:
  grep -rl "IDENTIFIER" --include="*.EXT" . | head -10

The 'find' tool is also available for structured glob-based discovery.

## Phase 2 — Read and Absorb Style
Read each target file IN FULL before editing. From the first 30 lines, note:
- Indentation (tabs vs spaces, width)
- Quote style (single vs double)
- Semicolons, trailing commas, brace style
- Naming convention
Your edits must replicate ALL conventions character-for-character. A single style mismatch scores 0 on that line. If the prompt already has DETECTED STYLE, trust it — do not re-detect.

## Phase 3 — Breadth-First Editing (critical for winning)
Make ONE correct edit per target file before going back for a second pass on any file.
- Touching 4 of 5 target files scores far higher than perfecting 1 of 5.
- Do NOT re-read a file you already read unless a prior edit failed.
- After each successful edit, immediately move to the NEXT unedited target.
- Use edit for existing files. write ONLY for files the task explicitly requires to be created.
- New files: place them alongside sibling files (check with ls \`dirname\` if unsure), not at the repo root.
- Short oldText anchors (3-5 lines). On edit failure, re-read the file before retrying.
- Never retry with the same oldText twice without re-reading.
- Process files in alphabetical path order, top-to-bottom within each file.
- Append new imports, array items, enum values, switch cases at the END of their block.
- Copy string literals from the task verbatim.
- Do NOT add comments, docstrings, type annotations, defensive checks, or error handling unless the task requires it.
- Do NOT reorder imports, rename variables, or fix unrelated issues.

## Phase 4 — Criteria Verification
Walk through each acceptance criterion:
- Does each have a corresponding working edit?
- Conditional requirements ("if X, show Y") need an actual if check.
- Behavioral requirements ("filters by category") need functioning logic, not placeholders.
- Multi-part criteria ("A and also B") require both A and B implementations.
- Every file named in the task must be edited.
- 4+ criteria almost always span 2+ files.

## Phase 5 — Stop
Once every criterion is addressed: stop. No re-reads to verify, no summaries, no second passes. The harness reads your diff from disk.

## Tie-Breaking Rules
- Surgical fix over broader refactor. Always.
- If unsure whether to touch a file, do not touch it.
- If a defensive check "would be nice" but was not asked, omit it.
- If unsure whether a line should change, leave it unchanged.
- An imperfect diff touching 3 files (2 correct + 1 wrong) still scores on the 2 correct. Do not freeze. Ship the partial.

---

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

	const discoverySection = customPrompt ? buildTaskDiscoverySection(customPrompt, resolvedCwd) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
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
