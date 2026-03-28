# SonarCloud Setup (Code Analysis)

This guide covers setting up SonarCloud static code analysis for public GitHub repositories. After completing this, the Commit Stage will include automated code analysis with coverage reporting.

All steps use the command line except where noted as (UI).

## Prerequisites

- A public GitHub repository with a working Commit Stage workflow (see [Commit Stage](05-commit-stage.md))
- `gh` CLI installed and authenticated
- `curl` available

## 1. Create a SonarCloud Account and Token (UI — one time only)

These are the only steps that require the browser:

1. Go to [sonarcloud.io](https://sonarcloud.io), click **Log in**, and sign in with your **GitHub** account.
2. Go to **My Account** → **Security** → **Generate Tokens**, enter a name (e.g. `ci`), click **Generate**, and copy the token.

Set the token as an environment variable for the remaining steps:

```bash
export SONAR_TOKEN="<your-token>"
```

## 2. Import Your GitHub Organization (CLI)

```bash
SONAR_ORG="<your-github-org>"  # e.g. optivem

curl -s -u "${SONAR_TOKEN}:" \
  -X POST "https://sonarcloud.io/api/organizations/create" \
  -d "key=${SONAR_ORG}&name=${SONAR_ORG}"
```

If the organization already exists, you will get an error saying so — that is fine, move on.

## 3. Create the SonarCloud Project (CLI)

```bash
REPO_NAME="<your-repo>"  # e.g. greeter-java
SONAR_PROJECT="${SONAR_ORG}_${REPO_NAME}"

curl -s -u "${SONAR_TOKEN}:" \
  -X POST "https://sonarcloud.io/api/projects/create" \
  -d "organization=${SONAR_ORG}&project=${SONAR_PROJECT}&name=${REPO_NAME}"
```

Verify the project was created:

```bash
curl -s -u "${SONAR_TOKEN}:" \
  "https://sonarcloud.io/api/projects/search?organization=${SONAR_ORG}" | jq '.components[].key'
```

## 4. Add GitHub Secret (CLI)

The `SONAR_TOKEN` is the same for all repos in your organization — it is your personal token, not per-project.

```bash
gh secret set SONAR_TOKEN --body "${SONAR_TOKEN}"
```

Verify:

```bash
gh secret list
```

## 5. Follow SonarCloud's Onboarding Instructions (UI)

SonarCloud provides tailored setup instructions for your specific language and build tool:

1. Go to your project on [sonarcloud.io](https://sonarcloud.io).
2. Select **With GitHub Actions** as the analysis method.
3. SonarCloud will show you step-by-step instructions for:
   - Creating the GitHub secret (already done in Step 4)
   - Updating your build file (e.g. `build.gradle`, `.csproj`, `package.json`)
   - Creating or updating your CI workflow file
4. Follow the build file and CI workflow instructions for your language.

**Important**: When adding the CI step, add it to your existing `commit-stage-monolith.yml` workflow (replacing the "Run Code Analysis" placeholder step) rather than creating a new workflow file as SonarCloud suggests.

## 6. Verify

Commit and push, then check the workflow:

```bash
git add -A && git commit -m "Add SonarCloud code analysis" && git push
gh run watch
```

Once the workflow completes, verify the analysis appeared in SonarCloud:

```bash
curl -s -u "${SONAR_TOKEN}:" \
  "https://sonarcloud.io/api/measures/component?component=${SONAR_PROJECT}&metricKeys=bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density" | jq '.component.measures'
```

You should see metrics for: bugs, vulnerabilities, code smells, coverage, and duplicated lines.

## Troubleshooting

Check project exists:

```bash
curl -s -u "${SONAR_TOKEN}:" \
  "https://sonarcloud.io/api/projects/search?organization=${SONAR_ORG}" | jq '.components[].key'
```

Check analysis status:

```bash
curl -s -u "${SONAR_TOKEN}:" \
  "https://sonarcloud.io/api/ce/activity?component=${SONAR_PROJECT}" | jq '.tasks[0].status'
```

Common issues:
- **"Not authorized"** — Verify `SONAR_TOKEN` is correct (`gh secret list` to check it exists).
- **"Project not found"** — Verify the project key and organization match between your build config and SonarCloud.
- **No coverage data** — Ensure tests run and produce coverage reports before the sonar step.
- **Analysis not appearing** — SonarCloud free tier only analyzes public repositories. Check: `gh repo view --json visibility -q '.visibility'`
