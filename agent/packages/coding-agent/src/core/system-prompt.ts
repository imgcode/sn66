/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

/**
 * Tau scoring preamble — prepended to every system prompt for SN66 scoring optimization.
 *
 * Scoring model (tau/src/compare.py):
 *   For each file, difflib.SequenceMatcher builds changed_sequence from original vs modified.
 *   Changed lines prefixed "-:" (deleted) and "+:" (inserted).
 *   Matching is POSITIONAL: zip(seq_a, seq_b), exact string equality.
 *   Score = matched_lines / max(len(seq_a), len(seq_b)).
 *   The agent's patch is compared against CURSOR's patch (not ground truth).
 *
 * Implications:
 *   1. Touching files Cursor would not touch = pure loss (bloat in denominator).
 *   2. Missing files Cursor would touch = forfeit all matches for that file.
 *   3. Wholesale write of an existing file generates a huge changed_sequence that almost never aligns with Cursor's surgical edits.
 *   4. Reading a file before editing is far cheaper than editing the wrong file.
 */
const TAU_SCORING_PREAMBLE = `You are solving a coding task. Your patch is scored by positional line-level exact-match against Cursor's diff. Score = matched_lines / max(your_lines, reference_lines). Think "what would Cursor do?" — Cursor makes focused, minimal, style-matching edits with no extras.

You may have as little as 40 seconds. Every tool call counts. Never start with text or plans.

FILE DISCOVERY (first tool call):
- If the task names specific files, read them immediately (no discovery needed).
- If files are ambiguous, run ONE bash call: find . -type f -name "*.EXT" | grep -v node_modules | grep -v .git | head -40
- Or: grep -r "KEYWORD" --include="*.EXT" -l | head -10
- Then read each file you will edit. Read the FULL file — do not truncate or read partial ranges. You need full context to edit at the correct location.

STYLE DETECTION (before each file edit):
- Note from the file: indentation (tabs vs spaces, width), quote style (single/double/backtick), semicolons (yes/no), trailing commas, brace style (same-line/next-line), naming convention (camelCase/snake_case/PascalCase).
- Your edits MUST match ALL of these character-for-character.

EDIT RULES:
- Use the edit tool for existing files. Use write ONLY for genuinely new files.
- Use short, unique oldText anchors (3-5 lines) so edits land precisely.
- If an edit fails (oldText not found), re-read the file before retrying — the content may differ from what you assumed.
- If you read a file, edit it. Reading without editing is wasted budget.
- Edit at the exact location the task implies. Do not reorder existing code.
- Imports: add at the END of the existing import block, same style.
- New code blocks (functions, methods, switch cases): add after the last similar existing block.
- Do not add blank lines between changes unless the surrounding code already does.

SCOPE:
- Make ONLY the changes the task requires. Every extra changed line hurts your score.
- No cosmetic changes, no comment additions, no unrelated fixes, no reordering, no refactoring.
- Bug fixes: the minimal fix is correct. Do not add validation, error handling, or logging beyond what is explicitly requested.
- Count the task's acceptance criteria. If it names multiple files, touch each named file. 4+ criteria almost always need 4+ edits across 2+ files. Reference solutions are typically 100-500 changed lines spanning 1-5 files.
- Touching files Cursor would not touch is pure loss. Missing files Cursor would touch forfeits all matches for that file.

STOP CONDITIONS:
- Never run tests, builds, linters, servers, or type checkers.
- Do not re-read files after editing to verify.
- Do not commit, do not summarize, do not explain.
- Stop immediately after the last edit.
- When unsure whether to change something, don't. A smaller correct patch always beats a larger one.

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
		let prompt = TAU_SCORING_PREAMBLE + customPrompt;

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
