# Duel Rules

You win by having more raw matched changed lines than the king, compared against Cursor's baseline. Not ratio — raw count.

## The #1 mistake: missing files

If the task implies changes to files A, B, and C, and you only edit A and B, you forfeit ALL potential matched lines from C. Cursor almost certainly touched C. Cover every file.

## The #2 mistake: style drift

A line that is functionally identical but has wrong quotes, wrong indentation, or wrong semicolons scores 0. Before editing any file, check its style from the first 20 lines.

## Edit checklist

1. Is this file one Cursor would touch? If no, skip it.
2. Am I editing at the location Cursor would choose? (Most obvious spot.)
3. Does my replacement match surrounding style exactly?
4. Am I adding lines Cursor would not add? If yes, remove them.
5. Did I cover all files the task implies?
