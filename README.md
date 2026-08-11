# Rumshell

Rust-based shell with Python-like syntax for declarative shell scripting and memo system integration.

## Features

- Python-like boolean operators: `and`, `or`, `not` for command chaining
- `.rum` file format for declarative shell scripts
- Memo system integration for command history and tracking
- Cross-platform (Windows/Linux/macOS) - built with Rust
- Bash syntax translation layer for easy migration

## Quick Start

```bash
# Build from source
cargo build --release

# Run a .rum file
./target/release/rumshell run test.rum

# Use with launcher from npm
rumshell run test.rum
```

## Installation

### From Source

```bash
cargo build --release
```

### Via npm (as part of rarebert)

```bash
npm link
rumshell run test.rum
```

## Basic Usage

### Run a .rum script

```bash
rumshell run your-script.rum
```

### Execute inline commands

```bash
rumshell --command "echo 'Hello World'"
```

### Boolean Logic

```rum
# Sequential execution - continues if previous succeeds
command "echo Step 1" and \
command "Step 1 passed" or \
command "Step 1 failed"

# Conditional execution - stops if previous succeeds
command "echo Important" or \
echo "This won't run"  # because 'Important' succeeded

# Negation
command "Check status" and not command "Should not run"

# Variable assignment
name="World" and \
echo "Hello $name"

# Line continuation
echo "Line 1" and \
echo "Line 2" \
echo "Line 3"
```

## .rum File Examples

### Simple script

```rum
command "echo 'Hello from rumshell!'"
```

### Complex script with logic

```rum
command "echo 'Starting complex script'" and \
command "Step 1: Checking environment" or \
command "Environment check failed" and \
command "Step 2: Running setup" and \
not command "Setup interrupted"

command "Final step: Summary"
```

### Environment check

```rum
echo "Current directory: $(pwd)"

name="My Project" and \
echo "Project name: $name"

count=5 and \
echo "Count: $count" and \
echo "Count + 1: $((count + 1))"
```

## Memo System

Rumshell integrates with the rarebert memo system for command tracking:

```bash
# View memo list
rumshell memo-list

# Recall memo for module
rumshell recall <module-name>

# Add memo manually
rumshell add <module-name> <content>

# Delete memo
rumshell delete <module-name>
```

## Translation Layer

Rumshell includes a translation layer that normalizes bash syntax:

- Converts `&&`, `||` to `and`, `or`
- Handles backslash line continuations
- Supports bash-style variable assignment
- Provides on-the-fly bash to rum conversion

## Why .rum Files?

File execution (`run file.rum`) avoids PowerShell's string escaping issues:

- Clean string handling
- Proper line continuation
- Consistent variable expansion
- Complex chain execution
- Better error handling

### Comparison: Inline vs File

```bash
# Inline (PowerShell escapes complex strings differently)
rumshell --command "echo 'Line 1' and echo 'Line 2' or echo 'Line 3'"

# File (clean, no escaping issues)
# save as test.rum:
echo "Line 1" and \
echo "Line 2" or \
echo "Line 3"

# then run:
rumshell run test.rum
```

## Testing

Create a test script to verify installation:

```bash
cat > test.rum <<EOF
# Test script
echo "Hello from rumshell! This is a basic command."
echo "Current directory: $(pwd)"

echo "Step 1: Checking environment" and \
echo "Environment check passed" or \
echo "Environment check failed"

name="World" and \
echo "Hello $name"
EOF

rumshell run test.rum
```

## Project Structure

```
rumshell/
├── Cargo.toml
├── src/
│   ├── main.rs          # CLI entry point
│   ├── executor.rs      # Command execution
│   ├── parser.rs        # Syntax parsing
│   ├── memo.rs          # Memo system integration
│   └── static_translate.rs  # Bash translation
├── examples/
│   ├── simple.rum       # Basic example
│   └── complex.rum      # Complex logic example
├── test.rum             # Comprehensive test script
└── INSTALLATION.md      # Detailed installation guide
```

## Development

```bash
# Build
cargo build --release

# Run tests
cargo test

# Check formatting
cargo fmt
```

## CLI Commands

- `run <file>` - Execute .rum file
- `--command <string>` - Execute inline command
- `memo-list` - Show memo system list
- `recall <module>` - Recall memo for module
- `add <module> <content>` - Add memo manually
- `delete <module>` - Delete memo

## Environment Variables

- `RUMSHELL_BIN` - Path to rumshell binary (for launcher)
- `CARGO_HOME` - Rust package registry directory
- `CARGO_TARGET_DIR` - Build artifacts directory

## License

MIT