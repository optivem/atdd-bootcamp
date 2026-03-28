# Roadmap

This page gives you the full picture — every module, every task, time estimates, and a week-by-week schedule.

**Total estimated time: ~20 hours across 14 tasks.**

---

## Module 1. Introduction (~4h)

**Task 1. Project Repository** ~1h
- Repository created, publicly accessible, with LICENSE, README, and collaborators

**Task 2. Pipeline Template** ~1h
- Template applied; all template references replaced with your own; GitHub Actions workflows visible

**Task 3. Project Documentation** ~1h
- README includes background context, contributors with GitHub profile links
- Status badge and website link (if using GitHub Pages)

**Task 4. Project Ticket Board** ~1h
- Project board created, publicly accessible, linked from README

---

## Module 2. Commit Stage (~1h)

**Task 1. Commit Stage** ~1h
- `commit-stage-monolith` workflow passes with placeholder stages for: Unit Tests, Narrow Integration Tests, Component Tests, Contract Tests
- Docker image artifact published to Packages

---

## Module 3. Acceptance Stage (~1h)

**Task 1. Acceptance Stage** ~1h
- `acceptance-stage` workflow completes with placeholder stages for: Smoke Tests, Acceptance Tests, External System Contract Tests, E2E Tests
- Release candidate created in GitHub Releases; Docker image tagged with RC version

---

## Module 4. QA Stage (~1h)

**Task 1. QA Stage** ~1h
- `qa-stage` workflow completes with placeholder stage for: Smoke Tests; release marked as QA deployed
- `qa-signoff` workflow completes; release marked as QA success

---

## Module 5. Production Stage (~1h)

**Task 1. Production Stage** ~1h
- Shared release subprocess extracted (used by both QA and Production stages) with placeholder stage for: Smoke Tests
- `prod-stage` workflow completes
- Release tagged and marked as Latest in GitHub Releases

---

## Module 6. Technical Customization (~1h)

**Task 1. Languages** ~1h
- Monolith language replaced to match your real-life project
- System test language replaced to match your real-life QA automation language
- `commit-stage-monolith` and `acceptance-stage` workflows pass

---

## Module 7. Domain Customization (~3h)

**Task 1. System Behavior Documentation** ~1h
- Primary actors, use cases, and external systems identified
- System Use Case Diagram created; documentation published

**Task 2. Smoke Tests** ~1h
- Smoke tests for API and UI exist and pass

**Task 3. E2E Tests** ~1h
- At least 3 additional E2E tests written and passing
- At least one test spans an external system; at least one covers CRUD; at least one covers business logic

---

## Module 8. Architecture Customization (~6h)

**Task 1. Multi-Component Implementation** ~3h
- System decomposed into components (e.g. frontend, backend)
- Separate commit stage workflow per component
- Docker Compose updated; acceptance, QA, and production stages all pass

**Task 2. Multi-Repository Implementation** ~3h
- Each component has its own repository with passing commit stage
- Acceptance, QA, and production stages all pass in the system repository

---

## Module 9. Extensions — Optional

**Task 1. Go Further**
- Additional technical characteristics reflected in sandbox project
- Advanced work beyond core curriculum (e.g. real deployment, version management, feature flags, logging)

---

## Time Summary

| Module | Tasks | Hours |
|--------|:-----:|------:|
| 1. Introduction | 4 | 4 |
| 2. Commit Stage | 1 | 1 |
| 3. Acceptance Stage | 1 | 1 |
| 4. QA Stage | 1 | 1 |
| 5. Production Stage | 1 | 1 |
| 6. Technical Customization | 1 | 1 |
| 7. Domain Customization | 3 | 3 |
| 8. Architecture Customization | 2 | 6 |
| **Total** | **14** | **~20** |

---

## 4-Week Schedule (~5 hours/week)

| Week | Module | Tasks | Hours |
|:----:|--------|-------|------:|
| 1 | 1. Introduction | Tasks 1–4 (Repo + Template + Docs + Board) | 4 |
| 1 | 2. Commit Stage | Task 1 | 1 |
| 2 | 3–5. Pipeline Stages | Acceptance + QA + Production stages | 3 |
| 2 | 6. Technical Customization | Task 1 (Languages) | 1 |
| 3 | 7. Domain Customization | Tasks 1–3 (Behavior Docs + Smoke + E2E) | 3 |
| 3 | 8. Architecture Customization | Task 1 (Multi-Component) | 3 |
| 4 | 8. Architecture Customization | Task 2 (Multi-Repository) | 3 |

**Pace: ~5 hours/week for 4 weeks.**

Module 9 (Extensions) is optional and open-ended — work on it after completing the core curriculum if time permits.
