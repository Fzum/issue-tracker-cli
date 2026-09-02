#!/usr/bin/env bun
/**
 * Command line interface for markdown-native work packages.
 *
 * This file is the executable entry point and the single public surface. All logic
 * lives in src/ — see CLAUDE.md for the module map and the boundary rules.
 */

import { main } from "./src/cli.ts";

export { main };
export {
  DirectoryError,
  FrontmatterError,
  FrontmatterParseError,
  Problem,
  type ScannedFile,
  TransitionError,
  UnknownWpError,
  Wp,
  WpError,
} from "./src/model.ts";
export { compareWpIds, parentId, stemSegments } from "./src/ids.ts";
export { parseFrontmatter } from "./src/frontmatter.ts";
export { graphFromScan, WpGraph } from "./src/graph.ts";
export { loadGraph, parseWp, scanDirectory, setStatus } from "./src/store.ts";
export { check } from "./src/check.ts";
export { finishWp, startWp } from "./src/transitions.ts";

if (import.meta.main) {
  // A reader that closes the pipe early (`wp tree | head`, quitting `less`) makes
  // the pending stdout write fail with EPIPE. That is not an error worth reporting,
  // and swallowing it leaves the exit code `main` chose intact — so `wp check | head`
  // still exits 1. Without this the EPIPE surfaces as an uncaught exception, because
  // it is raised at flush time and a try/catch around `main` never sees it.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });

  // `process.exitCode` rather than `process.exit()`: a single large
  // `process.stdout.write` followed by `process.exit()` discards everything past
  // 128 KiB when stdout is a pipe. Every fs call here is synchronous, so nothing
  // keeps the event loop alive and the process still exits immediately.
  process.exitCode = main();
}
