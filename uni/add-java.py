"""Scaffold Java modules under rarebert-host Maven source roots."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path

from devlib import run


JAVA_SRC_ROOT = Path("rarebert-host/src/main/java")
JAVA_TEMPLATE_ROOT = Path("rarebert-host/src/templates")


def available_template_names() -> list[str]:
    """Return available Java template filenames sorted alphabetically."""
    if not JAVA_TEMPLATE_ROOT.exists():
        return []
    return sorted(path.name for path in JAVA_TEMPLATE_ROOT.glob("*.java") if path.is_file())


def normalize_class_name(raw_name: str) -> str:
    """Normalize user input into a valid Java class name."""
    class_name = raw_name.strip()
    if class_name.endswith(".java"):
        class_name = class_name[:-5]

    if not class_name:
        raise ValueError("module name must not be empty")

    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", class_name):
        raise ValueError("module name must be a valid Java identifier")

    return class_name


def normalize_package(raw_package: str) -> str:
    """Normalize optional Java package path."""
    package_name = raw_package.strip()
    if not package_name:
        return ""

    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*", package_name):
        raise ValueError("package must be dot-separated Java identifiers")

    return package_name


def minimal_scaffold(class_name: str, package_name: str) -> str:
    """Return a minimal Java class scaffold."""
    package_block = f"package {package_name};\n\n" if package_name else ""
    return (
        f"{package_block}public class {class_name} {{\n"
        "    // TODO: implement class logic\n"
        "}\n"
    )


def load_template_path(copy_name: str) -> Path:
    """Resolve one template path from src/templates by logical name."""
    candidate = copy_name.strip()
    if not candidate:
        raise ValueError("copy template name must not be empty")

    candidate_filenames: list[str] = []
    if candidate.endswith(".java"):
        candidate_filenames.append(candidate)
    else:
        candidate_filenames.append(f"{candidate}.java")
        candidate_filenames.append(f"{candidate}Template.java")

    for filename in candidate_filenames:
        template_path = JAVA_TEMPLATE_ROOT / filename
        if template_path.exists():
            return template_path

    templates = available_template_names()
    if templates:
        available_text = ", ".join(templates)
        raise FileNotFoundError(
            f"template not found for copy '{copy_name}' in {JAVA_TEMPLATE_ROOT}. "
            f"Available templates: {available_text}"
        )
    raise FileNotFoundError(
        f"template not found for copy '{copy_name}' in {JAVA_TEMPLATE_ROOT}. "
        "No templates available."
    )


def render_from_template(template_path: Path, class_name: str, package_name: str) -> str:
    """Copy template content and rename the top-level type name via sed."""
    source = template_path.read_text(encoding="utf-8")
    sed_expr = (
        r"0,/\b(class|interface|enum|record)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*/"
        rf"s//\1 {class_name}/"
    )
    result = subprocess.run(
        ["sed", "-E", sed_expr],
        input=source,
        text=True,
        capture_output=True,
        check=True,
    )
    rendered = result.stdout

    if package_name:
        package_line = f"package {package_name};"
        if re.search(r"^\s*package\s+[^;]+;", rendered, flags=re.MULTILINE):
            rendered = re.sub(
                r"^\s*package\s+[^;]+;",
                package_line,
                rendered,
                count=1,
                flags=re.MULTILINE,
            )
        else:
            rendered = f"{package_line}\n\n{rendered.lstrip()}"
    else:
        rendered = re.sub(r"^\s*package\s+[^;]+;\s*\n", "", rendered, count=1, flags=re.MULTILINE)

    if not rendered.endswith("\n"):
        rendered += "\n"
    return rendered


def create_java_module(module: str, package_name: str = "", copy_name: str = "") -> Path:
    """Create one Java class file at the expected Maven source location."""
    class_name = normalize_class_name(module)
    package_name = normalize_package(package_name)

    target_dir = JAVA_SRC_ROOT
    if package_name:
        target_dir = target_dir / package_name.replace(".", "/")
    target_dir.mkdir(parents=True, exist_ok=True)

    target_path = target_dir / f"{class_name}.java"
    if target_path.exists():
        raise FileExistsError(f"{target_path.name} already exists")

    if copy_name:
        template_path = load_template_path(copy_name)
        content = render_from_template(
            template_path,
            class_name=class_name,
            package_name=package_name,
        )
    else:
        content = minimal_scaffold(class_name=class_name, package_name=package_name)

    target_path.write_text(content, encoding="utf-8")
    return target_path


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments for Java module scaffolding."""
    parser = argparse.ArgumentParser(description="Scaffold Java modules in rarebert-host.")
    subparsers = parser.add_subparsers(dest="command")

    add_parser = subparsers.add_parser("add", help="Create a new Java module")
    add_parser.add_argument("--module", required=True, help="Java class name, with or without .java")
    add_parser.add_argument("--package", default="", help="Optional Java package, e.g. com.akinevz.agents")
    add_parser.add_argument("--copy", default="", help="Optional template name from src/templates")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command != "add":
        print("Usage: python3 add-java.py add --module <Name> [--package <pkg>] [--copy <Template>]")
        return 2

    try:
        created = create_java_module(args.module, package_name=args.package, copy_name=args.copy)
    except (ValueError, FileExistsError, FileNotFoundError) as exc:
        print(f"Error: {exc}")
        return 1

    print(f"Created module: {created}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
