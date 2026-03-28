# QA Stage

For a working example, see the [Greeter](https://github.com/optivem/greeter) template.

## Setup

Before running the QA stage, create the `qa` GitHub environment in your repository:

1. Go to your repository on GitHub.
2. Click **Settings** → **Environments** → **New environment**.
3. Name it `qa` and click **Configure environment**.

## Verify the QA Stage

1. Go to **Actions** on GitHub.
2. Click on `qa-stage`, then **Run workflow**.
3. For the version input, enter a valid RC version (find it under **Releases**, e.g. `v0.0.1-rc`).
4. Click **Run workflow** and wait for completion. If it fails, stop and ask for support.
5. Go to **Releases**. You should see a release with the suffix `-qa-deployed` (e.g. `v0.0.1-rc-qa-deployed`).

## Verify QA Signoff

After deployment, the QA Engineer does manual testing (exploratory testing, usability). Once complete:

1. Go to **Actions**, click on `qa-signoff`, then **Run workflow**.
2. Enter the same version (e.g. `v0.0.1-rc`).
3. Set the QA result to `approved`.
4. Click **Run workflow** and wait for completion. If it fails, stop and ask for support.
5. Go to **Releases**. You should see a prerelease with the suffix `-rc-qa-approved`.

## Checklist

1. `qa-stage` workflow completes successfully
2. Release is marked as QA deployed (e.g. `-rc-qa-deployed`)
3. `qa-signoff` workflow completes successfully
4. Release is marked as QA approved (e.g. `-rc-qa-approved`)
