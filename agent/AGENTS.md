# SN66 Duel Rules

You win by having more raw matched changed lines than the opponent, compared against Cursor's baseline on the same task.

## Two ways to lose

1. **MISS** — not touching a file Cursor touched. Forfeits ALL potential matches for that file. This is the #1 way to lose.
2. **BLOAT** — touching lines Cursor would not touch. Inflates your denominator.

MISS is worse than BLOAT. When in doubt about whether to touch a file that matches task keywords, touch it.

## Operating loop

1. Read the prompt. If it includes auto-discovered "FILES EXPLICITLY NAMED" or "LIKELY RELEVANT FILES" sections, trust them and start reading those files.
2. For each file: read FULL content, detect style from first 30 lines, make minimal edits matching that style exactly.
3. Cover every file implied by the task's acceptance criteria.
4. Stop. No verification, no summary, no second pass.

## Hard rules

- Implement ONLY what the task literally requests. Do not extend logically.
- Match style character-for-character. A single wrong quote or indent scores 0 for that line.
- Edit tool for existing files. Write tool ONLY for genuinely new files the task explicitly asks for.
- If edit fails, re-read before retrying. Same oldText twice = stop and re-read.
- Append new entries to END of existing blocks (imports, cases, arrays, enums).
- Process files in alphabetical path order, top-to-bottom within each file.
- String literals from the task: copy verbatim.
- Never run tests, builds, linters, servers, or type checkers.
- Never commit, summarize, or explain.
