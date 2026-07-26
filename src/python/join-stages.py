"""Pipeline join: chain makefile recipe stages through shell piping.

Runs each requested stage in order, captures per-stage stdout, and writes
a combined ``pipeline.json`` descriptor to the nlp-pipeline-viewer's
``public/`` directory so the Vue viewer can render the run results.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import signal
import subprocess
import sys
from collections.abc import Sequence
from io import StringIO
from pathlib import Path
from typing import Optional


# Modules that exist as build / glue helpers and should not be treated as
# pipeline stages even if they appear in the Makefile's ``PY_TARGETS`` list.
NON_STAGE_TARGETS: frozenset[str] = frozenset(
    {
        "join-stages",
        "bootstrap-make",
        "devlib",
        "runtime",
    }
)

DEFAULT_VIEWER_PUBLIC_DIR = Path("nlp-pipeline-viewer") / "public"


# ---------------------------------------------------------------------------
# Stage discovery
# ---------------------------------------------------------------------------


def _load_existing_pipeline(viewer_public: Path) -> Optional[dict[str, object]]:
    """Return the parsed ``pipeline.json`` if it already exists on disk."""
    pipeline_path = viewer_public / "pipeline.json"
    if not pipeline_path.is_file():
        return None
    try:
        with pipeline_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(
            f"Warning: could not read existing pipeline.json ({exc}); "
            "falling back to Makefile-based discovery",
            file=sys.stderr,
        )
        return None


def _discover_makefile_targets(makefile: Path) -> List[str]:
    """Extract ``PY_TARGETS`` entries from a Makefile.

    Supports single-line ``PY_TARGETS := a b c`` as well as multi-line
    continuation forms (trailing backslash).  The returned list preserves
    file order and omits internal non-stage helpers.
    """
    if not makefile.is_file():
        return []

    text = makefile.read_text(encoding="utf-8")

    # Normalise line-continuations: turn "a \\<newline>b" into "a b".
    flattened = re.sub(r"\\\s*\n\s*", " ", text)

    match = re.search(
        r"^PY_TARGETS\s*[:?]?=\s*(.+?)$",
        flattened,
        flags=re.MULTILINE,
    )
    if not match:
        return []

    raw = match.group(1)
    # Strip inline Make comments, then split on whitespace.
    raw = raw.split("#", 1)[0]
    targets = [token for token in re.split(r"\s+", raw.strip()) if token]

    return [name for name in targets if name not in NON_STAGE_TARGETS]


def discover_stages(
    viewer_public: Path,
    makefile: Path,
) -> list[dict[str, object]]:
    """Discover pipeline stage definitions.

    Preference order:
    1. Existing ``public/pipeline.json`` ``stages`` array (preserves any
       hand-curated metadata such as ``printout`` or ``runtime``).
    2. ``PY_TARGETS`` from the Makefile, with internal helpers filtered.
    """
    existing = _load_existing_pipeline(viewer_public)
    if existing and isinstance(existing.get("stages"), list) and existing["stages"]:
        return [dict(stage) for stage in existing["stages"]]

    target_names = _discover_makefile_targets(makefile)
    return [
        {
            "module": name,
            "runtime": "make",
            "args": {},
        }
        for name in target_names
    ]


# ---------------------------------------------------------------------------
# Pipeline execution
# ---------------------------------------------------------------------------


class PipelineStage:
    """Represents a single stage in the pipeline."""

    def __init__(self, name: str, extra_args: Optional[List[str]] = None) -> None:
        self.name = name
        self.extra_args = list(extra_args or [])

    def build_command(self) -> List[str]:
        """Build the ``make`` command for this stage."""
        return ["make", self.name, *self.extra_args]


class PipelineBuilder:
    """Builds and manages pipeline stages from CLI arguments."""

    def __init__(self) -> None:
        self._stages: List[PipelineStage] = []
        self._extra_args: List[str] = []

    def add_stage(self, name: str) -> "PipelineBuilder":
        """Append a stage to the pipeline."""
        self._stages.append(PipelineStage(name, self._extra_args.copy()))
        return self

    def set_extra_args(self, args: List[str]) -> "PipelineBuilder":
        """Set extra ``KEY=VALUE`` pairs that apply to every stage."""
        self._extra_args = list(args)
        for stage in self._stages:
            stage.extra_args = list(args)
        return self

    def parse_arguments(self, raw_args: Sequence[str]) -> "PipelineBuilder":
        """Parse raw ``argv`` style arguments into stages + KEY=VALUE args."""
        cleaned = [arg for arg in (raw_args or []) if arg != "--"]
        for arg in cleaned:
            if "=" in arg and not arg.startswith("-"):
                self._extra_args.append(arg)
            else:
                self.add_stage(arg)
        return self

    def build(self) -> List[PipelineStage]:
        """Return a copy of the configured stages."""
        return list(self._stages)


class StageResult:
    """Captured outcome of running a single pipeline stage."""

    def __init__(self, name: str, returncode: int, stdout: str, stderr: str) -> None:
        self.name = name
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    @property
    def ok(self) -> bool:
        return self.returncode == 0


class PipelineRunner:
    """Runs pipelines of ``make`` targets and captures per-stage output."""

    def __init__(self, input_file: Optional[str] = None) -> None:
        self.input_file = input_file
        self._last_results: List[StageResult] = []

    @property
    def last_results(self) -> List[StageResult]:
        """Return the results captured during the most recent ``run`` call."""
        return list(self._last_results)

    def run(self, stages: List[PipelineStage]) -> int:
        """Run the pipeline and return the exit code of the final stage."""
        if not stages:
            print("Error: No stages specified", file=sys.stderr)
            return 1

        results: List[StageResult] = []
        stdin_stream = self._open_input_stream()

        try:
            current_input = stdin_stream
            for index, stage in enumerate(stages):
                is_last = index == len(stages) - 1
                result = self._run_single_stage(stage, current_input, is_last)
                results.append(result)

                if not result.ok:
                    print(
                        f"Stage '{stage.name}' failed with exit code "
                        f"{result.returncode}; aborting pipeline",
                        file=sys.stderr,
                    )
                    if result.stderr:
                        sys.stderr.write(result.stderr)
                    self._last_results = results
                    return result.returncode

                # Stages chain via the captured stdout so we can both
                # display the final result and attribute each piece of
                # output to the producing stage.
                current_input = StringIO(result.stdout)
        finally:
            if self.input_file and stdin_stream is not None:
                try:
                    stdin_stream.close()
                except OSError:
                    pass

        self._last_results = results
        return 0

    def _open_input_stream(self):
        """Resolve the initial stdin source (file, piped data, or ``None``).

        Returns either a real file handle (when ``--input-file`` is given) or
        a ``StringIO`` snapshot of ``sys.stdin``.  We deliberately snapshot
        ``sys.stdin`` so subsequent stages can be fed via ``communicate``,
        which only accepts text/bytes -- not a live file object.
        """
        if self.input_file:
            try:
                return open(self.input_file, "r", encoding="utf-8")
            except OSError as exc:
                print(
                    f"Error opening input file '{self.input_file}': {exc}",
                    file=sys.stderr,
                )
                raise

        if not sys.stdin.isatty():
            data = sys.stdin.read()
            return StringIO(data)

        return None

    def _run_single_stage(
        self,
        stage: PipelineStage,
        stdin_source,
        is_last_stage: bool,
    ) -> StageResult:
        """Run one ``make`` target and return its captured output."""
        cmd_parts = stage.build_command()

        # Normalise the upstream source to a plain text string so we can
        # always feed the child via ``communicate(input=...)``.  ``None``
        # means "no stdin at all" (terminal-launched, first stage).
        stdin_text: Optional[str]
        if stdin_source is None:
            stdin_text = None
        else:
            stdin_text = stdin_source.read()

        try:
            proc = subprocess.Popen(
                cmd_parts,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except FileNotFoundError as exc:
            print(
                f"Error launching stage '{stage.name}': {exc}",
                file=sys.stderr,
            )
            return StageResult(stage.name, returncode=127, stdout="", stderr=str(exc))

        try:
            stdout, stderr = proc.communicate(input=stdin_text)
        except BrokenPipeError:
            # Downstream stage may have exited early; treat as a hard failure
            # for this stage rather than crashing the runner.
            proc.wait()
            return StageResult(
                stage.name,
                proc.returncode or 1,
                "",
                "broken pipe writing to stage stdin",
            )

        if is_last_stage and proc.returncode == 0:
            # Mirror the final stage's output to the caller's stdout so the
            # existing chained-pipeline behaviour is preserved.
            sys.stdout.write(stdout)

        return StageResult(stage.name, proc.returncode, stdout, stderr)


# ---------------------------------------------------------------------------
# pipeline.json output
# ---------------------------------------------------------------------------


def resolve_viewer_public_dir() -> Path:
    """Resolve the viewer's ``public/`` directory for writing the JSON.

    Honours the ``PIPELINE_VIEWER_DIR`` environment variable when set, then
    falls back to ``./nlp-pipeline-viewer/public`` (relative to CWD).
    """
    override = os.environ.get("PIPELINE_VIEWER_DIR", "").strip()
    if override:
        base = Path(override)
    else:
        base = DEFAULT_VIEWER_PUBLIC_DIR

    # Accept either ".../public" or ".../<viewer>" -- normalise to public.
    if base.name != "public":
        base = base / "public"
    return base


def _build_pipeline_payload(
    stages: Sequence[dict[str, object]],
    results: Sequence[StageResult],
) -> dict[str, object]:
    """Merge captured per-stage output into the stage descriptors."""
    name_to_result = {result.name: result for result in results}

    merged: list[dict[str, object]] = []
    for stage in stages:
        record = dict(stage)
        result = name_to_result.get(str(stage.get("module", "")))
        if result is not None:
            record["output"] = result.stdout
            record["stderr"] = result.stderr
            record["returncode"] = result.returncode
            record["status"] = "ok" if result.ok else "error"
        merged.append(record)

    return {
        "stages": merged,
        "metadata": {
            "version": "1.0",
            "created_at": _dt.date.today().isoformat(),
            "description": (
                "Generated by join-stages.py after running the chained "
                "makefile pipeline."
            ),
        },
    }


def write_pipeline_json(
    payload: dict[str, object],
    viewer_public: Path,
) -> Path:
    """Persist ``payload`` to ``viewer_public/pipeline.json`` atomically."""
    viewer_public.mkdir(parents=True, exist_ok=True)
    target = viewer_public / "pipeline.json"
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, target)
    return target


# ---------------------------------------------------------------------------
# CLI plumbing (preserved from the original implementation)
# ---------------------------------------------------------------------------


class ArgumentParser:
    """Argparse wrapper for the pipeline CLI."""

    def __init__(self) -> None:
        self._parser = argparse.ArgumentParser(
            description="Chain makefile recipe stages through shell piping",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""Examples:
  %(prog)s get-training-set hyper-analysis
  %(prog)s --input-file data.txt stage1 stage2
  %(prog)s -h, --help  Show this help message""",
        )
        self._parser.add_argument(
            "args",
            nargs="*",
            help="Stages (target names) followed by KEY=VALUE argument pairs",
        )
        self._parser.add_argument(
            "-i",
            "--input-file",
            dest="input_file",
            help="Input file to provide to the first stage via stdin",
        )

    def parse(self) -> argparse.Namespace:
        return self._parser.parse_args()


class PipelineCLI:
    """Command-line entry point for the pipeline tool."""

    def __init__(self) -> None:
        self.arg_parser = ArgumentParser()

    def run(self) -> int:
        args = self.arg_parser.parse()

        builder = PipelineBuilder()
        builder.parse_arguments(args.args or [])
        stages = builder.build()

        if not stages:
            self.arg_parser._parser.error(
                "No stages specified. Use -h for help."
            )
            return 1

        runner = PipelineRunner(input_file=args.input_file)
        exit_code = runner.run(stages)
        if exit_code != 0:
            return exit_code

        viewer_public = resolve_viewer_public_dir()
        stage_records = discover_stages(
            viewer_public=viewer_public,
            makefile=Path("Makefile"),
        )
        if not stage_records:
            # If neither an existing descriptor nor any Makefile targets
            # were found, synthesise a minimal record from the stages
            # that actually ran.
            stage_records = [
                {"module": stage.name, "runtime": "make", "args": {}}
                for stage in stages
            ]

        payload = _build_pipeline_payload(
            stages=stage_records,
            results=runner.last_results,
        )
        written = write_pipeline_json(payload, viewer_public)
        print(
            f"Wrote pipeline descriptor: {written} "
            f"({len(payload['stages'])} stage(s))",
            file=sys.stderr,
        )
        return 0


# Suppress broken pipe errors (common when piping to commands that exit early).
signal.signal(signal.SIGPIPE, signal.SIG_DFL)


if __name__ == "__main__":
    raise SystemExit(PipelineCLI().run())
