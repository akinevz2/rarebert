---
name: brainstorm
description: Strategic workflow that integrates delegate patterns - uses cloud models for planning only, then delegates implementation to local models.
---

# Brainstorm

## Purpose

A strategic workflow that **integrates with** the `delegate` pattern:

- **Brainstorm**: Agent submits PLANNING to cloud model → Agent creates todos → Deploys implementation via delegate subagent patterns using local model
- **Delegate**: Subagents execute `opencode run` with local model on individual todos

This keeps expensive cloud model usage strictly for reasoning/planning, while implementation happens locally on cheaper quantized models via delegate subagents.

The cloud model for "opencode run" planning calls is:
- `opencode/glm-5.2`
- (using `-m "opencode/glm-5.2"`)

The local model for "opencode run" implementation calls is:
- `ollama/laguna-xs-2.1:q8_0`
- (using `-m "ollama/laguna-xs-2.1:q8_0"`)


## When to use

- Tasks requiring complex reasoning, architecture analysis, or multi-step coordination
- You want to preserve cloud model credits for planning only
- The implementation can be broken into verifiable chunks
- You need auditable planning with exact code before implementation begins
- The task size warrants todo tracking but implementation should be cheap
- You want to use delegate subagent patterns for implementation

## When NOT to use

- Simple single-edit tasks — do them directly
- Tasks requiring real-time debugging from the planning model
- When a local model can reason about the entire task without help

## Workflow

### Step 1 — Submit planning workload to cloud model

Use a `task` subagent to invoke the cloud model with a planning prompt. The prompt must instruct the cloud model to:

- Analyze the request thoroughly
- Break it into discrete todo items
- Generate exact code snippets for each todo
- Provide verification commands
- Output strict JSON (no markdown)

Planning prompt structure:

```
You are an expert software architect. For the rarebert project at <root>, analyze and plan the following request.

REQUEST:
<user request>

OUTPUT FORMAT (JSON ONLY, no prose or markdown):
{
  "title": "<brief title>",
  "analysis": "<2-3 sentence analysis>",
  "todos": [
    {
      "id": "todo-1",
      "description": "<one sentence - what to do>",
      "file": "<relative path to file>",
      "line": <optional number|null>,
      "exactCode": "<exact code to implement - complete function/block>",
      "constraints": ["<what NOT to change>", "..."],
    }
  ]
}

RULES:
- Output ONLY the JSON, no markdown fences
- Each todo must be independently implementable
- exactCode contains the FULL code needed - no placeholders
- State ALL constraints explicitly
```

### Step 2 — Launch task subagent for cloud planning

```javascript
[task: Cloud planning for <task-name>]
  prompt: "You are a planning runner. Run opencode run with this planning prompt asking the cloud model to analyze and plan the task. The model is <cloud-model-id>. Return the RAW JSON output - do not process it. Save it to .opencode/system/planning-response.json"
```

### Step 3 — Parse planning response and create todos

After the subagent completes, read the planning response JSON. For each todo:

1. Validate the JSON structure
2. Create a todo item using the `todowrite` tool with structured content
3. Prepare implementation details based on the todo

### Step 4 — Deploy implementation via delegate patterns

Use delegate subagent patterns to implement each todo with a local model:

1. Create context file at `.opencode/system/context.json` with:
   ```json
   {
     "todos": ["<full todo list>"],
     "implemented": "<array of completed todo indexes>",
     "currentTodo": "<current todo text>",
   }
   ```

2. Create prompt file at `.opencode/system/prompt.txt`:
   ```
   You have the following todo list:
   [JSON from context.json with todos array]
   
   Parts that have been implemented must not be reverted.
   You are working on: [current todo details]
   The rest will be implemented later.
   
   TASK: [todo.description]
   FILE: [todo.file]
   CONSTRAINTS: [todo.constraints]
   
   You must delegate the task to a model using the opencode run command.
   Explore the delegate opencode skill before proceding.
   ```

3. Launch subagent using delegate pattern:
   ```javascript
   [task: Implement <todo-id> via delegate]
     prompt: "Run: opencode run \"$(cat .opencode/system/prompt.txt)\" -m ws-rarebox:11434/laguna-xs-2.1:safe --auto with 1440000ms timeout. Report results."
   ```

### Step 5 — Final verification

After all todos complete:
```bash
node --check <each-modified-file>
make check
```

## Todo creation from planning response

After receiving the cloud model's planning response:

1. Read `.opencode/system/plan.json`
2. Parse the JSON
3. Create todos via `todowrite`:

```json
{
  "todos": [
    {
      "content": "todo-1: <description>",
      "status": "pending",
      "details": {
        "file": "<path>",
        "code": "<exact code>",
        "constraints": ["..."]
      }
    }
  ]
}
```

## Example: creating a new script module

**Planning phase (cloud model opencode/glm-5.2):**
- Analyzes request: "Create a brainstorm skill"
- Breaks into todos: structure, writing SKILL.md, writing implementation
- Returns JSON with exact code for each

**Agent phase:**
- Subagent runs planning, saves JSON
- Agent creates todos from JSON
- Agent creates context file with full todo list
- Agent deploys todos via delegate patterns using `ws-rarebox:11434/laguna-xs-2.1:safe`

**Subagent prompt includes:**
- Full todo list from context.json
- Constraint: "Parts that have been implemented must not be reverted"
- Focus on current todo only
- 24-minute timeout for local model execution

This uses cloud credits ONLY for the 2-minute planning phase, not for implementation.

## Checklist for the orchestrating agent

Before planning:
- [ ] Planning prompt written with strict JSON output format
- [ ] Cloud model verified available
- [ ] Task directory created under `.opencode/system/`

After planning:
- [ ] Subagent completed and returned JSON
- [ ] JSON parsed and validated
- [ ] All todos have required fields: id, description, file, exactCode, constraints 
- [ ] Todos created via todowrite tool
- [ ] Implementation prompts prepared for each todo
- [ ] Independent todos identified for parallel execution
- [ ] Dependent todos identified for sequential execution

During implementation:
- [ ] Local model verified available
- [ ] Each implementation run with appropriate timeout (24+ min for local quantized)
- [ ] Verification passes for each todo

After all implementation:
- [ ] `node --check` passes on modified files
- [ ] `grep` confirms symbols
- [ ] Any subagent errors resolved manually

## Collaborating with delegate

The `brainstorm` skill collaborates with `delegate` by:

1. **Brainstorm handles planning**: Cloud model analyzes request and generates structured todos with exact code
2. **Brainstorm deploys via delegate**: Uses delegate subagent patterns to run local model on each todo
3. **Each subagent is self-contained**: Prompt includes full context, constraints, and current todo focus
4. **Context preserved via instrumentation**: Files in `.opencode/system/` maintain shared state

This uses cloud credits ONLY for the planning phase (2-5 min with opencode/glm-5.2), while local model handles implementation via delegate patterns.

## Failure modes

### Cloud planning returns invalid JSON

1. The planning subagent should retry with adjusted prompt
2. If persistent, manually create the todo structure
3. Proceed with local implementation

### Planning misses edge cases

1. Read original request vs todos
2. Add missing todos manually
3. Write implementation for new todos
4. Continue workflow

### Local implementation diverges from planning

1. Compare actual code vs `exactCode` from planning
2. The verification commands in each todo will catch issues
3. Fix manually and re-run verification
4. Update the todo status
