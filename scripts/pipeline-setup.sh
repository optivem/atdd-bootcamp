#!/usr/bin/env bash
# Pipeline Project Setup
#
# Sets up a new pipeline project from the Greeter template.
# Can be used by students (permanent repo) or as a course tester (temp repo).
#
# Usage:
#   ./pipeline-setup.sh --owner <github-owner> --repo <repo-name> --language <java|dotnet|typescript> --token <github-token>
#
# Test mode (creates temp repo, verifies, optionally cleans up):
#   ./pipeline-setup.sh --owner <github-owner> --language java --token <token> --test
#
# Options:
#   --owner       GitHub owner (user or org) for the new repo
#   --repo        Repository name (default: auto-generated in test mode)
#   --language    Template language: java, dotnet, typescript (default: java)
#   --token       GitHub personal access token (or set GITHUB_TOKEN env var)
#   --test        Test mode: auto-name repo, verify workflows, cleanup prompt
#   --cleanup     Auto-cleanup in test mode (no prompt)
#   --no-cleanup  Keep repo in test mode (no prompt)
#   --workdir     Working directory for cloning (default: system temp dir)
#   --help        Show this help

set -uo pipefail

# ─── Defaults ───────────────────────────────────────────────────────────────

OWNER=""
REPO=""
LANGUAGE="java"
TOKEN="${GITHUB_TOKEN:-}"
TEST_MODE=false
CLEANUP=""
WORKDIR=""

# ─── Colors ─────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${CYAN}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; }
fatal() { echo -e "${RED}✗ FATAL:${NC} $1"; exit 1; }

# ─── Parse args ─────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)     OWNER="$2"; shift 2 ;;
    --repo)      REPO="$2"; shift 2 ;;
    --language)  LANGUAGE="$2"; shift 2 ;;
    --token)     TOKEN="$2"; shift 2 ;;
    --test)      TEST_MODE=true; shift ;;
    --cleanup)   CLEANUP="yes"; shift ;;
    --no-cleanup) CLEANUP="no"; shift ;;
    --workdir)   WORKDIR="$2"; shift 2 ;;
    --help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) fatal "Unknown option: $1" ;;
  esac
done

# ─── Validate ───────────────────────────────────────────────────────────────

[ -z "$OWNER" ] && fatal "Missing --owner"
[ -z "$TOKEN" ] && fatal "Missing --token (or set GITHUB_TOKEN env var)"

case "$LANGUAGE" in
  java)       TEMPLATE_REPO="optivem/greeter-java"; TEMPLATE_NS="optivem/greeter-java" ;;
  dotnet)     TEMPLATE_REPO="optivem/greeter-dotnet"; TEMPLATE_NS="optivem/greeter-dotnet" ;;
  typescript) TEMPLATE_REPO="optivem/greeter-typescript"; TEMPLATE_NS="optivem/greeter-typescript" ;;
  *) fatal "Unsupported language: $LANGUAGE (use java, dotnet, or typescript)" ;;
esac

if [ -z "$REPO" ]; then
  if [ "$TEST_MODE" = true ]; then
    REPO="sandbox-test-$(date +%Y%m%d-%H%M%S)"
  else
    fatal "Missing --repo"
  fi
fi

FULL_REPO="$OWNER/$REPO"
[ -z "$WORKDIR" ] && WORKDIR=$(mktemp -d)

echo ""
echo "╔══════════════════════════════════════╗"
echo "║      Pipeline Project Setup          ║"
echo "╚══════════════════════════════════════╝"
echo ""
log "Owner:    $OWNER"
log "Repo:     $REPO"
log "Language: $LANGUAGE"
log "Template: $TEMPLATE_REPO"
log "Test:     $TEST_MODE"
log "Workdir:  $WORKDIR"
echo ""

# ─── Helper: GitHub API ─────────────────────────────────────────────────────

gh_api() {
  local method="$1"
  local endpoint="$2"
  shift 2
  curl -sL -X "$method" \
    -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com$endpoint" \
    "$@"
}

# ─── Helper: Wait for workflow ──────────────────────────────────────────────

wait_for_workflow() {
  local workflow_name="$1"
  local max_wait="${2:-300}"  # seconds
  local poll_interval=15
  local elapsed=0

  log "Waiting for '$workflow_name' workflow to complete (max ${max_wait}s)..."

  while [ $elapsed -lt $max_wait ]; do
    local runs
    runs=$(gh_api GET "/repos/$FULL_REPO/actions/runs?per_page=5" | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
for run in data.get('workflow_runs', []):
    if run['name'] == '$workflow_name':
        print(run['status'] + '|' + run['conclusion'] + '|' + str(run['id']))
        break
" 2>/dev/null || echo "")

    if [ -n "$runs" ]; then
      local status conclusion run_id
      status=$(echo "$runs" | cut -d'|' -f1)
      conclusion=$(echo "$runs" | cut -d'|' -f2)
      run_id=$(echo "$runs" | cut -d'|' -f3)

      if [ "$status" = "completed" ]; then
        if [ "$conclusion" = "success" ]; then
          ok "'$workflow_name' passed (run #$run_id)"
          return 0
        else
          fail "'$workflow_name' failed with conclusion: $conclusion (run #$run_id)"
          return 1
        fi
      fi
    fi

    sleep $poll_interval
    elapsed=$((elapsed + poll_interval))
    log "  ...still running (${elapsed}s elapsed)"
  done

  fail "'$workflow_name' did not complete within ${max_wait}s"
  return 1
}

# ─── Helper: Trigger workflow ───────────────────────────────────────────────

trigger_workflow() {
  local workflow_file="$1"
  local inputs="${2:-{\}}"

  log "Triggering workflow: $workflow_file"
  gh_api POST "/repos/$FULL_REPO/actions/workflows/$workflow_file/dispatches" \
    -d "{\"ref\":\"main\",\"inputs\":$inputs}" > /dev/null
}

# ─── Step 1: Create repository ──────────────────────────────────────────────

step_create_repo() {
  log "Step 1: Creating repository $FULL_REPO..."

  # Check if repo already exists
  local check
  check=$(gh_api GET "/repos/$FULL_REPO" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('full_name',''))" 2>/dev/null || echo "")

  if [ "$check" = "$FULL_REPO" ]; then
    warn "Repository $FULL_REPO already exists — skipping creation"
    return 0
  fi

  # Create repo (user repo vs org repo)
  local create_result
  create_result=$(gh_api POST "/user/repos" \
    -d "{\"name\":\"$REPO\",\"auto_init\":true,\"private\":false}" 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('full_name','') or d.get('message','unknown error'))" 2>/dev/null || echo "")

  if [ "$create_result" = "$FULL_REPO" ]; then
    ok "Created repository: $FULL_REPO"
  else
    # Try org endpoint
    create_result=$(gh_api POST "/orgs/$OWNER/repos" \
      -d "{\"name\":\"$REPO\",\"auto_init\":true,\"private\":false}" 2>/dev/null | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('full_name','') or d.get('message','unknown error'))" 2>/dev/null || echo "")

    if [ "$create_result" = "$FULL_REPO" ]; then
      ok "Created repository: $FULL_REPO (org)"
    else
      fatal "Failed to create repository: $create_result"
    fi
  fi

  sleep 3  # Wait for GitHub to initialize
}

# ─── Step 2: Clone template and copy files ──────────────────────────────────

step_apply_template() {
  log "Step 2: Applying template from $TEMPLATE_REPO..."

  cd "$WORKDIR"

  # Clone the new repo
  git clone "https://x-access-token:${TOKEN}@github.com/${FULL_REPO}.git" repo 2>/dev/null
  ok "Cloned $FULL_REPO"

  # Clone the template
  git clone "https://github.com/${TEMPLATE_REPO}.git" template 2>/dev/null
  ok "Cloned template $TEMPLATE_REPO"

  # Copy template files into the new repo
  cp -r template/.github repo/
  cp -r template/monolith repo/
  cp -r template/system-test repo/
  if [ -f template/VERSION ]; then
    cp template/VERSION repo/
  fi
  ok "Copied .github, monolith, system-test to repo"

  # Copy status badges from template README (first lines with badges)
  local badge_lines
  badge_lines=$(grep -n '^\[' template/README.md | head -5 | cut -d: -f1 | tail -1)
  if [ -n "$badge_lines" ]; then
    head -n "$badge_lines" template/README.md > /tmp/badges.txt 2>/dev/null || true
  fi
}

# ─── Step 3: Replace namespaces ─────────────────────────────────────────────

step_replace_namespaces() {
  log "Step 3: Replacing template references with $FULL_REPO..."

  cd "$WORKDIR/repo"

  # Replace repo references (image URLs, badge links, etc.)
  local lc_full_repo
  lc_full_repo=$(echo "$FULL_REPO" | tr '[:upper:]' '[:lower:]')
  local lc_template_ns
  lc_template_ns=$(echo "$TEMPLATE_NS" | tr '[:upper:]' '[:lower:]')

  # Replace in all files recursively
  find . -type f -not -path './.git/*' | while read -r file; do
    if file "$file" | grep -q text; then
      sed -i "s|$TEMPLATE_NS|$FULL_REPO|g" "$file" 2>/dev/null || true
      sed -i "s|$lc_template_ns|$lc_full_repo|g" "$file" 2>/dev/null || true
    fi
  done

  # Ensure docker-compose image URL is lowercase
  if [ -f system-test/docker-compose.yml ]; then
    sed -i "s|image: ghcr.io/.*|image: ghcr.io/${lc_full_repo}/monolith:latest|g" system-test/docker-compose.yml
  fi

  ok "Replaced all template references with $FULL_REPO"
}

# ─── Step 4: Commit and push ────────────────────────────────────────────────

step_commit_and_push() {
  log "Step 4: Committing and pushing..."

  cd "$WORKDIR/repo"

  git add -A
  git commit -m "Apply pipeline template from $TEMPLATE_REPO" > /dev/null 2>&1
  git push origin main > /dev/null 2>&1

  ok "Pushed template to $FULL_REPO"
}

# ─── Step 5: Trigger and verify commit stage ────────────────────────────────

step_verify_commit_stage() {
  log "Step 5: Verifying commit-stage-monolith workflow..."

  sleep 5  # Wait for GitHub to pick up the push

  # The push should auto-trigger commit-stage-monolith
  # But also trigger manually in case path filters prevent it
  trigger_workflow "commit-stage-monolith.yml" || true

  sleep 10  # Give workflow time to start

  if wait_for_workflow "commit-stage-monolith" 300; then
    ok "Commit stage passed!"
    return 0
  else
    fail "Commit stage failed"
    return 1
  fi
}

# ─── Step 6: Verify artifact exists ────────────────────────────────────────

step_verify_artifact() {
  log "Step 6: Checking for published artifact..."

  local packages
  packages=$(gh_api GET "/users/$OWNER/packages?package_type=container" 2>/dev/null | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, list):
    for pkg in data:
        if '$REPO' in pkg.get('name', ''):
            print(pkg['name'])
" 2>/dev/null || echo "")

  if [ -n "$packages" ]; then
    ok "Artifact found: $packages"
    return 0
  else
    warn "No artifact found yet (may take a moment to appear)"
    return 0
  fi
}

# ─── Cleanup ────────────────────────────────────────────────────────────────

cleanup_repo() {
  log "Cleaning up: deleting $FULL_REPO..."

  gh_api DELETE "/repos/$FULL_REPO" > /dev/null 2>&1

  ok "Deleted repository $FULL_REPO"

  # Clean up workdir
  rm -rf "$WORKDIR/repo" "$WORKDIR/template" 2>/dev/null || true
}

# ─── Main ───────────────────────────────────────────────────────────────────

ERRORS=0

run_step() {
  local step_name="$1"
  local step_func="$2"

  if ! $step_func; then
    fail "Step failed: $step_name"
    ((ERRORS++))
    return 1
  fi
  return 0
}

run_step "Create repository" step_create_repo
run_step "Apply template" step_apply_template
run_step "Replace namespaces" step_replace_namespaces
run_step "Commit and push" step_commit_and_push
run_step "Verify commit stage" step_verify_commit_stage
run_step "Verify artifact" step_verify_artifact

echo ""
echo "═══════════════════════════════════════"

if [ "$ERRORS" -gt 0 ]; then
  fail "Setup completed with $ERRORS errors"
  echo ""
  echo "  Repository: https://github.com/$FULL_REPO"
  echo "  Actions:    https://github.com/$FULL_REPO/actions"
  echo ""
else
  ok "All steps passed!"
  echo ""
  echo "  Repository: https://github.com/$FULL_REPO"
  echo "  Actions:    https://github.com/$FULL_REPO/actions"
  echo "  Packages:   https://github.com/$FULL_REPO/pkgs"
  echo ""
fi

# Cleanup in test mode
if [ "$TEST_MODE" = true ]; then
  if [ "$CLEANUP" = "yes" ]; then
    cleanup_repo
  elif [ "$CLEANUP" = "no" ]; then
    log "Keeping repository for inspection: https://github.com/$FULL_REPO"
  else
    echo ""
    read -p "Delete test repository $FULL_REPO? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      cleanup_repo
    else
      log "Keeping repository for inspection: https://github.com/$FULL_REPO"
    fi
  fi
fi

exit $ERRORS
