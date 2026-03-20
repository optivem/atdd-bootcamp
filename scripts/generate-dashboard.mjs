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

const STATUS_COLORS = {
  "In Review": { bg: "#dbeafe", text: "#1e40af" },
  "In Progress": { bg: "#fef9c3", text: "#92400e" },
  Done: { bg: "#dcfce7", text: "#166534" },
};

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
          return `<td class="cell"><a href="${newIssueUrl}" target="_blank" rel="noopener" title="Create ticket for ${escapeHtml(moduleName)}">⚪</a></td>`;
        }

        const status = entry.status;
        const emojiMap = { "Done": "✅", "In Review": "🔵", "In Progress": "🟠" };
        const displayText = emojiMap[status] || "";

        return `<td class="cell"><a href="${entry.url}" target="_blank" rel="noopener" title="${status}">${displayText}</a></td>`;
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ATDD Classroom</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; color: #111827; padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
    .header-left h1 { font-size: 1.5rem; margin-bottom: 4px; }
    .subtitle { color: #6b7280; font-size: 0.85rem; }
    .nav-tabs { display: flex; gap: 8px; }
    .nav-tab { display: inline-block; padding: 6px 14px; font-size: 0.85rem; font-weight: 500; border-radius: 6px; text-decoration: none; border: 1px solid #d1d5db; color: #374151; background: #fff; cursor: pointer; font-family: inherit; }
    .nav-tab:hover { background: #f3f4f6; }
    .nav-tab.active { background: #1d4ed8; color: #fff; border-color: #1d4ed8; cursor: default; }
    .table-wrapper { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; min-width: 900px; font-size: 0.8rem; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: center; white-space: nowrap; }
    th { background: #f3f4f6; font-weight: 600; position: sticky; top: 0; }
    .project-code { text-align: center; font-weight: 600; background: #f9fafb; color: #6b7280; font-size: 0.75rem; }
    .project-name { text-align: left; font-weight: 600; background: #f9fafb; }
    .project-name a { color: #1d4ed8; text-decoration: none; }
    .project-name a:hover { text-decoration: underline; }
    .project-lead { text-align: left; font-size: 0.75rem; background: #f9fafb; }
    .project-lead a { color: #6b7280; text-decoration: none; }
    .project-lead a:hover { color: #1d4ed8; text-decoration: underline; }
    .module-header { min-width: 55px; }
    .module-header a { color: #1d4ed8; text-decoration: none; }
    .module-header a:hover { text-decoration: underline; }
    .cell a { text-decoration: none; display: block; width: 100%; }
    .cell a:hover { opacity: 0.8; }
    .cell a { text-decoration: none; display: block; width: 100%; }
    .progress-cell { position: relative; min-width: 70px; padding: 0; overflow: hidden; }
    .progress-bar { position: absolute; top: 0; left: 0; height: 100%; z-index: 0; transition: width 0.3s; }
    .progress-label { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; height: 100%; padding: 6px 8px; font-weight: 600; font-size: 0.8rem; }
    .progress-active .progress-bar { background: #bbf7d0; }
    .progress-active .progress-label { color: #166534; }
    .progress-none .progress-label { color: #9ca3af; }
    .legend { margin-top: 16px; display: flex; gap: 16px; flex-wrap: wrap; font-size: 0.8rem; }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .module-legend { margin-top: 16px; font-size: 0.8rem; }
    .module-legend h3 { font-size: 0.85rem; margin-bottom: 6px; }
    .module-legend-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 2px 24px; }
    .module-legend-item { color: #374151; }
    .module-legend-item span { color: #6b7280; font-weight: 600; margin-right: 4px; }
    .disclaimer { margin-top: 16px; padding: 10px 14px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; font-size: 0.8rem; color: #92400e; line-height: 1.5; }
    .disclaimer a { color: #92400e; font-weight: 600; text-decoration: underline; }
    .disclaimer a:hover { color: #78350f; }
    .filter-bar { margin-bottom: 16px; position: relative; max-width: 360px; }
    .filter-input { width: 100%; padding: 8px 12px 8px 34px; font-size: 0.85rem; font-family: inherit; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; color: #111827; outline: none; }
    .filter-input:focus { border-color: #1d4ed8; box-shadow: 0 0 0 2px rgba(29,78,216,0.15); }
    .filter-input::placeholder { color: #9ca3af; }
    .filter-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #9ca3af; pointer-events: none; font-size: 0.85rem; }
    .teacher-links { margin-top: 16px; font-size: 0.8rem; color: #6b7280; }
    .teacher-links span { font-weight: 600; margin-right: 8px; }
    .teacher-links a { color: #6b7280; text-decoration: none; margin-right: 12px; }
    .teacher-links a:hover { color: #1d4ed8; text-decoration: underline; }
    /* Mobile cards */
    .cards { display: none; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .card-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
    .card-code { font-size: 0.7rem; color: #6b7280; font-weight: 600; }
    .card-name { font-size: 1rem; font-weight: 600; }
    .card-name a { color: #1d4ed8; text-decoration: none; }
    .card-lead { font-size: 0.8rem; color: #6b7280; margin-bottom: 8px; }
    .card-lead a { color: #6b7280; text-decoration: none; }
    .card-progress { position: relative; height: 24px; background: #f3f4f6; border-radius: 12px; overflow: hidden; margin-bottom: 12px; }
    .card-progress-fill { position: absolute; top: 0; left: 0; height: 100%; border-radius: 12px; }
    .card-progress-fill.fill-active { background: #bbf7d0; }
    .card-progress-text { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; height: 100%; font-size: 0.75rem; font-weight: 600; color: #374151; }
    .card-modules { list-style: none; font-size: 0.8rem; }
    .card-modules li { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #f3f4f6; }
    .card-modules li:last-child { border-bottom: none; }
    .card-module-name { color: #374151; }
    .card-module-status { font-weight: 600; }
    .card-module-status a { text-decoration: none; }
    .card-status-done { color: #166534; }
    .card-status-in-review { color: #1e40af; }
    .card-status-in-progress { color: #92400e; }
    .card-status-missing { color: #d1d5db; }
    .card-status-missing a { color: #d1d5db; text-decoration: none; }
    @media (max-width: 768px) {
      .table-wrapper, .module-legend { display: none; }
      .cards { display: block; }
      body { padding: 16px; }
      .header { flex-direction: column; gap: 12px; }
      .nav-tabs { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>ATDD Classroom</h1>
      <p class="subtitle">Last updated: ${now}</p>
    </div>
    <nav class="nav-tabs">
      <span class="nav-tab active">Dashboard</span>
      <a class="nav-tab" href="https://optivem.thinkific.com/courses/take/atdd" target="_blank" rel="noopener">Course</a>
      <a class="nav-tab" href="https://optivem.thinkific.com/hub/community/339589" target="_blank" rel="noopener">Community</a>
    </nav>
  </div>
  <div class="filter-bar">
    <span class="filter-icon">&#128269;</span>
    <input type="text" class="filter-input" id="projectFilter" placeholder="Filter by code, project, lead, or member\u2026" autocomplete="off">
  </div>
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th class="project-code">Code</th>
          <th class="project-name">Project</th>
          <th class="project-lead">Lead</th>
          <th>Progress</th>
            ${moduleHeaders}
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
  <div class="cards">
${cards}
  </div>
  <div class="legend">
    <div class="legend-item">⚪ No ticket</div>
    <div class="legend-item">🔵 In Review</div>
    <div class="legend-item">🟠 In Progress</div>
    <div class="legend-item">✅ Done</div>
  </div>
  <div class="module-legend">
    <h3>Modules</h3>
    <div class="module-legend-list">
${modules.map((m) => `      <div class="module-legend-item"><span>${escapeHtml(m.number)}</span> ${escapeHtml(m.name)}</div>`).join("\n")}
    </div>
  </div>
  <div class="teacher-links">
    <span>For Teachers:</span>
    <a href="https://optivem.thinkific.com/manage/courses/3262198" target="_blank" rel="noopener">Admin</a>
    <a href="${escapeHtml(config.classroom.url)}" target="_blank" rel="noopener">Project Board</a>
    <a href="https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}" target="_blank" rel="noopener">GitHub</a>
    <a href="https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions" target="_blank" rel="noopener">Actions</a>
  </div>
  <div class="teacher-links">
    <span>Refresh:</span>
    <a href="https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/dashboard.yml" target="_blank" rel="noopener">Refresh Dashboard</a>
  </div>
  <script>
    document.getElementById('projectFilter').addEventListener('input', function() {
      const q = this.value.toLowerCase().trim();
      document.querySelectorAll('tbody tr[data-filter]').forEach(function(row) {
        row.style.display = !q || row.dataset.filter.includes(q) ? '' : 'none';
      });
      document.querySelectorAll('.card[data-filter]').forEach(function(card) {
        card.style.display = !q || card.dataset.filter.includes(q) ? '' : 'none';
      });
    });
  </script>
  <div class="disclaimer">
    This dashboard is in beta. Statuses are set automatically. If you submitted a review request and the status has not changed to "In Review", please <a href="https://optivem.thinkific.com/hub/conversations" target="_blank" rel="noopener">send a DM to Valentina</a>.
  </div>
</body>
</html>`;
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
