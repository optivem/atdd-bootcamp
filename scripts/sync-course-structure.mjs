#!/usr/bin/env node

/**
 * Sync course structure: scan accelerator lesson folders/files
 * and update config/courses/*.json with module and task metadata
 * (number, label, name). Does NOT touch URLs.
 *
 * Usage: node scripts/sync-course-structure.mjs [courses-root]
 *   courses-root defaults to ../courses (relative to classroom repo root)
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const coursesRoot = resolve(process.argv[2] || join(ROOT, "..", "courses"));

const COURSE_PATHS = {
  pipeline: join(coursesRoot, "pipeline", "accelerator", "course"),
  atdd: join(coursesRoot, "atdd", "accelerator", "course"),
};

function readModuleTitle(moduleDir) {
  const indexPath = join(moduleDir, "_index.md");
  if (!existsSync(indexPath)) return null;
  const content = readFileSync(indexPath, "utf-8").trim();
  const match = content.match(/^#\s*\d+\.\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function readLessonTitle(lessonPath) {
  const content = readFileSync(lessonPath, "utf-8").trim();
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function scanModules(coursePath) {
  const dirs = readdirSync(coursePath)
    .filter(d => /^\d{2}-/.test(d) && !d.includes("DRAFT") && !d.includes("guide") && statSync(join(coursePath, d)).isDirectory())
    .sort();

  return dirs.map(dir => {
    const moduleDir = join(coursePath, dir);
    const name = readModuleTitle(moduleDir);
    if (!name) return null;

    const files = readdirSync(moduleDir)
      .filter(f => f.endsWith(".md") && f !== "_index.md" && f !== "00-overview.md" && !f.includes("guide"))
      .filter(f => /^\d{2}-/.test(f))
      .sort();

    const tasks = files.map(f => ({
      number: f.slice(0, 2),
      label: f.replace(/\.md$/, ""),
      name: readLessonTitle(join(moduleDir, f)) || f.replace(/^\d{2}-/, "").replace(/\.md$/, ""),
    }));

    return {
      number: dir.slice(0, 2),
      label: dir,
      name,
      tasks,
    };
  }).filter(Boolean);
}

// Main
const configDir = join(ROOT, "config", "courses");

for (const [courseId, coursePath] of Object.entries(COURSE_PATHS)) {
  const configPath = join(configDir, `${courseId}.json`);

  if (!existsSync(configPath)) {
    console.log(`Skipping ${courseId}: no config file at ${configPath}`);
    continue;
  }
  if (!existsSync(coursePath)) {
    console.log(`Skipping ${courseId}: course path not found at ${coursePath}`);
    continue;
  }

  const course = JSON.parse(readFileSync(configPath, "utf-8"));
  const scanned = scanModules(coursePath);

  // Build lookup of existing data to preserve URLs and week values
  const existing = new Map();
  for (const m of course.modules || []) {
    const tasks = new Map();
    for (const t of m.tasks || []) {
      tasks.set(t.number, t);
    }
    existing.set(m.number, { ...m, _tasks: tasks });
  }

  course.modules = scanned.map(m => {
    const prev = existing.get(m.number) || {};
    const mod = { number: m.number, label: m.label, name: m.name, url: prev.url || "" };
    if (prev.week) mod.week = prev.week;

    const prevTasks = prev._tasks || new Map();
    mod.tasks = m.tasks.map(t => {
      const pt = prevTasks.get(t.number) || {};
      return { number: t.number, label: t.label, name: t.name, url: pt.url || "" };
    });

    return mod;
  });

  writeFileSync(configPath, JSON.stringify(course, null, 2) + "\n");

  const taskCount = course.modules.reduce((sum, m) => sum + m.tasks.length, 0);
  console.log(`${courseId}: ${course.modules.length} modules, ${taskCount} tasks`);
}
