/**
 * Offline test for FILL_SCREENING: build a DOM that mirrors the Example Corp Greenhouse
 * form (the one that actually blocked a submission) and check the filler
 * answers it from screening_answers.json without touching anything it should not.
 *
 * Runs in a throwaway browser - never the automation profile, which is single
 * instance and would collide with a real run.
 */
const fs = require("fs");
const path = require("path");

const { ROOT, profile, profilePrivate, screeningAnswers, employers, paths, BROWSER_PROFILE_DIR, validateProfile } = require('./config');
const APP_HOME = path.join(process.env.LOCALAPPDATA, "JobAutomation");
const { chromium } = require("./lib").requirePlaywright();

// The engine moved to apply_core.js, so this requires it
// directly instead of scraping the function out of prep_apply.js by source
// text. Same guarantee - the test runs the real code, not a copy - without the
// extraction breaking every time the file is reorganised.
const core = require(path.join(ROOT, "scripts", "apply_core.js"));
const loadAnswers = (includeDemographics) => core.loadAnswers(includeDemographics);

const PAGE = `
<div role="dialog" aria-modal="true">
  <h2>Apply to Example Corp</h2>

  <div>Attach your resume</div>
  <div data-hook="apply-modal-document-search"><input type="text" placeholder="Search your documents"></div>

  <div><label for="phone">Phone (required)</label><input id="phone" type="tel" required></div>
  <div><label for="li">LinkedIn Profile</label><input id="li" type="text"></div>

  <div><label for="hear1">How did you hear about this job? (required)</label>
    <select id="hear1"><option value="">Select...</option><option>Other</option><option>Career Fair</option></select></div>

  <div><label for="hear2">How did you originally hear about Example Corp? (required)</label>
    <select id="hear2"><option value="">Select...</option><option>Website</option><option>Friend</option></select></div>

  <div><label for="visa">Do you now or will you in the future require visa sponsorship? (required)</label>
    <select id="visa"><option value="">Select...</option><option>Yes</option><option>No</option></select></div>

  <div><label for="phon">Please provide the phonetic pronunciation for your first and last name (required)</label>
    <input id="phon" type="text"></div>

  <div><label for="pref">What is your preferred name? (required)</label><input id="pref" type="text"></div>

  <div><label for="grad">What is your expected College Graduation year? (required)</label>
    <select id="grad"><option value="">Select...</option><option>May 2027</option><option>May 2028</option></select></div>

  <div><label for="loc1">Please indicate which location you would be most interested in (required)</label>
    <select id="loc1"><option value="">Select...</option><option>Springfield, IL</option><option>Chicago, IL</option></select></div>

  <fieldset>
    <div>Are you available to work Part-Time Weekend Coverage for Saturday and Sunday Day Shift: 7am - 3pm?</div>
    <label><input type="radio" name="avail" value="yes"> Yes</label>
    <label><input type="radio" name="avail" value="no"> No</label>
  </fieldset>

  <div><label for="gender">Gender</label>
    <select id="gender"><option value="">Select...</option><option>Male</option><option>Female</option></select></div>

  <div><label for="mystery">What is your favourite colour? (required)</label><input id="mystery" type="text"></div>

  <button type="button">Submit Application</button>
</div>`;

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.setContent(PAGE);

  const run = async (answers) =>
    page.evaluate(core.FILL_SCREENING, { answers, scope: "modal" });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? " -> " + detail : ""}`); }
  };

  console.log("\n--- default run (no --demographics) ---");
  const r = await run(loadAnswers(false));
  r.filled.forEach((f) => console.log("    filled: " + f));
  r.unmatched.forEach((u) => console.log("    unmatched: " + u));

  const val = (sel) => page.$eval(sel, (e) => e.value);
  check("phone filled", (await val("#phone")) === "<Your Phone>", await val("#phone"));

  check("linkedin filled", (await val("#li")).includes(profile.identity.linkedin || "<Your LinkedIn>"), await val("#li"));
  check("preferred name filled", (await val("#pref")) === profile.identity.preferred_name, await val("#pref"));
  check("phonetic filled", (await val("#phon")) === `${profile.identity.preferred_name} ${profile.identity.legal_name.split(" ").pop()}`, await val("#phon"));
  check("how-did-you-hear = Other", (await val("#hear1")) === "Other", await val("#hear1"));
  check("originally-heard = Website", (await val("#hear2")) === "Website", await val("#hear2"));
  check("visa = No", (await val("#visa")) === "No", await val("#visa"));
  check("graduation = May 2028", (await val("#grad")) === "May 2028", await val("#grad"));
  check("location = Springfield, IL", (await val("#loc1")) === "Springfield, IL", await val("#loc1"));

  const radio = await page.$eval('input[name="avail"][value="yes"]', (e) => e.checked);
  const radioNo = await page.$eval('input[name="avail"][value="no"]', (e) => e.checked);
  check("availability radio NOT auto-answered", !radio && !radioNo,
    `yes=${radio} no=${radioNo} - availability state`);

  check("gender left blank without --demographics", (await val("#gender")) === "", await val("#gender"));
  check("unknown required field left blank", (await val("#mystery")) === "", await val("#mystery"));
  check("unknown required field is REPORTED",
    r.unmatched.some((u) => /favourite colour/i.test(u)), JSON.stringify(r.unmatched));
  check("document search box untouched",
    (await page.$eval('[data-hook="apply-modal-document-search"] input', (e) => e.value)) === "");

  console.log("\n--- second run: nothing should be overwritten ---");
  const r2 = await run(loadAnswers(false));
  check("idempotent (no refills)", r2.filled.length === 0, JSON.stringify(r2.filled));
  check("phone still correct", (await val("#phone")) === "<Your Phone>");

  console.log("\n--- with --demographics ---");
  await page.setContent(PAGE);
  const r3 = await run(loadAnswers(true));
  check("gender filled when asked for", (await val("#gender")) === "Male", await val("#gender"));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
