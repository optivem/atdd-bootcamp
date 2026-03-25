#!/usr/bin/env node

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { loadConfig } from "./load-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const config = loadConfig(ROOT);

// Label colors by type
const COLORS = {
  course: "5319e7",    // purple
  project: "0075ca",   // blue
  module: "e4e669",    // yellow
  task: "c5def5",      // light blue
  closed: "d73a4a",   // red
};

// Build expected labels from config (order: project, course, module, task)
const expected = new Map();

for (const p of config.projects) {
  expected.set(`project-${p.key.toLowerCase()}`, COLORS.project);
}

for (const c of config.courses) {
  expected.set(`course-${c.id}`, COLORS.course);
}

for (const c of config.courses) {
  for (const m of c.modules) {
    const moduleKey = m.label || m.number;
    expected.set(`module-${moduleKey}`, COLORS.module);
    for (const t of (m.tasks || [])) {
      const taskKey = t.label || t.number;
      expected.set(`task-${taskKey}`, COLORS.task);
    }
  }
}

// Auto-close reason labels
for (const reason of ["invalid", "duplicate", "blocked"]) {
  expected.set(`closed-${reason}`, COLORS.closed);
}

// Fetch existing labels
const existing = new Set(
  JSON.parse(
    execSync("gh label list --limit 500 --json name", { encoding: "utf-8" })
  ).map((l) => l.name)
);

// Create missing labels
let created = 0;
for (const [name, color] of expected) {
  if (!existing.has(name)) {
    console.log(`Creating label: ${name}`);
    execSync(
      `gh label create "${name}" --color "${color}" --force`,
      { encoding: "utf-8", stdio: "inherit" }
    );
    created++;
  }
}

if (created === 0) {
  console.log("All labels are in sync.");
} else {
  console.log(`Created ${created} label(s).`);
}
