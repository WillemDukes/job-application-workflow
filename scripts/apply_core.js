/**
 * apply_core.js - the one implementation of the Handshake apply engine.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * prep_apply.js did all of this inline inside a single IIFE, which meant a
 * batch runner would have had to copy it. Two copies of a form-filler that
 * types real answers into real job applications is how they drift, and the
 * drift is invisible until an employer sees the wrong field. So the engine
 * lives here once and every caller requires it.
 *
 * THE RULE THIS FILE KEEPS
 * ------------------------
 * Nothing here clicks Submit on its own. `submitIfClean()` exists, and it
 * refuses unless the caller explicitly opted in AND the form passes every gate
 * in CLEAN_GATES. The default requirement is that the
 * automation never submits unless explicitly enabled with an opt-in flag. The
 * default is still no.
 *
 * ENGINE FIXES AND IMPROVEMENTS:
 *   1. READ_MODAL now actually returns `submitEnabled` and `blockers`. The old
 *      one never did, so `!undefined` printed "GREYED OUT" on every run and the
 *      red-warning detector never fired once.
 *   2. Screening answers match on WORD BOUNDARIES and by specificity. The old
 *      substring match let the token "phone" match "phonetic", and because
 *      contact.phone sorts first, the "how do you pronounce your name" field
 *      was filled with a phone number.
 *   3. needsCover keys off the slot heading, not any mention of "cover letter".
 *   4. waitForUpload filters to visible dialogs like every other lookup.
 */
const fs = require("fs");
const path = require("path");
const { REPO_ROOT } = require("./lib");

const CSV_PATH = path.join(REPO_ROOT, "applications.csv");
const DOCS = path.join(REPO_ROOT, "Documents that will be uploaded");
const DEFAULT_PORTFOLIO = path.join(DOCS, "Portfolio.docx");
const DEFAULT_TRANSCRIPT = path.join(DOCS, "School Transcript.pdf");
const DEFAULT_RESUME = path.join(DOCS, "Resume.docx");
const ANSWERS_FILE = path.join(REPO_ROOT, "screening_answers.json");

// ---------------------------------------------------------------------------
// Selectors, captured from a live apply modal.
// Styled-components class names change every deploy, so these use data-hook,
// aria-label or exact text only.
// ---------------------------------------------------------------------------
const SEL = {
  // aria-label is EXACTLY "Apply". The external variant reads "Apply
  // externally" and must never match here.
  nativeApply: '[data-hook="job-details-page"] button[aria-label="Apply"]',
  externalApply: '[data-hook="job-details-page"] button[aria-label="Apply externally"]',
  promoClose: 'button[aria-label="Close modal"]',
  applyModalClose: '[data-hook="apply-modal-close-button"]',
  docSearch: '[data-hook="apply-modal-document-search"]',
};

// Never clicked except through submitIfClean(). Listed so the intent is
// auditable at a glance.
const FORBIDDEN_TEXT = /^(submit|submit application|apply now|confirm)$/i;

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Proper CSV read - a regex-and-filter trick mis-indexes quoted columns. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** Read the whole sheet as {header, rows:[{col:val}]}. */
function readCsv(csvPath = CSV_PATH) {
  const grid = parseCsv(fs.readFileSync(csvPath, "utf8")).filter((r) => r.length > 1);
  const header = grid[0];
  const rows = grid.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] || ""])));
  return { header, rows };
}

function rowFor(csvPath, key) {
  const { rows } = readCsv(csvPath);
  return rows.find((r) => r.app_key === key) || null;
}

/**
 * Patch one row in place and rewrite the file.
 *
 * Reads fresh off disk every call rather than holding the sheet in memory: a
 * batch run takes long enough that you may well have the CSV open, and
 * writing back a stale snapshot would silently drop edits.
 */
function updateRow(key, patch, csvPath = CSV_PATH) {
  const raw = fs.readFileSync(csvPath, "utf8");
  const { header, rows } = readCsv(csvPath);
  const target = rows.find((r) => r.app_key === key);
  if (!target) return false;
  Object.assign(target, patch);
  // Keep the file's own line ending. This sheet is CRLF; writing LF rewrote
  // all 55 lines on every single-cell update, which makes any diff of the CSV
  // useless and churns the file in your editor for no reason.
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const out = [header.map(csvCell).join(",")]
    .concat(rows.map((r) => header.map((h) => csvCell(r[h])).join(",")))
    .join(eol) + eol;
  fs.writeFileSync(csvPath, out, "utf8");
  return true;
}

/**
 * Append to a row's notes without losing what is already there, and without
 * repeating a `key: value` fact the row already records.
 *
 * The scan writes "apply: external" the first time it opens a detail page. A
 * later batch run that re-derives the same fact was appending a second copy,
 * so a row worked three times read "apply: external; apply: external;
 * apply: external".
 */
function addNote(row, note) {
  const have = (row.notes || "").trim();
  const parts = have ? have.replace(/;\s*$/, "").split(";").map((s) => s.trim()).filter(Boolean) : [];
  const keyOf = (s) => {
    const m = s.match(/^([a-z_0-9 ]+):/i);
    return m ? m[1].trim().toLowerCase() : null;
  };
  for (const piece of note.split(";").map((s) => s.trim()).filter(Boolean)) {
    const k = keyOf(piece);
    if (k) {
      // A keyed fact replaces the old value rather than stacking beside it.
      const at = parts.findIndex((p) => keyOf(p) === k);
      if (at >= 0) { parts[at] = piece; continue; }
    } else if (parts.includes(piece)) {
      continue;
    }
    parts.push(piece);
  }
  return parts.join("; ");
}

/**
 * Handshake bolts ~20 tracking parameters onto an external handoff URL
 * (`?gh_src=Handshake&iisn=Handshake&...`), which turned one CSV cell into 700
 * characters. Keep the address and any parameter that actually identifies the
 * posting; drop the rest.
 */
function cleanUrl(raw) {
  if (!raw) return raw;
  let u;
  try { u = new URL(raw); } catch { return raw; }
  const KEEP = /^(gh_jid|jid|job_?id|jobid|posting|postingid|req|reqid|requisition\w*|id|vacancy\w*|lever-\w*id)$/i;
  const kept = [...u.searchParams.entries()].filter(([k, v]) => KEEP.test(k) && v && !/^handshake$/i.test(v));
  u.search = kept.length ? "?" + kept.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") : "";
  u.hash = "";
  return u.toString();
}

// ---------------------------------------------------------------------------
// Saved screening answers
// ---------------------------------------------------------------------------

/**
 * Flatten screening_answers.json into [{key, answer, match, voluntary}].
 *
 * Demographic answers are tagged voluntary and left out unless the caller asks
 * for them: they are optional on every form and decided per application,
 * not once in a config file.
 */
/**
 * Pull the low end of an advertised pay range.
 *
 * Standing rule: "use low end of range as the standing rule." Handshake
 * prints pay as "$16.50-21.70/hr", "$16.50 - $21.70 per hour", "$17/hr" and a
 * dozen other shapes, so this takes the FIRST money-looking number and nothing
 * else. Returns null when the posting printed no rate - and null means the field
 * is left blank rather than guessed, because a salary typed onto a real
 * application cannot be taken back.
 */
function payLowEnd(pay) {
  if (!pay) return null;
  const m = String(pay).match(/\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/);
  if (!m) return null;
  return formatRate(Number(m[1].replace(/,/g, "")));
}

/** Shared by payLowEnd and parsePageRateLow. Hourly rates keep their cents;
 * annual figures are written whole. */
function formatRate(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1000 ? n.toFixed(2).replace(/\.00$/, "") : String(Math.round(n));
}

/**
 * Pull the LOW end of an hourly rate straight off the job posting's own text.
 *
 * SuccessFactors postings carry a standard paragraph: "COMPENSATION:
 * The hourly rate for this position is $15.50 to $15.50."
 * - sometimes a real range, sometimes the same number
 * twice. This is preferred over PAY_LOW (the CSV pay column) because it is the
 * exact figure the employer just showed the applicant, not a value transcribed
 * off Handshake's listing days earlier. Returns null when the posting's text
 * carries no such sentence, so the caller falls back to PAY_LOW rather than
 * guessing.
 */
function parsePageRateLow(text) {
  if (!text) return null;
  const m = String(text).match(/hourly\s+rate[^$]{0,60}?\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/i);
  if (!m) return null;
  return formatRate(Number(m[1].replace(/,/g, "")));
}

/**
 * @param ctx  Per-job context for tokens that cannot be answered in the abstract.
 *             `{ pay }` resolves PAY_LOW. Omit it and PAY_LOW-valued answers are
 *             dropped rather than guessed.
 */
function loadAnswers(includeDemographics, file = ANSWERS_FILE, ctx = {}) {
  if (!fs.existsSync(file)) return [];
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.log(`  !! ${path.basename(file)} is not valid JSON (${e.message}) - skipping screening`);
    return [];
  }
  const out = [];
  for (const [group, entries] of Object.entries(doc)) {
    if (group.startsWith("_") || typeof entries !== "object") continue;
    const voluntary = group === "demographic_voluntary";
    if (voluntary && !includeDemographics) continue;
    for (const [name, spec] of Object.entries(entries)) {
      if (name.startsWith("_") || !spec || typeof spec !== "object") continue;
      if (spec.answer === undefined || spec.answer === null || !Array.isArray(spec.match)) continue;
      // A null answer means "recorded but deliberately unanswerable" (see
      // compensation.desired_salary, which needs the posting's advertised rate).
      // Letting it through would type the string "null" into a real employer's
      // form, so it is dropped above rather than filled.
      let answer = spec.answer;
      // "TODAY" is a token, not a literal. availability.start_date is answered
      // this way because it uses the date actually applied, so it has to
      // be resolved at fill time - a hardcoded date goes stale the next morning.
      if (answer === "TODAY") {
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, "0");
        answer = `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${d.getFullYear()}`;
      }
      // "PAY_LOW" is the standing desired-salary rule: the low end of whatever
      // the posting advertised. It needs the job's own pay string, so a caller
      // that did not supply one gets the answer DROPPED, never guessed.
      if (answer === "PAY_LOW") {
        const low = payLowEnd(ctx.pay);
        if (!low) continue;
        answer = low;
      }
      // "SALARY_RATE" is for a free-text "salary expectations" box that
      // REJECTS anything but a number (on some
      // SuccessFactors forms - turning the box red on the literal
      // "Negotiable"). Prefers the posting's OWN advertised rate
      // (parsePageRateLow, from ctx.pageText) over the CSV's pay column
      // (payLowEnd, from ctx.pay), because the posting's own wording is the
      // more current and more specific source; falls through to PAY_LOW's
      // rule when the page printed no rate. Drops, never guesses, when
      // neither source has a number.
      if (answer === "SALARY_RATE") {
        const low = parsePageRateLow(ctx.pageText) || payLowEnd(ctx.pay);
        if (!low) continue;
        answer = low;
      }
      out.push({
        key: `${group}.${name}`, answer, match: spec.match, voluntary,
        avoid_within: spec.avoid_within,
        avoid_block: spec.avoid_block,
        require_block: spec.require_block,
        require_within: spec.require_within,
        require_block_text: spec.require_block_text,
        repeat: spec.repeat === true,
        // Opt-in only, per spec - see FILL_SCREENING's CREDENTIAL check.
        allow_password: spec.allow_password === true,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page functions. These are serialised into the browser, so they must be
// entirely self-contained - no closures over anything in this file.
// ---------------------------------------------------------------------------

/**
 * Tag each document slot's controls with data-wd-slot, in the page.
 *
 * The apply modal has up to FOUR slots - resume, cover letter, transcript,
 * other required documents - and Handshake gives every picker the same
 * data-hook and a bare input[type=file]. Nothing on the control says which slot
 * it belongs to, so the only reliable way to tell them apart is document order
 * relative to the headings. Getting this wrong means uploading a cover letter
 * into the RESUME slot.
 */
function TAG_SLOTS() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')]
    .filter(vis)
    .find((x) => /Apply to/i.test(x.innerText || ""));
  if (!d) return { found: false, slots: {} };

  const all = [...d.querySelectorAll("*")];
  const HEAD = [
    [/^attach your resume$/i, "resume"],
    [/^attach your cover letter$/i, "cover"],
    [/^attach your transcript$/i, "transcript"],
    [/^attach other required documents$/i, "other"],
  ];

  // Deepest element whose whole text IS the heading wins: ancestors match too,
  // and querySelectorAll is document order, so the last hit is the deepest.
  const headAt = {};
  all.forEach((el, i) => {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    const hit = HEAD.find(([re]) => re.test(t));
    if (hit) headAt[hit[1]] = i;
  });

  const owner = (i) => {
    let best = null, bestIdx = -1;
    for (const slot of Object.keys(headAt)) {
      const hi = headAt[slot];
      if (hi < i && hi > bestIdx) { bestIdx = hi; best = slot; }
    }
    return best;
  };

  const slots = {};
  all.forEach((el, i) => {
    const isSearch = el.matches('[data-hook="apply-modal-document-search"]');
    const isFile = el.tagName === "INPUT" && el.type === "file";
    if (!isSearch && !isFile) return;
    const slot = owner(i);
    if (!slot) return;
    const target = isFile ? el : (el.tagName === "INPUT" ? el : el.querySelector("input"));
    if (!target) return;
    target.setAttribute("data-wd-slot", slot + (isFile ? "-file" : "-search"));
    slots[slot] = slots[slot] || {};
    slots[slot][isFile ? "file" : "search"] = true;
  });

  return { found: true, slots, headings: Object.keys(headAt) };
}

/**
 * Answer screening questions. Runs in the page.
 *
 * `scope` is "modal" for the Handshake apply dialog or "document" for an
 * external portal's own page, which has no dialog to scope to.
 *
 * Fills every field whose QUESTION TEXT matches - never by field order.
 * Questions asked twice with different answers make position meaningless.
 *
 * Rules this function will not break:
 *   - It touches inputs, selects, textareas and radios ONLY. It never clicks a
 *     button. A stray button click in an apply form is a real submission.
 *   - It never overwrites a field that already has a value.
 *   - It never touches a password field, and never a field whose question looks
 *     like a credential. Account creation is not this script's business.
 *   - React tracks its own value on the DOM node, so a plain `el.value = x` is
 *     reverted on the next render. Every write goes through the native setter
 *     and then dispatches input + change.
 *
 * MATCHING logic: The matching logic relies on two key principles:
 * `question.includes(token)` and took the first hit in file order. The token
 * "phone" is a substring of "phonetic", and contact.phone sorts before
 * contact.phonetic_name, so "how do you pronounce your name" was answered with
 * a phone number. Two changes fix that at the root:
 *   - a token only matches on a WORD BOUNDARY, so "phone" no longer matches
 *     "phonetic" (nor "race" inside "embraced");
 *   - candidates are ranked by the LONGEST matching token, so the more specific
 *     answer wins regardless of where it sits in the file.
 */
function FILL_SCREENING(arg) {
  // Playwright's page.evaluate passes exactly ONE argument, so the parameters
  // arrive as a single object rather than a list.
  const answers = (arg && arg.answers) || [];
  const scope = (arg && arg.scope) || "modal";
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let d;
  if (scope === "document") {
    d = document.body;
  } else {
    d = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')]
      .filter(vis)
      .find((x) => /Apply to/i.test(x.innerText || ""));
  }
  if (!d) return { filled: [], skipped: [], unmatched: [] };

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  // A token matches only when it is not glued to more word characters on
  // either side. "phone" must not match "phonetic"; "race" must not match
  // "embraced".
  const containsWord = (hay, needle) => {
    if (!needle) return false;
    const isWord = (ch) => /[a-z0-9]/.test(ch);
    let i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) {
      const before = i === 0 ? " " : hay[i - 1];
      const after = i + needle.length >= hay.length ? " " : hay[i + needle.length];
      if (!isWord(before) && !isWord(after)) return true;
      i += 1;
    }
    return false;
  };

  const setNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  /**
   * The question attached to ONE field, and nothing else.
   *
   * An early version concatenated up to six previous siblings, which let every
   * field inherit the questions above it - the availability radio picked up a
   * location answer that way and checked "Yes" on its own. So: explicit labels
   * only, and if there is no label, ONE nearest preceding text block, taken
   * whole and never merged.
   */
  const questionFor = (el) => {
    if (el.id) {
      const lab = d.querySelector
        ? d.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]')
        : null;
      if (lab && norm(lab.textContent)) return norm(lab.textContent);
    }
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const parts = by.split(/\s+/)
        .map((id) => document.querySelector("#" + (window.CSS && CSS.escape ? CSS.escape(id) : id)))
        .filter(Boolean)
        .map((n) => norm(n.textContent))
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const wrap = el.closest("label");
    if (wrap && norm(wrap.textContent)) return norm(wrap.textContent);
    const aria = norm(el.getAttribute("aria-label"));
    if (aria) return aria;
    const ph = norm(el.getAttribute("placeholder"));
    // A placeholder that is only a date FORMAT HINT ("MM/YYYY", "MM/DD/YYYY",
    // "YYYY-MM-DD"...) is not a question, and treating it as one hid the real
    // label. Paylocity's End Date box has placeholder="MM/YYYY" and no
    // <label> at all, so this branch used to return "mm/yyyy" - the
    // profile.work_history field-detection regex for /end date/i never got a
    // chance to see "End Date" from the ancestor walk below, and the field
    // silently kept whatever the resume parser guessed (08/2026 instead of
    // the profile's 2025-08). Skip a pure format hint and fall through.
    if (ph && !/^[mdy]{1,4}([/\-.][mdy]{1,4}){1,2}$/i.test(ph)) return ph;

    let node = el;
    for (let up = 0; node && node !== d && up < 3; up++, node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const t = norm(sib.innerText || sib.textContent);
        if (t && t.length < 300) return t;
      }
    }
    return "";
  };

  // A radio group's question lives on its container, not on any one option.
  const groupQuestion = (list) => {
    const box = list[0].closest("fieldset") || list[0].parentElement;
    if (box) {
      const legend = box.querySelector("legend");
      if (legend && norm(legend.textContent)) return norm(legend.textContent);
      let t = norm(box.innerText || box.textContent);
      for (const r of list) {
        const lab = r.closest("label");
        if (lab) t = t.replace(norm(lab.textContent), " ");
      }
      t = norm(t);
      if (t) return t;
    }
    return questionFor(list[0]);
  };

  // One option's own label - never the surrounding context.
  const optionLabel = (r) => {
    const lab = r.closest("label");
    if (lab) return norm(lab.textContent);
    if (r.id) {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(r.id) : r.id) + '"]');
      if (l) return norm(l.textContent);
    }
    return norm(r.getAttribute("aria-label") || r.value);
  };

  const wantOf = (spec) => String(Array.isArray(spec.answer) ? spec.answer[0] : spec.answer);

  // Never fill anything that looks like a credential.
  const CREDENTIAL = /password|passcode|social security|ssn\b|routing number|account number|credit card|cvv|security code/i;

  const filled = [], skipped = [], unmatched = [];
  const used = new Set();
  const attempts = [];
  const profile = arg && arg.profile ? arg.profile : null;
  let fillId = 0;

  // `overrideFrom` is set only when this write REPLACES a value the field
  // already held (Paylocity's resume parser guessed wrong). driveScreening
  // reads it back off `attempts` once VERIFY_FILLS confirms the write stuck,
  // and turns it into an "override : <label> <old> -> <new>" log line.
  const setAndLog = (el, want, specKey, type, options, q, overrideFrom) => {
    const id = 'wd-fill-' + (++fillId);
    el.setAttribute('data-wd-fill-id', id);
    setNative(el, want);
    attempts.push({ id, want, type, key: specKey, q, options, overrideFrom: overrideFrom == null ? null : overrideFrom });
  };

  /**
   * Best answer for a question: the one whose longest matching token is
   * longest. Ties break toward the earlier entry, which keeps the deliberate
   * ordering for genuinely identical questions.
   */
  /**
   * The nearest section heading ABOVE a field, in document order.
   *
   * This is what makes an answer block-aware. A label alone cannot tell the two
   * apart: on a Paylocity application the box labelled "Zip Code" under
   * "Personal Information" wants the applicant's zip, and the identically labelled box
   * under "Work History" wants a previous EMPLOYER's zip. Matching on the label
   * put <zip> into <Employer>'s address twice before this existed.
   */
  const sectionOf = (el) => {
    const heads = [...d.querySelectorAll("h1,h2,h3,h4,h5,h6,legend,[role='heading']")];
    let cur = "";
    for (const h of heads) {
      // Keep the last heading that comes BEFORE this element.
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        cur = norm(h.textContent);
      }
    }
    return cur;
  };

  /**
   * The repeated sub-form a field belongs to - one work-history entry, say.
   *
   * A Paylocity application repeats an identical Company Name / Position /
   * Address group per previous job. `sectionOf` gets us as far as "this is Work
   * History"; it cannot tell WHICH job. This walks up to the nearest ancestor
   * that contains a "Company Name" box and returns that ancestor's text, so an
   * answer can require the block to name a particular employer before it fills.
   */
  /**
   * What KIND of repeated block a field sits in: "work", "education", or "" for
   * the applicant's own top-level details.
   *
   * Heading-based detection does not work here. Paylocity's application carries
   * no section headings whatsoever - checked on live forms, the
   * only <h*> on the page are "Apply with resume", the employer name, and the
   * cookie banner. So "Work History" as a string appears nowhere for sectionOf()
   * to find, which silently blocked every require_within answer.
   *
   * A block is identified by its OWN fields instead: the nearest ancestor
   * containing a "Company Name" label is a work-history entry, and one
   * containing "School Name" is an education entry. Walking up one level at a
   * time means the FIRST hit is the smallest containing block, which is the
   * right one - the whole form contains every label and would always match if
   * we searched from the top.
   */
  const BLOCK_WORK = /^(work history|employment history|employer)\b/;
  const BLOCK_EDU = /^(education|school)\b/;
  const knownBlocks = new Map();
  let workCount = 0;
  let eduCount = 0;
  const blockOf = (el) => {
    let n = el && el.parentElement;
    for (let hops = 0; n && hops < 14; hops++, n = n.parentElement) {
      const t = norm(n.innerText || "");
      if (BLOCK_WORK.test(t) || BLOCK_EDU.test(t)) {
        if (!knownBlocks.has(n)) {
          knownBlocks.set(n, {
            kind: BLOCK_WORK.test(t) ? "work" : "education",
            ordinal: BLOCK_WORK.test(t) ? workCount++ : eduCount++
          });
        }
        const bk = knownBlocks.get(n);
        const vals = [...n.querySelectorAll("input,textarea,select")]
          .map((i) => norm(i.value))
          .filter(Boolean)
          .join(" ");
        const text = (t + " " + vals).slice(0, 4000);
        return { kind: bk.kind, text, ordinal: bk.ordinal };
      }
    }
    return { kind: "", text: "", ordinal: -1 };
  };

  const pick = (q, el) => {
    if (!q) return null;
    const section = el ? sectionOf(el) : "";
    let block = null;  // computed lazily; innerText on every field is slow
    const blk = () => (block === null ? (block = el ? blockOf(el) : { kind: "", text: "" }) : block);
    let best = null, bestLen = 0;
    for (const a of answers) {
      if (used.has(a.key)) continue;
      // An answer can refuse to be used inside a named section. Wrong data on a
      // real application is worse than a blank field, so this check comes first
      // and is absolute - a refused answer is not "best effort" filled anywhere.
      if (a.avoid_within && section &&
          a.avoid_within.some((s) => containsWord(section, norm(s)))) {
        continue;
      }
      // The inverse: an answer that is ONLY valid inside a named section. Kept
      // for portals that do use headings; harmless where none exist.
      if (a.require_within) {
        if (!section || !a.require_within.some((s) => containsWord(section, norm(s)))) continue;
      }
      // Heading-free block rules - these are the ones that actually bite on
      // Paylocity. avoid_block keeps the applicant's own address out of a previous
      // employer's block; require_block keeps an employer's address inside one.
      if (a.avoid_block && a.avoid_block.includes(blk().kind)) continue;
      if (a.require_block && blk().kind !== a.require_block) continue;
      // And the strict form: the surrounding block must NAME the thing this
      // answer describes. An employer's address may only be typed into a
      // block that says that employer's name - otherwise a second employer's
      // block would silently receive the first employer's address.
      if (a.require_block_text) {
        const t = blk().text;
        if (!t || !a.require_block_text.some((s) => containsWord(t, norm(s)))) continue;
      }
      let len = 0;
      for (const m of a.match) {
        const t = norm(m);
        if (containsWord(q, t) && t.length > len) len = t.length;
      }
      if (len > bestLen) { best = a; bestLen = len; }
    }
    return best;
  };

  const isRequired = (el, q) =>
    el.required || el.getAttribute("aria-required") === "true" || /\(required\)|\*\s*$/.test(q);

  // --- radio groups -------------------------------------------------------
  const radios = [...d.querySelectorAll('input[type="radio"]')].filter(vis);
  const groups = {};
  for (const r of radios) (groups[r.name || "_unnamed"] = groups[r.name || "_unnamed"] || []).push(r);
  for (const [name, list] of Object.entries(groups)) {
    if (list.some((r) => r.checked)) { skipped.push('radio "' + name + '" already answered'); continue; }
    const q = groupQuestion(list);
    const spec = pick(q, list[0]);
    if (!spec) {
      if (list.some((r) => r.required || r.getAttribute("aria-required") === "true")) {
        unmatched.push('a REQUIRED choice has no saved answer: "' + q.slice(0, 90) + '"');
      }
      continue;
    }
    const want = norm(wantOf(spec));
    const chosen = list.find((r) => optionLabel(r) === want || norm(r.value) === want);
    if (!chosen) { unmatched.push(spec.key + ': no option matching "' + want + '"'); continue; }
    const id = 'wd-fill-' + (++fillId);
    chosen.setAttribute('data-wd-fill-id', id);
    chosen.click();
    if (!spec.repeat) used.add(spec.key);
    attempts.push({ id, want, type: 'radio', key: spec.key, q });
    filled.push(spec.key + " = " + want);
  }

  // --- selects ------------------------------------------------------------
  for (const sel of [...d.querySelectorAll("select")].filter(vis)) {
    if (sel.value && sel.selectedIndex > 0) { skipped.push("a dropdown already had a value"); continue; }
    const q = questionFor(sel);
    const spec = pick(q, sel);
    if (!spec) {
      if (isRequired(sel, q)) unmatched.push('a REQUIRED dropdown has no saved answer: "' + q.slice(0, 90) + '"');
      continue;
    }
    const want = norm(wantOf(spec));
    const opt = [...sel.options].find((o) => norm(o.textContent) === want)
      || [...sel.options].find((o) => norm(o.textContent).startsWith(want))
      || [...sel.options].find((o) => norm(o.value) === want);
    if (!opt) { unmatched.push(spec.key + ': no option matching "' + want + '"'); continue; }
    const id = 'wd-fill-' + (++fillId);
    sel.setAttribute('data-wd-fill-id', id);
    setNative(sel, opt.value);
    if (!spec.repeat) used.add(spec.key);
    attempts.push({ id, want: opt.value, wantText: norm(opt.textContent), type: 'select', key: spec.key, q });
    filled.push(spec.key + " = " + norm(opt.textContent));
  }

  // --- free text ----------------------------------------------------------
  // input[type="password"] is included ONLY so the allow_password exception
  // below has a field to act on - CREDENTIAL still gates every one of them by
  // default. See that check for the (narrow, opt-in-per-spec) exception.
  const texts = [...d.querySelectorAll(
    'input[type="text"],input[type="tel"],input[type="url"],input[type="email"],input[type="password"],input:not([type]),textarea'
  )]
    .filter(vis)
    .filter((el) => !el.closest('[data-hook="apply-modal-document-search"]'))
    .filter((el) => !el.hasAttribute("data-wd-slot"))
    .filter((el) => !/search/i.test(el.getAttribute("placeholder") || ""))
    // SuccessFactors' own paginated-select combobox (Country,
    // State/Province, Preferred Language, opt-in-to-text, worked-before,
    // 18-or-older, authorized-to-work, Gender/Ethnicity/Race/Veteran/
    // Disability) is a plain <input> with no `type` attribute, so it used to
    // match this SAME selector and get its DISPLAY TEXT typed via setNative
    // below - which satisfies SF's own visual read-back ("Indiana" shows in
    // the box) but never fires SF's real option-selection, so validation kept
    // printing "<Field> is required" under text that looked filled.
    // SF does not always stamp role="combobox" on these
    // until some async init finishes (Country had it, the otherwise-identical
    // State/Province input did not), so the exclusion checks the WIDGET
    // CLASS too, not just the role - the same class widgets.js's TAG_WIDGETS
    // uses to find and properly click these. Left for widgets.js's
    // "sfpicklist" handler exclusively, which opens the real listbox and
    // clicks a real option.
    .filter((el) => el.getAttribute("role") !== "combobox" && !/\brcmpaginatedselectinput\b/.test(el.className || ""));
  // Fields where profile.json is AUTHORITATIVE - the applicant's own
  // street/city/county/state/zip (screening_answers "address" group, sourced
  // from profile.json identity.local_address). These may OVERWRITE a value
  // Paylocity's resume parser already guessed instead of skipping the field
  // the moment it is non-empty. Work-history block fields get the same
  // treatment below via the profile.work_history direct mapping - they are
  // not spec-based, so they do not need this regex.
  const AUTHORITATIVE_KEY = /^address\.(street|city|county|state|zip)$/;

  // Paylocity names the two halves of an address box "...-address-1" (Line 1
  // - the street belongs here) and "...-address-2" (Line 2, optional). The
  // resume parser sometimes puts the street in Line 2 and a city/state guess
  // in Line 1. Once Line 1 is corrected to the real street, Line 2 must be
  // cleared if it is STILL holding that same street, or it ends up typed
  // twice on the application.
  const findAddressLine2 = (el) => {
    if (el.id && /-address-1$/i.test(el.id)) {
      const alt = document.getElementById(el.id.replace(/-address-1$/i, "-address-2"));
      if (alt) return alt;
    }
    const box = el.closest("div") && el.closest("div").parentElement;
    if (box) {
      const cand = [...box.querySelectorAll("input,textarea")]
        .find((c) => c !== el && /address line ?2/i.test(questionFor(c)));
      if (cand) return cand;
    }
    return null;
  };
  const clearLine2IfDuplicateStreet = (line1El, street) => {
    const line2 = findAddressLine2(line1El);
    if (!line2 || !vis(line2)) return;
    const cur = norm(line2.value);
    if (cur && cur === norm(street)) {
      setAndLog(line2, "", "addressLine2.clear", "text", null, "Address Line 2 (auto-cleared - held the street)", line2.value);
    }
  };

  for (const el of texts) {
    const rawVal = el.value || "";
    const hasVal = !!rawVal.trim();
    const q = questionFor(el);
    if (CREDENTIAL.test(q) || CREDENTIAL.test(el.name || "")) {
      // A password box is filled ONLY when a screening_answers.json entry
      // matches it AND that entry explicitly carries allow_password:true -
      // account creation is still not this script's business by default.
      // Added for SuccessFactors, which puts up a real account
      // form (Choose Password / Retype Password) before it will show the
      // application when configured.
      // Every other credential-looking field (SSN, routing number, an
      // unrecognised password box) is still left alone, unconditionally.
      const maybeSpec = pick(q, el);
      if (!(el.type === "password" && maybeSpec && maybeSpec.allow_password === true)) {
        skipped.push("left a credential-looking field alone: " + q.slice(0, 60));
        continue;
      }
    }

    if (profile && profile.work_history) {
      let blockIndex = -1;
      const m = (el.id || el.name || "").match(/(?:workHistory|work-history)[^0-9]*?(\d+)/i);
      const blk = blockOf(el);
      if (m) {
        blockIndex = parseInt(m[1], 10);
      } else if (blk.kind === 'work') {
        blockIndex = blk.ordinal;
      }

      if (blockIndex >= 0 && profile.work_history[blockIndex]) {
        const wh = profile.work_history[blockIndex];
        // Order matters: "employer"/"title" are broad catch-alls that appear as
        // SUBSTRINGS of the more specific labels below ("Employer Phone",
        // "Employer Address", "Employer City"...), so they must be tested LAST.
        // Tested in the old order, "Employer Phone" matched /employer/ first and
        // wrote the COMPANY NAME into the phone box on every work-history block.
        let field = null;
        if (/company phone|supervisor phone|employer phone/i.test(q)) field = 'supervisor_phone';
        else if (/address line 1|street/i.test(q)) field = 'street';
        else if (/(^|\s)city/i.test(q)) field = 'city';
        else if (/(^|\s)county/i.test(q)) field = 'county';
        else if (/(^|\s)state(?!ment)/i.test(q)) field = 'state';
        else if (/(^|\s)(zip|postal)/i.test(q)) field = 'zip';
        else if (/start date/i.test(q)) field = 'start';
        else if (/end date/i.test(q)) field = 'end';
        else if (/responsibilities|duties/i.test(q)) field = 'duties';
        else if (/position|title/i.test(q)) field = 'title';
        else if (/company name|employer/i.test(q)) field = 'employer';

        if (field) {
          let val = '';
          if (['street', 'city', 'county', 'state', 'zip'].includes(field)) {
            val = wh.employer_address ? wh.employer_address[field] : '';
          } else if (field === 'duties') {
            val = (wh.duties || []).join("; ");
          } else if (field === 'start' || field === 'end') {
            const dVal = wh[field];
            if (dVal) {
              const ph = (el.placeholder || el.title || el.pattern || "").toUpperCase();
              const [y, mm] = dVal.split('-');
              if (/MM\/YYYY/.test(ph)) val = `${mm}/${y}`;
              else if (/MM\/DD\/YYYY/.test(ph)) val = `${mm}/01/${y}`;
              else if (/YYYY-MM-DD/.test(ph)) val = `${y}-${mm}-01`;
              else if (/YYYY-MM/.test(ph)) val = `${y}-${mm}`;
              else {
                unmatched.push(`Date format unknown for "${q.slice(0, 40)}" (placeholder: ${ph}) in work block ${blockIndex}`);
                continue;
              }
            }
          } else {
            val = wh[field];
          }

          if (val) {
             if (norm(rawVal) === norm(String(val))) {
                // Idempotent: Paylocity (or a previous run) already got this
                // right. Leave it alone - do not even touch data-wd-fill-id.
                // Address Line 2 is checked regardless: Paylocity's resume
                // parser can re-populate IT with the street on a fresh page
                // load even when Line 1 is already correct (Line 1 needed
                // no touch, Line 2 still had to be cleared), so the clear
                // cannot be conditioned on Line 1 actually being WRITTEN this run.
               if (field === 'street') clearLine2IfDuplicateStreet(el, val);
               skipped.push('workHistory.' + field + '.' + blockIndex + ' already correct');
               continue;
             }
             const isTypeahead = el.getAttribute("aria-autocomplete") === "list";
             setAndLog(el, val, 'workHistory.' + field + '.' + blockIndex, isTypeahead ? 'typeahead' : 'text', null, q, hasVal ? rawVal : null);
             filled.push('workHistory.' + field + '.' + blockIndex + " = " + val);
             if (field === 'street') clearLine2IfDuplicateStreet(el, val);
             continue;
          }
        }
      }
    }
    const spec = pick(q, el);
    if (!spec) {
      if (hasVal) { skipped.push("a text field already had a value"); continue; }
      if (isRequired(el, q)) unmatched.push('a REQUIRED field has no saved answer: "' + q.slice(0, 90) + '"');
      continue;
    }
    const want = wantOf(spec);
    if (norm(rawVal) === norm(want)) {
      // Idempotent: already holds the answer we would have typed. Same
      // Address-Line-2 note as above - check regardless of whether Line 1
      // needed a write this run.
      if (spec.key === 'address.street') clearLine2IfDuplicateStreet(el, want);
      skipped.push(spec.key + " already correct");
      continue;
    }
    const authoritative = AUTHORITATIVE_KEY.test(spec.key);
    if (hasVal && !authoritative) { skipped.push("a text field already had a value"); continue; }
    const isTypeahead = el.getAttribute("aria-autocomplete") === "list";
    setAndLog(el, want, spec.key, isTypeahead ? 'typeahead' : 'text', null, q, hasVal ? rawVal : null);
    if (!spec.repeat) used.add(spec.key);
    filled.push(spec.key + " = " + want);
    if (spec.key === 'address.street') clearLine2IfDuplicateStreet(el, want);
  }

  // --- checkboxes -----------------------------------------------------------
  // Added for SuccessFactors' "I Accept" Applicant Acknowledgement
  // checkbox. A screening_answers.json entry answers a checkbox with a
  // truthy token (true/yes/accept/check) rather than the literal text that
  // would go into a text box - see application_terms.i_accept. Only ever
  // CHECKS a box, never unchecks one: an unchecked default (e.g. a marketing
  // opt-in nobody answered) is a safe default to leave alone.
  const AFFIRM = /^(true|yes|check|checked|accept|agree)$/i;
  for (const el of [...d.querySelectorAll('input[type="checkbox"]')].filter(vis)) {
    if (el.checked) { skipped.push("a checkbox was already checked"); continue; }
    const q = questionFor(el);
    const spec = pick(q, el);
    if (!spec) {
      if (isRequired(el, q)) unmatched.push('a REQUIRED checkbox has no saved answer: "' + q.slice(0, 90) + '"');
      continue;
    }
    const want = wantOf(spec);
    if (!AFFIRM.test(norm(want))) { skipped.push(spec.key + ": answer is not a check"); continue; }
    const id = 'wd-fill-' + (++fillId);
    el.setAttribute('data-wd-fill-id', id);
    el.click();
    if (!spec.repeat) used.add(spec.key);
    attempts.push({ id, want: 'checked', type: 'checkbox', key: spec.key, q });
    filled.push(spec.key + " = checked");
  }

  return { filled, skipped, unmatched, attempts };
}

/**
 * Re-check every field FILL_SCREENING just set. Runs in the page, so it must
 * stay self-contained like FILL_SCREENING itself.
 *
 * React re-renders can silently revert a value that was set through the
 * native setter the instant the component's own state overwrites it on the
 * next tick. FILL_SCREENING reports a fill the moment it sets the value, which
 * was true then and may not be true 300ms later. This is what driveScreening
 * uses to tell "still there" from "reverted".
 *
 * `attempts` is FILL_SCREENING's own `attempts` array - each entry carries the
 * `data-wd-fill-id` FILL_SCREENING stamped on the element, so the SAME node is
 * re-read here rather than re-discovered by label (which could resolve to a
 * different field entirely on a form with duplicate labels).
 */
function VERIFY_FILLS(attempts) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  return (attempts || []).map((a) => {
    const el = document.querySelector('[data-wd-fill-id="' + a.id + '"]');
    if (!el) return { id: a.id, ok: false, current: null };
    if (a.type === "radio" || a.type === "checkbox") {
      return { id: a.id, ok: el.checked === true, current: el.checked };
    }
    if (a.type === "select") {
      const val = norm(el.value);
      const shownText = el.options && el.selectedIndex >= 0
        ? norm(el.options[el.selectedIndex].textContent)
        : "";
      const ok = val === norm(String(a.want)) || (a.wantText && shownText === norm(a.wantText));
      return { id: a.id, ok, current: val };
    }
    // text / typeahead
    const cur = norm(el.value !== undefined ? el.value : el.textContent);
    let ok = cur === norm(String(a.want));
    if (!ok && a.type === "typeahead") {
      // A typeahead's COMMITTED value is often a formatted/expanded version of
      // what was typed ("<street address>" -> "<street address>, <City, ST>
      // <zip>"), so an exact match is too strict here - the leading text
      // agreeing is what matters.
      const wantLower = String(a.want).toLowerCase();
      ok = !!cur && cur.toLowerCase().indexOf(wantLower.slice(0, Math.min(6, wantLower.length))) === 0;
    }
    return { id: a.id, ok, current: cur };
  });
}

/**
 * Read the visible apply dialog: its text, its controls, its warnings.
 *
 * `submitEnabled` and `blockers` are the two fields prep_apply.js has always
 * read and READ_MODAL returned. Their absence meant
 * `!undefined` printed "GREYED OUT" on every run - including forms that were
 * perfectly valid - and the red-warning check never fired once.
 */
function READ_MODAL() {
  // Does the slot under `head` already hold a filename? Reads from that heading
  // up to the NEXT document heading, so adding a slot never silently widens
  // another slot's span.
  const SLOT_FILLED = (text, head) => {
    const HEADS = [
      /Attach your resume/i,
      /Attach your cover letter/i,
      /Attach your transcript/i,
      /Attach other required documents/i,
    ];
    const s = text.search(head);
    if (s < 0) return false;
    let end = text.length;
    for (const h of HEADS) {
      const i = text.slice(s + 1).search(h);
      if (i >= 0 && s + 1 + i < end) end = s + 1 + i;
    }
    return /\.(docx?|pdf)\b/i.test(text.slice(s, end));
  };

  const visible = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const d = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
    .filter(visible)
    .find((x) => /Apply to/i.test(x.innerText || ""));
  if (!d) return { found: false };

  const text = (d.innerText || "").replace(/\s+/g, " ").trim();

  const controls = [...d.querySelectorAll("button, input, select, textarea, a")]
    .filter(visible)
    .map((e) => ({
      tag: e.tagName,
      type: e.type || "",
      name: e.name || "",
      text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 45),
      aria: e.getAttribute("aria-label") || "",
      hook: e.getAttribute("data-hook") || "",
      // Needed to tell a live Submit from a greyed-out one. Was never captured.
      disabled: !!e.disabled || e.getAttribute("aria-disabled") === "true",
    }));

  const submit = controls.find((c) => /^submit application$/i.test(c.text));

  return {
    found: true,
    text: text.slice(0, 1500),
    controls,
    needsResume: /requires a resume|attach your resume/i.test(text),
    // Key off the SLOT HEADING, not any mention of the phrase. The old
    // /cover letter/i matched employer instructions that said a cover letter
    // was not wanted, and matched the third slot's instruction text too.
    needsCover: /attach your cover letter|requires a cover letter/i.test(text),
    // Is a document actually sitting in the resume slot? Do NOT match a
    // specific name: today the default is Resume.docx, but hardcoding that
    // would report a missing resume the day it gets renamed.
    resumeAttached: SLOT_FILLED(text, /Attach your resume/i),
    coverAttached: SLOT_FILLED(text, /Attach your cover letter/i),
    transcriptAttached: SLOT_FILLED(text, /Attach your transcript/i),
    needsTranscript: /Attach your transcript/i.test(text),
    // THE THIRD SLOT. Employer photo or portfolio instructions
    // here while the run still printed "everything is filled".
    otherDocs: (() => {
      const s = text.search(/Attach other required documents/i);
      if (s < 0) return null;
      const tail = text.slice(s, s + 500);
      const m = tail.match(/Instructions from employer:\s*(.+?)(?=\s+Search your other documents|\s+Upload new|$)/i);
      return {
        instructions: m ? m[1].trim().slice(0, 220) : null,
        filled: /\.(docx?|pdf)\b/i.test(tail),
      };
    })(),
    mismatch: /does not match what is requested/i.test(text),
    hasSubmit: !!submit,
    // TRUE only when a Submit button is present and live. Undefined-safe: the
    // caller can trust `submitEnabled === true` to mean the form is ready.
    submitEnabled: !!submit && !submit.disabled,
    // Handshake's inline validation. Red text under a field, and the reason
    // Submit stays grey on a form that otherwise looks complete.
    blockers: /please enter a valid response|this field is required|is required\b/i.test(text),
  };
}

// ---------------------------------------------------------------------------
// Node-side helpers
// ---------------------------------------------------------------------------

/** The "Get the app" promo renders as a dialog and covers the real one. */
async function dismissPromo(page) {
  const close = page.locator(SEL.promoClose);
  if (await close.count().catch(() => 0)) {
    await close.first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
}

/**
 * Handshake runs TWO async stages, "Uploading..." then "Converting...".
 * Screenshotting or closing during either one abandons the attachment.
 */
async function waitForUpload(page) {
  return page
    .waitForFunction(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const d = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')]
        .filter(vis)
        .find((x) => /Apply to/i.test(x.innerText || ""));
      return d && !/Uploading|Converting/i.test(d.innerText || "");
    }, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Attach a document to ONE named slot WITHOUT creating a duplicate.
 *
 * `slot` is "cover", "transcript" or "other" - the value TAG_SLOTS() stamped on
 * the controls. Never pass "resume": the default resume is managed separately
 * and nothing here touches that slot.
 *
 * Handshake keeps every upload forever and de-dupes by appending " (1)",
 * " (2)" - and that suffixed name is what the EMPLOYER sees. Two prep runs on
 * Example Jewelry left three copies in the account and put "... (2)" on the form. So:
 * search the account's existing documents for an exact name match and reuse it.
 */
async function attachDoc(page, filePath, slot, opts) {
  const { replace = false, log = console.log, label = slot } = opts || {};
  if (slot === "resume") throw new Error("attachDoc must never be called on the resume slot");
  const want = path.basename(filePath);
  // notes      = the attachment did NOT land. These block a submit.
  // advisories = the attachment DID land, but there is something to know about
  //              it later (duplicates sitting in the account, a suffixed name).
  //              These must never block a submit: the form is complete.
  const notes = [];
  const advisories = [];
  const pad = (label + "        ").slice(0, 8);

  const search = page.locator(`[data-wd-slot="${slot}-search"]`);
  const hasSearch = await search.count().catch(() => 0);

  if (hasSearch && !replace) {
    // Type the stem, not the whole filename: the picker matches on a prefix and
    // the ".docx" tail can push an exact match out of the list.
    const stem = want.replace(/\.docx?$/i, "").slice(0, 45);
    await search.first().click().catch(() => {});
    await search.first().fill("").catch(() => {});
    await search.first().type(stem, { delay: 45 });
    await page.waitForTimeout(2800);

    const found = await page.evaluate((w) => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const opts2 = [...document.querySelectorAll('[role="option"]')].filter(vis);
      const texts = opts2.map((o) => (o.textContent || "").replace(/\s+/g, " ").trim());
      const i = texts.indexOf(w);
      const dupes = texts.filter((t) => t.startsWith(w + " (")).length;
      if (i < 0) return { hit: false, dupes };
      opts2[i].click();
      return { hit: true, dupes };
    }, want);

    if (found.dupes) {
      advisories.push(
        `Handshake already holds ${found.dupes} duplicate${found.dupes > 1 ? "s" : ""} of ` +
        `"${want}" (named "(1)", "(2)"...). Delete them in Handshake > Documents ` +
        "so the wrong one can never be picked."
      );
    }

    if (found.hit) {
      const settled = await waitForUpload(page);
      if (!settled) notes.push(`the reused ${label} was still processing after 30s - check it before submitting`);
      log(`  ${pad} : reused "${want}" already in your Handshake documents (no new upload)`);
      return { how: "reused", name: want, notes, advisories };
    }
    log(`  ${pad} : not in your Handshake documents yet, uploading it`);
  }

  const fileIn = page.locator(`[data-wd-slot="${slot}-file"]`);
  if (!(await fileIn.count().catch(() => 0))) {
    notes.push(`the ${label} slot has no file input - attach by hand: ${filePath}`);
    return { how: "failed", name: want, notes, advisories };
  }

  let ok = true;
  await fileIn.first().setInputFiles(filePath).catch(() => { ok = false; });
  if (!ok) {
    notes.push(`could not attach the ${label} - do it by hand: ${filePath}`);
    return { how: "failed", name: want, notes, advisories };
  }

  const settled = await waitForUpload(page);
  if (!settled) notes.push(`the ${label} was still uploading/converting after 30s - check it before submitting`);
  log(`  ${pad} : uploaded ${want}${settled ? "" : " (STILL UPLOADING)"}`);
  if (replace) {
    advisories.push(
      `a fresh copy of the ${label} was uploaded, so Handshake will have suffixed it ` +
      `"(n)". Confirm the name on the form before submitting.`
    );
  }
  return { how: "uploaded", name: want, notes, advisories };
}

/**
 * Run FILL_SCREENING, then verify what it claims to have set against the live
 * DOM and repair anything React reverted.
 *
 * `target` is a Playwright Page or Frame - apply_external.js drives this on
 * the employer's tab (a Page it opened itself), apply_watch.js and fillModal
 * drive it on the main Page. Both expose evaluate()/locator(); Page also has
 * waitForTimeout(), which Frame does not, so that is done with a plain timer
 * when the target lacks it.
 *
 * Returns the SAME {filled, skipped, unmatched} shape FILL_SCREENING always
 * returned - `attempts` is internal bookkeeping and is not passed back out.
 * A field FILL_SCREENING set and this could not keep set lands in `unmatched`
 * with the suffix "(reverted)" and is NOT counted in `filled`.
 */
async function driveScreening(target, opts) {
  const { answers = [], scope = "modal", profile = null } = opts || {};
  const res = await target.evaluate(FILL_SCREENING, { answers, scope, profile });
  const filled = (res && res.filled) || [];
  const skipped = (res && res.skipped) || [];
  const unmatched = ((res && res.unmatched) || []).slice();
  const attempts = (res && res.attempts) || [];

  if (!attempts.length) return { filled, skipped, unmatched, overrides: [] };

  const wait = (ms) => (typeof target.waitForTimeout === "function"
    ? target.waitForTimeout(ms)
    : new Promise((r) => setTimeout(r, ms)));

  await wait(300);

  const checked = await target.evaluate(VERIFY_FILLS, attempts)
    .catch(() => attempts.map((a) => ({ id: a.id, ok: true })));
  const byId = new Map(checked.map((c) => [c.id, c]));

  // attempts[i] and filled[i] are pushed together everywhere FILL_SCREENING
  // records a fill (radio, select, work-history text, plain text), so they
  // stay index-aligned - no need to match them back up by key.
  // Only a write that VERIFIED as stuck (immediately, or after the retry
  // below) is reported as an override. A write FILL_SCREENING made but React
  // reverted is not a real override - it lands in `unmatched` instead, same
  // as any other reverted fill.
  const overrides = [];
  const noteOverride = (a) => {
    if (a.overrideFrom == null) return;
    const label = a.q ? a.q.slice(0, 70) : a.key;
    overrides.push(`${label} : "${a.overrideFrom}" -> "${a.want}"`);
  };

  const finalFilled = [];
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const c = byId.get(a.id) || { ok: true };
    if (c.ok) { finalFilled.push(filled[i]); noteOverride(a); continue; }

    // One retry through Playwright's own trusted input path - a real click and
    // a real fill, not a scripted value assignment - before giving up on it.
    let recovered = false;
    try {
      const loc = target.locator('[data-wd-fill-id="' + a.id + '"]').first();
      if (await loc.count().catch(() => 0)) {
        if (a.type === "radio" || a.type === "checkbox") {
          await loc.click({ timeout: 5000 }).catch(() => {});
        } else if (a.type === "select") {
          await loc.selectOption({ value: String(a.want) }).catch(() =>
            loc.selectOption({ label: String(a.wantText || a.want) }).catch(() => {}));
        } else {
          await loc.click({ timeout: 5000 }).catch(() => {});
          await loc.fill(String(a.want), { timeout: 5000 }).catch(() => {});

          let isTypeahead = a.type === "typeahead";
          if (!isTypeahead) {
            isTypeahead = await loc.getAttribute("aria-autocomplete")
              .then((v) => v === "list").catch(() => false);
          }
          if (isTypeahead) {
            await wait(400);
            const popupOpts = target.locator('[role="listbox"] [role="option"], [role="option"], .rw-list-option');
            const n = await popupOpts.count().catch(() => 0);
            const wantLower = String(a.want).toLowerCase();
            let matchIdx = -1;
            for (let k = 0; k < n; k++) {
              const t = (await popupOpts.nth(k).innerText().catch(() => ""))
                .replace(/\s+/g, " ").trim().toLowerCase();
              if (t === wantLower || t.startsWith(wantLower) || wantLower.startsWith(t)) { matchIdx = k; break; }
            }
            if (matchIdx >= 0) await popupOpts.nth(matchIdx).click({ timeout: 3000 }).catch(() => {});
          }
        }
      }
    } catch { /* fall through to re-verify - a failed retry still gets checked */ }

    await wait(300);
    const recheck = await target.evaluate(VERIFY_FILLS, [a]).catch(() => [{ ok: false }]);
    recovered = !!(recheck && recheck[0] && recheck[0].ok);

    if (recovered) {
      finalFilled.push(filled[i]);
      noteOverride(a);
    } else {
      unmatched.push(a.key + (a.q ? ': "' + a.q.slice(0, 60) + '"' : "") + " (reverted)");
    }
  }

  return { filled: finalFilled, skipped, unmatched, overrides };
}

/**
 * Attach a file through a "click to open a dialog" upload control - the
 * pattern SuccessFactors uses for Resume/CV and Cover Letter.
 * On SuccessFactors forms: there is NO
 * input[type=file] anywhere in the initial DOM (unlike Paylocity's static
 * slots, which READ_PORTAL's hasResumeSlot/hasCoverSlot already cover). The
 * control is a `<span role="button" class="...addAttachments">` inside a
 * `.RCMFormField` whose own <label> carries the field name ("Resume/CV:",
 * "Cover Letter:"). Clicking it does NOT fire a native file chooser - it
 * opens a floating `[role="dialog"]` callout ("Select a source for your
 * file upload") with three choices: Upload from Device / Upload from
 * Dropbox / Sign in with Google. "Upload from Device" is not a button that
 * triggers a chooser either - it already IS a real (visually hidden)
 * `<input type="file" class="fileUpload">` sitting inside that popup, so
 * `setInputFiles` works on it directly with no click or filechooser event
 * needed. The `page.waitForEvent("filechooser")` path is kept as a fallback
 * FIRST attempt for any other portal using the same "click to open a
 * dialog" idiom but a genuine native chooser.
 *
 * `labelRe` matches the FIELD LABEL, not the button text, so this is not
 * vendor-specific - any portal with a same-shaped "<label>: [upload icon]"
 * pair works. Returns true only once the field's own text shows the
 * uploaded filename back - a click that opened something but never actually
 * attached (menu dismissed, wrong option, timeout) must not be reported as
 * a success.
 */
async function attachViaFileDialog(page, labelRe, filePath, log = () => {}) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const field = page
    .locator(".RCMFormField, [class*='FormField']")
    .filter({ has: page.locator("label") })
    .filter({ hasText: labelRe })
    .first();

  // The field can render a beat after the rest of the form (present
  // a few seconds later, absent at the instant right
  // after the "Apply now" hop). Poll rather than fail on the very first
  // check - a field genuinely not on this portal still resolves to 0 either
  // way, just a few seconds later.
  let fieldCount = 0;
  for (let i = 0; i < 6; i++) {
    fieldCount = await field.count().catch(() => 0);
    if (fieldCount) break;
    await page.waitForTimeout(1000);
  }
  if (!fieldCount) {
    log(`  attach   : no field labelled like ${labelRe} found on this page`);
    return false;
  }

  // Tried in priority order, NOT as one comma-joined selector: `.first()` on
  // a union picks whichever matches earliest in DOM order, and .attachmentBtn
  // is the OUTER wrapper that CONTAINS .addAttachments - it comes first in
  // the document and has no onclick of its own, so a union selector here
  // clicked a dead area of the wrapper instead of the actual icon.
  // Identical click code targeting .addAttachments directly
  // opened the upload popup every time; going through the union selector
  // clicked nothing.
  let btn = field.locator(".addAttachments").first();
  if (!(await btn.count().catch(() => 0))) {
    btn = field.locator('[role="button"][aria-label*="Opens a dialog" i]').first();
  }
  if (!(await btn.count().catch(() => 0))) {
    btn = field.locator(".attachmentBtn").first();
  }
  if (!(await btn.count().catch(() => 0))) {
    log(`  attach   : found the "${labelRe}" field but no clickable upload control inside it`);
    return false;
  }

  const fcPromise = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await btn.click({ timeout: 5000 }).catch(() => {});

  let opened = false;
  const chooser = await fcPromise;
  if (chooser) {
    opened = await chooser.setFiles(filePath).then(() => true).catch(() => false);
  } else {
    // No native chooser - the SuccessFactors "select a source" popup path.
    // Its "Upload from Device" option IS the file input, hidden but real;
    // poll for it rather than assume the popup has finished rendering.
    let input = page.locator('input.fileUpload[type="file"], [role="dialog"] input[type="file"]').last();
    for (let i = 0; i < 5; i++) {
      if (await input.count().catch(() => 0)) break;
      await page.waitForTimeout(500);
    }
    if (await input.count().catch(() => 0)) {
      opened = await input.setInputFiles(filePath).then(() => true).catch(() => false);
    } else {
      // Last resort: an input[type=file] the click dropped INTO the field
      // itself, for a portal shaped like this one but without the popup.
      const inField = field.locator('input[type="file"]').first();
      if (await inField.count().catch(() => 0)) {
        opened = await inField.setInputFiles(filePath).then(() => true).catch(() => false);
      }
    }
  }
  if (!opened) {
    log(`  attach   : clicked the "${labelRe}" upload control but no file chooser, upload popup, or input[type=file] ever appeared`);
    return false;
  }

  await page.waitForTimeout(2500);
  const name = path.basename(filePath);
  const txt = await field.innerText().catch(() => "");
  const shown = txt.includes(name);
  if (!shown) log(`  attach   : set the file on "${labelRe}", but "${name}" never appeared on the field - not counting it`);
  return shown;
}

/**
 * Read a portal sign-in credential out of profile_private.json's `accounts`
 * block. Returns { username, password } or null.
 *
 * Kept in the Tier-2 file (name/DOB/permanent address already live there) and
 * NEVER loaded into the screening `answers` flow, so it can only ever be typed
 * into a sign-in field by signInSuccessFactors, never into an application
 * question. A missing file or missing entry returns null, and the caller then
 * reports "no credentials configured" rather than throwing.
 */
function loadAccount(name) {
  const file = path.join(REPO_ROOT, "profile_private.json");
  if (!fs.existsSync(file)) return null;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  const a = doc && doc.accounts && doc.accounts[name];
  if (!a || !a.username || !a.password) return null;
  return { username: a.username, password: a.password };
}

/**
 * Sign in to an existing SuccessFactors candidate account before the apply
 * form is filled.
 *
 * WHY THIS EXISTS. SuccessFactors apply page embeds an
 * ACCOUNT-CREATION form (fbclc_userName / fbclc_pwd / fbclc_pwdConf / fbclc_fName
 * ...). Once an account exists - which it does, created in an earlier session -
 * submitting that guest/register form is rejected with "Account Already Exists"
 * and, worse, the rejection RE-RENDERS the page and wipes the resume/cover
 * uploads. The fix is to
 * sign in first, so the form renders in authenticated mode: no register fields,
 * uploads persist, and #fbqa_apply files against the account.
 *
 * The session lands in the persistent Chrome profile, so this only actually
 * logs in ONCE - every later req detects the already-authenticated state and
 * returns { already: true } without touching anything.
 *
 * The sign-in path:
 *   - "Already a registered user? Please sign in" is an <a onclick="openSignInModal()">.
 *   - The modal exposes visible #username + #password and a <button id="fbqa_signin">Sign In</button>.
 *   - A successful sign-in reloads the page authenticated: the "Please sign in"
 *     link and the #fbclc_pwd register field both disappear.
 *
 * Returns { found, signedIn, already, detail } - never throws. Every OTHER
 * password field on any other portal is still left untouched (see the
 * CREDENTIAL gate in FILL_SCREENING).
 */
async function signInSuccessFactors(page, creds, log = () => {}) {
  const readState = () => page.evaluate(() => {
    const body = document.body ? (document.body.innerText || "") : "";
    const link = [...document.querySelectorAll("a")]
      .some((a) => /please sign in/i.test(a.textContent || ""));
    return {
      hasSignInLink: link,
      hasRegPwd: !!document.querySelector("#fbclc_pwd"),
      hasOpenFn: typeof window.openSignInModal === "function",
      loggedIn: /\bsign ?out\b|\blog ?out\b/i.test(body),
      err: /(has not been recognized|not recognized|incorrect|invalid (?:user|password|login)|does not match our records|no account|account is locked)/i.test(body),
    };
  }).catch(() => null);

  const before = await readState();
  if (!before) return { found: false, signedIn: false, detail: "page not readable" };

  // Already authenticated, or this page simply has no SF sign-in path.
  if (before.loggedIn) return { found: true, signedIn: true, already: true, detail: "already signed in" };
  if (!before.hasSignInLink && !before.hasRegPwd && !before.hasOpenFn) {
    return { found: false, signedIn: false, detail: "no SuccessFactors sign-in on this page" };
  }
  if (!creds || !creds.username || !creds.password) {
    return { found: true, signedIn: false, detail: "sign-in is available but no credentials are configured (profile_private.json accounts.successfactors)" };
  }

  // Open the modal - the onclick handler first, the visible link as a fallback.
  await page.evaluate(() => { try { openSignInModal(); } catch (e) {} }).catch(() => {});
  const user = page.locator("#username");
  const pass = page.locator("#password");
  const modalUp = async () => {
    for (let i = 0; i < 10; i++) {
      if (await user.isVisible().catch(() => false) && await pass.isVisible().catch(() => false)) return true;
      await page.waitForTimeout(500);
    }
    return false;
  };
  let up = await modalUp();
  if (!up) {
    await page.locator("a", { hasText: /please sign in/i }).first().click({ timeout: 5000 }).catch(() => {});
    up = await modalUp();
  }
  if (!up) return { found: true, signedIn: false, detail: "could not open the sign-in modal" };

  await user.fill(creds.username, { timeout: 6000 }).catch(() => {});
  await pass.fill(creds.password, { timeout: 6000 }).catch(() => {});
  log("  signin   : entered saved credentials, clicking Sign In");
  // MUST be button#fbqa_signin, not #fbqa_signin: SF renders a HIDDEN
  // input#fbqa_signin AND the visible Sign In <button> with the SAME id, and a
  // bare #fbqa_signin resolves to the hidden input, whose click silently fails
  // (element not visible) so the login never submits and the modal just stays
  // open.
  const signBtn = page.locator("button#fbqa_signin").first();
  if (await signBtn.count().catch(() => 0)) {
    await signBtn.click({ timeout: 8000 }).catch(() => {});
  } else {
    // Fallback: the visible button whose text is exactly "Sign In".
    await page.locator("button", { hasText: /^\s*sign in\s*$/i }).first().click({ timeout: 8000 }).catch(() => {});
  }

  // The click submits and reloads the careers page authenticated. Give the
  // navigation and SF's own post-login redirect time to settle before reading.
  await page.waitForLoadState("domcontentloaded", { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(4500);

  const after = await readState();
  if (!after) return { found: true, signedIn: false, detail: "page not readable after Sign In" };
  const signedIn = !!after.loggedIn || (!after.hasSignInLink && !after.hasRegPwd);
  if (!signedIn && after.err) {
    return { found: true, signedIn: false, detail: "sign-in was rejected - bad credentials or unrecognized account" };
  }
  log(signedIn
    ? "  signin   : signed in - the apply form will render in authenticated mode"
    : "  signin   : clicked Sign In but could not confirm an authenticated session - verify by hand");
  return { found: true, signedIn, detail: signedIn ? "signed in" : "clicked Sign In, no authenticated session confirmed" };
}

/**
 * Click through SuccessFactors' "Terms of Use: Read and accept the data
 * privacy statement." requirement and confirm it cleared.
 *
 * On SuccessFactors forms:
 *   - The link is `<a id="dataPrivacyId" role="button">`. Its onclick
 *     (`validateAndOpenDpcsDialog`) silently REFUSES to open the dialog and
 *     instead prints "Terms of Use is required" if the "Country/Region of
 *     Residence" select (`#fbclc_country`) is still empty - it must already
 *     have a value (screening_answers.json's address.country fills it in the
 *     normal screening pass, which must run before this).
 *   - A real click opens a `.dialogBoxWrapper` overlay with the full privacy
 *     statement and an "Accept" button (`#dlgButton_<n>:` - the numeric
 *     suffix is not stable across page loads, so this matches on the
 *     button's TEXT, scoped to the dialog).
 *   - After Accept, the dialog closes, hidden input `#fbclc_dpcsId` gets a
 *     non-empty value, and the link's own `<td>` gains the sentence "Data
 *     privacy statement has been accepted." - that sentence is what this
 *     function checks to report success, not just "a button got clicked".
 *
 * Returns { found, accepted, detail } - never throws. `found: false` means
 * this portal has no such link (nothing to do); `accepted: false` with
 * `found: true` is a real gap, never silently swallowed.
 */
async function acceptTermsOfUse(page, log = () => {}) {
  const link = page.locator("#dataPrivacyId").first();
  if (!(await link.count().catch(() => 0))) return { found: false, accepted: false, detail: "no Terms of Use link on this page" };

  const already = await page.evaluate(() => {
    const el = document.getElementById("dataPrivacyId");
    const cell = el && el.closest("td");
    return !!(cell && /has been accepted/i.test(cell.textContent || ""));
  }).catch(() => false);
  if (already) {
    log("  terms    : data privacy statement already accepted");
    return { found: true, accepted: true, detail: "already accepted" };
  }

  await link.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  await link.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const acceptBtn = page.locator(".dialogBoxWrapper button", { hasText: /^\s*Accept\s*$/i }).first();
  const dialogOpened = await acceptBtn.count().catch(() => 0);
  if (!dialogOpened) {
    // Most likely cause: Country/Region of Residence was
    // still empty when the click fired, so validateAndOpenDpcsDialog bailed
    // out before ever opening the dialog.
    const countryVal = await page.evaluate(() => {
      const c = document.getElementById("fbclc_country");
      return c ? c.value : null;
    }).catch(() => null);
    const detail = countryVal
      ? "clicked the Terms of Use link but no Accept dialog appeared"
      : "clicked the Terms of Use link but no Accept dialog appeared - Country/Region of Residence is still empty, which blocks the dialog from opening";
    log(`  terms    : ${detail}`);
    return { found: true, accepted: false, detail };
  }

  await acceptBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const accepted = await page.evaluate(() => {
    const el = document.getElementById("dataPrivacyId");
    const cell = el && el.closest("td");
    return !!(cell && /has been accepted/i.test(cell.textContent || ""));
  }).catch(() => false);

  log(accepted
    ? "  terms    : clicked Accept - data privacy statement accepted"
    : "  terms    : clicked Accept but the page never confirmed acceptance - verify by hand");
  return { found: true, accepted, detail: accepted ? "accepted" : "clicked Accept, no confirmation text appeared" };
}

/**
 * Turn a driveScreening() result into the two collapsed summary lines you
 * actually read: how much of the REQUIRED surface got filled, and the gap
 * labels themselves, required ones first. The per-field "screen :" / "you :"
 * lines still carry the full detail - to the log FILE only, via makeLogger().
 */
function summarizeScreen(res) {
  const filled = (res && res.filled) || [];
  const unmatched = (res && res.unmatched) || [];
  const isOptional = (s) => /^demographic_voluntary\./.test(s);
  const filledOptional = filled.filter(isOptional).length;
  const filledRequired = filled.length - filledOptional;
  const isRequiredGap = (s) => /required/i.test(s);
  const requiredGaps = unmatched.filter(isRequiredGap);
  const otherGaps = unmatched.filter((s) => !isRequiredGap(s));
  const requiredTotal = filledRequired + requiredGaps.length;
  const ordered = requiredGaps.concat(otherGaps).map((s) => (s.length > 80 ? s.slice(0, 80) + "..." : s));
  const CAP = 12;
  const shown = ordered.slice(0, CAP);
  const more = ordered.length - shown.length;
  const gapLine = ordered.length
    ? "gaps: " + shown.join("; ") + (more > 0 ? "; +" + more + " more" : "")
    : "gaps: none";
  return {
    filledRequired, requiredTotal, filledOptional,
    line: `filled ${filledRequired}/${requiredTotal} required, ${filledOptional} optional`,
    gapLine,
  };
}

/**
 * Per-field lines ("filled :", "widget :", "wskip :", "gap :", "screen :",
 * "you :", "override :") are noise at the terminal but the only record that
 * shows WHAT was typed where - so they still go somewhere. This sends them to
 * the run's own .log file always, and to stdout only under --verbose;
 * everything else (the one-line summaries) goes to both.
 */
function isPerFieldLine(line) {
  const m = String(line).match(/^\s*([a-z]+)\s*:/i);
  if (!m) return false;
  return ["filled", "widget", "wskip", "gap", "screen", "you", "override"].includes(m[1].toLowerCase());
}

function makeLogger(logFile, verbose = false) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  const log = (line) => {
    const s = line === undefined ? "" : String(line);
    stream.write(s + "\n");
    if (verbose || !isPerFieldLine(s)) console.log(s);
  };
  log.filePath = logFile;
  log.end = () => stream.end();
  return log;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/**
 * What kind of apply control does this job page have?
 * Returns "native" | "external" | "none" | "already".
 */
async function probeApply(page) {
  const already = await page
    .locator('[data-hook="job-details-page"]')
    .innerText()
    .then((t) => /applied on \w+ \d+, \d{4}/i.test(t))
    .catch(() => false);
  if (already) return "already";
  const native = await page.locator(SEL.nativeApply).count().catch(() => 0);
  if (native) return "native";
  const ext = await page.locator(SEL.externalApply).count().catch(() => 0);
  if (ext) return "external";
  return "none";
}

/**
 * Fill everything the engine knows how to fill on an already-open apply modal.
 * Returns { modal, unfilled, advisories }.
 *
 * NOTHING in here clicks Submit.
 */
async function fillModal(page, opts) {
  const {
    cover = null, replaceCover = false,
    portfolio = DEFAULT_PORTFOLIO, noPortfolio = false,
    transcript = DEFAULT_TRANSCRIPT, noTranscript = false,
    noScreening = false, demographics = false,
    log = console.log,
  } = opts || {};

  const unfilled = [];
  // Things that did NOT stop the form being complete. Reported, never gating.
  const advisories = [];
  let modal = await page.evaluate(READ_MODAL).catch(() => ({ found: false }));
  if (!modal.found) {
    await page.waitForTimeout(2500);
    await dismissPromo(page);
    modal = await page.evaluate(READ_MODAL).catch(() => ({ found: false }));
  }

  // Label each slot's controls before touching any of them.
  await page.evaluate(TAG_SLOTS).catch(() => ({ found: false, slots: {} }));

  if (!modal.found) {
    unfilled.push("the apply dialog never rendered - finish this one by hand");
    return { modal, unfilled, advisories };
  }

  if (modal.mismatch) {
    // cleanGates() blocks on modal.mismatch directly. Counting it here too made
    // the "N item(s) still need attention" tally lie about the form itself.
    advisories.push("HANDSHAKE WARNS: your school year does not match what this job asks for");
  }
  if (modal.needsResume) {
    if (modal.resumeAttached) log("  resume   : default resume already attached by Handshake");
    else unfilled.push("this job wants a resume and none was pre-selected - attach one by hand");
  }

  if (modal.needsCover) {
    if (modal.coverAttached && !replaceCover) {
      log("  cover    : one is already attached to this application - left alone");
    } else if (cover && fs.existsSync(cover)) {
      const r = await attachDoc(page, cover, "cover", { replace: replaceCover, label: "cover", log });
      r.notes.forEach((n) => unfilled.push(n));
      r.advisories.forEach((a) => advisories.push(a));
    } else {
      unfilled.push("this job wants a COVER LETTER and none was passed - generate one with make_cover_letter.py");
    }
  }

  // Handshake greys out Submit until the transcript is there, so a missed
  // transcript is a dead application, not a warning.
  if (modal.needsTranscript) {
    if (modal.transcriptAttached) {
      log("  transcpt : one is already attached to this application - left alone");
    } else if (noTranscript) {
      unfilled.push("--no-transcript was passed, so the transcript slot is empty. " +
        "Handshake will likely refuse to submit until it is filled.");
    } else if (!fs.existsSync(transcript)) {
      unfilled.push(`this job wants a TRANSCRIPT and none was found at ${transcript} - attach one by hand.`);
    } else {
      const r = await attachDoc(page, transcript, "transcript", { label: "transcpt", log });
      r.notes.forEach((n) => unfilled.push(n));
      r.advisories.forEach((a) => advisories.push(a));
    }
  }

  // The third slot. Do NOT trust the employer's wording to tell you whether it
  // is optional: Example Jewelry's read "If available, photos or a portfolio" and
  // Handshake still marked the field required and greyed out Submit.
  if (modal.otherDocs) {
    const o = modal.otherDocs;
    if (o.instructions) log(`  asks for : "${o.instructions}"`);
    if (o.filled) {
      log("  other    : a document is already in the third slot - left alone");
    } else if (noPortfolio) {
      unfilled.push("--no-portfolio was passed, so the third slot is empty. Handshake may refuse to submit.");
    } else if (!fs.existsSync(portfolio)) {
      unfilled.push(`THIRD DOCUMENT SLOT and no portfolio found at ${portfolio} - attach something by hand.`);
    } else {
      const r = await attachDoc(page, portfolio, "other", { label: "other", log });
      r.notes.forEach((n) => unfilled.push(n));
      r.advisories.forEach((a) => advisories.push(a));
      if (o.instructions) {
        // The slot IS filled, so Handshake will accept the form. This is a
        // "check we sent the right thing", not a gap.
        advisories.push(`the third slot was filled with ${path.basename(portfolio)} - ` +
          `the employer asked for "${o.instructions}", so check that is what they want.`);
      }
    }
  }

  // Screening questions. Documents were never what blocked a submission -
  // every one of the five forms stopped on a question instead.
  // Runs AFTER the documents so it can skip the pickers by their data-wd-slot.
  if (!noScreening) {
    const answers = loadAnswers(demographics);
    if (!answers.length) {
      log("  screen   : no saved answers to apply");
    } else {
      const res = await driveScreening(page, { answers, scope: "modal" })
        .catch((e) => {
          unfilled.push(`the screening filler threw (${e.message}) - answer the questions by hand`);
          return null;
        });
      if (res) {
        res.filled.forEach((f) => log(`  screen   : ${f}`));
        if (!res.filled.length) log("  screen   : nothing on this form matched a saved answer");
        (res.overrides || []).forEach((o) => log(`  override : ${o}`));
        res.unmatched.forEach((u) => unfilled.push(u));
        const sum = summarizeScreen(res);
        log(sum.line);
        log(sum.gapLine);
        if (!demographics) {
          const txt = (modal.text || "").toLowerCase();
          if (/gender|ethnicity|veteran|disability/.test(txt)) {
            unfilled.push("this form has VOLUNTARY demographic questions - left blank. " +
              "Pass --demographics to fill them from screening_answers.json.");
          }
        }
      }
    }
  }

  // The modal above was read BEFORE anything was attached, so its submit state
  // is stale by now. Re-read it.
  const finalModal = await page.evaluate(READ_MODAL).catch(() => modal);
  return { modal: finalModal, unfilled, advisories };
}

/**
 * Every condition that must hold before a form may be submitted.
 * Returns the list of reasons it may NOT be - empty means clean.
 */
function cleanGates(modal, unfilled) {
  const blocked = [];
  if (!modal || !modal.found) blocked.push("the apply dialog was never read");
  else {
    if (unfilled.length) blocked.push(`${unfilled.length} item(s) still need attention`);
    if (!modal.hasSubmit) blocked.push("there is no Submit Application button on screen");
    if (modal.submitEnabled !== true) blocked.push("Submit is greyed out - Handshake still wants something");
    if (modal.blockers) blocked.push('the form shows a red "Please enter a valid response" warning');
    if (modal.mismatch) blocked.push("Handshake warns your school year does not match this job");
  }
  return blocked;
}

/**
 * Click Submit - but only with explicit opt-in and a provably clean form.
 *
 * Then VERIFY against the live page before reporting success. Every one of the
 * six applications submitted by hand was checked for the Applied
 * banner before the CSV was touched; an automated submit has to hold itself to
 * the same standard, because a CSV that says "applied" when nothing was sent is
 * worse than no automation at all.
 *
 * Returns { submitted, verified, blocked[] }.
 */
async function submitIfClean(page, modal, unfilled, opts) {
  const { allow = false, log = console.log } = opts || {};
  const blocked = cleanGates(modal, unfilled);
  if (!allow) blocked.unshift("--submit was not passed");
  if (blocked.length) return { submitted: false, verified: false, blocked };

  const btn = page.locator('button:has-text("Submit Application")').first();
  if (!(await btn.count().catch(() => 0))) {
    return { submitted: false, verified: false, blocked: ["the Submit button vanished between the check and the click"] };
  }

  log("  submit   : form is clean and --submit was passed - clicking Submit Application");
  await btn.click({ timeout: 15000 });
  await page.waitForTimeout(6000);

  // Proof, not optimism.
  const verified = await page
    .locator('[data-hook="job-details-page"]')
    .innerText()
    .then((t) => /applied on \w+ \d+, \d{4}/i.test(t))
    .catch(() => false);

  return { submitted: true, verified, blocked: [] };
}

module.exports = {
  CSV_PATH, DOCS, DEFAULT_PORTFOLIO, DEFAULT_TRANSCRIPT, DEFAULT_RESUME, ANSWERS_FILE,
  SEL, FORBIDDEN_TEXT,
  parseCsv, readCsv, rowFor, updateRow, addNote, csvCell, cleanUrl,
  loadAnswers, payLowEnd, parsePageRateLow,
  TAG_SLOTS, FILL_SCREENING, READ_MODAL, VERIFY_FILLS, driveScreening,
  summarizeScreen, isPerFieldLine, makeLogger,
  dismissPromo, waitForUpload, attachDoc, attachViaFileDialog, acceptTermsOfUse,
  loadAccount, signInSuccessFactors,
  probeApply, fillModal, cleanGates, submitIfClean,
};
