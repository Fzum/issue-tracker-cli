#!/bin/sh
#
# Install the tracker and the orchestrator into another project.
#
# `wp` is a tool, like `git` or `jq`: cloned once, then pointed at a project
# (decision D10 in docs/vision.md). This script does the pointing. It runs in
# the *target* project and touches four things there — `wps/`,
# `prompts/worker.md`, one line in `.gitignore`, and two symlinks in a bin
# directory — then prints the two steps a shell script cannot do itself.
#
#     cd /path/to/your/project
#     /path/to/issue-tracker-cli/install.sh
#
# `$0` is how it finds `wp.ts`, so call it by its real path inside the clone;
# `pwd -P` resolves a symlinked *directory* but not a symlink to this file.
#
# Nothing here is destructive and running it twice is safe: every step reports
# `=` and skips when it is already done, and a file you wrote yourself is never
# overwritten. `--dry-run` reports the same lines and writes nothing.
#
# POSIX sh, not bash — same constraint as scripts/check-boundaries.sh.

set -u
export LC_ALL=C

dry_run=0
path_hint=0
attention=0
status=0

tools=$(cd "$(dirname "$0")" && pwd -P)
project=$(pwd -P)

usage() {
	cat <<'EOF'
usage: install.sh [--dry-run] [-h|--help]

Install the wp tracker and the orchestrator into the project in the current
directory:

    cd /path/to/your/project
    /path/to/issue-tracker-cli/install.sh

It creates wps/, copies prompts/worker.md when you have none, adds log/ to
.gitignore, and links `wp` and `orchestrate` into $WP_BIN_DIR (default
$HOME/.local/bin). Running it again is safe.

  --dry-run   report what would change and write nothing
  -h, --help  print this help

exit: 0 installed, 1 installed but `wp check` found problems, 2 refused
EOF
}

# One report line. `+` changed something, `=` already in place, `!` read me.
mark() {
	printf '  %s %s\n' "$1" "$2"
}

# Indent a captured command's output under the line that introduced it.
quote() {
	printf '%s\n' "$1" | sed 's/^/      /'
}

refuse() {
	printf 'install: %s\n' "$1" >&2
	exit 2
}

# link <command name> <file it should point at>
link() {
	name=$1
	target=$2
	path=$bin_dir/$name

	if [ -L "$path" ]; then
		current=$(readlink "$path")
		if [ "$current" = "$target" ]; then
			mark '=' "$path"
			return
		fi
		# Silently clobbering another tool's command is worse than stopping.
		mark '!' "$path already points at $current — left alone"
		attention=1
		return
	fi

	if [ -e "$path" ]; then
		mark '!' "$path exists and is not a symlink — left alone"
		attention=1
		return
	fi

	if [ "$dry_run" = 0 ]; then
		mkdir -p "$bin_dir" || refuse "cannot create $bin_dir"
		ln -s "$target" "$path" || refuse "cannot create the symlink $path"
	fi
	mark '+' "$path -> $target"
}

while [ $# -gt 0 ]; do
	case $1 in
	--dry-run)
		dry_run=1
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf 'install: unknown option %s\n' "$1" >&2
		usage >&2
		exit 2
		;;
	esac
	shift
done

if [ -n "${WP_BIN_DIR:-}" ]; then
	bin_dir=$WP_BIN_DIR
elif [ -n "${HOME:-}" ]; then
	bin_dir=$HOME/.local/bin
else
	refuse 'neither WP_BIN_DIR nor HOME is set — set WP_BIN_DIR to a directory on your PATH'
fi

# --- Refuse before touching anything -----------------------------------------

command -v bun >/dev/null 2>&1 ||
	refuse 'bun is not on PATH. Install it from https://bun.sh, then run this again.'

for required in wp.ts orchestrate.ts prompts/worker.md; do
	[ -f "$tools/$required" ] ||
		refuse "$tools/$required not found — run this script from inside the issue-tracker-cli clone."
done

if [ "$project" = "$tools" ]; then
	refuse 'the current directory is the issue-tracker-cli clone itself. cd into the project that should get a queue, then run this script by its full path.'
fi

# --- Install ------------------------------------------------------------------

printf 'issue-tracker-cli -> %s\n' "$project"
if [ "$dry_run" = 1 ]; then
	printf '  (dry run: nothing is written)\n'
fi
printf '\n'

if ! git -C "$project" rev-parse --git-dir >/dev/null 2>&1; then
	# wp reads and writes plain files; only the orchestrator needs git, and it
	# needs it in *this* directory, because that is what it merges into.
	mark '!' 'not a git repository — wp works, orchestrate needs `git init` first'
	attention=1
fi

if [ -d "$project/wps" ]; then
	mark '=' 'wps/'
else
	[ "$dry_run" = 1 ] || mkdir -p "$project/wps" || refuse "cannot create $project/wps"
	mark '+' 'wps/'
fi

if [ -f "$project/prompts/worker.md" ]; then
	mark '=' 'prompts/worker.md (yours, kept)'
else
	if [ "$dry_run" = 0 ]; then
		mkdir -p "$project/prompts" || refuse "cannot create $project/prompts"
		cp "$tools/prompts/worker.md" "$project/prompts/worker.md" ||
			refuse 'cannot copy the worker role prompt'
	fi
	mark '+' 'prompts/worker.md (from the template — edit it)'
fi

ignore_file=$project/.gitignore
# `tr -d '\r'`, not a plain grep: with core.autocrlf=true the file is checked out
# with CRLF endings, and `grep -qxF 'log/'` never matches `log/\r`. Without this
# the rule is appended again on every run, which breaks the "safe to re-run"
# promise in the loudest possible way.
if [ -f "$ignore_file" ] && tr -d '\r' <"$ignore_file" | grep -qxF 'log/'; then
	mark '=' 'log/ in .gitignore'
else
	if [ "$dry_run" = 0 ]; then
		# Start on a fresh line. A file whose last line has no newline would
		# otherwise get `log/` glued onto the end of it. Command substitution
		# strips trailing newlines, so this is empty exactly when the file
		# already ends in one.
		if [ -s "$ignore_file" ] && [ -n "$(tail -c 1 "$ignore_file")" ]; then
			printf '\n' >>"$ignore_file"
		fi
		printf '# Orchestrator agent logs\nlog/\n' >>"$ignore_file" ||
			refuse "cannot write $ignore_file"
	fi
	mark '+' 'log/ in .gitignore'
fi

link wp "$tools/wp.ts"
link orchestrate "$tools/orchestrate.ts"

case ":$PATH:" in
*":$bin_dir:"*) ;;
*)
	mark '!' "$bin_dir is not on your PATH"
	path_hint=1
	attention=1
	;;
esac

# The smoke test: the tracker reading the directory it was just given. Skipped
# under --dry-run, where wps/ does not exist and the failure would be the
# script's own fault.
if [ "$dry_run" = 0 ]; then
	check_output=$("$tools/wp.ts" --dir "$project/wps" check 2>&1)
	check_status=$?
	if [ "$check_status" = 0 ]; then
		mark '=' 'wp check: clean'
	elif [ "$check_status" = 1 ]; then
		mark '!' 'wp check found problems:'
		quote "$check_output"
		attention=1
		status=1
	else
		mark '!' "wp check could not run (exit $check_status):"
		quote "$check_output"
		attention=1
		status=2
	fi
fi

# --- What a shell script cannot do -------------------------------------------

printf '\nNext:\n'
if [ "$path_hint" = 1 ]; then
	printf '  export PATH="%s:$PATH"     # add this to your shell profile\n' "$bin_dir"
fi
printf '  /plugin install %s\n' "$tools"
printf '      in Claude Code, for the planning skills: /vision /architecture /breakdown\n'
printf '  wp tree\n'
printf '  orchestrate --dry-run --verify "<the command that verifies your build>"\n'

if [ "$attention" != 0 ]; then
	printf '\nThe ! lines above want a human. Nothing else was left half done.\n'
fi

exit "$status"
