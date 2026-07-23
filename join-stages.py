"""Pipeline join: chain makefile recipe stages through shell piping."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
from typing import List, Optional, Iterator


class PipelineStage:
    """Represents a single stage in the pipeline."""
    
    def __init__(self, name: str, extra_args: List[str] = None):
        self.name = name
        self.extra_args = extra_args or []
    
    def build_command(self) -> List[str]:
        """Build the make command for this stage."""
        return ["make", self.name] + self.extra_args


class PipelineBuilder:
    """Builds and manages pipeline stages."""
    
    def __init__(self):
        self._stages: List[PipelineStage] = []
        self._extra_args: List[str] = []
    
    def add_stage(self, name: str) -> 'PipelineBuilder':
        """Add a stage to the pipeline."""
        self._stages.append(PipelineStage(name, self._extra_args.copy()))
        return self
    
    def set_extra_args(self, args: List[str]) -> 'PipelineBuilder':
        """Set extra arguments (KEY=VALUE pairs) for all stages."""
        self._extra_args = args
        # Update existing stages with new args
        for stage in self._stages:
            stage.extra_args = args.copy()
        return self
    
    def parse_arguments(self, raw_args: List[str]) -> 'PipelineBuilder':
        """Parse raw arguments to extract stages and extra args."""
        parsed_args = [arg for arg in (raw_args or []) if arg != "--"]
        
        for arg in parsed_args:
            if "=" in arg and not arg.startswith("-"):
                self._extra_args.append(arg)
            else:
                self.add_stage(arg)
        
        return self
    
    def build(self) -> List[PipelineStage]:
        """Return the built pipeline stages."""
        return self._stages.copy()


class PipelineRunner:
    """Runs pipelines of make targets with optional stdin/stdout piping."""
    
    def __init__(self, input_file: Optional[str] = None):
        self.input_file = input_file
    
    def run(self, stages: List[PipelineStage]) -> int:
        """Run the pipeline and return exit code from final stage."""
        if not stages:
            print("Error: No stages specified", file=sys.stderr)
            return 1
        
        extra_args = stages[0].extra_args if stages else []
        
        # Single stage case - run directly with variable assignments
        if len(stages) == 1:
            return self._run_single_stage(stages[0])
        
        # Multiple stages - chain with pipes using shell=True for pipe syntax
        return self._run_multi_stage_pipeline(stages, extra_args)
    
    def _open_input_stream(self) -> Optional[Iterator[str]]:
        """Get the appropriate input stream based on configuration."""
        if self.input_file:
            try:
                return open(self.input_file, 'r')
            except Exception as e:
                print(f"Error opening input file '{self.input_file}': {e}", file=sys.stderr)
                raise
        
        if not sys.stdin.isatty():
            # Stdin has data piped to it - use it directly
            return sys.stdin
        
        return None
    
    def _run_single_stage(self, stage: PipelineStage) -> int:
        """Run a single make target as the final pipeline stage."""
        try:
            proc_stdin = self._open_input_stream()
            
            cmd_parts = stage.build_command()
            
            proc = subprocess.Popen(
                cmd_parts,
                stdin=proc_stdin,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            stdout, stderr = proc.communicate()
            
            if self.input_file and proc_stdin:
                proc_stdin.close()
            if stderr:
                sys.stderr.write(stderr)
            
            # Forward the output to stdout only for the final stage
            if proc.returncode == 0:
                sys.stdout.write(stdout)
            
            return proc.returncode
        except Exception as e:
            print(f"Error running stage '{stage.name}': {e}", file=sys.stderr)
            return 1
    
    def _run_multi_stage_pipeline(self, stages: List[PipelineStage], extra_args: List[str]) -> int:
        """Run multiple stages chained together with pipes."""
        try:
            # Build the pipeline command string with KEY=VALUE pairs
            make_commands = []
            for i, stage in enumerate(stages):
                cmd_parts = ["make", stage.name] + extra_args
                cmd_str = " ".join(cmd_parts)
                
                # For all intermediate stages, redirect stdout to /dev/null
                # Only the last stage should output to stdout
                if i < len(stages) - 1:
                    cmd_str += " > /dev/null"
                
                make_commands.append(cmd_str)
            
            pipeline_cmd = " | ".join(make_commands)
            
            # If input_file is provided, prepend it to the pipeline as stdin redirection
            if self.input_file:
                pipeline_cmd = f"cat {self.input_file} | {pipeline_cmd}"
            
            proc = subprocess.Popen(
                pipeline_cmd,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            stdout, stderr = proc.communicate()
            if stderr:
                sys.stderr.write(stderr)
            
            # Only output the final result to stdout
            if proc.returncode == 0:
                sys.stdout.write(stdout)
            
            return proc.returncode
            
        except Exception as e:
            print(f"Error running pipeline: {e}", file=sys.stderr)
            return 1


class ArgumentParser:
    """Handles argument parsing for the pipeline tool."""
    
    def __init__(self):
        self._parser = argparse.ArgumentParser(
            description="Chain makefile recipe stages through shell piping",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""Examples:
  %(prog)s get-training-set hyper-analysis
  %(prog)s --input-file data.txt stage1 stage2
  %(prog)s -h, --help  Show this help message"""
        )
        self._parser.add_argument(
            "args",
            nargs="*",
            help="Stages (target names) followed by KEY=VALUE argument pairs"
        )
        self._parser.add_argument(
            "-i", "--input-file",
            dest="input_file",
            help="Input file to provide to the first stage via stdin"
        )
    
    def parse(self) -> argparse.Namespace:
        """Parse command line arguments."""
        return self._parser.parse_args()


class PipelineCLI:
    """Command-line interface for pipeline execution."""
    
    def __init__(self):
        self.arg_parser = ArgumentParser()
    
    def run(self) -> int:
        """Main entry point for CLI execution."""
        args = self.arg_parser.parse()
        
        # Build the pipeline from arguments
        builder = PipelineBuilder()
        builder.parse_arguments(args.args or [])
        
        stages = builder.build()
        
        if not stages:
            self.arg_parser._parser.error("No stages specified. Use -h for help.")
            return 1
        
        # Run the pipeline
        runner = PipelineRunner(input_file=args.input_file)
        return runner.run(stages)


# Suppress broken pipe errors (common when piping to commands that exit early)
signal.signal(signal.SIGPIPE, signal.SIG_DFL)


if __name__ == "__main__":
    cli = PipelineCLI()
    raise SystemExit(cli.run())
