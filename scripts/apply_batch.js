/**
 * apply_batch.js - work a queue of Handshake jobs in one browser session.
 *
 * WHAT IT DOES
 * ------------
 * Walks the rows you select out of applications.csv, and for each one:
 *   - opens the job page and works out how it applies (native / external /
 *     already applied / no apply control at all),
 *   - native  -> opens the form, attaches the documents, answers the saved
 *                screening questions, and stops at the review screen,
 *   - external-> follows the handoff to the employer's site and fills whatever
 *                is reachable without a login (see apply_external.js),
 *   - writes what it learned back to the CSV,
 *   - moves to the next job in the SAME Chrome. The automation profile is
 *     single-instance; a second browser is a ProcessSingleton crash.
 *
 * SUBMITTING
 * ----------
 * Off unless you pass --submit. Even then it only clicks when the form is
 * provably clean - see cleanGates() in apply_core.js - and it then re-reads the
 * live page and requires the "Applied on ..." banner before it will write
 * status=applied. If the banner is not there, the row is NOT marked applied,
 * because a CSV that lies about what was sent is worse than no automation.
 *
 * Nothing here clicks Submit on an external portal. Those have no review step
 * and no undo.
 *
 * USAGE
 *   node scripts/apply_batch.js --dry-run              # probe only, touch nothing
 *   node scripts/apply_batch.js --limit 5              # prep the next 5 native jobs
 *   node scripts/apply_batch.js --keys ce0e19f1,91c49d
 *   node scripts/apply_batch.js --external --limit 3   # include external jobs
 *   node scripts/apply_batch.js --limit 5 --submit     # opt in to auto-submit
 *   node scripts/apply_batch.js --make-cover --limit 5 # generate missing letters
 *
 * OPTIONS
 *   --keys a,b,c        only these app_keys (prefix match, so 8 chars is fine)
 *   --status found      which CSV status to pick up          (default: found)
 *   --limit N           most jobs to work this run           (default: 10)
 *   --external          also work "Apply externally" jobs    (default: skip)
 *   --external-only     ONLY external jobs
 *   --submit            opt in to auto-submitting clean native forms
 *   --submit-external   opt in to SUBMITTING external portal applications.
 *                       Irreversible: an
 *                       external portal has no review screen and no undo, so
 *                       each form must pass externalSubmitGate() first.
 *   --make-cover        generate a missing cover letter via make_cover_letter.py
 *   --demographics      also answer the VOLUNTARY demographic questions
 *   --no-screening      do not answer screening questions at all
 *   --no-portfolio      leave the third document slot empty
 *   --no-transcript     leave the transcript slot empty
 *   --no-upload-resume  do not attach the resume on external portals
 *   --allow-handshake-mark
 *                       let the external path click "Apply externally". That
 *                       click MARKS the job as externally applied on your
 *                       Handshake account - it is the only way Handshake will
 *                       reveal the employer's URL. Off by default.
 *   --hold N            minutes to hold the LAST job open    (default: 20)
 *   --pace N            minutes to hold EACH job open before advancing, and
 *                       never auto-close a form. Turns the batch from
 *                       unattended into operator-paced: prep one, you submit
 *                       it, then it moves on.               (default: 0 = off)
 *   --dry-run           probe each job and report; never open a form
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { launchBrowser, profileIsEmpty, settle, pause, argOf, REPO_ROOT, RUNS_DIR } = require("./lib");
const { validateProfile } = require('./config');
const { logger, screenshotOnFailure, appliedLedger, withRetry } = require('./util');

const core = require("./apply_core");
const { runExternal } = require("./apply_external");

const GENERATED = path.join(REPO_ROOT, "generated");

/** Filenames Windows will not take. Mirrors make_cover_letter.py's safe_name. */
const safeName = (s) => (s || "").replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim();

/**
 * The application cover letter for this employer, if one has been generated.
 * make_cover_letter.py writes `generated\<Company> Cover Letter.docx`.
 */
function coverFor(employer) {
  const candidates = [
    path.join(GENERATED, `${employer} Cover Letter.docx`),
    path.join(GENERATED, `${safeName(employer)} Cover Letter.docx`),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** Build one, using the APPLICATIONS template. Returns the path or null. */
function makeCover(row, log) {
  const out = path.join(GENERATED, `${safeName(row.employer)} Cover Letter.docx`);
  try {
    execFileSync("python", [
      path.join(REPO_ROOT, "scripts", "make_cover_letter.py"),
      "--company", row.employer,
      "--position", row.role,
      "--kind", "application",
      "--key", row.app_key,
      "--out", out,
    ], { stdio: "pipe" });
    if (fs.existsSync(out)) { log(`  cover    : generated ${path.basename(out)}`); return out; }
  } catch (e) {
    log(`  cover    : could not generate one (${String(e.message).split("\n")[0]})`);
  }
  return null;
}

/** Close the apply modal so the next job starts from a clean page. */
async function closeModal(page) {
  const x = page.locator(core.SEL.applyModalClose).first();
  if (await x.count().catch(() => 0)) {
    await x.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
}

/** Pick the rows this run will work. */
function selectRows(opts) {
  const { rows } = core.readCsv();
  const { keys, status, limit, externalOnly, external } = opts;

  let picked = rows;
  if (keys.length) {
    picked = rows.filter((r) => keys.some((k) => r.app_key.startsWith(k)));
  } else {
    picked = rows.filter((r) => r.status === status);
    // Without --keys, never touch a row already marked applied.
    picked = picked.filter((r) => r.status !== "applied");
  }

  // The scan records "apply: native" / "apply: external" in notes when it
  // opened the detail page. Rows it never probed have neither, and those are
  // worth opening - that is how you find out.
  const kindOf = (r) => {
    const n = r.notes || "";
    if (/apply:\s*external/i.test(n)) return "external";
    if (/apply:\s*native/i.test(n)) return "native";
    return "unknown";
  };

  if (externalOnly) picked = picked.filter((r) => kindOf(r) === "external");
  else if (!external) picked = picked.filter((r) => kindOf(r) !== "external");

  return picked.slice(0, limit);
}

(async () => {
  validateProfile();

  let browserCtx;
  process.on('SIGINT', async () => {
    logger.info('Caught interrupt signal (SIGINT). Closing browser...');
    if (browserCtx) await browserCtx.close().catch(()=>{});
    process.exit(0);
  });

  const args = process.argv.slice(2);
  const opts = {
    keys: (argOf(args, "--keys", "") || "").split(",").map((s) => s.trim()).filter(Boolean),
    status: argOf(args, "--status", "found"),
    limit: Number(argOf(args, "--limit", "10")),
    external: args.includes("--external") || args.includes("--external-only"),
    externalOnly: args.includes("--external-only"),
    submit: args.includes("--submit"),
    makeCover: args.includes("--make-cover"),
    demographics: args.includes("--demographics"),
    noScreening: args.includes("--no-screening"),
    noPortfolio: args.includes("--no-portfolio"),
    noTranscript: args.includes("--no-transcript"),
    uploadResume: !args.includes("--no-upload-resume"),
    allowMark: args.includes("--allow-handshake-mark"),
    hold: Number(argOf(args, "--hold", "20")),
    pace: Number(argOf(args, "--pace", "0")),
    submitExternal: args.includes("--submit-external"),
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose"),
  };

  if (!fs.existsSync(core.CSV_PATH)) { console.error(`no applications.csv at ${core.CSV_PATH}`); process.exit(2); }
  if (profileIsEmpty()) {
    console.error("the automation Chrome profile is empty - run browser_setup.js first");
    process.exit(2);
  }

  const queue = selectRows(opts);
  if (!queue.length) {
    console.log("nothing to do - no rows matched. Try --status found, --keys, or --external.");
    process.exit(0);
  }

  console.log(`\nqueue: ${queue.length} job(s)`);
  queue.forEach((r, i) => console.log(`  ${i + 1}. ${r.employer} - ${r.role}`));
  console.log(opts.submit
    ? "\n!! --submit is ON. Clean forms will be submitted for real.\n"
    : "\nsubmit: OFF. Every form stops at the review screen.\n");
  if (opts.dryRun) console.log("--dry-run: probing only, no form will be opened.\n");

  // Per-field lines ("filled :", "widget :", "wskip :", "gap :", "screen :",
  // "you :") go to this run's .log file only, unless --verbose. Everything
  // else - the one-line-per-job summaries - goes to both stdout and the file,
  // so the file is always the complete record of a run.
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = core.makeLogger(path.join(RUNS_DIR, `batch_${runStamp}.log`), opts.verbose);

  const { ctx, page } = await launchBrowser();
  browserCtx = ctx;
  browserCtx = ctx;
  const results = [];

  try {
    for (const [i, row] of queue.entries()) {
      log("-".repeat(62));
      log(`${row.employer} - ${row.role} | ${i + 1}/${queue.length}`);
      log(row.url);

      const res = {
        key: row.app_key, employer: row.employer, role: row.role,
        kind: null, outcome: "error", unfilled: [], advisories: [], shot: null,
      };

      try {
        await page.goto(row.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await settle(page);
        await core.dismissPromo(page);
        await pause();

        const kind = await core.probeApply(page);
        res.kind = kind;

        if (kind === "already") {
          log("  already applied on Handshake - marking the row and moving on");
          res.outcome = "already-applied";
          if (row.status !== "applied") {
            core.updateRow(row.app_key, {
              status: "applied",
              date_applied: row.date_applied || new Date().toISOString().slice(0, 10),
              notes: core.addNote(row, "verified live: Applied banner (found by apply_batch)"),
            });
          }
        } else if (kind === "none") {
          log("  no apply control on Handshake at all - check the description");
          res.outcome = "no-apply-control";
          res.unfilled.push("no apply control on the Handshake page");
          core.updateRow(row.app_key, { notes: core.addNote(row, "apply: none") });
        } else if (kind === "external") {
          if (!opts.external) {
            log("  applies externally - skipped (pass --external to work these)");
            res.outcome = "skipped-external";
            core.updateRow(row.app_key, { notes: core.addNote(row, "apply: external") });
          } else if (opts.dryRun) {
            log("  applies externally - would follow the handoff");
            res.outcome = "dry-run";
          } else {
            const rep = await runExternal(page, row, {
              uploadResume: opts.uploadResume,
              demographics: opts.demographics,
              noScreening: opts.noScreening,
              allowMark: opts.allowMark,
              submitExternal: opts.submitExternal,
              log,
            });
            res.outcome = rep.outcome;
            res.unfilled = rep.unfilled;
            res.shot = rep.shot;
            res.externalUrl = rep.externalUrl;
            res.ats = rep.ats;
            // Status has to say what actually happened. A landing page with no
            // form on it is not "in progress" - nothing is in progress.
            const EXT_STATUS = {
              filled: "in_progress",
              partial: "in_progress",
              "login-wall": "blocked",
              "no-form": "needs_check",
              unreadable: "needs_check",
              "no-external-button": "needs_check",
              "handoff-failed": "needs_check",
              // Nothing happened at all, so the row must stay where it was.
              "needs-handshake-mark": null,
            };
            const nextStatus = rep.outcome in EXT_STATUS
              ? EXT_STATUS[rep.outcome]
              : "needs_check";
            core.updateRow(row.app_key, {
              status: nextStatus || row.status,
              notes: core.addNote(row,
                `apply: external; external_url: ${core.cleanUrl(rep.externalUrl) || "?"}; ` +
                `ats: ${rep.ats}; ext: ${rep.outcome}`),
            });
          }
        } else if (kind === "native") {
          if (opts.dryRun) {
            log("  native Apply found - stopping before the form (--dry-run)");
            res.outcome = "dry-run";
            core.updateRow(row.app_key, { notes: core.addNote(row, "apply: native") });
          } else {
            log("  opening the application form (native Handshake apply)");
            await page.locator(core.SEL.nativeApply).first().click({ timeout: 15000 });
            await page.waitForTimeout(3500);
            await core.dismissPromo(page);

            let cover = coverFor(row.employer);
            if (!cover && opts.makeCover) cover = makeCover(row, log);

            const { modal, unfilled, advisories } = await core.fillModal(page, {
              cover,
              portfolio: core.DEFAULT_PORTFOLIO, noPortfolio: opts.noPortfolio,
              transcript: core.DEFAULT_TRANSCRIPT, noTranscript: opts.noTranscript,
              noScreening: opts.noScreening, demographics: opts.demographics,
              log,
            });
            res.unfilled = unfilled;
            res.advisories = advisories || [];

            fs.mkdirSync(RUNS_DIR, { recursive: true });
            res.shot = path.join(RUNS_DIR, `apply_${row.app_key}_${new Date().toISOString().slice(0, 10)}.png`);
            await page.screenshot({ path: res.shot, fullPage: false }).catch(() => {});

            const sub = await core.submitIfClean(page, modal, unfilled, { allow: opts.submit });
            if (sub.submitted && sub.verified) {
              log("  SUBMITTED and verified against the live page");
              res.outcome = "submitted";
              core.updateRow(row.app_key, {
                status: "applied",
                date_applied: new Date().toISOString().slice(0, 10),
                cover_letter_path: cover || row.cover_letter_path,
                notes: core.addNote(row, "apply: native; submitted by apply_batch (verified live: Applied banner)"),
              });
            } else if (sub.submitted && !sub.verified) {
              // Clicked, but the banner never appeared. Do NOT claim applied.
              log("  !! Submit was clicked but the Applied banner never appeared.");
              log("     The row is NOT marked applied. Check this one by hand.");
              res.outcome = "submit-unverified";
              res.unfilled.push("Submit was clicked but the page never confirmed - verify by hand");
              core.updateRow(row.app_key, {
                status: "needs_check",
                notes: core.addNote(row, "apply: native; SUBMIT CLICKED BUT UNVERIFIED - check by hand"),
              });
            } else {
              res.outcome = unfilled.length ? "prepped-with-gaps" : "prepped";
              if (opts.submit) {
                log("  not submitted:");
                sub.blocked.forEach((b) => log(`    - ${b}`));
              }
              core.updateRow(row.app_key, {
                status: "in_progress",
                cover_letter_path: cover || row.cover_letter_path,
                notes: core.addNote(row, "apply: native; prepped by apply_batch, awaiting your Submit"),
              });
            }

            if (res.unfilled.length) {
              log("  needs your attention:");
              res.unfilled.forEach((u) => log(`    - ${u}`));
            }
            if (res.advisories.length) {
              log("  for your information (did not block anything):");
              res.advisories.forEach((a) => log(`    - ${a}`));
            }
            if (!res.unfilled.length && res.outcome === "prepped") {
              log("  everything the script knows how to fill is filled");
            }

            // Leave the LAST job on screen; tidy up the ones before it. Under
            // --pace nothing is tidied - every job keeps its window.
            if (i < queue.length - 1 && !opts.pace) await closeModal(page);
          }
        }
      } catch (e) {
        console.error(`  error: ${e.message}`);
        res.outcome = "error";
        res.unfilled.push(`the run threw: ${e.message}`);
        await closeModal(page).catch(() => {});
      }

      // --pace: hold THIS job on screen before moving on, instead of only the
      // last one: "don't close these windows until they are
      // fully applied". Only one Chrome can hold the automation profile, so ten
      // simultaneous windows is not available - the batch becomes operator-paced
      // instead: prep one, finish and submit it, then it advances.
      if (opts.pace > 0 && i < queue.length - 1) {
        log(`\n  holding this one for ${opts.pace} min - finish and submit it, then the batch advances.`);
        await page.waitForTimeout(opts.pace * 60 * 1000);
      }

      results.push(res);
    }

    // --- summary -----------------------------------------------------------
    log("\n" + "=".repeat(62));
    log("BATCH DONE");
    log("=".repeat(62));
    const w = (s, n) => (String(s || "") + " ".repeat(n)).slice(0, n);
    log(`\n${w("EMPLOYER", 28)} ${w("KIND", 9)} ${w("OUTCOME", 20)} GAPS`);
    for (const r of results) {
      log(`${w(r.employer, 28)} ${w(r.kind, 9)} ${w(r.outcome, 20)} ${r.unfilled.length || ""}`);
    }

    const needs = results.filter((r) => r.unfilled.length);
    if (needs.length) {
      log("\nWhat still needs you:");
      for (const r of needs) {
        log(`\n  ${r.employer} - ${r.role}`);
        r.unfilled.forEach((u) => log(`    - ${u}`));
        if (r.externalUrl) log(`    url: ${r.externalUrl}`);
      }
    }

    const submitted = results.filter((r) => r.outcome === "submitted");
    if (submitted.length) log(`\n${submitted.length} application(s) submitted and verified.`);
    const prepped = results.filter((r) => r.outcome.startsWith("prepped"));
    if (prepped.length) {
      log(`\n${prepped.length} form(s) prepped and NOT submitted. The last one is on screen now.`);
      log("Review it, click Submit Application yourself, then tell Claude so the row can move.");
    }

    if (!opts.dryRun && opts.hold > 0) {
      log(`\nChrome stays open for ${opts.hold} min.`);
      await page.waitForTimeout(opts.hold * 60 * 1000);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
})();
