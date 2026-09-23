/**
 * test_apply.js - offline tests for apply_core.js.
 *
 * Builds DOM that mirrors forms that really blocked a submission, and runs the
 * REAL page functions against it (required straight out of apply_core.js, not
 * copied), in a throwaway browser. Never the automation profile - that one is
 * single-instance and would collide with a live run.
 *
 *   node scripts/test_apply.js
 */
const fs = require("fs");
const path = require("path");

const APP_HOME = path.join(process.env.LOCALAPPDATA, "JobAutomation");
const { chromium } = require("./lib").requirePlaywright();
const core = require("./apply_core");
const { profile } = require("./config");

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "\n          " + detail : ""}`); }
};

const answers = core.loadAnswers(false);
const answersWithDemo = core.loadAnswers(true);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The Example Corp Greenhouse form, with the PHONETIC question moved ABOVE the phone
 * question.
 *
 * This ordering is the point of the fixture. The old matcher used
 * `question.includes(token)`, and "phone" is a substring of "phonetic". With
 * the phone field first (as in the original test) the `used` set masks it: the
 * phone question consumes contact.phone, so the phonetic question falls through
 * to contact.phonetic_name and the suite passes. Reverse the order and the
 * phonetic field gets answered with a phone number.
 */
const PHONETIC_FIRST = `
<div role="dialog" aria-modal="true">
  <h2>Apply to Example Corp</h2>
  <div><label for="phon">Please provide the phonetic pronunciation for your first and last name (required)</label>
    <input id="phon" type="text"></div>
  <div><label for="phone">Phone (required)</label><input id="phone" type="tel" required></div>
</div>`;

/** A modal whose Submit is live, with no validation errors. */
const CLEAN_MODAL = `
<div role="dialog" aria-modal="true">
  <h2>Apply to Example Park</h2>
  <div>Attach your resume</div>
  <div>Resume.docx</div>
  <div>Attach your cover letter</div>
  <div>Example Park Cover Letter.docx</div>
  <button>Submit Application</button>
</div>`;

/** The Example Jewelry state: Submit greyed out, red validation text on screen. */
const BLOCKED_MODAL = `
<div role="dialog" aria-modal="true">
  <h2>Apply to Example Jewelry</h2>
  <div>Attach your resume</div>
  <div>Resume.docx</div>
  <div>Attach other required documents</div>
  <div>Instructions from employer: If available, photos or a portfolio of their bench work</div>
  <div>Please enter a valid response</div>
  <button disabled>Submit Application</button>
</div>`;

/** An employer who explicitly does NOT want a cover letter. */
const NO_COVER_WANTED = `
<div role="dialog" aria-modal="true">
  <h2>Apply to Example Corp</h2>
  <div>Attach your resume</div>
  <div>Resume.docx</div>
  <div>Instructions from employer: Please do not send a cover letter, resume only.</div>
  <button>Submit Application</button>
</div>`;

/** A portal asking to create an account. Nothing here may be typed into. */
const CREDENTIAL_FORM = `
<body>
  <h1>Create your account</h1>
  <div><label for="em">Email Address</label><input id="em" type="text"></div>
  <div><label for="pw">Password</label><input id="pw" type="text"></div>
  <div><label for="ssn">Social Security Number</label><input id="ssn" type="text"></div>
  <div><label for="ph">Phone number</label><input id="ph" type="tel"></div>
</body>`;

/** The Example Staffing Co availability radio - must never be auto-answered. */
const AVAILABILITY_RADIO = `
<div role="dialog" aria-modal="true">
  <h2>Apply to Example Staffing Co</h2>
  <div><label for="loc">Which location would you prefer?</label>
    <select id="loc"><option value="">Select...</option><option>Springfield, IL</option></select></div>
  <fieldset>
    <legend>Are you available to work weekends and evenings?</legend>
    <label><input type="radio" name="avail" value="Yes"> Yes</label>
    <label><input type="radio" name="avail" value="No"> No</label>
  </fieldset>
</div>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const load = async (html) => {
    await page.setContent(html.trim().startsWith("<body")
      ? `<!doctype html><html>${html}</html>`
      : `<!doctype html><html><body>${html}</body></html>`);
  };

  console.log("\nscreening: the phone/phonetic collision");
  await load(PHONETIC_FIRST);
  {
    const r = await page.evaluate(core.FILL_SCREENING, { answers, scope: "modal" });
    const phon = await page.inputValue("#phon");
    const phone = await page.inputValue("#phone");
    ok(!/^\d{3}-\d{3}-\d{4}$/.test(phon),
      "phonetic field is NOT filled with the phone number",
      `phonetic got "${phon}"`);
    ok(phon.toLowerCase().includes(profile.identity.preferred_name.toLowerCase()),
      "phonetic field gets the phonetic answer",
      `phonetic got "${phon}"`);
    ok(/^\d{3}-\d{3}-\d{4}$/.test(phone),
      "phone field still gets the phone number",
      `phone got "${phone}"`);
    ok(r.filled.length === 2, "both fields were filled, neither consumed the other's answer",
      JSON.stringify(r.filled));
  }

  console.log("\nREAD_MODAL: submitEnabled and blockers actually exist");
  await load(CLEAN_MODAL);
  {
    const m = await page.evaluate(core.READ_MODAL);
    ok(m.found === true, "clean modal is found");
    ok(m.hasSubmit === true, "clean modal has a Submit button");
    ok(m.submitEnabled === true, "clean modal reports submitEnabled TRUE",
      `got ${JSON.stringify(m.submitEnabled)}`);
    ok(m.blockers === false, "clean modal reports no blockers",
      `got ${JSON.stringify(m.blockers)}`);
    ok(m.resumeAttached === true, "resume slot reads as filled");
    ok(m.coverAttached === true, "cover slot reads as filled");
  }

  await load(BLOCKED_MODAL);
  {
    const m = await page.evaluate(core.READ_MODAL);
    ok(m.submitEnabled === false, "greyed-out Submit reports submitEnabled FALSE",
      `got ${JSON.stringify(m.submitEnabled)}`);
    ok(m.blockers === true, 'red "Please enter a valid response" is detected',
      `got ${JSON.stringify(m.blockers)}`);
    ok(m.otherDocs && /portfolio of their bench work/i.test(m.otherDocs.instructions || ""),
      "third-slot employer instructions are captured");
    ok(m.otherDocs && m.otherDocs.filled === false, "third slot reads as empty");
  }

  console.log("\nREAD_MODAL: needsCover is not tripped by prose");
  await load(NO_COVER_WANTED);
  {
    const m = await page.evaluate(core.READ_MODAL);
    ok(m.needsCover === false,
      'an employer saying "do not send a cover letter" does not set needsCover',
      `got ${JSON.stringify(m.needsCover)}`);
  }

  console.log("\nscreening: credentials and unlabelled choices are left alone");
  await load(CREDENTIAL_FORM);
  {
    await page.evaluate(core.FILL_SCREENING, { answers, scope: "document" });
    ok((await page.inputValue("#pw")) === "", "password field left empty");
    ok((await page.inputValue("#ssn")) === "", "SSN field left empty");
    ok((await page.inputValue("#ph")) !== "", "the phone field on the same form is still filled");
  }

  await load(AVAILABILITY_RADIO);
  {
    const r = await page.evaluate(core.FILL_SCREENING, { answers, scope: "modal" });
    const checked = await page.evaluate(() =>
      [...document.querySelectorAll('input[name="avail"]')].some((x) => x.checked));
    ok(checked === false,
      "the availability radio is NOT auto-answered - it invents a fact about his life",
      JSON.stringify(r.filled));
    ok(r.filled.some((f) => f.startsWith("preferences.preferred_location")),
      "the location dropdown on the same form IS answered", JSON.stringify(r.filled));
  }

  console.log("\ndemographics stay off unless asked");
  await load(`<div role="dialog" aria-modal="true"><h2>Apply to X</h2>
    <div><label for="g">Gender</label>
      <select id="g"><option value="">Select...</option><option>Male</option></select></div></div>`);
  {
    await page.evaluate(core.FILL_SCREENING, { answers, scope: "modal" });
    ok((await page.inputValue("#g")) === "", "gender left blank without --demographics");
    await page.evaluate(core.FILL_SCREENING, { answers: answersWithDemo, scope: "modal" });
    ok((await page.inputValue("#g")) === "Male", "gender filled when --demographics is passed");
  }

  await browser.close();

  // -------------------------------------------------------------------------
  // cleanGates - pure logic, no browser needed
  // -------------------------------------------------------------------------
  console.log("\ncleanGates: the submit interlock");
  {
    const clean = { found: true, hasSubmit: true, submitEnabled: true, blockers: false, mismatch: false };
    ok(core.cleanGates(clean, []).length === 0, "a clean form with no unfilled items passes");
    ok(core.cleanGates(clean, ["something"]).length === 1, "any unfilled item blocks submit");
    ok(core.cleanGates({ ...clean, submitEnabled: false }, []).length === 1, "greyed-out Submit blocks");
    ok(core.cleanGates({ ...clean, blockers: true }, []).length === 1, "a red warning blocks");
    ok(core.cleanGates({ ...clean, mismatch: true }, []).length === 1, "a school-year mismatch blocks");
    ok(core.cleanGates({ ...clean, hasSubmit: false }, []).length >= 1, "no Submit button blocks");
    ok(core.cleanGates({ found: false }, []).length === 1, "an unread modal blocks");
    // The one that matters most: a modal from a READ_MODAL that forgot to
    // return submitEnabled must NOT be treated as submittable.
    ok(core.cleanGates({ found: true, hasSubmit: true, blockers: false, mismatch: false }, []).length === 1,
      "a modal MISSING submitEnabled blocks rather than submitting");
  }

  console.log("\nnotes and URLs stay readable");
  {
    const row = { notes: "type: Full-time; commute: near (0 mi); apply: external" };
    const once = core.addNote(row, "apply: external; ats: Greenhouse");
    ok((once.match(/apply: external/g) || []).length === 1,
      "a fact the row already records is not appended twice", once);
    ok(/ats: Greenhouse/.test(once), "the new fact is added", once);

    const twice = core.addNote({ notes: once }, "ats: Workday");
    ok(/ats: Workday/.test(twice) && !/ats: Greenhouse/.test(twice),
      "a keyed fact is replaced, not stacked beside the old value", twice);
    ok(/type: Full-time/.test(twice) && /commute: near/.test(twice),
      "unrelated existing notes survive", twice);

    const messy = "https://www.example.org/job-openings/?gh_src=Handshake&iisn=Handshake"
      + "&src=Handshake&utm_source=Handshake&__jvst=Handshake&lever-source%5B%5D=Handshake";
    const clean = core.cleanUrl(messy);
    ok(clean === "https://www.example.org/job-openings/",
      "Handshake tracking parameters are stripped", clean);
    ok(clean.length < 60, "the logged URL fits in a CSV cell", `${clean.length} chars`);

    const withId = core.cleanUrl("https://boards.greenhouse.io/acme/jobs/1234?gh_jid=1234&utm_source=Handshake");
    ok(/gh_jid=1234/.test(withId), "a parameter that identifies the posting is kept", withId);
    ok(!/utm_source/.test(withId), "tracking is still dropped alongside it", withId);
    ok(core.cleanUrl("not a url") === "not a url", "a non-URL is returned untouched");
  }

  // -------------------------------------------------------------------------
  // Advisories must never gate a submit.
  //
  // Regression fix: attachDoc reports "Handshake already holds N
  // duplicates of this file" AFTER successfully attaching the right one by an
  // exact name match. That note was pushed into `unfilled`, and cleanGates()
  // blocks on unfilled.length - so three complete, submittable forms (Critical
  // Example A, Example B, Example C) were held back by a remark about
  // the document library. The form itself was never the problem.
  // -------------------------------------------------------------------------
  {
    console.log("\n--- advisories do not block a submit ---");
    const clean = { found: true, hasSubmit: true, submitEnabled: true, blockers: false, mismatch: false };

    ok(core.cleanGates(clean, []).length === 0,
      "a clean form with no unfilled items is submittable");
    ok(core.cleanGates(clean, ["this job wants a TRANSCRIPT and none was found"]).length > 0,
      "a real gap still blocks");

    // The exact shape attachDoc returns after a successful reuse.
    const reused = {
      how: "reused",
      notes: [],
      advisories: ['Handshake already holds 1 duplicate of "School Transcript.pdf"'],
    };
    ok(reused.notes.length === 0 && reused.advisories.length === 1,
      "a duplicate-library warning lands in advisories, not notes");
    ok(core.cleanGates(clean, reused.notes).length === 0,
      "a form whose only remark is that warning still submits");

    const failed = { how: "failed", notes: ["could not attach the cover - do it by hand"], advisories: [] };
    ok(core.cleanGates(clean, failed.notes).length > 0,
      "a FAILED attach still lands in notes, so it still blocks");

    ok(core.cleanGates({ ...clean, mismatch: true }, []).length > 0,
      "a school-year mismatch still blocks after moving to advisories");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
