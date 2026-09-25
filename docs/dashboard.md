# Dashboard across repositories

<p align="center">
  <img alt="The croissant mascot, looking worried." src="assets/mascot.png" width="200">
</p>

Each repository keeps its own history. The dashboard action reads the history branches of several repositories and ranks their unreliable tests together, the costliest first, in one static page: an organization's flakiest tests at a glance.

The demos have one, rebuilt every day: [notmyfault.aldwin.fr/dashboard](https://notmyfault.aldwin.fr/dashboard/).

## Setup

A scheduled workflow builds the page and publishes it with GitHub Pages:

```yaml
# .github/workflows/dashboard.yml
name: Dashboard

on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  dashboard:
    runs-on: ubuntu-latest
    steps:
      - uses: tashikomaaa/notmyfault/dashboard@v1
        with:
          repositories: |
            acme/shop
            acme/api
            https://gitlab.com/acme/mobile.git
          token: ${{ secrets.DASHBOARD_TOKEN }}

      - uses: actions/upload-pages-artifact@v5
        with:
          path: notmyfault-dashboard

  deploy:
    needs: dashboard
    runs-on: ubuntu-latest
    environment: github-pages
    steps:
      - uses: actions/deploy-pages@v5
```

In **Settings > Pages**, set the source to *GitHub Actions*. The page is also in the job summary, as a table of the 10 costliest tests, and the `path` output gives its directory for any other way of publishing it.

## Inputs

| Input | Default | Description |
|---|---|---|
| `repositories` | required | Repositories to read, one per line or separated by commas: `owner/repo` on the server of the workflow, or git URLs |
| `token` | `${{ github.token }}` | Token that can read the repositories on the server of the workflow |
| `history-branch` | `notmyfault-history` | Branch holding the history in each repository |
| `output` | `notmyfault-dashboard` | Directory where `index.html` is written, relative to the workspace |
| `title` | `Unreliable tests` | Title of the page |
| `limit` | `100` | Unreliable tests listed on the page, the costliest first |

## Reading the repositories

- **The token** of the workflow reads its own repository and public ones. For other private repositories, use a fine-grained personal access token or a GitHub App token with read access to their contents.
- **Git URLs** of other servers, like GitLab or Forgejo, are read **without the token**, which never leaves the server of the workflow: only public repositories can be read there.
- A repository that cannot be read, or has no history, is listed with the reason, and the others are still shown. The step fails only when no repository could be read at all.

## What the page shows

- **Repositories**, with their suites, their remembered runs, their number of unreliable tests and what those cost.
- **Unreliable tests** of every repository, the ones that failed or needed a retry in their remembered runs, ranked by [estimated cost](verdicts.md#cost-of-unreliable-tests), then by how unreliable they are: their verdict, a timeline of their runs, their failures and retries, their last failure, their proof of flakiness, their median duration and their cost. Tests already failing say since which commit.

The page reads the history branches as they are, and does not change them.
