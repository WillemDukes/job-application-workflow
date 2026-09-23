/**
 * prep_apply.js - open ONE Handshake application, fill what it can, and STOP.
 *
 * THE RULE THIS SCRIPT EXISTS TO KEEP: it never clicks Submit. It fills the
 * form, leaves Chrome open on the review screen, prints what it could not fill,
 * and submit the application manually.
 *
 * That is still true even with an opt-in --submit
 * flag in the BATCH runner. It was deliberately not added here. Keeping one
 * tool that structurally cannot submit means there is always a safe way to look
 * at a form: this file imports no submit function and calls none. If you want
 * auto-submit, use apply_batch.js --submit and read what it gates on first.
 *
 * The engine moved to apply_core.js. It used to live inline here,
 * which meant the batch runner would have needed a second copy of a form-filler
 * that types real answers into real job applications. Two copies drift, and the
 * drift is invisible until an employer sees the wrong field. Everything below
 * is argument handling and reporting; the behaviour is unchanged.
 *
 * HANDSHAKE-NATIVE ONLY. A job whose button reads "Apply externally" is
 * refused here rather than half-attempted - use apply_external.js for those.
 *
 * DOCUMENTS.
 *
 *   RESUME - the Handshake default resume is the SAME file as Resume.docx in
 *   the repo, not a separate upload. Handshake pre-selects it. This only CHECKS
 *   that something is in the resume slot and never uploads, replaces or renames
 *   it. The check is filename-agnostic on purpose, so a later rename cannot make
 *   it report a missing resume that is right there. There is no PDF resume in
 *   this project and must never be one again.
 *
 *   COVER LETTER - pass --cover with a letter built from the APPLICATIONS
 *   template by make_cover_letter.py. The other template is for emailing a
 *   named hiring manager and opens "Dear [HIRING MANAGER NAME],". Neither
 *   template is ever edited - a copy is made per job.
 *
 * Usage:
 *   node prep_apply.js --key <app_key>
 *   node prep_apply.js --key <app_key> --cover generated\<Company> Cover Letter.docx
 *   node prep_apply.js --key <app_key> --hold 5           # minutes to stay open
 *   node prep_apply.js --key <app_key> --replace-cover    # force a fresh upload
 *   node prep_apply.js --key <app_key> --portfolio <path.docx>
 *   node prep_apply.js --key <app_key> --no-portfolio     # leave slot 3 empty
 *   node prep_apply.js --key <app_key> --transcript <path.pdf>
 *   node prep_apply.js --key <app_key> --no-transcript
 *   node prep_apply.js --key <app_key> --no-screening
 *   node prep_apply.js --key <app_key> --demographics     # the VOLUNTARY ones
 *   node prep_apply.js --key <app_key> --dry-run          # stop BEFORE the form
 */
const fs = require("fs");
const path = require("path");
const {
  launchBrowser, profileIsEmpty, settle, pause, argOf, RUNS_DIR,
} = require("./lib");
const core = require("./apply_core");

(async () => {
  const args = process.argv.slice(2);
  const key = argOf(args, "--key");
  const cover = argOf(args, "--cover");
  const dryRun = args.includes("--dry-run");
  // Reuse an identically named letter already in the Handshake account by
  // default; pass --replace-cover when the letter was regenerated and the
  // stored copy is stale (a new date, or edited wording).
  const replaceCover = args.includes("--replace-cover");
  const portfolio = argOf(args, "--portfolio", core.DEFAULT_PORTFOLIO);
  const noPortfolio = args.includes("--no-portfolio");
  const transcript = argOf(args, "--transcript", core.DEFAULT_TRANSCRIPT);
  const noTranscript = args.includes("--no-transcript");
  const noScreening = args.includes("--no-screening");
  // Voluntary by law: off unless requested on the run.
  const demographics = args.includes("--demographics");
  const holdMin = Number(argOf(args, "--hold", "20"));

  if (!key) {
    console.error("usage: node prep_apply.js --key <app_key> [--cover <path.docx>] [--hold <minutes>] [--dry-run]");
    process.exit(2);
  }
  if (!fs.existsSync(core.CSV_PATH)) { console.error(`no applications.csv at ${core.CSV_PATH}`); process.exit(2); }

  const row = core.rowFor(core.CSV_PATH, key);
  if (!row) { console.error(`no row with app_key ${key}`); process.exit(2); }
  if (cover && !fs.existsSync(cover)) { console.error(`cover letter not found: ${cover}`); process.exit(2); }
  if (profileIsEmpty()) {
    console.error("the automation Chrome profile is empty - run browser_setup.js first");
    process.exit(2);
  }

  console.log(`prepping : ${row.employer} - ${row.role}`);
  console.log(`url      : ${row.url}`);
  console.log(`cover    : ${cover || "(none)"}`);
  console.log("resume   : whatever Handshake has set as the default (this script never touches it)");

  const { ctx, page } = await launchBrowser();

  try {
    await page.goto(row.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle(page);
    await core.dismissPromo(page);
    await pause();

    // --- what kind of apply is this, before anything is clicked -------------
    const kind = await core.probeApply(page);

    if (kind !== "native") {
      console.log("\n" + "=".repeat(62));
      if (kind === "already") {
        console.log("ALREADY APPLIED - Handshake shows an Applied banner on this job.");
        console.log("Move the CSV row to status=applied if it is not there already.");
      } else if (kind === "external") {
        console.log("SKIPPED - this job applies on the employer's own site.");
        console.log('Handshake shows "Apply externally", so there is no form here to fill.');
        console.log(`Work it with:  node scripts/apply_external.js --key ${key}`);
      } else {
        console.log("SKIPPED - this job has no apply control on Handshake at all.");
        console.log("Check the description; some of these say to apply on the employer's website.");
      }
      console.log("=".repeat(62));
      await ctx.close();
      process.exit(0);
    }

    if (dryRun) {
      console.log("\n--dry-run: native Apply found, stopping BEFORE opening the form. Nothing clicked.");
      await ctx.close();
      process.exit(0);
    }

    // --- open the application form ------------------------------------------
    console.log("\nopening the application form (native Handshake apply)");
    await page.locator(core.SEL.nativeApply).first().click({ timeout: 15000 });
    await page.waitForTimeout(3500);
    await core.dismissPromo(page); // the promo can appear after the click too

    const { modal, unfilled } = await core.fillModal(page, {
      cover, replaceCover,
      portfolio, noPortfolio,
      transcript, noTranscript,
      noScreening, demographics,
    });

    // --- evidence, then stop ------------------------------------------------
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const shot = path.join(RUNS_DIR, `apply_${key}_${new Date().toISOString().slice(0, 10)}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

    console.log("\n" + "=".repeat(62));
    console.log("PREPPED - NOT SUBMITTED");
    console.log("=".repeat(62));
    if (unfilled.length) {
      console.log("\nNeeds your attention:");
      unfilled.forEach((u) => console.log("  - " + u));
    } else {
      console.log("\nEverything this script knows how to fill is filled.");
    }

    if (modal.found && modal.hasSubmit) {
      console.log('\n"Submit Application" is on screen and was NOT clicked.');
      // submitEnabled is a real boolean now. Previously READ_MODAL never
      // returned it, so `!undefined` printed GREYED OUT on every single run,
      // including forms that were perfectly ready to send.
      if (modal.submitEnabled === false) {
        console.log("!! it is GREYED OUT - Handshake still wants something above.");
      }
      if (modal.blockers) {
        console.log('!! the form shows a red "Please enter a valid response" warning.');
      }
    }

    console.log(`\nscreenshot: ${shot}`);
    console.log(`\nChrome stays open for ${holdMin} min. Review every field, then click`);
    console.log("Submit Application yourself. Tell Claude once it's sent so the row");
    console.log("can move to status=applied.");

    await page.waitForTimeout(Math.max(0, holdMin) * 60 * 1000);
  } catch (e) {
    console.error(`\nerror: ${e.message}`);
    console.error("Nothing was submitted. Finish by hand if the window is still open.");
  } finally {
    await ctx.close().catch(() => {});
  }
})();
