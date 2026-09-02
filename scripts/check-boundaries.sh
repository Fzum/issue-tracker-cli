#!/bin/sh
#
# The four module-boundary rules from the "Architecture" section of CLAUDE.md,
# as one runnable check. Each rule fixes the *set of files* allowed to match one
# grep; together they are what keeps the one-way dependency direction (L0
# ids/model up to L5 wp.ts) honest.
#
# `grep -r`, never `git grep`: a new file is untracked until it is staged, so
# `git grep` passes vacuously on exactly the file you just added.
#
# Scope is `wp.ts src/` on purpose. `orchestrate.ts` is a second entry point,
# not part of the CLI, and legitimately touches process.*, node:fs and Bun.spawn.
#
# Run it the same way CI does:  bun run boundaries

set -u
export LC_ALL=C

status=0

for required in wp.ts src; do
	if [ ! -e "$required" ]; then
		printf 'boundaries: %s not found — run this from the repository root.\n' "$required" >&2
		exit 2
	fi
done

# check <name> <allowed space-separated file list, sorted> <extended regex> <path>...
check() {
	name=$1
	allowed=$2
	pattern=$3
	shift 3

	# Unquoted expansion collapses grep's newlines into single spaces, so
	# `allowed` can be written inline as a plain sorted list.
	found=$(grep -rlE "$pattern" "$@" | sort)
	found=$(echo $found)

	if [ "$found" = "$allowed" ]; then
		printf 'ok    %s\n' "$name"
		return 0
	fi

	status=1
	printf 'FAIL  %s\n' "$name"
	printf '        allowed: %s\n' "${allowed:-(nothing)}"
	printf '        found:   %s\n' "${found:-(nothing)}"

	# Quote only the offending files. Dumping every hit buries the one new line
	# under the dozen legitimate ones in cli.ts.
	offenders=''
	for file in $found; do
		case " $allowed " in
		*" $file "*) ;;
		*) offenders="$offenders $file" ;;
		esac
	done
	if [ -n "$offenders" ]; then
		# -H so a single offending file still gets its name printed.
		grep -HnE "$pattern" $offenders | sed 's/^/        /'
	fi
	return 0
}

# 1. src/store.ts is the only module allowed to reach the filesystem.
#    node:path is exempt on purpose — it is pure string manipulation.
check 'only src/store.ts touches the filesystem' \
	'src/store.ts' \
	'node:fs|from "fs"|Bun\.(write|file)' \
	wp.ts src/

# 2. src/cli.ts is the only module allowed to touch process.*, plus the wp.ts
#    entry block. Bun.stringWidth in src/tree.ts is fine — it is not process.*.
check 'only src/cli.ts and wp.ts touch process.*' \
	'src/cli.ts wp.ts' \
	'process\.' \
	wp.ts src/

# 3. import.meta.main is only true in the process entry file, so moving it into
#    src/cli.ts turns the whole CLI into a silent no-op. Exactly one hit, in
#    wp.ts — a file list alone would not catch a second hit in wp.ts itself.
name='exactly one import.meta.main, in wp.ts'
found=$(grep -rlE 'import\.meta\.main' wp.ts src/ | sort)
found=$(echo $found)
count=$(grep -rnE 'import\.meta\.main' wp.ts src/ | wc -l | tr -d ' ')
if [ "$found" = "wp.ts" ] && [ "$count" = "1" ]; then
	printf 'ok    %s\n' "$name"
else
	status=1
	printf 'FAIL  %s\n' "$name"
	printf '        allowed: wp.ts (1 hit)\n'
	printf '        found:   %s (%s hits)\n' "${found:-(nothing)}" "$count"
	grep -rnE 'import\.meta\.main' wp.ts src/ | sed 's/^/        /'
fi

# 4. No src/ module may import the public barrel; the barrel imports them.
check 'no src/ module imports the wp.ts barrel' \
	'' \
	'from "\.\./wp' \
	src/

if [ "$status" -ne 0 ]; then
	printf '\nboundaries: read the "Architecture" section of CLAUDE.md before\n' >&2
	printf 'changing a boundary — each of these four rules is load-bearing.\n' >&2
fi

exit "$status"
