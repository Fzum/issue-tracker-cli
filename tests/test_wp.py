from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import wp  # noqa: E402


class WpFixtureTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.directory = Path(self.temporary_directory.name) / "wps"
        self.directory.mkdir()

    def given_wp(
        self,
        wp_id: str,
        *,
        status: str | None = "todo",
        description: str | None = None,
        blocked_by: list[str] | None = None,
        extra_frontmatter: str = "",
        body: str = "\n## Context\nWork package body.\n",
    ) -> Path:
        lines = ["---"]
        if status is not None:
            lines.append(f"status: {status}")
        if blocked_by is not None:
            lines.append(f"blocked_by: [{', '.join(blocked_by)}]")
        if description is not None:
            lines.append(f'short_description: "{description}"')
        if extra_frontmatter:
            lines.extend(extra_frontmatter.strip("\n").splitlines())
        lines.append("---")
        path = self.directory / f"{wp_id}.md"
        path.write_text("\n".join(lines) + body, encoding="utf-8")
        return path

    def given_raw_file(self, filename: str, content: str) -> Path:
        path = self.directory / filename
        path.write_text(content, encoding="utf-8")
        return path

    def when_checked(self) -> list[wp.Problem]:
        return wp.check(wp.scan_directory(self.directory))

    def given_graph(self) -> wp.WpGraph:
        return wp.load_graph(self.directory)

    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "wp.py"), *arguments],
            text=True,
            capture_output=True,
            check=False,
        )


class ParseTests(WpFixtureTestCase):
    def test_given_valid_leaf_when_parsed_then_fields_and_body_are_returned(self) -> None:
        # Given
        path = self.given_wp(
            "wp-m1", description="First milestone task", body="\nTicket body\n"
        )

        # When
        work_package = wp.parse_wp(path)

        # Then
        self.assertEqual("wp-m1", work_package.id)
        self.assertEqual("todo", work_package.status)
        self.assertEqual("First milestone task", work_package.short_description)
        self.assertEqual("Ticket body\n", work_package.body)

    def test_given_valid_container_when_parsed_then_blocked_by_defaults_empty(self) -> None:
        # Given
        path = self.given_wp(
            "wp-m1", status=None, description="Authentication milestone"
        )

        # When
        work_package = wp.parse_wp(path)

        # Then
        self.assertEqual((), work_package.blocked_by)

    def test_given_inline_blocked_by_when_parsed_then_dependencies_are_returned(self) -> None:
        # Given
        path = self.given_wp(
            "wp-m1",
            description="Dependent work",
            blocked_by=["wp-m2", "wp-m10e2"],
        )

        # When
        work_package = wp.parse_wp(path)

        # Then
        self.assertEqual(("wp-m2", "wp-m10e2"), work_package.blocked_by)

    def test_given_block_list_when_parsed_then_dependencies_are_returned(self) -> None:
        # Given
        path = self.given_raw_file(
            "wp-m1.md",
            """---
status: todo
blocked_by:
  - wp-m2
  - 'wp-m3'
short_description: Block list
---
Body
""",
        )

        # When
        work_package = wp.parse_wp(path)

        # Then
        self.assertEqual(("wp-m2", "wp-m3"), work_package.blocked_by)

    def test_given_unknown_scalar_field_when_parsed_then_it_is_preserved(self) -> None:
        # Given
        path = self.given_wp(
            "wp-m1",
            description="Extensible work package",
            extra_frontmatter="priority: high",
        )

        # When
        work_package = wp.parse_wp(path)

        # Then
        self.assertEqual("high", work_package.fields["priority"])

    def test_given_missing_frontmatter_when_parsed_then_clear_error_is_raised(self) -> None:
        # Given
        path = self.given_raw_file("wp-m1.md", "No frontmatter\n")

        # When / Then
        with self.assertRaisesRegex(wp.FrontmatterError, "missing"):
            wp.parse_wp(path)

    def test_given_unterminated_frontmatter_when_parsed_then_clear_error_is_raised(self) -> None:
        # Given
        path = self.given_raw_file(
            "wp-m1.md", "---\nstatus: todo\nshort_description: Work\n"
        )

        # When / Then
        with self.assertRaisesRegex(wp.FrontmatterError, "unterminated"):
            wp.parse_wp(path)

    def test_given_line_without_colon_when_parsed_then_subset_error_is_raised(self) -> None:
        # Given
        path = self.given_raw_file(
            "wp-m1.md", "---\nstatus todo\nshort_description: Work\n---\n"
        )

        # When / Then
        with self.assertRaisesRegex(wp.FrontmatterParseError, "key: value"):
            wp.parse_wp(path)

    def test_given_nested_map_when_parsed_then_subset_error_is_raised(self) -> None:
        # Given
        path = self.given_raw_file(
            "wp-m1.md",
            "---\nstatus: todo\nshort_description: Work\nmetadata:\n  owner: agent\n---\n",
        )

        # When / Then
        with self.assertRaises(wp.FrontmatterParseError):
            wp.parse_wp(path)

    def test_given_multiline_scalar_when_parsed_then_subset_error_is_raised(self) -> None:
        # Given
        path = self.given_raw_file(
            "wp-m1.md",
            "---\nstatus: todo\nshort_description: |\n  Multiple lines\n---\n",
        )

        # When / Then
        with self.assertRaisesRegex(wp.FrontmatterParseError, "unsupported YAML"):
            wp.parse_wp(path)

    def test_given_anchor_when_parsed_then_subset_error_is_raised(self) -> None:
        # Given
        path = self.given_raw_file(
            "wp-m1.md",
            "---\nstatus: todo\nshort_description: &summary Work\n---\n",
        )

        # When / Then
        with self.assertRaisesRegex(wp.FrontmatterParseError, "unsupported YAML"):
            wp.parse_wp(path)


class GraphTests(WpFixtureTestCase):
    def test_given_hierarchy_when_graph_built_then_parent_children_and_types_are_derived(self) -> None:
        # Given
        self.given_wp("wp-m1", status=None, description="Milestone")
        self.given_wp("wp-m1e1", status=None, description="Epic")
        self.given_wp("wp-m1e1u1", description="Story")
        self.given_wp("wp-m1e1u1t1", description="Task")

        # When
        graph = self.given_graph()

        # Then
        self.assertEqual("wp-m1e1", wp.parent_id("wp-m1e1u1"))
        self.assertEqual(("wp-m1e1",), graph.children["wp-m1"])
        self.assertEqual("milestone", graph.type_name("wp-m1"))
        self.assertEqual("epic", graph.type_name("wp-m1e1"))
        self.assertEqual("story", graph.type_name("wp-m1e1u1"))
        self.assertEqual("task", graph.type_name("wp-m1e1u1t1"))

    def test_given_dependencies_when_graph_built_then_blocks_are_inverted(self) -> None:
        # Given
        self.given_wp("wp-m1", description="First", blocked_by=["wp-m2"])
        self.given_wp("wp-m2", description="Second")
        self.given_wp("wp-m3", description="Third", blocked_by=["wp-m2"])

        # When
        graph = self.given_graph()

        # Then
        self.assertEqual(("wp-m1", "wp-m3"), graph.blocks["wp-m2"])

    def test_given_self_edge_when_cycles_detected_then_member_is_reported(self) -> None:
        # Given
        self.given_wp("wp-m1", description="Self cycle", blocked_by=["wp-m1"])

        # When
        cycles = self.given_graph().dependency_cycles()

        # Then
        self.assertEqual([("wp-m1",)], cycles)

    def test_given_two_node_cycle_when_cycles_detected_then_both_members_are_reported(self) -> None:
        # Given
        self.given_wp("wp-m1", description="First", blocked_by=["wp-m2"])
        self.given_wp("wp-m2", description="Second", blocked_by=["wp-m1"])

        # When
        cycles = self.given_graph().dependency_cycles()

        # Then
        self.assertEqual([("wp-m1", "wp-m2")], cycles)

    def test_given_long_cycle_when_cycles_detected_then_all_members_are_reported(self) -> None:
        # Given
        self.given_wp("wp-m1", description="First", blocked_by=["wp-m2"])
        self.given_wp("wp-m2", description="Second", blocked_by=["wp-m3"])
        self.given_wp("wp-m3", description="Third", blocked_by=["wp-m1"])

        # When
        cycles = self.given_graph().dependency_cycles()

        # Then
        self.assertEqual([("wp-m1", "wp-m2", "wp-m3")], cycles)


class QueryTests(WpFixtureTestCase):
    def given_container_with_child_statuses(self, *statuses: str) -> wp.WpGraph:
        self.given_wp("wp-m1", status=None, description="Milestone")
        for number, status in enumerate(statuses, start=1):
            self.given_wp(
                f"wp-m1e{number}", status=status, description=f"Child {number}"
            )
        return self.given_graph()

    def test_given_all_todo_children_when_status_resolved_then_container_is_todo(self) -> None:
        # Given
        graph = self.given_container_with_child_statuses("todo", "todo")

        # When
        status = graph.resolved_status("wp-m1")

        # Then
        self.assertEqual("todo", status)

    def test_given_doing_child_when_status_resolved_then_container_is_doing(self) -> None:
        # Given
        graph = self.given_container_with_child_statuses("todo", "doing")

        # When
        status = graph.resolved_status("wp-m1")

        # Then
        self.assertEqual("doing", status)

    def test_given_done_and_todo_children_when_status_resolved_then_container_is_doing(self) -> None:
        # Given
        graph = self.given_container_with_child_statuses("done", "todo")

        # When
        status = graph.resolved_status("wp-m1")

        # Then
        self.assertEqual("doing", status)

    def test_given_all_done_children_when_status_resolved_then_container_is_done(self) -> None:
        # Given
        graph = self.given_container_with_child_statuses("done", "done")

        # When
        status = graph.resolved_status("wp-m1")

        # Then
        self.assertEqual("done", status)

    def test_given_unfinished_leaf_dependency_when_ready_queried_then_leaf_is_blocked(self) -> None:
        # Given
        self.given_wp("wp-m1", description="Dependent", blocked_by=["wp-m2"])
        self.given_wp("wp-m2", status="doing", description="Dependency")

        # When
        ready = self.given_graph().is_ready("wp-m1")

        # Then
        self.assertFalse(ready)

    def test_given_done_container_dependency_when_ready_queried_then_leaf_is_ready(self) -> None:
        # Given
        self.given_wp("wp-m1", description="Dependent", blocked_by=["wp-m2"])
        self.given_wp("wp-m2", status=None, description="Dependency milestone")
        self.given_wp("wp-m2e1", status="done", description="Done dependency")

        # When
        ready = self.given_graph().is_ready("wp-m1")

        # Then
        self.assertTrue(ready)

    def test_given_ancestor_dependency_when_ready_queried_then_descendant_is_blocked(self) -> None:
        # Given
        self.given_wp(
            "wp-m1", status=None, description="Blocked milestone", blocked_by=["wp-m2"]
        )
        self.given_wp("wp-m1e1", description="Otherwise ready leaf")
        self.given_wp("wp-m2", status="todo", description="Dependency")

        # When
        ready = self.given_graph().is_ready("wp-m1e1")

        # Then
        self.assertFalse(ready)

    def test_given_m2_and_m10_when_ready_queue_built_then_natural_order_is_used(self) -> None:
        # Given
        self.given_wp("wp-m10", description="Tenth")
        self.given_wp("wp-m2", description="Second")

        # When
        ready_ids = [work_package.id for work_package in self.given_graph().ready_queue()]

        # Then
        self.assertEqual(["wp-m2", "wp-m10"], ready_ids)

    def test_given_no_todo_leaves_when_ready_queue_built_then_queue_is_empty(self) -> None:
        # Given
        self.given_wp("wp-m1", status="done", description="Completed")

        # When
        ready = self.given_graph().ready_queue()

        # Then
        self.assertEqual([], ready)


class CheckTests(WpFixtureTestCase):
    def assert_problem_contains(self, expected: str) -> None:
        messages = [problem.message for problem in self.when_checked()]
        self.assertTrue(
            any(expected in message for message in messages),
            f"Expected {expected!r} in {messages!r}",
        )

    def test_given_bad_filename_when_checked_then_filename_problem_is_reported(self) -> None:
        # Given
        self.given_raw_file(
            "milestone.md",
            "---\nstatus: todo\nshort_description: Work\n---\n",
        )

        # When / Then
        self.assert_problem_contains("filename does not match")

    def test_given_missing_frontmatter_when_checked_then_missing_problem_is_reported(self) -> None:
        # Given
        self.given_raw_file("wp-m1.md", "Ticket body\n")

        # When / Then
        self.assert_problem_contains("frontmatter block missing")

    def test_given_unterminated_frontmatter_when_checked_then_unterminated_problem_is_reported(self) -> None:
        # Given
        self.given_raw_file("wp-m1.md", "---\nstatus: todo\n")

        # When / Then
        self.assert_problem_contains("frontmatter block unterminated")

    def test_given_invalid_subset_yaml_when_checked_then_parse_problem_is_reported(self) -> None:
        # Given
        self.given_raw_file(
            "wp-m1.md", "---\nstatus todo\nshort_description: Work\n---\n"
        )

        # When / Then
        self.assert_problem_contains("expected 'key: value'")

    def test_given_empty_description_when_checked_then_description_problem_is_reported(self) -> None:
        # Given
        self.given_wp("wp-m1", description="")

        # When / Then
        self.assert_problem_contains("short_description missing or empty")

    def test_given_leaf_without_status_when_checked_then_missing_status_is_reported(self) -> None:
        # Given
        self.given_wp("wp-m1", status=None, description="Leaf")

        # When / Then
        self.assert_problem_contains("status missing on leaf")

    def test_given_container_with_status_when_checked_then_container_status_is_reported(self) -> None:
        # Given
        self.given_wp("wp-m1", description="Container")
        self.given_wp("wp-m1e1", description="Child")

        # When / Then
        self.assert_problem_contains("status present on container")

    def test_given_invalid_status_when_checked_then_allowed_statuses_are_reported(self) -> None:
        # Given
        self.given_wp("wp-m1", status="cancelled", description="Invalid state")

        # When / Then
        self.assert_problem_contains("todo, doing, done")

    def test_given_unknown_dependency_when_checked_then_reference_problem_is_reported(self) -> None:
        # Given
        self.given_wp(
            "wp-m1", description="Unknown dependency", blocked_by=["wp-m99"]
        )

        # When / Then
        self.assert_problem_contains("references unknown WP wp-m99")

    def test_given_self_dependency_when_checked_then_self_reference_is_reported(self) -> None:
        # Given
        self.given_wp("wp-m1", description="Self dependency", blocked_by=["wp-m1"])

        # When / Then
        self.assert_problem_contains("references the WP itself")

    def test_given_dependency_cycle_when_checked_then_all_cycle_members_are_reported(self) -> None:
        # Given
        self.given_wp("wp-m1", description="First", blocked_by=["wp-m2"])
        self.given_wp("wp-m2", description="Second", blocked_by=["wp-m1"])

        # When / Then
        self.assert_problem_contains("blocked_by cycle: wp-m1, wp-m2")

    def test_given_missing_parent_when_checked_then_orphan_problem_is_reported(self) -> None:
        # Given
        self.given_wp("wp-m1e1u1", description="Orphan")

        # When / Then
        self.assert_problem_contains("parent WP wp-m1e1 has no file")

    def test_given_valid_folder_when_checked_then_no_problems_are_returned(self) -> None:
        # Given
        self.given_wp("wp-m1", status=None, description="Milestone")
        self.given_wp("wp-m1e1", status="done", description="Completed epic")
        self.given_wp(
            "wp-m2", description="Ready after milestone", blocked_by=["wp-m1"]
        )

        # When
        problems = self.when_checked()

        # Then
        self.assertEqual([], problems)


class CliTests(WpFixtureTestCase):
    def test_given_ready_work_when_next_run_then_first_natural_item_is_printed(self) -> None:
        # Given
        self.given_wp("wp-m10", description="Tenth")
        self.given_wp("wp-m2", description="Second")

        # When
        result = self.run_cli("next", "--dir", str(self.directory))

        # Then
        self.assertEqual(0, result.returncode)
        self.assertEqual("wp-m2\ttodo\tSecond\n", result.stdout)

    def test_given_ready_work_when_next_all_json_run_then_stable_array_is_printed(self) -> None:
        # Given
        self.given_wp("wp-m2", description="Second")
        self.given_wp("wp-m1", status="done", description="Completed")

        # When
        result = self.run_cli(
            "next", "--all", "--json", "--dir", str(self.directory)
        )

        # Then
        self.assertEqual(0, result.returncode)
        self.assertEqual(
            [
                {
                    "id": "wp-m2",
                    "short_description": "Second",
                    "status": "todo",
                }
            ],
            json.loads(result.stdout),
        )

    def test_given_empty_queue_when_next_json_run_then_nothing_and_success_are_returned(self) -> None:
        # Given
        self.given_wp("wp-m1", status="done", description="Completed")

        # When
        result = self.run_cli("--dir", str(self.directory), "--json", "next")

        # Then
        self.assertEqual(0, result.returncode)
        self.assertEqual("", result.stdout)

    def test_given_known_container_when_show_json_run_then_derived_shape_is_printed(self) -> None:
        # Given
        self.given_wp("wp-m1", status=None, description="Milestone")
        self.given_wp("wp-m1e1", status="done", description="Completed child")

        # When
        result = self.run_cli(
            "show", "wp-m1", "--json", "--dir", str(self.directory)
        )
        payload = json.loads(result.stdout)

        # Then
        self.assertEqual(0, result.returncode)
        self.assertEqual("done", payload["rolled_up_status"])
        self.assertEqual(["wp-m1e1"], payload["children"])
        self.assertFalse(payload["is_leaf"])
        self.assertFalse(payload["ready"])

    def test_given_unknown_id_when_show_run_then_exit_two_is_returned(self) -> None:
        # Given
        self.given_wp("wp-m1", description="Known")

        # When
        result = self.run_cli("show", "wp-m2", "--dir", str(self.directory))

        # Then
        self.assertEqual(2, result.returncode)
        self.assertIn("unknown work-package ID", result.stderr)

    def test_given_hierarchy_when_tree_run_then_indented_rollup_is_printed(self) -> None:
        # Given
        self.given_wp("wp-m1", status=None, description="Milestone")
        self.given_wp("wp-m1e1", status="doing", description="Child")

        # When
        result = self.run_cli("tree", "--dir", str(self.directory))

        # Then
        self.assertEqual(0, result.returncode)
        self.assertEqual(
            "wp-m1\tdoing\tMilestone\n  wp-m1e1\tdoing\tChild\n",
            result.stdout,
        )

    def test_given_invalid_folder_when_check_run_then_problems_and_exit_one_are_returned(self) -> None:
        # Given
        self.given_wp("wp-m1", status=None, description="Leaf without status")

        # When
        result = self.run_cli("check", "--dir", str(self.directory))

        # Then
        self.assertEqual(1, result.returncode)
        self.assertIn("wp-m1.md: status missing on leaf", result.stdout)

    def test_given_valid_folder_when_check_json_run_then_empty_array_and_success_are_returned(self) -> None:
        # Given
        self.given_wp("wp-m1", description="Valid")

        # When
        result = self.run_cli("check", "--json", "--dir", str(self.directory))

        # Then
        self.assertEqual(0, result.returncode)
        self.assertEqual([], json.loads(result.stdout))

    def test_given_missing_directory_when_command_run_then_exit_two_is_returned(self) -> None:
        # Given
        missing_directory = self.directory / "missing"

        # When
        result = self.run_cli("next", "--dir", str(missing_directory))

        # Then
        self.assertEqual(2, result.returncode)
        self.assertIn("cannot read directory", result.stderr)


if __name__ == "__main__":
    unittest.main()
