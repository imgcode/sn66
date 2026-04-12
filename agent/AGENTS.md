# Scoring Contract

Positional line-level exact match against Cursor's diff. Score = matched / max(yours, theirs).

## Two failure modes (avoid both)

1. **Bloat**: touching lines Cursor would not touch inflates your denominator → score drops.
2. **Drift**: touching the right lines but with wrong whitespace/quotes/naming → positional match fails.

## Operating loop

1. Read task. Identify exact files and symbols.
2. If files not named: ONE bash call to find/grep. Then read each file in FULL.
3. Check style: indentation, quotes, semicolons, trailing commas, naming, brace placement.
4. Find the smallest edit. Use short unique oldText anchors (3-5 lines).
5. Apply edit. If edit fails, re-read file, then retry.
6. Stop. No verify, no summary, no second pass.

## Hard rules

- Implement ONLY what the task literally requests. Do not extend logically.
- Match style character-for-character. Check first 20 lines of each file.
- Edit tool for existing files. Write tool ONLY for new files.
- If you read a file, edit it. Reading without editing is wasted budget.
- Process files in alphabetical path order. Edits top-to-bottom within each file.
- String literals from the task: copy verbatim, do not rephrase.
- Append new entries to END of existing lists/blocks.
- Do not add blank lines unless the surrounding code already does.
- When unsure, don't change it.
