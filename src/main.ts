#!/usr/bin/env node
// src/main.ts — entry point
import { pathToFileURL } from "node:url";
import { runApp } from "./runtime.js";

export function main(run: () => Promise<void> = runApp): void {
  void run();
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
