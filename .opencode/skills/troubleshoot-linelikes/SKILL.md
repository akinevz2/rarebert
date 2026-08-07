---
name: troubleshoot-linelikes
description: Sets up troubleshooting structure for scripting languages like bash, js or python to create a module that evaluates line-wise sets of variables and displays them by checking related imports. Use when debugging variable flow across import chains in scripts.
---

# Troubleshoot Linelikes Skill

## Purpose

Creates/uses the `troubleshoot-linelikes` module inside rarebert/scripts/ that can evaluate line-wise sets of variables across scripting languages (bash, js, python) and display them by tracing through related imports. This is useful for debugging when variable scope or values are unclear due to complex import chains.

## Usage

```bash
node index.js troubleshoot-linelikes <script-path>
```

Or programmatically:

```javascript
import { troubleshootVariables } from '../scripts/troubleshoot-linelikes.mjs';
await troubleshootVariables('path/to/script.js');
```

## Features

1. **Language Detection** - Auto-detects bash (sh/bash), js (mjs/js), and python (.py) files by extension
2. **Line-wise Variable Extraction** - Parses each line to track variable declarations, function definitions, class declarations
3. **Import Tracing** - Extracts import statements and resolves the actual file paths for JS imports

## Example Output

```
=== Variable Analysis for scripts/memo.mjs ===
Language: js

Imports:
  → lib/projects.mjs
  → lib/modules.mjs
  → lib/cli.mjs

Founds 12 variable/function definitions:
  line 9: META
  line 48: ƒ printGroupedMemos
  line 72: modules
```

## Key Methods in scripts/troubleshoot-linelikes.mjs

- `analyzeFile(filePath)` - Main entry point, returns structured analysis result
- `displayResult(result)` - Pretty-prints the analysis to console
- Language-specific extractors: `extractJsVariables()`, `extractPyVariables()`, `extractBashVariables()`