"""runtime: process pipeline JSON and generate executable commands."""

import json
import sys
from typing import List, Dict, Union

from devlib import run


def process_module(module_config: Dict[str, Union[str, Dict]]) -> str:
    """Generate executable command from module configuration."""
    module = module_config.get("module", "")
    runtime = module_config.get("runtime", "")
    
    if runtime == "make":
        return f"make {module}"
    elif runtime == "java":
        # For Java modules, we might want to run a specific Java class
        # This would depend on the actual implementation of the Java modules
        return f"java -cp target/classes com.example.{module}"
    else:
        # For other runtime types, just return the module name as command
        return module


def main() -> int:
    """Main function to process JSON input and output executable commands."""
    try:
        # Read JSON input from stdin
        input_data = sys.stdin.read().strip()
        
        if not input_data:
            print("No input provided")
            return 1
            
        # Parse the JSON data
        data = json.loads(input_data)
        
        # Handle both single module and list of modules
        if isinstance(data, list):
            # Process each module in the list
            commands = []
            for module_config in data:
                command = process_module(module_config)
                commands.append(command)
            
            # Output all commands (one per line)
            print("\n".join(commands))
        else:
            # Process single module
            command = process_module(data)
            print(command)
            
        return 0
        
    except json.JSONDecodeError as e:
        print(f"Invalid JSON input: {e}")
        return 1
    except Exception as e:
        print(f"Error processing input: {e}")
        return 1


def mark_as_pipeline_middleware() -> bool:
    """Mark this script as a pipeline middleware component.

    Returns True when stdin has piped input available, enabling the script
    to participate in Unix-style pipelines. When called without piped input,
    returns False indicating standalone execution mode.

    This function helps scripts distinguish between direct invocation and
    pipeline usage, allowing graceful handling of both scenarios.

    Returns:
        True if data is being piped via stdin, False otherwise.
    """
    import select
    return bool(select.select([sys.stdin], [], [], 0.0)[0])


if __name__ == "__main__":
    raise SystemExit(run(main))
