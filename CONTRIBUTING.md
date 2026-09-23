# Contributing

Thanks for helping improve Job Application Workflow.

## Ground rules

- **No personal data, ever.** Do not commit a filled-in `profile.json`, resume, application log, or anything in the gitignored "PERSONAL DATA" list. Fixtures, examples and comments use placeholders (`Example Corp`, `<Your City>`, `555-0199`), never real people, employers or places from your own job search. CI blocks the obvious files; reviewers check the rest.
- **Keep the human in the loop.** Changes must preserve the core guarantees: forms are never auto-submitted, emails are never auto-sent, and screening questions without a stored answer stop and ask instead of guessing.
- **Be a polite bot.** No CAPTCHA solving, detection evasion, or anything that breaks a site's terms of service.

## Setup

```bash
git clone https://github.com/<you>/job-application-workflow.git
cd job-application-workflow
npm install
bash templates/hooks/setup-hooks.sh   # secret-scanning pre-commit hook
```

## Before opening a PR

```bash
for f in scripts/*.js setup.mjs; do node --check "$f"; done
python -m py_compile scripts/*.py
node scripts/test_apply.js        # needs a filled-in local profile
node scripts/test_screening.js
```

When a real form breaks the filler, add a fixture to `scripts/test_apply.js` that reproduces it with placeholder names.

## Pull requests

- Branch from `main` and use conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Keep PRs focused; describe what broke and how you verified the fix.
- Changes to `CLAUDE.md`, `AGENTS.md`, `.github/workflows/`, `.gitignore` or `*.example.json` need owner review (see `.github/CODEOWNERS`).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
