/**
 * apply_watch.js - fill one external application, then WATCH the applicant finish it.
 *
 * Why this exists, separate from apply_external.js:
 *
 * The batch runner fills what it can and reports the gaps as prose. That tells
 * us a field was missed; it does not tell us what the right answer WAS. The applicant
 * then types the answer by hand into a browser nobody is reading, and the next
 * run hits exactly the same gap.
 *
 * This script closes that loop. After the automated fill it takes a BASELINE
 * snapshot of every field on the page, then polls. Anything that changes after
 * the baseline was changed manually gets recorded with its label, its
 * type and its options. The output is a file of real answers to real fields,
 * which is what turns into new screening_answers.json entries.
 *
 * It reads answers OFF THE PAGE rather than out of the conversation on purpose:
 * a value transcribed from chat is a value that can be mistyped or misheard,
 * and this data ends up on real job applications.
 *
 * Nothing here submits. There is no submit path in this file at all - the last
 * click on an external portal stays manual.
 *
 *   node scripts/apply_watch.js --key 2059f2f5 --watch-min 60
 *   node scripts/apply_watch.js --url https://... --watch-min 45
 *
 * Stop early by creating runs/STOP_WATCH (any content), or Ctrl-C - the final
 * capture is written on the way out either way.
 */

const fs = require("fs");
const path = require("path");
const { launchBrowser, argOf, RUNS_DIR } = require("./lib");
const { validateProfile } = require('./config');
const { logger, screenshotOnFailure, appliedLedger, withRetry } = require('./util');

const core = require("./apply_core");
const { READ_PORTAL, classifyAts } = require("./apply_external");
const { driveWidgets } = require("./widgets");


const CSV_PATH = path.join(REPO_ROOT, "applications.csv");
const STOP_FILE = path.join(RUNS_DIR, "STOP_WATCH");

/* ------------------------------------------------------------------ *
 * In-page snapshot. Serialised into the browser, so self-contained.
 * ------------------------------------------------------------------ */
function SNAP() {
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

  function labelFor(el) {
    if (!el || !el.getAttribute) return "";
    const al = el.getAttribute("aria-label");
    if (clean(al)) return clean(al);

    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? n.innerText : "";
        })
        .join(" ");
      if (clean(t)) return clean(t);
    }

    if (el.id) {
      const l = document.querySelector(`label[for="${esc(el.id)}"]`);
      if (l && clean(l.innerText)) return clean(l.innerText);
    }

    const anc = el.closest && el.closest("label");
    if (anc && clean(anc.innerText)) return clean(anc.innerText);

    // Walk up a few levels looking for the text that sits beside the control.
    let n = el.parentElement;
    for (let hops = 0; n && hops < 4; hops++, n = n.parentElement) {
      const lbl = n.querySelector && n.querySelector("label");
      if (lbl && clean(lbl.innerText) && clean(lbl.innerText).length < 140) {
        return clean(lbl.innerText);
      }
      const own = clean(
        [...n.childNodes]
          .filter((c) => c.nodeType === 3)
          .map((c) => c.textContent)
          .join(" ")
      );
      if (own && own.length < 140) return own;
    }
    return clean(el.placeholder || el.name || el.id || "");
  }

  const isRequired = (el, label) =>
    !!(
      (el.required) ||
      el.getAttribute("aria-required") === "true" ||
      /\*\s*$/.test(label) ||
      /\(required\)/i.test(label)
    );

  const out = [];
  const seenRadio = new Set();
  const labelCount = {};

  const nodes = [
    ...document.querySelectorAll(
      'input,select,textarea,[role="combobox"],[contenteditable="true"]'
    ),
  ].filter(vis);

  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || tag).toLowerCase();

    // Never read a password, and never treat a button as a field. File inputs
    // are reported by READ_PORTAL, not here.
    if (["hidden", "submit", "button", "image", "reset", "password", "file"].includes(type)) {
      continue;
    }

    const label = labelFor(el);

    if (type === "radio") {
      const nm = el.name || label;
      if (seenRadio.has(nm)) continue;
      seenRadio.add(nm);
      const group = el.name
        ? [...document.querySelectorAll(`input[type="radio"][name="${esc(el.name)}"]`)]
        : [el];
      const on = group.find((r) => r.checked);
      const fs_ = el.closest("fieldset");
      const legend = fs_ && fs_.querySelector("legend");
      out.push({
        sig: `radio:${nm}`,
        label: clean((legend && legend.innerText) || label),
        type: "radio",
        value: on ? labelFor(on) || on.value : "",
        required: group.some((r) => isRequired(r, label)),
        options: group.map((r) => labelFor(r) || r.value).slice(0, 20),
      });
      continue;
    }

    const key = el.name || el.id || label || tag;
    labelCount[key] = (labelCount[key] || 0) + 1;
    const sig = `${type}:${key}:${labelCount[key]}`;

    let value = "";
    let options;
    if (tag === "select") {
      const o = el.options[el.selectedIndex];
      value = o ? clean(o.textContent) : "";
      options = [...el.options].map((x) => clean(x.textContent)).slice(0, 60);
    } else if (type === "checkbox") {
      value = el.checked ? "checked" : "";
    } else if (el.getAttribute("role") === "combobox" && el.classList.contains("rw-dropdownlist")) {
      // react-widgets keeps its choice as TEXT in .rw-input, not as a value.
      // Reading el.value here returned undefined, so a dropdown that had just
      // been answered still counted as an empty required field.
      //
      // MUST come before the aria-autocomplete="list" branch below: the SMS
      // opt-in widget's <div role="combobox" class="rw-dropdownlist"> ALSO
      // carries aria-autocomplete="list", so with
      // the checks the other way around this branch was unreachable for it -
      // it fell into the typeahead branch instead, found no
      // .input-select-input-single-value sibling (dropdowns don't have one),
      // and reported "" even while the widget plainly showed "Yes*". That was
      // a SNAP() misread, not a lost click: widgets.js's own re-verification
      // (driveWidgets's stabilisation pass, and apply_watch's second pass
      // right before this snapshot) both independently re-read the SAME
      // element correctly as "Yes*" moments earlier.
      const shown = clean((el.querySelector(".rw-input") || {}).textContent || "");
      value = shown === "--" ? "" : shown;
    } else if (el.getAttribute("aria-autocomplete") === "list") {
      // Paylocity's typeahead keeps its CHOICE in a sibling
      // .input-select-input-single-value div and leaves input.value empty, so
      // reading .value reported every answered Country/State box as an empty
      // required field long after it had been filled correctly.
      let sv = null, n = el;
      for (let h = 0; n && h < 4 && !sv; h++, n = n.parentElement) {
        sv = n.querySelector && n.querySelector(".input-select-input-single-value");
      }
      value = clean(el.value) || (sv ? clean(sv.textContent) : "");
    } else if (el.isContentEditable) {
      value = clean(el.innerText);
    } else {
      value = clean(el.value);
    }

    out.push({
      sig,
      label,
      type,
      value,
      required: isRequired(el, label),
      ...(options ? { options } : {}),
    });
  }

  return {
    url: location.href,
    step: (() => {
      const m = (document.body.innerText || "").match(/step\s+(\d+)\s+of\s+(\d+)/i);
      return m ? `${m[1]}/${m[2]}` : null;
    })(),
    fields: out,
  };
}

/* ------------------------------------------------------------------ */

/** Prefix match on app_key, so `--key 2059f2f5` is enough to name a row. */
function rowByPrefix(key) {
  const { rows } = core.readCsv(CSV_PATH);
  return rows.find((r) => r.app_key === key)
    || rows.find((r) => r.app_key.startsWith(key))
    || null;
}

function externalUrlOf(row) {
  const m = (row.notes || "").match(/external_url:\s*(\S+)/);
  return m ? m[1].replace(/[;,]$/, "") : null;
}

const diffKey = (f) => f.sig;

function diffSnaps(before, after) {
  const b = new Map(before.fields.map((f) => [diffKey(f), f]));
  const changes = [];
  for (const f of after.fields) {
    const prev = b.get(diffKey(f));
    const was = prev ? prev.value : "";
    if (f.value !== was) {
      // sig, not label: a form can carry two address blocks whose fields are
      // BOTH labelled "County" and "State" - the applicant's own and a previous
      // employer's. Keyed on label, the second silently overwrites the first
      // and the wrong address ends up in the saved answers.
      changes.push({ sig: f.sig, label: f.label, type: f.type, from: was, to: f.value, required: f.required, options: f.options });
    }
  }
  return changes;
}

async function main() {
  const args = process.argv.slice(2);
  const key = argOf(args, "--key", "");
  let url = argOf(args, "--url", "");
  const watchMin = Number(argOf(args, "--watch-min", "45"));
  const resume = argOf(args, "--resume", core.DEFAULT_RESUME);
  let cover = argOf(args, "--cover", "");
  const verbose = args.includes("--verbose");
  // Voluntary demographic questions (gender/ethnicity/race/veteran/disability)
  // are opt-in per run - see screening_answers.json's demographic_voluntary
  // note. Off by default; pass --demographics only when explicitly authorised
  // for filling them on this specific application.
  const demographics = args.includes("--demographics");
  // Opt-in, off by default - mirrors apply_batch.js / apply_external.js's
  // --submit / --submit-external. Only fires once the form is provably clean
  // (see the submit gate right after the baseline snapshot below); nothing
  // changes for a plain run without this flag.
  const submitFlag = args.includes("--submit");

  let row = null;
  if (key) {
    row = rowByPrefix(key);
    if (!row) throw new Error(`no row in applications.csv starting ${key}`);
    url = url || externalUrlOf(row);
  }
  if (!url) throw new Error("need --url, or --key of a row whose notes carry external_url:");

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const tag = (key || "url").replace(/[^a-z0-9]/gi, "");
  const outJson = path.join(RUNS_DIR, `watch_${tag}_${stamp}.json`);
  const outLog = path.join(RUNS_DIR, `watch_${tag}_${stamp}.jsonl`);
  const runLog = path.join(RUNS_DIR, `watch_${tag}_${stamp}.log`);
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);

  // Per-field lines ("filled :", "widget :", "wskip :", "gap :", "you :") go
  // to runLog only unless --verbose; everything else (this function's own
  // non-prefixed calls) goes to both. See apply_core.js's isPerFieldLine().
  const log = core.makeLogger(runLog, verbose);
  const append = (o) => fs.appendFileSync(outLog, JSON.stringify(o) + "\n");

  log(`watching  : ${row ? row.employer + " - " + row.role : url}`);
  log(`url       : ${url}`);

  // `page` is reassigned by the hop below if "Apply now" opens a new tab
  // (SuccessFactors) rather than navigating in place - everything after
  // that point must keep operating on whichever tab actually holds the form.
  let { ctx, page } = await launchBrowser();

  // Pay text and ATS are read from the LANDING page, before the hop.
  let ats = "unknown";
  let landingText = "";
  let portal = null;

  // Navigate to the posting and, when it is only a landing page, follow "Apply
  // now" to the real form. Factored into a function because a fresh sign-in
  // reloads the SuccessFactors careers site and drops us back off the form, so
  // this has to run a second time after logging in.
  //
  // The hop MUST be a real Playwright click, not page.goto(href): the anchor's own href (".../talentcommunity/
  // apply/<id>/...") is a dead link that just redirects to the generic
  // careers homepage when fetched directly. The actual jobId/company
  // SuccessFactors form only appears when the link's own JS click handler runs,
  // which page.goto() skips. A real click can also open a NEW TAB, which a plain
  // in-page el.click() cannot see - caught with ctx.waitForEvent("page").
  async function loadForm() {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    portal = await page.evaluate(READ_PORTAL).catch(() => null);
    if (!portal) return false;
    ats = classifyAts(portal.url, portal.text);
    // The job posting's OWN wording of its pay ("COMPENSATION: The hourly rate
    // for this position is $15.50 to $15.50.") lives on the landing page, not
    // on the apply form the hop lands on - captured full (not READ_PORTAL's
    // 2500-char slice) so a longer description never truncates it away. See
    // core.parsePageRateLow(), used by compensation.salary_expectations_open.
    landingText = await page.evaluate(() => document.body.innerText || "").catch(() => "");

    if (!portal.wall && portal.answerable === 0) {
      const WANT_RE = /^\s*(apply now|apply here|apply for this job|apply to this job|start (your )?application|apply)\s*[»›>]?\s*(\(opens in new tab\))?\s*$/i;
      const hopLocator = page.locator('a,button,[role="button"]').filter({ hasText: WANT_RE });
      if (await hopLocator.count().catch(() => 0)) {
        const hopEl = hopLocator.first();
        const label = (((await hopEl.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim());
        log(`hop       : clicking "${label}" to reach the application`);
        const known = new Set(ctx.pages());
        const [popup] = await Promise.all([
          ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null),
          hopEl.click({ timeout: 10000 }).catch(() => {}),
        ]);
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        const fresh = popup || ctx.pages().find((p) => !known.has(p));
        if (fresh && fresh !== page) {
          log("hop       : Apply now opened a new tab - continuing there");
          await fresh.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
          page = fresh;
        }
        await page.waitForTimeout(4500);
        portal = await page.evaluate(READ_PORTAL).catch(() => portal);
        log(`hop       : now on ${portal.url ? portal.url.slice(0, 100) : page.url().slice(0, 100)}`);
      }
    }
    return true;
  }

  if (!(await loadForm())) { log("the page never became readable"); return; }
  log(`ats       : ${ats}`);

  // SuccessFactors sign-in. The apply page embeds an ACCOUNT-CREATION form;
  // the account already exists (created a prior session), so the guest/register
  // path is rejected with "Account Already Exists" AND the rejection wipes the
  // resume/cover uploads. Sign in first so the form renders authenticated - the
  // session persists in the Chrome profile, so this logs in only once and later
  // reqs detect the authenticated state and skip. Opt out with --no-login.
  if (!args.includes("--no-login") && /successfactors/i.test(page.url())) {
    const li = await core.signInSuccessFactors(page, core.loadAccount("successfactors"), log)
      .catch((e) => ({ found: false, signedIn: false, detail: `threw: ${e.message}` }));
    if (li.signedIn || li.already) {
      // Signing in from the job's register page lands SF straight on the
      // authenticated apply form (portalcareer, carrying career_job_req_id).
      // So re-read the CURRENT page and keep it if
      // it is already a usable form. Only fall back to loadForm() (the
      // jobreqcareer -> "Apply now" hop) when it is not, because that hop is
      // nondeterministic post-login: it sometimes redirects to the PUBLIC
      // job page, which carries no real apply form at all.
      log(li.already
        ? "signin    : already signed in (session from a previous run)"
        : "signin    : signed in");
      portal = await page.evaluate(READ_PORTAL).catch(() => null);
      const hasApply = await page.locator("#fbqa_apply").count().catch(() => 0);
      if (portal && !portal.wall && portal.answerable > 0 && hasApply) {
        log(`signin    : on the authenticated form (${page.url().slice(0, 80)})`);
      } else {
        log("signin    : re-loading the application as an authenticated user");
        await loadForm();
      }
    } else if (li.found) {
      log(`signin    : NOT signed in (${li.detail}) - the form may still show account-creation fields; finish by hand`);
    }
  }

  if (portal.wall) {
    log("wall      : this portal wants an account. Sign in yourself if you want to continue.");
  }

  // SuccessFactors form names no employer via --key on this
  // exact test command (--url only), so the per-employer generated cover
  // letter can't come from applications.csv. Guessed ONLY from the page's
  // own text (READ_PORTAL's `portal.text`), and ONLY when nothing was passed
  // explicitly - never overrides a --cover the caller gave.
  if (!cover) {
    const guess = path.join(REPO_ROOT, "generated", "Cover Letter.docx");
    if (fs.existsSync(guess)) cover = guess;
  }

  // Resume, then the saved answers - exactly what the batch run does.
  if (portal.hasResumeSlot && fs.existsSync(resume)) {
    const ok = await page.locator('[data-wd-resume="1"]').first()
      .setInputFiles(resume).then(() => true).catch(() => false);
    log(`resume    : ${ok ? "attached " + path.basename(resume) : "could not attach - do it by hand"}`);
    await page.waitForTimeout(3500);
  } else if (portal.hasResumeSlot) {
    log(`resume    : no file at ${resume} - attach by hand`);
  } else if (fs.existsSync(resume)) {
    // No static input[type=file] anywhere in the DOM (SuccessFactors:
    // "Upload a Resume" opens a dialog instead) - see core.attachViaFileDialog.
    const ok = await core.attachViaFileDialog(page, /resume\s*\/?\s*cv/i, resume, log);
    log(`resume    : ${ok ? "attached " + path.basename(resume) + " via dialog" : "no resume upload control found on this page"}`);
    await page.waitForTimeout(1500);
  }

  // Cover letter, on portals that expose an ordinary input[type=file] for it
  // (READ_PORTAL's hasCoverSlot for SuccessFactors).
  if (portal.hasCoverSlot && cover && fs.existsSync(cover)) {
    const ok = await page.locator('[data-wd-cover="1"]').first()
      .setInputFiles(cover).then(() => true).catch(() => false);
    log(`cover     : ${ok ? "attached " + path.basename(cover) : "could not attach - do it by hand"}`);
    await page.waitForTimeout(3500);
  } else if (portal.hasCoverSlot) {
    log(`cover     : a cover letter slot is on the page and none was passed (--cover) - attach by hand`);
  } else if (cover && fs.existsSync(cover)) {
    // Dialog-style upload, same idiom as the resume control above.
    const ok = await core.attachViaFileDialog(page, /cover letter/i, cover, log);
    log(`cover     : ${ok ? "attached " + path.basename(cover) + " via dialog" : "no cover-letter upload control found on this page"}`);
    await page.waitForTimeout(1500);
  }

  // profile.json is loaded up front now because driveScreening needs it too:
  // it is what lets the filler OVERWRITE a value Paylocity's resume parser
  // guessed wrong (applicant street/city/county/state/zip, and every
  // work-history block field: employer, title, duties, supervisor_phone,
  // employer_address.*, start, end) instead of treating "already has a
  // value" as done.
  const profile = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "profile.json"), "utf8"));

  log(`step 1    : ${row ? row.employer + " - " + row.role : url} | ${ats} | 1/1`);
  const answers = core.loadAnswers(demographics, undefined, { pay: row ? row.pay : "", pageText: landingText });
  const res = await core.driveScreening(page, { answers, scope: "document", profile }).catch((e) => {
    log(`filler    : threw (${e.message})`);
    return null;
  });
  if (res) {
    res.filled.forEach((f) => log(`  filled  : ${f}`));
    if (!res.filled.length) log("  filled  : nothing matched a saved answer");
    (res.overrides || []).forEach((o) => log(`  override : ${o}`));
  }
  const screenSum = res ? core.summarizeScreen(res) : null;
  await page.waitForTimeout(1500);

  // The custom widgets FILL_SCREENING cannot touch - see widgets.js.
  const home = (profile.identity && profile.identity.local_address) || {};
  const known = {};
  for (const job of profile.work_history || []) {
    const a = job.employer_address;
    if (!job.employer || !a) continue;
    known[job.employer] = {
      country: a.country || "United States",
      state: a.state, county: a.county, city: a.city, zip: a.zip,
      // `street` was missing here, which is why widgets.js's own override
      // logic for a work-history Address Line 1 always computed `want` as
      // null and left "<City, ST>" (a city, not a street) sitting in the box.
      street: a.street,
    };
  }
  const personal = {
    country: "United States", state: home.state, county: home.county,
    zip: home.zip, street: home.street, city: home.city,
  };
  // Voluntary EEO demographic answers (Gender/Ethnicity/Race/Veteran
  // Status/Disability), read from screening_answers.json's
  // demographic_voluntary group via `answers` above - never hardcoded here.
  // Empty unless --demographics was passed, same opt-in `answers` already
  // respects. These render as SuccessFactors "No Selection" comboboxes, not
  // <select> elements, so FILL_SCREENING never sees them - see widgets.js's
  // "sfpicklist" widget kind.
  const demo = {};
  if (demographics) {
    for (const a of answers) {
      if (a.key === "demographic_voluntary.gender") demo.gender = a.answer;
      else if (a.key === "demographic_voluntary.ethnicity") demo.ethnicity = a.answer;
      else if (a.key === "demographic_voluntary.race") demo.race = a.answer;
      else if (a.key === "demographic_voluntary.veteran_status") demo.veteran = a.answer;
      else if (a.key === "demographic_voluntary.disability_status") demo.disability = a.answer;
    }
  }
  const wres = await driveWidgets(page, { personal, known, demo, answers, log });
  log(`  widgets : ${wres.filled.length} of ${wres.seen} set`);
  await page.waitForTimeout(700);

  // One more pass, run as close to the baseline read as this script can get
  // it. Idempotent - a widget that already agrees with `want` is skipped in
  // well under a second, so this costs almost nothing on a clean run. It is
  // what actually catches the SMS widget if Paylocity's own async work (the
  // resume parser, most likely) reset it sometime after the first pass
  // verified it: "widget : ... = Yes*" logged,
  // then the baseline snapshot read it back empty a little over a second
  // later. See the "dropdown widgets go LAST" comment in widgets.js, which
  // shrinks the same exposure window from the other end.
  const wres2 = await driveWidgets(page, { personal, known, demo, answers, log }).catch(() => ({ filled: [], seen: 0 }));
  if (wres2.filled.length) log(`  widgets : re-check caught ${wres2.filled.length} more`);
  await page.waitForTimeout(300);

  // SuccessFactors' "Terms of Use: Read and accept the data privacy
  // statement." requirement - a link + modal, not a plain field, so it is
  // driven separately from FILL_SCREENING/driveWidgets above. Must run AFTER
  // those: opening the dialog needs Country/Region of Residence already
  // filled (screening_answers.json's address.country), see
  // core.acceptTermsOfUse's own comment.
  const termsRes = await core.acceptTermsOfUse(page, log).catch((e) => {
    log(`  terms    : threw (${e.message})`);
    return { found: false, accepted: false, detail: `threw: ${e.message}` };
  });
  await page.waitForTimeout(500);

  // BASELINE. Everything after this point is manual user interaction.
  let base = await page.evaluate(SNAP);
  let last = base;
  const gaps = base.fields.filter((f) => f.required && !f.value);
  log("");
  log(`baseline  : ${base.fields.length} fields, ${gaps.length} required and still empty${base.step ? `, step ${base.step}` : ""}`);
  if (screenSum) log(`${screenSum.line} | widgets ${wres.filled.length}/${wres.seen}`);
  const gapLabels = gaps.map((f) => f.label || f.sig);
  const GAP_CAP = 12;
  const shownGaps = gapLabels.slice(0, GAP_CAP);
  const moreGaps = gapLabels.length - shownGaps.length;
  log(gapLabels.length
    ? `gaps: ${shownGaps.join("; ")}${moreGaps > 0 ? `; +${moreGaps} more` : ""}`
    : "gaps: none");
  gaps.forEach((f) => log(`  gap     : ${f.label || f.sig}${f.options ? ` [${f.options.slice(0, 8).join(" | ")}]` : ""}`));
  append({ t: new Date().toISOString(), event: "baseline", url: base.url, step: base.step, fields: base.fields });
  if (termsRes.found) log(`terms of use : ${termsRes.accepted ? "accepted" : "NOT accepted - " + termsRes.detail}`);

  // DOM check only - reported on every run, --submit or not, so "the Apply
  // button is live" never has to be taken on faith. Never clicked here.
  {
    const chk = page.locator("#fbqa_apply").first();
    const chkFound = await chk.count().catch(() => 0);
    const chkEnabled = chkFound ? await chk.isEnabled().catch(() => false) : false;
    log(`apply btn : ${chkFound ? (chkEnabled ? "present, enabled" : "present, DISABLED") : "not found"} (not clicked)`);
  }

  // ---- --submit -----------------------------------------------------------
  //
  // Opt-in only (see the --submit parse above). Fires only when the baseline
  // shows zero required-empty fields, the Terms of Use requirement (which
  // baseline's SNAP() cannot see - it is a link + hidden field, not a normal
  // input) is confirmed accepted, and the Apply button is actually there and
  // enabled. This is the one irreversible step in this file; every path
  // above it only fills and stops, same as it always has.
  if (submitFlag) {
    const applyBtn = page.locator("#fbqa_apply").first();
    const applyCount = await applyBtn.count().catch(() => 0);
    const applyLoc = applyCount ? applyBtn : page.locator("button, [role=\"button\"]").filter({ hasText: /^\s*Apply\s*$/i }).first();
    const applyFound = applyCount || await applyLoc.count().catch(() => 0);
    const applyEnabled = applyFound
      ? await applyLoc.isEnabled().catch(() => false)
      : false;

    const blockers = [];
    if (gaps.length) blockers.push(`${gaps.length} required field(s) still empty`);
    // Terms of Use only blocks when the form actually HAS the requirement. The
    // guest/register form carries the #dataPrivacyId link; the AUTHENTICATED
    // form does not (terms were accepted at account creation), so a "not found"
    // there means "not required here", not a gap. Only an unaccepted-but-present
    // link blocks. (Signed-in portalcareer form has
    // no Terms link and SF enables Apply without one.)
    if (termsRes.found && !termsRes.accepted) blockers.push(`Terms of Use not accepted (${termsRes.detail})`);
    if (!applyFound) blockers.push("no Apply button found");
    else if (!applyEnabled) blockers.push("Apply button is present but disabled");

    log("");
    if (blockers.length) {
      log("submit    : --submit was passed but NOT submitted:");
      blockers.forEach((b) => log(`             - ${b}`));
    } else {
      log("submit    : form is clean, Terms of Use accepted, Apply is live - clicking Apply");
      const clicked = await applyLoc.click({ timeout: 10000 }).then(() => true).catch(() => false);
      if (!clicked) {
        log("submit    : the click failed - nothing was sent");
      } else {
        await page.waitForTimeout(6000);
        const after = ((await page.evaluate(() => document.body.innerText).catch(() => "")) || "").slice(0, 4000);
        const confirmMatch = after.match(
          /(thank you[^.\n]{0,200}|application (has been )?(received|submitted|complete)[^.\n]{0,200}|successfully submitted[^.\n]{0,200}|we('| ha)ve received[^.\n]{0,200}|submission confirmation[^.\n]{0,200})/i
        );
        if (confirmMatch) {
          log(`submit    : CONFIRMED - "${confirmMatch[0].replace(/\s+/g, " ").trim().slice(0, 200)}"`);
        } else {
          log("submit    : clicked Apply but no confirmation text was found on the page - verify by hand");
        }
        append({ t: new Date().toISOString(), event: "submit", confirmed: !!confirmMatch, text: after.slice(0, 1000) });
      }
    }
  }

  log("");
  log(`over to you - fill the rest in the browser. Everything you type is being`);
  log(`recorded to ${path.basename(outLog)} so the next run already knows it.`);
  log(`watching for ${watchMin} min. Do NOT submit until you are ready; nothing here will click it.`);
  log("");

  const captured = new Map();  // label -> latest value set
  const deadline = Date.now() + watchMin * 60 * 1000;
  let stopped = "timeout";

  const finish = () => {
    const final = last;
    const answersOut = [...captured.entries()].map(([sig, v]) => ({ sig, ...v }));
    fs.writeFileSync(outJson, JSON.stringify({
      employer: row ? row.employer : null,
      role: row ? row.role : null,
      app_key: row ? row.app_key : null,
      url: final.url,
      stopped,
      captured: answersOut,
      final_fields: final.fields,
    }, null, 2));
    log("");
    log(`captured  : ${answersOut.length} answer(s) from you -> ${outJson}`);
    answersOut.forEach((a) => log(`  you     : ${a.label} = ${a.value}`));
  };

  process.on("SIGINT", () => { stopped = "ctrl-c"; finish(); process.exit(0); });

  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    if (fs.existsSync(STOP_FILE)) { stopped = "stop-file"; break; }

    let snap;
    try {
      snap = await page.evaluate(SNAP);
    } catch {
      continue;  // navigation mid-read; try again next tick
    }

    if (snap.url !== last.url || snap.step !== last.step) {
      log(`page      : now ${snap.step ? "step " + snap.step + " - " : ""}${snap.url.slice(0, 90)}`);
      append({ t: new Date().toISOString(), event: "navigate", url: snap.url, step: snap.step, fields: snap.fields });
      // A new page is a new baseline; its prefilled values are not manual entries.
      last = snap;
      base = snap;
      const g = snap.fields.filter((f) => f.required && !f.value);
      const gLabels = g.map((f) => f.label || f.sig);
      log(gLabels.length ? `gaps: ${gLabels.slice(0, 12).join("; ")}${gLabels.length > 12 ? `; +${gLabels.length - 12} more` : ""}` : "gaps: none");
      g.forEach((f) => log(`  gap     : ${f.label || f.sig}`));
      continue;
    }

    // Full detail per field still goes to the log FILE (see the "you :" prefix
    // handling in makeLogger); stdout gets one line for the whole batch this
    // poll caught, not one line per field touched since the
    // last tick.
    const changes = diffSnaps(last, snap);
    const recorded = [];
    for (const c of changes) {
      if (!c.to) continue;  // a field being cleared teaches nothing
      const label = c.label || "(unlabelled)";
      captured.set(c.sig, { label, value: c.to, type: c.type, required: c.required, options: c.options });
      log(`  you     : ${label} = ${c.to}`);
      append({ t: new Date().toISOString(), event: "answer", ...c });
      recorded.push(label);
    }
    if (recorded.length) {
      const shown = recorded.slice(0, 6);
      log(`recorded  : ${recorded.length} answer(s) from you (${shown.join(", ")}${recorded.length > shown.length ? ", ..." : ""})`);
    }
    last = snap;
  }

  finish();
  log("");
  log("browser stays open. Close it yourself when the application is in.");
  await new Promise(() => {});  // hold the process so Chrome does not die
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
