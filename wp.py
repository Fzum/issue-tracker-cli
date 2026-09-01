#!/usr/bin/env python3
"""Read-only command line interface for markdown-native work packages."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


STEM_PATTERN = re.compile(r"^wp-(?:[a-z][0-9]+)+$")
SEGMENT_PATTERN = re.compile(r"[a-z][0-9]+")
KEY_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")
VALID_STATUSES = frozenset({"todo", "doing", "done"})
TYPE_NAMES = {1: "milestone", 2: "epic", 3: "story"}


class WpError(Exception):
    """Base class for errors that should be shown without a traceback."""


class DirectoryError(WpError):
    """The work-package directory could not be read."""


class UnknownWpError(WpError):
    """A requested work-package ID does not exist."""


class FrontmatterError(WpError):
    """The frontmatter delimiters are missing or incomplete."""


class FrontmatterParseError(WpError):
    """The frontmatter is outside the supported YAML subset."""


@dataclass(frozen=True)
class Wp:
    """One parsed work-package file."""

    id: str
    path: Path
    fields: Mapping[str, Any]
    body: str

    @property
    def status(self) -> str | None:
        value = self.fields.get("status")
        return value if isinstance(value, str) and value else None

    @property
    def short_description(self) -> str:
        value = self.fields.get("short_description")
        return value if isinstance(value, str) else ""

    @property
    def blocked_by(self) -> tuple[str, ...]:
        value = self.fields.get("blocked_by", ())
        return tuple(value) if isinstance(value, (list, tuple)) else ()


@dataclass(frozen=True)
class ScannedFile:
    """A file discovered during a directory scan, parsed or otherwise."""

    path: Path
    id: str | None
    wp: Wp | None = None
    error: WpError | None = None


@dataclass(frozen=True, order=True)
class Problem:
    """A validation problem tied to a source file."""

    file: str
    message: str

    def __str__(self) -> str:
        return f"{self.file}: {self.message}"


def _line_without_ending(line: str) -> str:
    return line.removesuffix("\n").removesuffix("\r")


def _parse_scalar(value: str, *, line_number: int) -> str:
    value = value.strip()
    if not value:
        return ""

    starts_quoted = value[0] in {'"', "'"}
    ends_quoted = value[-1] in {'"', "'"}
    if starts_quoted or ends_quoted:
        if len(value) < 2 or value[0] != value[-1]:
            raise FrontmatterParseError(
                f"line {line_number}: unterminated or mismatched quoted scalar"
            )
        return value[1:-1]

    if value[0] in "|>&*!{}[]":
        raise FrontmatterParseError(
            f"line {line_number}: unsupported YAML scalar {value!r}"
        )
    return value


def _parse_inline_list(value: str, *, line_number: int) -> list[str]:
    value = value.strip()
    if not (value.startswith("[") and value.endswith("]")):
        raise FrontmatterParseError(
            f"line {line_number}: blocked_by must be an inline or block list"
        )

    content = value[1:-1].strip()
    if not content:
        return []

    entries: list[str] = []
    for raw_entry in content.split(","):
        entry = _parse_scalar(raw_entry, line_number=line_number)
        if not entry:
            raise FrontmatterParseError(
                f"line {line_number}: blocked_by entries cannot be empty"
            )
        entries.append(entry)
    return entries


def parse_frontmatter(lines: Sequence[str]) -> dict[str, Any]:
    """Parse the supported frontmatter subset from delimiter-free lines."""

    fields: dict[str, Any] = {}
    index = 0
    while index < len(lines):
        raw_line = _line_without_ending(lines[index])
        line_number = index + 2  # Account for the opening delimiter.
        index += 1

        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if raw_line[0].isspace():
            raise FrontmatterParseError(
                f"line {line_number}: unexpected indentation"
            )
        if ":" not in raw_line:
            raise FrontmatterParseError(
                f"line {line_number}: expected 'key: value'"
            )

        raw_key, raw_value = raw_line.split(":", 1)
        key = raw_key.strip()
        value = raw_value.strip()
        if not KEY_PATTERN.fullmatch(key):
            raise FrontmatterParseError(f"line {line_number}: invalid key {key!r}")
        if key in fields:
            raise FrontmatterParseError(f"line {line_number}: duplicate key {key!r}")

        if key != "blocked_by":
            if not value:
                raise FrontmatterParseError(
                    f"line {line_number}: empty values are only valid for a blocked_by block list"
                )
            fields[key] = _parse_scalar(value, line_number=line_number)
            continue

        if value:
            fields[key] = _parse_inline_list(value, line_number=line_number)
            continue

        entries: list[str] = []
        while index < len(lines):
            candidate = _line_without_ending(lines[index])
            candidate_line_number = index + 2
            if not candidate.strip() or candidate.lstrip().startswith("#"):
                index += 1
                continue
            match = re.fullmatch(r"[ \t]+-[ \t]+(.+)", candidate)
            if not match:
                break
            entry = _parse_scalar(match.group(1), line_number=candidate_line_number)
            if not entry:
                raise FrontmatterParseError(
                    f"line {candidate_line_number}: blocked_by entries cannot be empty"
                )
            entries.append(entry)
            index += 1
        if not entries:
            raise FrontmatterParseError(
                f"line {line_number}: blocked_by block list has no entries"
            )
        fields[key] = entries

    return fields


def parse_wp(path: Path) -> Wp:
    """Read and parse one work-package file."""

    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise DirectoryError(f"cannot read {path}: {error}") from error

    lines = content.splitlines(keepends=True)
    if not lines or _line_without_ending(lines[0]) != "---":
        raise FrontmatterError("frontmatter block missing")

    closing_index = next(
        (
            index
            for index, line in enumerate(lines[1:], start=1)
            if _line_without_ending(line) == "---"
        ),
        None,
    )
    if closing_index is None:
        raise FrontmatterError("frontmatter block unterminated")

    fields = parse_frontmatter(lines[1:closing_index])
    fields.setdefault("blocked_by", [])
    return Wp(
        id=path.stem,
        path=path,
        fields=fields,
        body="".join(lines[closing_index + 1 :]),
    )


def stem_segments(stem: str) -> tuple[str, ...]:
    """Return the validated stem's segments."""

    if not STEM_PATTERN.fullmatch(stem):
        raise ValueError(f"invalid work-package stem: {stem}")
    return tuple(SEGMENT_PATTERN.findall(stem[3:]))


def parent_id(stem: str) -> str | None:
    segments = stem_segments(stem)
    return None if len(segments) == 1 else f"wp-{''.join(segments[:-1])}"


def natural_sort_key(stem: str) -> tuple[tuple[str, int], ...]:
    """Sort stems by segment letter and numeric value."""

    return tuple((segment[0], int(segment[1:])) for segment in stem_segments(stem))


def scan_directory(directory: Path) -> list[ScannedFile]:
    """Read every regular file in a work-package directory."""

    try:
        paths = sorted(
            (path for path in directory.iterdir() if path.is_file()),
            key=lambda path: path.name,
        )
    except OSError as error:
        raise DirectoryError(f"cannot read directory {directory}: {error}") from error

    if not directory.is_dir():
        raise DirectoryError(f"cannot read directory {directory}: not a directory")

    scanned: list[ScannedFile] = []
    for path in paths:
        stem = path.stem if path.suffix == ".md" else None
        wp_id = stem if stem is not None and STEM_PATTERN.fullmatch(stem) else None
        try:
            wp = parse_wp(path)
        except (FrontmatterError, FrontmatterParseError) as error:
            scanned.append(ScannedFile(path=path, id=wp_id, error=error))
        else:
            scanned.append(ScannedFile(path=path, id=wp_id, wp=wp))
    return scanned


class WpGraph:
    """Hierarchy and dependency queries derived from parsed work packages."""

    def __init__(self, work_packages: Iterable[Wp]) -> None:
        self.by_id = {wp.id: wp for wp in work_packages}
        self.ordered_ids = tuple(sorted(self.by_id, key=natural_sort_key))
        self._segments = {wp_id: stem_segments(wp_id) for wp_id in self.by_id}
        container_ids = {
            f"wp-{''.join(segments[:depth])}"
            for segments in self._segments.values()
            for depth in range(1, len(segments))
        }
        self._leaf_ids = self.by_id.keys() - container_ids

        children: dict[str, list[str]] = {wp_id: [] for wp_id in self.by_id}
        blocks: dict[str, list[str]] = {wp_id: [] for wp_id in self.by_id}
        for wp in self.by_id.values():
            parent = parent_id(wp.id)
            if parent in children:
                children[parent].append(wp.id)
            for target in wp.blocked_by:
                if target in blocks:
                    blocks[target].append(wp.id)

        self.children = {
            wp_id: tuple(sorted(ids, key=natural_sort_key))
            for wp_id, ids in children.items()
        }
        self.blocks = {
            wp_id: tuple(sorted(ids, key=natural_sort_key))
            for wp_id, ids in blocks.items()
        }
        self._status_cache: dict[str, str | None] = {}

    def type_name(self, wp_id: str) -> str:
        depth = len(self._segments[wp_id])
        return TYPE_NAMES.get(depth, "task")

    def is_leaf(self, wp_id: str) -> bool:
        return wp_id in self._leaf_ids

    def resolved_status(self, wp_id: str) -> str | None:
        """Return written leaf status or recursively rolled-up container status."""

        if wp_id in self._status_cache:
            return self._status_cache[wp_id]

        wp = self.by_id[wp_id]
        if self.is_leaf(wp_id):
            status = wp.status
        else:
            child_statuses = [
                self.resolved_status(child_id) for child_id in self.children[wp_id]
            ]
            if not child_statuses or any(status is None for status in child_statuses):
                status = None
            elif all(status == "done" for status in child_statuses):
                status = "done"
            elif any(status in {"doing", "done"} for status in child_statuses):
                status = "doing"
            else:
                status = "todo"

        self._status_cache[wp_id] = status
        return status

    def ancestors(self, wp_id: str) -> tuple[str, ...]:
        result: list[str] = []
        candidate = parent_id(wp_id)
        while candidate is not None:
            if candidate in self.by_id:
                result.append(candidate)
            candidate = parent_id(candidate)
        return tuple(result)

    def is_ready(self, wp_id: str) -> bool:
        wp = self.by_id[wp_id]
        if not self.is_leaf(wp_id) or wp.status != "todo":
            return False

        dependency_ids = [
            dependency
            for owner_id in (wp_id, *self.ancestors(wp_id))
            for dependency in self.by_id[owner_id].blocked_by
        ]
        return all(
            dependency in self.by_id
            and self.resolved_status(dependency) == "done"
            for dependency in dependency_ids
        )

    def ready_queue(self) -> list[Wp]:
        return [self.by_id[wp_id] for wp_id in self.ordered_ids if self.is_ready(wp_id)]

    def dependency_cycles(self) -> list[tuple[str, ...]]:
        """Return dependency cycles as strongly connected components."""

        index = 0
        indices: dict[str, int] = {}
        low_links: dict[str, int] = {}
        stack: list[str] = []
        on_stack: set[str] = set()
        cycles: list[tuple[str, ...]] = []

        def visit(wp_id: str) -> None:
            nonlocal index
            indices[wp_id] = index
            low_links[wp_id] = index
            index += 1
            stack.append(wp_id)
            on_stack.add(wp_id)

            for dependency in self.by_id[wp_id].blocked_by:
                if dependency not in self.by_id:
                    continue
                if dependency not in indices:
                    visit(dependency)
                    low_links[wp_id] = min(low_links[wp_id], low_links[dependency])
                elif dependency in on_stack:
                    low_links[wp_id] = min(low_links[wp_id], indices[dependency])

            if low_links[wp_id] != indices[wp_id]:
                return

            component: list[str] = []
            while True:
                member = stack.pop()
                on_stack.remove(member)
                component.append(member)
                if member == wp_id:
                    break
            has_self_edge = (
                len(component) == 1
                and component[0] in self.by_id[component[0]].blocked_by
            )
            if len(component) > 1 or has_self_edge:
                cycles.append(tuple(sorted(component, key=natural_sort_key)))

        for wp_id in self.ordered_ids:
            if wp_id not in indices:
                visit(wp_id)
        return sorted(cycles, key=lambda cycle: natural_sort_key(cycle[0]))


def graph_from_scan(scanned: Iterable[ScannedFile]) -> WpGraph:
    return WpGraph(
        entry.wp
        for entry in scanned
        if entry.id is not None and entry.wp is not None
    )


def check(scanned: Sequence[ScannedFile]) -> list[Problem]:
    """Validate all files and relationships, returning every found problem."""

    problems: list[Problem] = []
    for entry in scanned:
        if entry.id is None:
            problems.append(
                Problem(entry.path.name, "filename does not match wp-<segments>.md grammar")
            )
        if entry.error is not None:
            problems.append(Problem(entry.path.name, str(entry.error)))

    graph = graph_from_scan(scanned)
    for wp_id in graph.ordered_ids:
        wp = graph.by_id[wp_id]
        is_leaf = graph.is_leaf(wp_id)
        if not wp.short_description.strip():
            problems.append(Problem(wp.path.name, "short_description missing or empty"))
        if is_leaf and "status" not in wp.fields:
            problems.append(Problem(wp.path.name, "status missing on leaf"))
        if not is_leaf and "status" in wp.fields:
            problems.append(Problem(wp.path.name, "status present on container"))
        if "status" in wp.fields and wp.fields["status"] not in VALID_STATUSES:
            problems.append(
                Problem(
                    wp.path.name,
                    "status must be one of todo, doing, done",
                )
            )

        for dependency in wp.blocked_by:
            if dependency not in graph.by_id:
                problems.append(
                    Problem(wp.path.name, f"blocked_by references unknown WP {dependency}")
                )
            if dependency == wp_id:
                problems.append(
                    Problem(wp.path.name, "blocked_by references the WP itself")
                )

        parent = parent_id(wp_id)
        if parent is not None and parent not in graph.by_id:
            problems.append(Problem(wp.path.name, f"parent WP {parent} has no file"))

    for cycle in graph.dependency_cycles():
        first = graph.by_id[cycle[0]]
        problems.append(
            Problem(first.path.name, f"blocked_by cycle: {', '.join(cycle)}")
        )

    return sorted(problems)


def load_graph(directory: Path) -> WpGraph:
    """Load queryable work packages, rejecting parse-level corruption."""

    scanned = scan_directory(directory)
    parse_problems = [
        Problem(entry.path.name, str(entry.error))
        for entry in scanned
        if entry.error is not None
    ]
    invalid_names = [entry.path.name for entry in scanned if entry.id is None]
    if parse_problems or invalid_names:
        details = [str(problem) for problem in parse_problems]
        details.extend(f"{name}: invalid filename" for name in invalid_names)
        raise DirectoryError(
            "invalid work-package directory; run 'wp.py check': "
            + "; ".join(details)
        )
    return graph_from_scan(scanned)


def _wp_json(graph: WpGraph, wp: Wp) -> dict[str, Any]:
    status = graph.resolved_status(wp.id)
    result: dict[str, Any] = {
        "id": wp.id,
        **wp.fields,
        "type": graph.type_name(wp.id),
        "is_leaf": graph.is_leaf(wp.id),
        "parent": parent_id(wp.id),
        "children": list(graph.children[wp.id]),
        "blocks": list(graph.blocks[wp.id]),
        "ready": graph.is_ready(wp.id),
        "body": wp.body,
    }
    if not graph.is_leaf(wp.id):
        result["rolled_up_status"] = status
    return result


def _next_json(wp: Wp) -> dict[str, str]:
    return {
        "id": wp.id,
        "status": wp.status or "",
        "short_description": wp.short_description,
    }


def _print_next(graph: WpGraph, *, all_ready: bool, as_json: bool) -> None:
    ready = graph.ready_queue()
    selected = ready if all_ready else ready[:1]
    if not selected and not all_ready:
        return
    if as_json:
        payload: Any = (
            [_next_json(wp) for wp in selected]
            if all_ready
            else _next_json(selected[0])
        )
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    for wp in selected:
        print(f"{wp.id}\t{wp.status}\t{wp.short_description}")


def _print_show(graph: WpGraph, wp_id: str, *, as_json: bool) -> None:
    if wp_id not in graph.by_id:
        raise UnknownWpError(f"unknown work-package ID: {wp_id}")
    wp = graph.by_id[wp_id]
    payload = _wp_json(graph, wp)
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return

    display_order = (
        "id",
        "short_description",
        "status",
        "rolled_up_status",
        "blocked_by",
        "type",
        "is_leaf",
        "parent",
        "children",
        "blocks",
        "ready",
    )
    shown = set(display_order) | {"body"}
    for key in display_order:
        if key in payload:
            value = payload[key]
            if isinstance(value, list):
                value = f"[{', '.join(value)}]"
            elif value is None:
                value = ""
            elif isinstance(value, bool):
                value = str(value).lower()
            print(f"{key}: {value}")
    for key in sorted(payload.keys() - shown):
        print(f"{key}: {payload[key]}")
    if wp.body:
        print()
        print(wp.body, end="" if wp.body.endswith("\n") else "\n")


def _tree_rows(graph: WpGraph) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for wp_id in graph.ordered_ids:
        wp = graph.by_id[wp_id]
        rows.append(
            {
                "id": wp_id,
                "status": graph.resolved_status(wp_id),
                "short_description": wp.short_description,
                "depth": len(stem_segments(wp_id)),
            }
        )
    return rows


def _print_tree(graph: WpGraph, *, as_json: bool) -> None:
    rows = _tree_rows(graph)
    if as_json:
        print(json.dumps(rows, indent=2, sort_keys=True))
        return
    for row in rows:
        indent = "  " * (row["depth"] - 1)
        print(
            f"{indent}{row['id']}\t{row['status'] or 'invalid'}\t{row['short_description']}"
        )


def _print_check(problems: Sequence[Problem], *, as_json: bool) -> None:
    if as_json:
        payload = [
            {"file": problem.file, "problem": problem.message}
            for problem in problems
        ]
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    for problem in problems:
        print(problem)


def _add_common_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--dir",
        dest="directory",
        type=Path,
        default=argparse.SUPPRESS,
        help="work-package directory (default: ./wps)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        default=argparse.SUPPRESS,
        help="emit machine-readable JSON",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wp.py")
    _add_common_options(parser)
    parser.set_defaults(directory=Path("wps"), json=False)
    commands = parser.add_subparsers(dest="command", required=True)

    next_parser = commands.add_parser("next", help="print ready work")
    _add_common_options(next_parser)
    next_parser.add_argument("--all", action="store_true", help="print every ready WP")

    show_parser = commands.add_parser("show", help="show one work package")
    _add_common_options(show_parser)
    show_parser.add_argument("id", help="work-package ID")

    tree_parser = commands.add_parser("tree", help="show the work-package tree")
    _add_common_options(tree_parser)

    check_parser = commands.add_parser("check", help="validate work packages")
    _add_common_options(check_parser)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "check":
            problems = check(scan_directory(args.directory))
            _print_check(problems, as_json=args.json)
            return 1 if problems else 0

        graph = load_graph(args.directory)
        if args.command == "next":
            _print_next(graph, all_ready=args.all, as_json=args.json)
        elif args.command == "show":
            _print_show(graph, args.id, as_json=args.json)
        elif args.command == "tree":
            _print_tree(graph, as_json=args.json)
        return 0
    except WpError as error:
        print(f"wp.py: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
