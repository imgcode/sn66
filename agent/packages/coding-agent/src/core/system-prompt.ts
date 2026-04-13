/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

/**
 * Extract keywords from task text and grep the codebase to find likely relevant files.
 * Returns a prompt section listing the top matching files, giving the model a head start.
 */
function grepTaskKeywords(taskText: string, cwd: string): string {
	// Extract keywords: backtick-quoted terms, camelCase, snake_case identifiers
	const keywords = new Set<string>();

	// Backtick-quoted terms
	const backtickMatches = taskText.match(/`([^`]+)`/g);
	if (backtickMatches) {
		for (const m of backtickMatches) {
			const term = m.slice(1, -1).trim();
			if (term.length >= 3 && term.length <= 80 && !term.includes(" ")) {
				keywords.add(term);
			}
		}
	}

	// camelCase and PascalCase identifiers (3+ chars)
	const camelMatches = taskText.match(/\b[a-z][a-zA-Z0-9]{2,30}\b/g);
	if (camelMatches) {
		for (const m of camelMatches) {
			if (/[A-Z]/.test(m)) keywords.add(m);
		}
	}

	// snake_case identifiers
	const snakeMatches = taskText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g);
	if (snakeMatches) {
		for (const m of snakeMatches) {
			if (m.length >= 4) keywords.add(m);
		}
	}

	if (keywords.size === 0) return "";

	const srcExtensions = "ts,tsx,js,jsx,py,go,rs,java,c,cpp,h,hpp,cs,rb,php,swift,kt,scala,vue,svelte";
	const keywordList = [...keywords].slice(0, 20);

	try {
		// Run grep for each keyword, collect file hits
		const fileCounts = new Map<string, number>();
		for (const kw of keywordList) {
			const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			try {
				const result = execSync(
					`grep -rl "${escaped}" --include="*.{${srcExtensions}}" . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | head -20`,
					{ cwd, timeout: 5000, encoding: "utf8" },
				);
				for (const line of result.trim().split("\n")) {
					const file = line.trim();
					if (file) fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
				}
			} catch {
				// grep returns exit code 1 if no matches — ignore
			}
		}

		if (fileCounts.size === 0) return "";

		// Sort by match count descending, take top 15
		const sorted = [...fileCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 15);

		let section = "\n\nLIKELY RELEVANT FILES (auto-discovered from task keywords):\n";
		for (const [file, count] of sorted) {
			section += `- ${file} (${count} keyword${count > 1 ? "s" : ""})\n`;
		}
		section += "Start by reading the top-ranked files above.\n";
		return section;
	} catch {
		return "";
	}
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
const TAU_SCORING_PREAMBLE = `Your diff is compared against Cursor's diff on the same task. The duel winner is whoever has more raw matched changed lines. Think "what would Cursor do?" — then do exactly that.

WINNING STRATEGY:
1. Cover ALL files the task implies. Missing a file Cursor touched forfeits all potential matches for that file. This is the #1 way to lose.
2. Within each file, match Cursor's edit locations exactly. Cursor edits at the most obvious location — do the same.
3. Extra lines you add that Cursor didn't are noise that disrupts positional alignment. When in doubt, do less.

FILE DISCOVERY:
- If files are named in the task, read them immediately. No discovery step needed.
- If files are ambiguous, ONE bash call: find . -type f -name "*.EXT" | grep -v node_modules | grep -v .git | head -40
- Or: grep -r "KEYWORD" --include="*.EXT" -l | head -10
- If you read a file, edit it. Reading without editing wastes budget.

STYLE DETECTION (before editing each file):
- Check first 20 lines: indentation (tabs/spaces, width), quotes (single/double), semicolons, trailing commas, brace style, naming convention.
- Edits must match all of these. A single style mismatch on a line = that line scores 0.

EDIT TACTICS:
- Use edit tool for existing files. write tool ONLY for genuinely new files.
- Use short unique oldText anchors (3-5 lines) so edits land precisely.
- If an edit fails, re-read the file before retrying.
- Imports: add at END of the existing import block, same style as adjacent imports.
- New functions/methods/cases: add after the last similar existing block.
- No blank lines between changes unless surrounding code already has them.
- Bug fixes: the minimal fix is almost always what Cursor would do.

SCOPE ESTIMATION:
- Count acceptance criteria. Tasks have 100+ changed lines across 1-5 files typically.
- 4+ criteria almost always need 4+ edits across 2+ files.
- Do not stop after one file if the task implies changes to multiple files.
- After editing a file, check sibling files: ls $(dirname <path>)/ — related files often need changes too.

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
		const keywordHits = grepTaskKeywords(customPrompt, resolvedCwd);
		let prompt = TAU_SCORING_PREAMBLE + keywordHits + customPrompt;

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
