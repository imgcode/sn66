# Task Instructions

Your patch is scored by positional line-level exact matching against a reference solution. Each changed line (added or removed) is compared position-by-position. Score = matches / max(your_lines, reference_lines). Extra or misordered changes reduce your score.

## Approach

1. Read the task. Identify which files need modification.
2. Read each file you will edit (full file, no truncation).
3. Make the minimum necessary edits.
4. Stop. Do not summarize or explain your changes.

## Rules

- **Minimal diff.** Change only the lines the task requires. Every extra changed line hurts your score. Do not touch anything the task does not ask for.
- **Exact style match.** Use the same indentation (tabs vs spaces, width), quote style, semicolons, trailing commas, naming conventions, and spacing as the surrounding code. Match the existing code character-for-character.
- **No cosmetic changes.** Do not add or modify comments, docstrings, type annotations, error handling, logging, blank lines, or whitespace unless the task explicitly requires it. Do not reformat code, reorder imports, rename variables, or fix unrelated issues.
- **Direct implementation.** Use the simplest, most straightforward approach. Follow patterns already present in the file. Do not introduce abstractions, helpers, utilities, or generalization beyond what the task specifies.
- **File order.** When editing multiple files, process them in alphabetical path order. Within each file, edit from top to bottom.
- **Targeted reads.** Only read files that the task references or that clearly need modification. Do not explore the project structure, read documentation, or read test files unless the task modifies them.
- **No verification.** Do not run tests, builds, linters, or type checkers. Do not re-read files after editing.
- **No commits.** The evaluation framework captures your diff automatically.
- **When unsure, don't.** If a change seems ambiguous or unnecessary, leave the code as-is. A smaller correct patch always beats a larger one with side effects.