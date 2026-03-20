#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error("Required env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO");
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf-8"));
const projectId = config.classroom.id;
const projects = config.projects;
const modules = config.modules;
const students = config.students;

// Map GitHub username (lowercase) → display name
const nameMap = {};
for (const r of config.reviewers) {
  nameMap[r.github.toLowerCase()] = r.name;
}
for (const s of students) {
  nameMap[s.github.toLowerCase()] = s.name;
}
function displayName(github) {
  return nameMap[github.toLowerCase()] || github;
}

const MODULE_COUNT = modules.length;

// --- GraphQL helpers ---

async function graphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json.data;
}

async function fetchAllIssues() {
  const issues = [];
  let cursor = null;

  while (true) {
    const data = await graphql(
      `
      query($owner: String!, $repo: String!, $after: String) {
        repository(owner: $owner, name: $repo) {
          issues(first: 100, after: $after, states: [OPEN, CLOSED]) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              url
              labels(first: 20) {
                nodes { name }
              }
              projectItems(first: 10) {
                nodes {
                  project { id }
                  fieldValueByName(name: "Status") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
      `,
      { owner: GITHUB_OWNER, repo: GITHUB_REPO, after: cursor }
    );

    const page = data.repository.issues;
    issues.push(...page.nodes);

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return issues;
}

// --- Build matrix ---

function buildMatrix(issues) {
  // matrix[projectKey][moduleNum] = { status, url }
  const matrix = {};
  for (const proj of projects) {
    matrix[proj.key.toLowerCase()] = {};
  }

  for (const issue of issues) {
    const labels = issue.labels.nodes.map((l) => l.name);
    const moduleLabel = labels.find((l) => /^module-\d{2}$/.test(l));
    const projectLabel = labels.find((l) => /^project-/.test(l));

    if (moduleLabel && !projectLabel) {
      console.warn(
        `Warning: Issue #${issue.number} has ${moduleLabel} but no project- label — skipping`
      );
      continue;
    }
    if (!moduleLabel || !projectLabel) continue;

    const moduleNum = moduleLabel.replace("module-", "");
    const projKey = projectLabel.replace("project-", "");

    if (!matrix[projKey]) {
      console.warn(
        `Warning: Issue #${issue.number} has label ${projectLabel} but no matching project in config.json — skipping`
      );
      continue;
    }

    // Get status from project board
    const projectItem = issue.projectItems.nodes.find(
      (n) => n.project.id === projectId
    );
    const status = projectItem?.fieldValueByName?.name || "In Review";

    matrix[projKey][moduleNum] = { status, url: issue.url };
  }

  return matrix;
}

// --- Generate HTML ---

function generateHtml(matrix) {
  const now = new Date().toUTCString();

  const moduleHeaders = modules.map((m) => {
    const label = escapeHtml(m.number);
    const fullTitle = `Module ${escapeHtml(m.number)} - ${escapeHtml(m.name)}`;
    if (m.url) {
      return `<th class="module-header"><a href="${escapeHtml(m.url)}" target="_blank" rel="noopener" title="${fullTitle}">${label}</a></th>`;
    }
    return `<th class="module-header" title="${fullTitle}">${label}</th>`;
  }).join("\n            ");

  function statusPoints(status) {
    if (status === "Done") return 1;
    if (status === "In Review" || status === "In Progress") return 0.5;
    return 0;
  }

  // Compute scores and sort projects by leaderboard ranking
  const scored = projects.map((proj) => {
    const key = proj.key.toLowerCase();
    const data = matrix[key] || {};
    let points = 0;
    let doneCount = 0;
    for (const m of modules) {
      const entry = data[m.number];
      if (entry) {
        points += statusPoints(entry.status);
        if (entry.status === "Done") doneCount++;
      }
    }
    return { proj, key, data, points, doneCount };
  });
  scored.sort((a, b) => b.points - a.points);

  const rows = scored
    .map(({ proj, key, data, points, doneCount }, rank) => {
      const cells = modules.map((m) => {
        const num = m.number;
        const entry = data[num];

        if (!entry) {
          const moduleName = `${m.number} - ${m.name}`;
          const notice = `> **⚠️ This ticket is auto-generated. Please do not change the title or contents below. Just click the "Create" button below. After a few minutes, the ticket will be automatically assigned to a reviewer — no further action needed. You can add comments after the ticket is created.**`;
          const issueBody = `${notice}\n\n### Project\n\n${proj.name}\n\n### Module\n\n${moduleName}\n\n${notice}`;
          const newIssueUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/issues/new?title=${encodeURIComponent(moduleName)}&body=${encodeURIComponent(issueBody)}&labels=${encodeURIComponent('review')}`;
          return `<td class="cell cell-missing"><a href="${newIssueUrl}" target="_blank" rel="noopener" title="Create ticket for ${escapeHtml(moduleName)}">+</a></td>`;
        }

        const status = entry.status;
        const statusClass = status.toLowerCase().replace(/\s+/g, "-");
        const displayText = status === "Done" ? "✅ Done" : status;

        return `<td class="cell cell-${statusClass}"><a href="${entry.url}" target="_blank" rel="noopener" title="${status}">${displayText}</a></td>`;
      }).join("\n              ");

      const pct = Math.round((doneCount / MODULE_COUNT) * 100);
      const progressClass = pct > 0 ? "progress-active" : "progress-none";

      const nameCell = proj.repo
        ? `<a href="${escapeHtml(proj.repo)}" target="_blank" rel="noopener">${escapeHtml(proj.name)}</a>`
        : escapeHtml(proj.name);

      const filterText = [proj.key, proj.name, ...proj.members.map(m => displayName(m)), ...proj.members].join(" ").toLowerCase();

      return `          <tr data-filter="${escapeHtml(filterText)}">
            <td class="project-code">${escapeHtml(proj.key)}</td>
            <td class="project-name">${nameCell}</td>
            <td class="project-lead" title="${escapeHtml(proj.members.map(m => displayName(m)).join(', '))}"><a href="https://github.com/${encodeURIComponent(proj.lead)}" target="_blank" rel="noopener">${escapeHtml(displayName(proj.lead))}</a></td>
            <td class="cell progress-cell ${progressClass}" title="Score: ${points}/${MODULE_COUNT}"><div class="progress-bar" style="width:${pct}%"></div><div class="progress-label">${pct}%</div></td>
              ${cells}
          </tr>`;
    })
    .join("\n");

  // Mobile cards
  const cards = scored
    .map(({ proj, key, data, points, doneCount }) => {
      const pct = Math.round((doneCount / MODULE_COUNT) * 100);
      const fillClass = pct > 0 ? "fill-active" : "";

      const nameHtml = proj.repo
        ? `<a href="${escapeHtml(proj.repo)}" target="_blank" rel="noopener">${escapeHtml(proj.name)}</a>`
        : escapeHtml(proj.name);

      const moduleItems = modules.map((m) => {
        const entry = data[m.number];
        if (!entry) {
          const moduleName = `${m.number} - ${m.name}`;
          const notice = `> **⚠️ This ticket is auto-generated. Please do not change the title or contents below. Just click the "Create" button below. After a few minutes, the ticket will be automatically assigned to a reviewer — no further action needed. You can add comments after the ticket is created.**`;
          const issueBody = `${notice}\n\n### Project\n\n${proj.name}\n\n### Module\n\n${moduleName}\n\n${notice}`;
          const newIssueUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/issues/new?title=${encodeURIComponent(moduleName)}&body=${encodeURIComponent(issueBody)}&labels=${encodeURIComponent('review')}`;
          return `<li><span class="card-module-name">${escapeHtml(m.number)} - ${escapeHtml(m.name)}</span><span class="card-module-status card-status-missing"><a href="${newIssueUrl}" target="_blank" rel="noopener">+</a></span></li>`;
        }
        const statusClass = "card-status-" + entry.status.toLowerCase().replace(/\s+/g, "-");
        return `<li><span class="card-module-name">${escapeHtml(m.number)} - ${escapeHtml(m.name)}</span><span class="card-module-status ${statusClass}"><a href="${entry.url}" target="_blank" rel="noopener">${entry.status}</a></span></li>`;
      }).join("\n");

      const cardFilterText = [proj.key, proj.name, ...proj.members.map(m => displayName(m)), ...proj.members].join(" ").toLowerCase();

      return `    <div class="card" data-filter="${escapeHtml(cardFilterText)}">
      <div class="card-header">
        <span class="card-name">${nameHtml}</span>
        <span class="card-code">${escapeHtml(proj.key)}</span>
      </div>
      <div class="card-lead">Lead: <a href="https://github.com/${encodeURIComponent(proj.lead)}" target="_blank" rel="noopener">${escapeHtml(displayName(proj.lead))}</a></div>
      <div class="card-progress" title="Score: ${points}/${MODULE_COUNT}">
        <div class="card-progress-fill ${fillClass}" style="width:${pct}%"></div>
        <div class="card-progress-text">${pct}%</div>
      </div>
      <ul class="card-modules">
${moduleItems}
      </ul>
    </div>`;
    })
    .join("\n");


  const moduleLegend = modules.map((m) => `      <div class="module-legend-item"><span>${escapeHtml(m.number)}</span> ${escapeHtml(m.name)}</div>`).join("\n");

  const template = readFileSync(join(__dirname, "dashboard-template.html"), "utf-8");

  return template
    .replace("{{LAST_UPDATED}}", now)
    .replace("{{MODULE_HEADERS}}", moduleHeaders)
    .replace("{{TABLE_ROWS}}", rows)
    .replace("{{CARDS}}", cards)
    .replace("{{MODULE_LEGEND}}", moduleLegend)
    .replace("{{CLASSROOM_URL}}", escapeHtml(config.classroom.url))
    .replaceAll("{{GITHUB_OWNER}}", GITHUB_OWNER)
    .replaceAll("{{GITHUB_REPO}}", GITHUB_REPO);
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Main ---

console.log("Fetching issues...");
const issues = await fetchAllIssues();
console.log(`Fetched ${issues.length} issues.`);

const matrix = buildMatrix(issues);

console.log("Generating dashboard...");
const html = generateHtml(matrix);

const docsDir = join(ROOT, "docs");
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, "index.html"), html, "utf-8");
console.log("Dashboard written to docs/index.html");
