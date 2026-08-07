---
name: open-in-editor
description: Opens a file in VS Code using the 'code' command.
---

# Open In Editor Skill

## Purpose

The user might want to inspect ongoing work done in a project file while an agent is doing work.

Interrupting the agent's work with a request to display the file contents is time consuming.

Instead, the user might opt to have another agent connected to the project's workspace from their IDE.

Instead of locating the file in their IDE's file browser, the user should be able to instruct the agent
to intelligently locate the file, or a set of files, and use their IDE's cli command to connect and launch
the file and take the focus from the terminal. This is to improve developer ergonomic in context switching
and help the developer maintain a stack-like history of opened files (which serve them as working context layers)
so that as work is completed on the most current file, they can collapse the most recently opened editor files
to maintain focus on linear history of changes done to a codebase.

## Usage

When asked to open a file or a file path (e.g., "scripts/add.mjs", "lib/memo.mjs", or "Makefile"), execute:

```bash
# given a full path and assuming the user's editor of choice by default is VS Code
# the -r flag indicated to vscode to reuse the user's most recent editor window
code -r $FILE
```

When asked to open a folder but not a collection of files (e.g., "open the folder docs/" ), execute:

```bash
# vscode treats opening a folder as replacing the current window's workspace/project
# using --new-window ensures that the user's current window's context is preserved
code --new-window $FOLDER
```

When asked to open a collection of files (e.g., "open all of the files in lib/", or "please open lib/memo.mjs, scripts/memo.mjs, and lib/core.mjs")
you should be very careful to ask for a response from the user to confirm if the number of files to be opened is larger than 3. After they give consent,
execute:

```bash
# vscode accepts multiple files as arguments to open multiple tabs in the editor simultaneously
# the agent must use the --wait flag when opening multiple files so that their session is blocked
# until the user has had a chance to review all of the files. vscode's "code --wait" command will
# unblock when all of the opened file tabs have been closed by the user, allowing the agent to
# continue
code -r --wait "$FILES"
```

## Context

- This is useful for exploring code during or after edits, refactors, semantic analysis, additional modules being added to a project, complex refactors or implementation
- The `-r` flag connects to the running VS Code editor, which the user is currently working from currently
- The `--new-window` flag connects to the running VS Code editor, and requests a new window to be opened on top of the current one, switching focus to it automatically
- The `--wait` flag requests that the command blocks until the user has closed the opened file(s). This gives the user freedom to return to the agent's window only when they're sure of the code they requested to view
- Works with relative paths or absolute file paths
- When asked to operate on a filename without absolute or relative path/without an extension, use the terminal tools available in order to locate the file first
- If the `code` command fails and isn't present on the user's system, and their `$EDITOR` or `$VISUAL` variables are set to a different application, use it instead

## Example Invocation

User: "Open scripts/analyze.mjs"
Response: Run `code -r scripts/analyze.mjs` using the bash/terminal tool.
