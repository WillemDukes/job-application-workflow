/**
 * apply_external.js - the "Apply externally" path.
 *
 * WHAT THIS DOES
 * --------------
 * Handshake hands these jobs off to the employer's own site. This follows that
 * handoff, works out which ATS it landed in, fills whatever is reachable
 * WITHOUT a login, attaches the resume when there is a slot for it, screenshots
 * the result, and stops.
 *
 * WHAT IT WILL NOT DO, EVER
 * -------------------------
 *   - Create an account. Most of these portals (Workday above all) want a new
 *     account with a password before they will show you a form. Claude does not
 *     create accounts and does not type passwords - that must be done manually in the
 *     browser. A job that hits that wall is REPORTED, not worked around.
 *   - Type into anything that looks like a credential, an SSN, or a bank field.
 *     FILL_SCREENING refuses those by pattern; this adds a second check.
 *
 * SUBMITTING
 * ----------
 * `--submit-external` allows submitting external applications directly. It is
 * off by default and it is NOT a blanket yes:
 *
 *   - every form must clear externalSubmitGate() first, which is stricter than
 *     the Handshake gate because there is no review screen, no undo and no
 *     Applied banner here - the click IS the whole transaction;
 *   - the finished form is screenshotted BEFORE the click, because afterwards
 *     there is no other record of what was sent;
 *   - the outcome is only written as "submitted" when the portal itself prints
 *     a confirmation. No confirmation means `submit-unconfirmed`, never a
 *     cheerful guess.
 *
 * A form that is blank, behind a wall, missing its resume, or still on step 1
 * of a 3-step wizard is NOT sent. An empty application is worse than none.
 *   - Click Handshake's "Did you apply?" prompt. Handshake asks for manual confirmation.
 *
 * Usage (normally driven by apply_batch.js, but runnable alone):
 *   node scripts/apply_external.js --key <app_key>
 *   node scripts/apply_external.js --key <app_key> --allow-handshake-mark
 *   node scripts/apply_external.js --key <app_key> --no-upload-resume
 */
const fs = require("fs");
const path = require("path");
const { launchBrowser, settle, pause, argOf, RUNS_DIR, REPO_ROOT } = require("./lib");
const core = require("./apply_core");
const { driveWidgets } = require("./widgets");

/**
 * Which ATS is this? Host first - it is the one thing an employer cannot
 * restyle away. The page-marker fallback covers white-labelled domains.
 */
const ATS_HOSTS = [
  [/myworkdayjobs\.com|myworkday\.com|\.wd\d+\./i, "Workday"],
  [/greenhouse\.io/i, "Greenhouse"],
  [/lever\.co/i, "Lever"],
  [/icims\.com/i, "iCIMS"],
  [/taleo\.net/i, "Taleo"],
  [/smartrecruiters\.com/i, "SmartRecruiters"],
  [/jobvite\.com/i, "Jobvite"],
  [/ashbyhq\.com/i, "Ashby"],
  [/recruiting\.paylocity\.com/i, "Paylocity"],
  [/workforcenow\.adp\.com/i, "ADP"],
  [/ultipro\.com|ukg\.com/i, "UKG"],
  [/bamboohr\.com/i, "BambooHR"],
  [/applytojob\.com|jazzhr/i, "JazzHR"],
  [/paycor\.com/i, "Paycor"],
  [/phenompeople|phenom\.com/i, "Phenom"],
  [/oraclecloud\.com|taleo/i, "Oracle"],
  [/successfactors|sapsf\.com/i, "SuccessFactors"],
  [/breezy\.hr/i, "Breezy"],
  [/workable\.com/i, "Workable"],
  [/indeed\.com/i, "Indeed"],
  [/linkedin\.com/i, "LinkedIn"],
];

function classifyAts(url, bodyText) {
  for (const [re, name] of ATS_HOSTS) if (re.test(url)) return name;
  const t = bodyText || "";
  if (/powered by greenhouse/i.test(t)) return "Greenhouse";
  if (/powered by lever/i.test(t)) return "Lever";
  if (/workday/i.test(t)) return "Workday";
  if (/icims/i.test(t)) return "iCIMS";
  return "unknown";
}

/**
 * Read the landing page: is there a form, or a wall in front of it?
 * Runs in the page.
 */
function READ_PORTAL() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();

  const fields = [...document.querySelectorAll("input,select,textarea")].filter(vis);
  const passwords = fields.filter(
    (f) => f.type === "password" || /password|passwd/i.test(f.name || "") || /password/i.test(f.id || "")
  );
  const fileInputs = [...document.querySelectorAll('input[type="file"]')];

  // A wall is a password box, or an unmistakable sign-in ask with no real form
  // behind it. Careful: plenty of application forms carry a small "already have
  // an account? sign in" link, and that is not a wall.
  const signInWords = /(sign in to (apply|continue)|create an account to (apply|continue)|you must (sign in|log ?in|register)|please (sign in|log ?in) to)/i;
  const wall = passwords.length > 0 || signInWords.test(text);

  // Search and filter boxes are NOT application fields.
  //
  // An example employer listing had its stored URL as a Paylocity
  // job LISTING whose only input is a Search box. That counted as "answerable",
  // so the run concluded a form was already present, never looked for the Apply
  // button to hop through, and reported a form it had never reached.
  // A SuccessFactors landing page (the
  // Handshake-stored URL for a req, before "Apply now" is
  // followed) also carries a "get job alerts every N days" spinner - not a
  // search box, but just as much page chrome and not an application field.
  // name="frequency", no aria-label, so it slipped
  // through as the one "answerable" field and blocked the Apply-now hop,
  // which only fires when answerable === 0.
  const isSearch = (f) => {
    const hay = [
      f.type, f.name, f.id, f.getAttribute("aria-label"), f.placeholder,
      f.getAttribute("role"),
    ].filter(Boolean).join(" ").toLowerCase();
    return /\bsearch\b|\bfilter\b|\bkeyword\b|\bquery\b|\bsort\b|\bsubscribe\b|\balert\b|\bfrequency\b/.test(hay);
  };

  const realFields = fields.filter(
    (f) => f.type !== "password" && f.type !== "hidden" && f.type !== "submit" && f.type !== "button" && !isSearch(f)
  );
  const answerable = realFields.length;
  const searchOnly = fields.length > 0 && answerable === 0;

  // Anything that looks like it takes a resume.
  const resumeSlot = fileInputs.find((f) => {
    const hay = [
      f.name, f.id, f.getAttribute("aria-label"), f.getAttribute("accept"),
      (f.closest("label") || {}).innerText,
      (f.parentElement || {}).innerText,
    ].filter(Boolean).join(" ").toLowerCase();
    return /resume|cv\b|curriculum/.test(hay);
  });
  if (resumeSlot) resumeSlot.setAttribute("data-wd-resume", "1");

  // Same idea for a cover-letter slot in SuccessFactors,
  // which puts a plain input[type=file] on its own form (not a
  // custom dropzone) for both Resume/CV and Cover Letter. Only matches a
  // bare file input - a portal using a non-standard upload widget correctly
  // reports hasCoverSlot:false rather than something being forced.
  const coverSlot = fileInputs.find((f) => {
    if (f === resumeSlot) return false;
    const hay = [
      f.name, f.id, f.getAttribute("aria-label"), f.getAttribute("accept"),
      (f.closest("label") || {}).innerText,
      (f.parentElement || {}).innerText,
    ].filter(Boolean).join(" ").toLowerCase();
    return /cover letter|cover-letter|coverletter/.test(hay);
  });
  if (coverSlot) coverSlot.setAttribute("data-wd-cover", "1");

  return {
    url: location.href,
    title: document.title || "",
    text: text.slice(0, 2500),
    wall,
    passwordFields: passwords.length,
    answerable,
    searchOnly,
    fileInputs: fileInputs.length,
    hasResumeSlot: !!resumeSlot,
    hasCoverSlot: !!coverSlot,
    // Reported, never clicked.
    submitControls: [...document.querySelectorAll('button,input[type="submit"],[role="button"]')]
      .filter(vis)
      .map((b) => (b.textContent || b.value || "").replace(/\s+/g, " ").trim())
      .filter((t) => /^(submit|apply|send|continue|next|save and continue)/i.test(t))
      .slice(0, 6),
  };
}

/**
 * Everything that must be true before an external application may be sent.
 *
 * This is deliberately stricter than the Handshake gate. Handshake has a review
 * screen, an "Applied on <date>" banner to verify against, and a Withdraw link.
 * An external portal has none of those: the click is the whole transaction. So
 * the rule is not "looks fine" but "provably complete", and anything unproven
 * blocks. Returns the reasons NOT to submit; empty means go.
 */
function externalSubmitGate(report, portal) {
  const blockers = [];
  if (report.unfilled.length) {
    blockers.push(`${report.unfilled.length} unresolved item(s) on the form`);
  }
  if (!portal.answerable) {
    blockers.push("no answerable fields were found - this is not an application form");
  }
  if (portal.wall || portal.passwordFields) {
    blockers.push("the page is behind a sign-in wall");
  }
  if (portal.hasResumeSlot && !report.resumeAttached) {
    blockers.push("there is a resume slot and the resume did not attach");
  }
  // A wizard still showing "Step 1 of 3" has pages that were never seen.
  if (report.lastStep && report.lastStep.current < report.lastStep.total) {
    blockers.push(`still on step ${report.lastStep.current} of ${report.lastStep.total} - later pages were never reached`);
  }
  // Nothing was typed. Submitting an untouched form is worse than not applying:
  // it burns the req with an empty application the employer will remember.
  if (Array.isArray(report.filled) && report.filled.length === 0) {
    blockers.push("nothing on this form matched a saved answer - it would be sent effectively blank");
  }
  return blockers;
}

/**
 * Read a wizard's "Step 1 of 3" indicator, if the portal has one.
 * Serialised into the page, so it must stay self-contained.
 */
const READ_STEP = () => {
  const m = (document.body.innerText || "").match(/step\s+(\d+)\s+of\s+(\d+)/i);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
};

/**
 * Country/state/county/zip/street/city on Paylocity-style portals render as
 * custom widgets (react-widgets DropdownList, or a typeahead combobox) that
 * FILL_SCREENING cannot set - see widgets.js's own header comment. Their
 * glued labels ("CountryUnited States", "StateIN") are exactly what
 * apply_core.js's word-boundary matching reports as an unmatched "no saved
 * answer" gap, which was blocking every external submission on these portals
 * even though widgets.js already knows how to fill them (apply_watch.js was
 * the only caller). This wires driveWidgets() into the external-portal path
 * too, then reconciles apply_core's gap list against whatever driveWidgets
 * actually resolved, matched on the same glued-label text apply_core quoted
 * in the gap message.
 */
const gapKey = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

async function fillWidgetsAndReconcile(target, { personal, known, demo, answers, log, report }) {
  const wres = await driveWidgets(target, { personal, known, demo, answers, log }).catch((e) => {
    log(`  widgets  : threw (${e.message})`);
    return { filled: [], skipped: [], seen: 0 };
  });
  if (wres.seen) log(`  widgets  : ${wres.filled.length} of ${wres.seen} set`);
  if (wres.filled.length) {
    if (!Array.isArray(report.filled)) report.filled = [];
    report.filled.push(...wres.filled);
  }
  // A widget already holding the right value is reported as SKIPPED
  // ("<label>: already \"...\""), not filled - that is still a resolved
  // field, just one driveWidgets did not have to touch. apply_core's gap
  // list does not know that, since its own word-boundary match against the
  // glued label failed before driveWidgets ever ran.
  const resolved = new Set([
    ...wres.filled.map((f) => gapKey(f.split(" = ")[0])),
    ...(wres.skipped || [])
      .filter((s) => /: already "/.test(s))
      .map((s) => gapKey(s.split(/: already "/)[0])),
  ]);
  if (resolved.size) {
    report.unfilled = report.unfilled.filter((u) => {
      const m = /no saved answer: "(.+)"$/i.exec(u);
      return !(m && resolved.has(gapKey(m[1])));
    });
  }
  return wres;
}

/**
 * Same personal/known/demo shape apply_watch.js builds for driveWidgets -
 * profile.json's home address and per-employer work-history addresses.
 */
function widgetContext(demographics) {
  const profile = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "profile.json"), "utf8"));
  const home = (profile.identity && profile.identity.local_address) || {};
  const known = {};
  for (const job of profile.work_history || []) {
    const a = job.employer_address;
    if (!job.employer || !a) continue;
    known[job.employer] = {
      country: a.country || "United States",
      state: a.state, county: a.county, city: a.city, zip: a.zip,
      street: a.street,
    };
  }
  const personal = {
    country: "United States", state: home.state, county: home.county,
    zip: home.zip, street: home.street, city: home.city,
  };
  const demo = {};
  if (demographics) {
    for (const a of core.loadAnswers(true)) {
      if (a.key === "demographic_voluntary.gender") demo.gender = a.answer;
      else if (a.key === "demographic_voluntary.ethnicity") demo.ethnicity = a.answer;
      else if (a.key === "demographic_voluntary.race") demo.race = a.answer;
      else if (a.key === "demographic_voluntary.veteran_status") demo.veteran = a.answer;
      else if (a.key === "demographic_voluntary.disability_status") demo.disability = a.answer;
    }
  }
  return { personal, known, demo };
}

/**
 * Follow a Handshake "Apply externally" handoff and work the destination.
 *
 * `page` must already be on the Handshake job page. Returns a report object;
 * the caller writes the CSV.
 */
async function runExternal(page, row, opts) {
  const {
    uploadResume = true, resume = core.DEFAULT_RESUME,
    demographics = false, noScreening = false,
    // Clicking "Apply externally" writes to the Handshake account. Opt in.
    allowMark = false,
    // Submitting an external application.
    // Opt-in per run, and gated - see
    // externalSubmitGate(). An external portal has no review screen, no undo and
    // no Applied banner to verify against, so a half-filled application that
    // reaches a real employer cannot be taken back.
    submitExternal = false,
    // Skip Handshake's handoff entirely and work this URL instead.
    //
    // Handshake's "View application" link is not always the application. An example
    // bank's link points at a Paylocity job LISTING that redirects to the employer's
    // whole job index - six unrelated jobs and no Apply button for any of them.
    // No amount of hop logic recovers the right form from there, because the
    // page it lands on is not about this job at all.
    //
    // Passing this skips the Handshake read AND the marking click, so it is also
    // the safe way to re-work a job whose mark has already been spent.
    forceUrl = null,
    log = console.log,
  } = opts || {};

  const report = {
    key: row.app_key, employer: row.employer, role: row.role,
    ats: null, externalUrl: null, wall: false,
    filled: [], unfilled: [], resumeAttached: false, shot: null,
    outcome: "unknown",
  };

  const ctx = page.context();

  // Is the destination already known? Once a job has been handed off, Handshake
  // replaces the button with a "View application" link that holds the real
  // employer URL. Reading that costs nothing and changes nothing.
  const knownUrl = forceUrl || await page.evaluate(() => {
    const root = document.querySelector('[data-hook="job-details-page"]') || document.body;
    const a = [...root.querySelectorAll("a[href]")]
      .find((x) => /view application/i.test(x.textContent || "") && !/joinhandshake\.com/.test(x.href));
    return a ? a.href : null;
  }).catch(() => null);

  const btn = page.locator(core.SEL.externalApply).first();
  const btnCount = await btn.count().catch(() => 0);
  const btnEnabled = btnCount
    ? await btn.isEnabled().catch(() => false)
    : false;

  if (!knownUrl && !btnCount) {
    report.outcome = "no-external-button";
    report.unfilled.push("the Apply externally button was not on the page");
    return report;
  }

  /**
   * THE SIDE EFFECT THIS FLAG EXISTS FOR.
   *
   * An untouched external job carries the
   * employer's URL NOWHERE in its DOM - no anchor, no data attribute. Clicking
   * "Apply externally" is the only way to learn it, and that click writes to
   * the Handshake account: Handshake records an external application,
   * disables the button, and swaps it for "View application".
   *
   * So the click is opt-in. Without --allow-handshake-mark this reports what it
   * would need and stops.
   */
  if (!knownUrl && !allowMark) {
    report.outcome = "needs-handshake-mark";
    report.unfilled.push(
      "the employer's URL is not in the page - Handshake only reveals it when you click " +
      '"Apply externally", and that click marks the job as externally applied on your ' +
      "Handshake account. Re-run with --allow-handshake-mark to let it, or click it yourself."
    );
    return report;
  }

  const HANDSHAKE = /(^|\.)joinhandshake\.com$/i;
  let destination = knownUrl;

  if (!destination) {
    // Click, then read the URL off the "View application" link Handshake
    // renders in its place. Do NOT chase the popup it opens: Chrome's popup
    // blocker kills the second and later ones in a batch, which is what made an
    // earlier version silently read Handshake's own page as the employer's
    // form. The link is deterministic; the popup is not.
    log("  external : clicking Apply externally (this marks the job on Handshake)");
    const known = new Set(ctx.pages());
    await btn.click({ timeout: 15000 }).catch((e) => log(`  external : the click failed (${e.message.split("\n")[0]})`));

    // Handshake added an intermediate modal:
    // "Step 1: Review Employer Instructions" -> a "Step 2: External
    // Application" button, which is what actually opens the popup / reveals
    // the "View application" link. Without this click every job behind the
    // new modal reported "handoff-failed" even though the destination was
    // one click away. Harmless no-op on any job
    // that still hands off directly (button simply will not be found).
    await page.waitForTimeout(1500);
    const step2 = page.locator("button, [role=\"button\"]", { hasText: /step 2|external application/i }).first();
    if (await step2.count().catch(() => 0)) {
      log("  external : clicking through Handshake's \"Step 2: External Application\" modal");
      await step2.click({ timeout: 10000 }).catch((e) => log(`  external : step 2 click failed (${e.message.split("\n")[0]})`));
      await page.waitForTimeout(1500);
    }

    const deadline = Date.now() + 20000;
    while (!destination && Date.now() < deadline) {
      await page.waitForTimeout(1500);
      destination = await page.evaluate(() => {
        const root = document.querySelector('[data-hook="job-details-page"]') || document.body;
        const a = [...root.querySelectorAll("a[href]")]
          .find((x) => /view application/i.test(x.textContent || "") && !/joinhandshake\.com/.test(x.href));
        return a ? a.href : null;
      }).catch(() => null);
      // A popup, if Chrome allowed one, is just as good a source.
      if (!destination) {
        const fresh = ctx.pages().find((p) => !known.has(p));
        if (fresh) {
          const u = fresh.url();
          if (u && !HANDSHAKE.test(new URL(u).hostname)) destination = u;
          await fresh.close().catch(() => {});
        }
      }
    }

    // Handshake also asks "Did you apply?". This is left unanswered
    // here.
    if (/did you apply/i.test(await page.innerText("body").catch(() => ""))) {
      log('  external : Handshake is asking "Did you apply?" - left unanswered, that is yours');
    }
  } else {
    log("  external : destination already known from Handshake's View application link");
  }

  if (!destination) {
    report.outcome = "handoff-failed";
    report.unfilled.push(
      btnEnabled
        ? "clicked Apply externally but Handshake never revealed the employer's URL - open the job and click it yourself"
        : "the Apply externally button is disabled and there is no View application link - open the job by hand"
    );
    return report;
  }

  // Open the employer's site in a tab of our own. No popup, no race.
  const target = await ctx.newPage();
  await target.goto(destination, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await target.waitForTimeout(4000);

  // THE GUARD. If we are somehow still on Handshake, nothing below may run:
  // filling a form here would be typing into Handshake's own page.
  let host = "";
  try { host = new URL(target.url()).hostname; } catch { /* about:blank */ }
  if (!host || HANDSHAKE.test(host)) {
    report.outcome = "handoff-failed";
    report.unfilled.push("the employer's page never opened - work this one by hand");
    await target.close().catch(() => {});
    return report;
  }

  let portal = await target.evaluate(READ_PORTAL).catch(() => null);
  if (!portal) {
    report.outcome = "unreadable";
    report.unfilled.push("the external page never became readable");
    if (target !== page) await target.close().catch(() => {});
    return report;
  }

  report.externalUrl = portal.url;
  report.ats = classifyAts(portal.url, portal.text);
  report.wall = portal.wall;
  log(`  external : ${report.ats} - ${portal.url.slice(0, 100)}`);
  log(`${row.employer} - ${row.role} | ${report.ats} | 1/1`);

  if (portal.wall) {
    report.outcome = "login-wall";
    report.unfilled.push(
      `${report.ats} wants an account before it will show the form ` +
      `(${portal.passwordFields} password field(s) on screen). Claude cannot create ` +
      "accounts or type passwords - sign in yourself, then re-run this job."
    );
  } else if (portal.answerable === 0) {
    // Handshake often lands on the employer's job AD, not the application. The
    // form is one "Apply" click away.
    //
    // Clicking here is safe precisely because there are ZERO fields on the
    // page: with nothing to submit, an Apply button can only navigate. That is
    // why this is gated on answerable === 0 and on the button's text being
    // exactly Apply / Apply Now - never "Submit", never on a page with a form.
    const hop = await target.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      // Employers decorate these: e.g. "Apply now »". Strip trailing
      // punctuation and arrows before matching, or the exact-match test fails
      // on a button that is plainly the right one.
      const label = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
      const bare = (s) => s.replace(/[^a-z0-9 ]+$/i, "").trim().toLowerCase();
      const WANT = /^(apply|apply now|apply here|apply for this job|apply to this job|start (your )?application)$/;
      const el = [...document.querySelectorAll('a,button,[role="button"]')]
        .filter(vis)
        .find((b) => WANT.test(bare(label(b))));
      if (!el) return null;
      // An anchor gives a URL, which is far more reliable than a click.
      return { label: label(el), href: el.tagName === "A" && el.href ? el.href : null };
    }).catch(() => null);

    if (hop) {
      log(`  external : no form here - following "${hop.label}" to the application`);
      if (hop.href) {
        await target.goto(hop.href, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      } else {
        await target.evaluate(() => {
          const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const bare = (s) => s.replace(/[^a-z0-9 ]+$/i, "").trim().toLowerCase();
          const WANT = /^(apply|apply now|apply here|apply for this job|apply to this job|start (your )?application)$/;
          const el = [...document.querySelectorAll('a,button,[role="button"]')]
            .filter(vis)
            .find((b) => WANT.test(bare((b.textContent || "").replace(/\s+/g, " ").trim())));
          if (el) el.click();
        }).catch(() => {});
        await target.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      }
      await target.waitForTimeout(4500);
      portal = await target.evaluate(READ_PORTAL).catch(() => portal);
      report.externalUrl = portal.url;
      report.ats = classifyAts(portal.url, portal.text);
    }

    if (portal.answerable === 0) {
      report.outcome = "no-form";
      report.unfilled.push(hop
        ? `followed "${hop.label}" but still no fillable form - this employer may want an account, or the form is further in`
        : "no fillable form on the landing page and no Apply button to follow - this looks like a job ad, not an application");
    }
  }

  if (report.outcome === "unknown" && !portal.wall && portal.answerable > 0) {
    // Resume first: a portal that takes one usually wants it before it will
    // reveal the rest of the form.
    if (uploadResume && portal.hasResumeSlot) {
      if (!fs.existsSync(resume)) {
        report.unfilled.push(`there is a resume slot but no file at ${resume}`);
      } else {
        const slot = target.locator('[data-wd-resume="1"]').first();
        const ok = await slot.setInputFiles(resume).then(() => true).catch(() => false);
        report.resumeAttached = ok;
        log(`  resume   : ${ok ? "attached " + path.basename(resume) : "could not attach - do it by hand"}`);
        if (!ok) report.unfilled.push(`could not attach the resume - do it by hand: ${resume}`);
        await target.waitForTimeout(3500);
        // Many portals parse the resume and repaint the form, so re-read.
        portal = await target.evaluate(READ_PORTAL).catch(() => portal);
      }
    } else if (portal.fileInputs > 0 && !portal.hasResumeSlot) {
      report.unfilled.push(`${portal.fileInputs} file upload(s) on the page, none obviously the resume - check by hand`);
    }

    const widgetCtx = widgetContext(demographics);
    let answers = [];
    if (!noScreening) {
      answers = core.loadAnswers(demographics, undefined, { pay: row.pay });
      const res = await core.driveScreening(target, { answers, scope: "document" })
        .catch((e) => {
          report.unfilled.push(`the screening filler threw (${e.message}) - fill this one by hand`);
          return null;
        });
      if (res) {
        report.filled = res.filled;
        res.filled.forEach((f) => log(`  screen   : ${f}`));
        if (!res.filled.length) log("  screen   : nothing on this form matched a saved answer");
        res.unmatched.forEach((u) => report.unfilled.push(u));
        const sum = core.summarizeScreen(res);
        log(sum.line);
        log(sum.gapLine);
      }
      // Widgets FILL_SCREENING cannot touch (react-widgets dropdowns, Paylocity
      // typeaheads) - see fillWidgetsAndReconcile's comment above.
      await fillWidgetsAndReconcile(target, { ...widgetCtx, answers, log, report });
    }
    // Multi-step wizards. Paylocity's is "Step 1 of 3", and until now the run
    // filled page one and stopped, reporting a form that was never finishable.
    //
    // Advancing is NOT submitting. "Next Step" moves within the form and Back
    // undoes it; the irreversible control is the one on the LAST step, and this
    // loop never reaches it - it walks forward only while a later step exists,
    // and bails the moment the button's own text looks like a real submit.
    if (!noScreening && !report.unfilled.length) {
      if (!Array.isArray(report.filled)) report.filled = [];
      for (let guard = 0; guard < 6; guard++) {
        const step = await target.evaluate(READ_STEP).catch(() => null);
        report.lastStep = step || report.lastStep;
        if (!step || !step.total || step.current >= step.total) break;

        const btn = target
          .locator('button, [role="button"], input[type="button"]')
          .filter({ hasText: /^\s*(next|continue|save and continue)/i })
          .first();
        if (!(await btn.count().catch(() => 0))) break;

        const label = ((await btn.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (/submit|apply now|send|finish/i.test(label)) {
          log(`  wizard   : "${label}" looks like a real submit - stopping, that click is manual`);
          break;
        }

        log(`  wizard   : step ${step.current} of ${step.total} - clicking "${label}"`);
        await btn.click().catch(() => {});
        await target.waitForTimeout(2500);

        const after = await target.evaluate(READ_STEP).catch(() => null);
        report.lastStep = after || report.lastStep;
        if (!after || after.current === step.current) {
          log("  wizard   : the page did not advance - a required field is probably still empty");
          break;
        }

        log(`${row.employer} - ${row.role} | ${report.ats} | ${after.current}/${after.total}`);
        const nextAnswers = core.loadAnswers(demographics, undefined, { pay: row.pay });
        const r2 = await core.driveScreening(target, { answers: nextAnswers, scope: "document" })
          .catch(() => null);
        if (r2) {
          r2.filled.forEach((f) => { report.filled.push(f); log(`  screen   : ${f}`); });
          r2.unmatched.forEach((u) => report.unfilled.push(`step ${after.current}: ${u}`));
          await fillWidgetsAndReconcile(target, { ...widgetCtx, answers: nextAnswers, log, report });
          const sum2 = core.summarizeScreen(r2);
          log(sum2.line);
          log(sum2.gapLine);
        }
        if (report.unfilled.length) break;
      }
    }

    report.outcome = report.unfilled.length ? "partial" : "filled";
  }

  // The Apply hop can land somewhere new - most often a sign-in page, since
  // that is exactly where "Apply" leads on Workday and friends. Classify the
  // page we actually ended on, so no run can finish reporting "unknown".
  if (report.outcome === "unknown") {
    if (portal.wall) {
      report.outcome = "login-wall";
      report.unfilled.push(
        `${report.ats} wants an account before it will show the form ` +
        `(${portal.passwordFields} password field(s) on screen). Claude cannot create ` +
        "accounts or type passwords - sign in yourself, then re-run this job."
      );
    } else {
      report.outcome = "no-form";
      report.unfilled.push("ended on a page with nothing fillable - work this one by hand");
    }
  }

  // ---- submitting -------------------------------------------------------
  //
  // Everything above this point is reversible. This is the one part that is not.
  if (portal.submitControls.length && submitExternal) {
    const blockers = externalSubmitGate(report, portal);
    if (blockers.length) {
      log("  submit   : NOT submitted - the form is not provably complete:");
      blockers.forEach((b) => log(`             - ${b}`));
      report.unfilled.push(...blockers.map((b) => `not submitted: ${b}`));
    } else {
      // Photograph the finished form BEFORE sending it. If the submit succeeds
      // there is no other record of what was actually on screen.
      fs.mkdirSync(RUNS_DIR, { recursive: true });
      const pre = path.join(RUNS_DIR, `presubmit_${row.app_key}_${new Date().toISOString().slice(0, 10)}.png`);
      await target.screenshot({ path: pre, fullPage: true }).catch(() => {});
      report.presubmitShot = pre;

      const btn = target
        .locator('button, input[type="submit"], [role="button"]')
        .filter({ hasText: /^\s*(submit|apply|send)/i })
        .first();
      const label = ((await btn.textContent().catch(() => "")) || portal.submitControls[0]).replace(/\s+/g, " ").trim();
      log(`  submit   : clicking "${label}" - this is irreversible`);
      const clicked = await btn.click({ timeout: 10000 }).then(() => true).catch(() => false);
      if (!clicked) {
        log("  submit   : the click failed - nothing was sent");
        report.unfilled.push("the submit click failed - finish this one by hand");
      } else {
        await target.waitForTimeout(6000);
        const after = ((await target.evaluate(() => document.body.innerText).catch(() => "")) || "").slice(0, 3000);
        // Confirmed only on the employer's own wording. No confirmation text
        // means the outcome is genuinely unknown, and it is recorded that way -
        // a CSV that claims a submission it cannot see is worse than no row.
        if (/thank you|application (has been )?(received|submitted|complete)|successfully submitted|we('| ha)ve received/i.test(after)) {
          report.outcome = "submitted";
          report.submitted = true;
          log("  submit   : CONFIRMED - the portal acknowledged the application");
        } else {
          report.outcome = "submit-unconfirmed";
          report.unfilled.push("clicked submit but the portal printed no confirmation - verify this one by hand before re-sending");
          log("  submit   : clicked, but NO confirmation text found - verify by hand");
        }
        report.postsubmitShot = path.join(RUNS_DIR, `postsubmit_${row.app_key}_${new Date().toISOString().slice(0, 10)}.png`);
        await target.screenshot({ path: report.postsubmitShot, fullPage: true }).catch(() => {});
      }
    }
  } else if (portal.submitControls.length) {
    log(`  submit   : "${portal.submitControls[0]}" is on screen and was NOT clicked`);
  }

  fs.mkdirSync(RUNS_DIR, { recursive: true });
  report.shot = path.join(RUNS_DIR, `ext_${row.app_key}_${new Date().toISOString().slice(0, 10)}.png`);
  await target.screenshot({ path: report.shot, fullPage: false }).catch(() => {});

  // The employer tab is always one we opened, so it is always ours to close.
  await target.close().catch(() => {});
  return report;
}

module.exports = { runExternal, classifyAts, READ_PORTAL, ATS_HOSTS };

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const key = argOf(args, "--key");
    if (!key) { console.error("usage: node apply_external.js --key <app_key>"); process.exit(2); }
    const row = core.rowFor(core.CSV_PATH, key);
    if (!row) { console.error(`no row with app_key ${key}`); process.exit(2); }

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const log = core.makeLogger(path.join(RUNS_DIR, `ext_${key}_${stamp}.log`), args.includes("--verbose"));

    log(`external : ${row.employer} - ${row.role}`);
    const { ctx, page } = await launchBrowser();
    try {
      await page.goto(row.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await settle(page);
      await core.dismissPromo(page);
      await pause();

      const report = await runExternal(page, row, {
        uploadResume: !args.includes("--no-upload-resume"),
        demographics: args.includes("--demographics"),
        noScreening: args.includes("--no-screening"),
        submitExternal: args.includes("--submit-external"),
        allowMark: args.includes("--allow-handshake-mark"),
        forceUrl: argOf(args, "--url", null),
        log,
      });

      log("\n" + "=".repeat(62));
      log(`${report.outcome.toUpperCase()} - NOT SUBMITTED`);
      log("=".repeat(62));
      if (report.unfilled.length) {
        log("\nNeeds your attention:");
        report.unfilled.forEach((u) => log("  - " + u));
      }
      if (report.shot) log(`\nscreenshot: ${report.shot}`);

      core.updateRow(key, {
        notes: core.addNote(row,
          `apply: external; external_url: ${core.cleanUrl(report.externalUrl) || "?"}; ` +
          `ats: ${report.ats}; ext: ${report.outcome}`),
      });
      log("CSV updated with the destination URL and ATS.");
    } finally {
      await ctx.close().catch(() => {});
    }
  })();
}
