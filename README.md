# Job Application Workflow

[![CI](https://github.com/WillemDukes/job-application-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/WillemDukes/job-application-workflow/actions/workflows/ci.yml)
[![CodeQL](https://github.com/WillemDukes/job-application-workflow/actions/workflows/codeql.yml/badge.svg)](https://github.com/WillemDukes/job-application-workflow/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Open-source, human-in-the-loop job application automation. It scans Handshake for postings, filters them by commute, pay and scam signals, and uses Playwright to fill Applicant Tracking System (ATS) forms in a real browser, then **stops at the review screen so you click Submit yourself**. With Claude Code it can also draft (never send) follow-up emails through the Gmail connector and look up recruiter emails through the Hunter connector.

## Prerequisites

- Node.js 20+
- A machine that can run Chromium
- Optional: Python 3 (only for generating cover letters; standard library only)
- Optional: [Claude Code](https://claude.com/claude-code) with the Gmail and Hunter connectors enabled at <https://claude.ai/settings/connectors>

## Quick start

```bash
git clone https://github.com/WillemDukes/job-application-workflow.git
cd job-application-workflow
```

Run setup. It installs dependencies, downloads Chromium and walks you through your profile:

- Windows: `.\setup.ps1`
- macOS/Linux: `./setup.sh`
- Unattended: copy `setup.answers.example.json` to `setup.answers.json`, fill it in, then run setup with `--non-interactive`.

`npm run check` validates your config (setup runs it automatically at the end).

## Daily workflow

| Step | Command |
|---|---|
| Scan Handshake | `npm run scan -- --dry-run` |
| Review targets | open `targets.csv` |
| Preview fills | `npm run apply:dry` |
| Fill forms for review | `npm run apply` |
| Watch one form | `npm run watch -- --url <form-url>` |
| Cover letter | `npm run cover -- --position "<role>" --company "<employer>"` |

## Your data stays local

Everything personal lives in gitignored files created by setup from the `*.example.json` templates:

| File | Holds |
|---|---|
| `profile.json` | contact info, education, availability, work history |
| `profile_private.json` | ATS logins, date of birth, permanent address (read only when a form demands it) |
| `screening_answers.json` | your answers to common screening questions |
| `employers.json`, `targets.csv` | target employers and leads |
| `applied.jsonl`, `logs/` | application history |
| `resumes/`, `documents/` | your resume and cover letters |

SSN, driver's license and bank details are never stored. CI fails if any of the files above is committed. Every field is documented in [`profile.schema.md`](profile.schema.md).

## Using it with Claude Code

Run `claude` in the project folder. [`CLAUDE.md`](CLAUDE.md) (and [`AGENTS.md`](AGENTS.md) for Codex) holds the rules the agent follows: dry-run first, never auto-submit, never auto-send email, never guess a screening answer.

Example prompts:

- "Run today's job scan and tell me what's new."
- "Draft a follow-up email for the role at Example Corp."
- "Run the application batch and stop at the review screen."

## Tests

The Playwright suites run offline against fixture pages and need a filled-in profile:

```bash
node scripts/test_apply.js
node scripts/test_screening.js
```

With only the example placeholders in place, the checks that expect real contact values fail. That is expected.

## Troubleshooting

- **Chromium missing:** `npx playwright install chromium`
- **ATS login expired:** update the credentials in `profile_private.json`
- **A field is not found:** give Claude Code the job URL so it can inspect the page and adjust the selectors
- **Rate-limited or blocked:** slow down and respect the site's terms of service

## Safety and etiquette

- Always dry-run before a real run.
- Review every application yourself before submitting it.
- Never apply twice to the same posting.
- Respect each site's terms of service and rate limits. You are responsible for how you use this tool.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Report vulnerabilities privately through GitHub security advisories.

## License

[MIT](LICENSE) © 2026 Willem Dukes. Repository scaffolding is derived from [vbonk/repo-template](https://github.com/vbonk/repo-template) (MIT).
