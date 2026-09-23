# Job Application Automation - Rules for Codex and other agents

## Output Discipline
- Be terse. Lead with the result. Use bullets, no narration, no restating the plan. Keep status/edit reports under 100 words.
- Script stdout is already a summary; do not paste run logs into chat.
- Do not re-run a fill script just to "see what happens". Run once, read the summary, fix, and run again.

## Hard Rules (Never Relax)
1. **Pre-flight reads:** Always read `profile.json` (and `profile_private.json` for credentials if needed) before doing anything.
2. **Never fabricate answers:** If a screening question is not covered by `profile.json` or `screening_answers.json`, never fabricate or guess an answer. Stop and ask the human instead.
3. **Always dry-run:** Always perform and show a dry run (e.g., `--dry-run`) before starting any real application process.
4. **Manual submission:** External portals are NEVER auto-submitted. The script must fill the form, stop at the review screen, and wait for the human to click Submit.
5. **No auto-emailing:** Never send an email automatically. Explicitly draft them only. The human will attach files and send.
6. **No data leakage:** Never commit, print, or expose the full contents of `profile_private.json`, `.env`, or any resume/document containing personal data.

## Runtime & Logging
- **Logging applications:** Log every submitted application as one JSON line appended to `applied.jsonl`. Include fields: `timestamp`, `company`, `title`, `url`, `status`.
- **Connectors:** 
  - Use the **Hunter connector** to look up and verify a recruiter's email address at a target company before drafting a follow-up email. Only use verified emails.
  - Use the **Gmail connector** to draft follow-up emails. explicitly draft only, never send. Remind the human to attach the resume/cover letter themselves.
- Do not modify the existing cover letter templates. Generate per-lead copies instead.

## Repository Rules
- Work on a feature branch and open a PR; do not push directly to `main`. Use conventional commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`).
- Personal data never enters git: the `.gitignore` "PERSONAL DATA" section is authoritative, and CI fails if any of those files is tracked. Examples, tests and comments use placeholder names (`Example Corp`, `<Your City>`), never real people, employers or places from a real job search.
- CI (`.github/workflows/ci.yml`) checks JS/Python syntax, example-JSON validity and the personal-data guard. The Playwright suites (`node scripts/test_apply.js`, `node scripts/test_screening.js`) run locally only.
- Install the secret-scanning pre-commit hook once per clone: `bash templates/hooks/setup-hooks.sh`.
- Keep `CLAUDE.md` and `AGENTS.md` consistent.

## Template Ancestry
This project descends from `vbonk/repo-template`. `.repo-template.yaml` records the last reconciled compatibility baseline. Normal project work does not rerun Phase 0. For a template upgrade or compatibility request, follow `docs/TEMPLATE-UPGRADE.md` (or the canonical spec linked in the marker).
