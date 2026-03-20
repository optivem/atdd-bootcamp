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
const boardId = config.board.id;

// Map project key (uppercase) → project object
const projectMap = {};
for (const p of config.projects) {
  projectMap[p.key.toUpperCase()] = p;
}

// Resolve bootcamp projectKeys into full project objects
for (const bootcamp of config.bootcamps) {
  bootcamp.projects = (bootcamp.projectKeys || []).map((key) => {
    const proj = projectMap[key.toUpperCase()];
    if (!proj) {
      console.warn(`Warning: [${bootcamp.name}] projectKey "${key}" not found in top-level projects — skipping`);
    }
    return proj;
  }).filter(Boolean);
}

// Map GitHub username (lowercase) → display name
const nameMap = {};
for (const r of config.reviewers) {
  nameMap[r.github.toLowerCase()] = r.name;
}
for (const s of config.students) {
  nameMap[s.github.toLowerCase()] = s.name;
}
function displayName(github) {
  return nameMap[github.toLowerCase()] || github;
}

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

async function fetchAllIssues(owner, repo) {
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
      { owner, repo, after: cursor }
    );

    const page = data.repository.issues;
    issues.push(...page.nodes);

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return issues;
}

// --- Build matrix for a single bootcamp ---

function buildMatrix(issues, bootcamp) {
  const modules = bootcamp.modules;

  // matrix[projectKey][moduleNum] = { status, url }
  const matrix = {};
  for (const proj of config.projects) {
    matrix[proj.key.toLowerCase()] = {};
  }

  for (const issue of issues) {
    const labels = issue.labels.nodes.map((l) => l.name);
    const bootcampLabel = labels.find((l) => /^bootcamp-/.test(l));
    const moduleLabel = labels.find((l) => /^module-\d{2}$/.test(l));
    const projectLabel = labels.find((l) => /^project-/.test(l));

    // Only include issues that have the matching bootcamp label
    if (bootcampLabel !== `bootcamp-${bootcamp.id}`) continue;

    if (moduleLabel && !projectLabel) {
      console.warn(
        `Warning: [${bootcamp.name}] Issue #${issue.number} has ${moduleLabel} but no project- label — skipping`
      );
      continue;
    }
    if (!moduleLabel || !projectLabel) continue;

    const moduleNum = moduleLabel.replace("module-", "");
    const projKey = projectLabel.replace("project-", "");

    if (!matrix[projKey]) {
      console.warn(
        `Warning: [${bootcamp.name}] Issue #${issue.number} has label ${projectLabel} but no matching project in config — skipping`
      );
      continue;
    }

    // Get status from project board
    const projectItem = issue.projectItems.nodes.find(
      (n) => n.project.id === boardId
    );
    const status = projectItem?.fieldValueByName?.name || "In Review";

    matrix[projKey][moduleNum] = { status, url: issue.url };
  }

  return matrix;
}

// --- Generate HTML section for a single bootcamp ---

function generateBootcampSection(bootcamp, matrix, owner, repo) {
  const modules = bootcamp.modules;
  const projects = config.projects;  // All projects, not just bootcamp-specific
  const moduleCount = modules.length;
  const bootcampId = bootcamp.id;

  function statusPoints(status) {
    if (status === "Done") return 1;
    if (status === "In Review" || status === "In Progress") return 0.5;
    return 0;
  }

  // Score projects for sorting columns (best progress first)
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

  // Column headers: one per project
  const projectHeaders = scored.map(({ proj, doneCount }) => {
    const pct = Math.round((doneCount / moduleCount) * 100);
    const nameHtml = proj.repo
      ? `<a href="${escapeHtml(proj.repo)}" target="_blank" rel="noopener" title="${escapeHtml(proj.name)}">${escapeHtml(proj.key)}</a>`
      : `<span title="${escapeHtml(proj.name)}">${escapeHtml(proj.key)}</span>`;
    return `<th class="project-header" title="${escapeHtml(proj.name)} (${pct}%)">${nameHtml}</th>`;
  }).join("\n            ");

  // Rows: one per module
  const rows = modules.map((m) => {
    const moduleName = `${m.number} - ${m.name}`;
    const moduleLabel = m.url
      ? `<a href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${escapeHtml(moduleName)}</a>`
      : escapeHtml(moduleName);

    const cells = scored.map(({ proj, data }) => {
      const entry = data[m.number];

      if (!entry) {
        const notice = `> **⚠️ This ticket is auto-generated. Please do not change the title or contents below. Just click the "Create" button below. After a few minutes, the ticket will be automatically assigned to a reviewer — no further action needed. You can add comments after the ticket is created.**`;
        const issueBody = `${notice}\n\n### Bootcamp\n\n${bootcamp.name}\n\n### Project\n\n${proj.name}\n\n### Module\n\n${moduleName}\n\n${notice}`;
        const newIssueUrl = `https://github.com/${owner}/${repo}/issues/new?title=${encodeURIComponent(moduleName)}&body=${encodeURIComponent(issueBody)}`;
        return `<td class="cell cell-missing"><a href="${newIssueUrl}" target="_blank" rel="noopener" title="Create ticket for ${escapeHtml(proj.key)} - ${escapeHtml(moduleName)}">+</a></td>`;
      }

      const status = entry.status;
      const statusClass = status.toLowerCase().replace(/\s+/g, "-");
      const displayText = status === "Done" ? "✅" : status;

      return `<td class="cell cell-${statusClass}"><a href="${entry.url}" target="_blank" rel="noopener" title="${escapeHtml(proj.key)}: ${status}">${displayText}</a></td>`;
    }).join("\n              ");

    return `          <tr>
            <td class="module-name">${moduleLabel}</td>
              ${cells}
          </tr>`;
  }).join("\n");

  // Progress row at bottom
  const progressCells = scored.map(({ doneCount }) => {
    const pct = Math.round((doneCount / moduleCount) * 100);
    const progressClass = pct > 0 ? "progress-active" : "progress-none";
    return `<td class="cell progress-cell ${progressClass}"><div class="progress-bar" style="width:${pct}%"></div><div class="progress-label">${pct}%</div></td>`;
  }).join("\n              ");

  const section = `
  <div class="bootcamp-section" id="bootcamp-${escapeHtml(bootcampId)}">
    <h2 class="bootcamp-title">${escapeHtml(bootcamp.name)}</h2>
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th class="module-name">Module</th>
            ${projectHeaders}
          </tr>
        </thead>
        <tbody>
${rows}
          <tr class="progress-row">
            <td class="module-name"><strong>Progress</strong></td>
              ${progressCells}
          </tr>
        </tbody>
      </table>
    </div>
  </div>`;

  // Mobile cards
  const cardItems = scored
    .map(({ proj, key, data, points, doneCount }) => {
      const pct = Math.round((doneCount / moduleCount) * 100);
      const fillClass = pct > 0 ? "fill-active" : "";

      const nameHtml = proj.repo
        ? `<a href="${escapeHtml(proj.repo)}" target="_blank" rel="noopener">${escapeHtml(proj.name)}</a>`
        : escapeHtml(proj.name);

      const moduleItems = modules.map((m) => {
        const entry = data[m.number];
        if (!entry) {
          const moduleName = `${m.number} - ${m.name}`;
          const notice = `> **⚠️ This ticket is auto-generated. Please do not change the title or contents below. Just click the "Create" button below. After a few minutes, the ticket will be automatically assigned to a reviewer — no further action needed. You can add comments after the ticket is created.**`;
          const issueBody = `${notice}\n\n### Bootcamp\n\n${bootcamp.name}\n\n### Project\n\n${proj.name}\n\n### Module\n\n${moduleName}\n\n${notice}`;
          const newIssueUrl = `https://github.com/${owner}/${repo}/issues/new?title=${encodeURIComponent(moduleName)}&body=${encodeURIComponent(issueBody)}`;
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
      <div class="card-progress" title="Score: ${points}/${moduleCount}">
        <div class="card-progress-fill ${fillClass}" style="width:${pct}%"></div>
        <div class="card-progress-text">${pct}%</div>
      </div>
      <ul class="card-modules">
${moduleItems}
      </ul>
    </div>`;
    })
    .join("\n");

  const cardSection = `
  <div class="bootcamp-section-mobile" id="bootcamp-${escapeHtml(bootcampId)}-mobile">
    <h2 class="bootcamp-title">${escapeHtml(bootcamp.name)}</h2>
${cardItems}
  </div>`;

  return { section, cards: cardSection };
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Main ---

async function main() {
  const bootcamps = config.bootcamps;
  const owner = GITHUB_OWNER;
  const repo = GITHUB_REPO;

  // Fetch issues once (all bootcamps share the same repo)
  console.log("Fetching issues...");
  const issues = await fetchAllIssues(owner, repo);
  console.log(`Fetched ${issues.length} issues.`);

  const allSections = [];
  const allCards = [];

  for (const bootcamp of bootcamps) {
    console.log(`Processing ${bootcamp.name}...`);
    const matrix = buildMatrix(issues, bootcamp);
    const { section, cards } = generateBootcampSection(bootcamp, matrix, owner, repo);
    allSections.push(section);
    allCards.push(cards);
  }

  const now = new Date().toUTCString();

  const template = readFileSync(join(__dirname, "dashboard-template.html"), "utf-8");

  const html = template
    .replace("{{LAST_UPDATED}}", now)
    .replace("{{BOOTCAMP_SECTIONS}}", allSections.join("\n"))
    .replace("{{BOOTCAMP_CARDS}}", allCards.join("\n"))
    .replaceAll("{{CLASSROOM_TITLE}}", escapeHtml(config.title))
    .replace("{{BOARD_URL}}", escapeHtml(config.board.url))
    .replaceAll("{{GITHUB_OWNER}}", owner)
    .replaceAll("{{GITHUB_REPO}}", repo);

  const docsDir = join(ROOT, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "index.html"), html, "utf-8");
  console.log("Dashboard written to docs/index.html");
}

main();
