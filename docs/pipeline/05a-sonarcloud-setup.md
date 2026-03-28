# SonarCloud Setup (Code Analysis)

This guide covers setting up SonarCloud static code analysis for public GitHub repositories. After completing this, the Commit Stage will include automated code analysis with coverage reporting.

All steps use the command line except for the initial one-time SonarCloud sign-in and token generation.

## Prerequisites

- A public GitHub repository with a Gradle-based Java project
- A working Commit Stage workflow (see [Commit Stage](05-commit-stage.md))
- `gh` CLI installed and authenticated
- `curl` available

## 1. Create a SonarCloud Account and Token (UI — one time only)

These are the only steps that require the browser:

1. Go to [sonarcloud.io](https://sonarcloud.io), click **Log in**, and sign in with your **GitHub** account.
2. Go to **My Account** → **Security** → **Generate Tokens**, enter a name (e.g. `ci`), click **Generate**, and copy the token.

Export the token for the remaining steps:

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

## 4. Add GitHub Secrets and Variables (CLI)

Run these from your repository root:

```bash
gh secret set SONAR_TOKEN --body "${SONAR_TOKEN}"
gh variable set SONAR_HOST_URL --body "https://sonarcloud.io"
```

Verify:

```bash
gh secret list
gh variable list
```

## 5. Add Gradle Plugins

In your `monolith/build.gradle`, add the `jacoco` and `org.sonarqube` plugins:

```gradle
plugins {
    id 'java'
    id 'checkstyle'
    id 'jacoco'
    id 'org.sonarqube' version '6.0.1.5171'
    id 'org.springframework.boot' version '3.5.6'
    id 'io.spring.dependency-management' version '1.1.7'
}
```

## 6. Configure JaCoCo (Code Coverage)

Add the following after your `test` task configuration:

```gradle
tasks.named('test') {
    useJUnitPlatform()
    finalizedBy jacocoTestReport
}

jacocoTestReport {
    dependsOn test
    reports {
        xml.required = true
    }
}
```

JaCoCo generates an XML coverage report that SonarCloud uses to display code coverage metrics.

## 7. Configure Sonar Properties

Add the following block to `monolith/build.gradle`:

```gradle
sonar {
    properties {
        property 'sonar.projectKey', '<your-org>_<your-repo>'
        property 'sonar.projectName', '<your-repo>'
        property 'sonar.organization', '<your-org>'
        property 'sonar.coverage.jacoco.xmlReportPaths', "${buildDir}/reports/jacoco/test/jacocoTestReport.xml"
    }
}
```

Replace `<your-org>` and `<your-repo>` with the values from Steps 2 and 3.

## 8. Add the Code Analysis Step to CI

In your `.github/workflows/commit-stage-monolith.yml`, replace the "Run Code Analysis" placeholder step with:

```yaml
      - name: Run Code Analysis
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        run: ./gradlew test jacocoTestReport sonar
        working-directory: monolith
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
          SONAR_HOST_URL: ${{ vars.SONAR_HOST_URL }}
```

This runs code analysis only on pushes to `main` (not on pull requests), since SonarCloud free tier analyzes the default branch.

## 9. Verify

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
- **"Project not found"** — Verify `sonar.projectKey` and `sonar.organization` in `build.gradle` match the values from Steps 2–3.
- **No coverage data** — Make sure `jacocoTestReport` runs before `sonar` and that the XML report path is correct.
- **Analysis not appearing** — SonarCloud free tier only analyzes public repositories. Check: `gh repo view --json visibility -q '.visibility'`
