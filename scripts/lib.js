/**
 * lib.js — shared plumbing for the job-application scripts.
 *
 * Two things live here that used to be copy-pasted into every script:
 * where the browser session lives, and the halt conditions.
 *
 * SESSION MODEL:
 *   The old model cloned the Chrome profile with profile_clone.ps1.
 *   That required closing Chrome on every run and, on Chrome 127+, the
 *   app-bound cookie encryption makes the copy undecryptable anyway.
 *
 *   The new model is a dedicated Chrome profile that is logged into ONCE,
 *   by hand, via browser_setup.js. Chrome keeps the session there like any
 *   other profile. The primary profile is never read, copied, or opened.
 *
 *   The profile lives OUTSIDE the Obsidian vault on purpose — a Chrome
 *   profile is thousands of files and has no business being synced or
 *   indexed by a notes app.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Everything the automation installs or stores, kept out of the vault. */
const { ROOT, profile, profilePrivate, paths, BROWSER_PROFILE_DIR, validateProfile } = require('./config');
const PROFILE_DIR = BROWSER_PROFILE_DIR;

/** Root folder for anything the automation installs/stores outside the repo. */
const APP_HOME = process.env.JOB_AUTOMATION_HOME || path.join(os.homedir(), '.job-automation');

/** The repo folder this script lives in. */
const REPO_ROOT = ROOT;

const RUNS_DIR = paths.runs;

/**
 * Playwright may be installed in APP_HOME rather than beside the scripts,
 * so that npm never writes node_modules into the vault.
 */
function requirePlaywright() {
  try {
    return require("playwright");
  } catch (_) {}
  // JobAutomation node_modules: global or local install.
  const globalRoot = process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "playwright") : null;
  for (const fallback of [path.join(APP_HOME, "node_modules", "playwright"), globalRoot].filter(Boolean)) {
    try {
      return require(fallback);
    } catch (_) {}
  }
  console.error(
    [
      "",
      "Playwright is not installed.",
      "",
      "Run this once in PowerShell:",
      `  mkdir "${APP_HOME}" -Force`,
      `  cd "${APP_HOME}"`,
      "  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
      "  npm init -y",
      "  npm install playwright",
      "",
      "The browser download is skipped on purpose: these scripts drive your",
      "real installed Chrome (channel: 'chrome'), not a bundled Chromium.",
      "",
    ].join("\n")
  );
  process.exit(2);
}

const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Randomised gap between navigations. Human cadence, not evasion. */
const pause = () => sleep(rand(400, 1400));

/**
 * Launch the dedicated profile.
 *
 * By default there is no --disable-blink-features=AutomationControlled here.
 * Concealment is disabled by default: the scripts stay inside sane limits
 * rather than hiding that they are scripts. The scan and prep scripts must
 * never pass hideAutomation.
 *
 * hideAutomation is an escape hatch for ONE case: the one-time School SSO login
 * in browser_setup.js. Okta's device check reads navigator.webdriver, and a
 * true value can fail the verification step. That is
 * logging into the university account by hand, not a script
 * pretending to be a human on someone else's site, so the flag is scoped to
 * that script alone and is opt-in even there.
 */
async function launchBrowser({ profileDir = PROFILE_DIR, hideAutomation = false } = {}) {
  const { chromium } = requirePlaywright();
  fs.mkdirSync(profileDir, { recursive: true });
  const args = ["--no-first-run", "--no-default-browser-check"];
  if (hideAutomation) args.push("--disable-blink-features=AutomationControlled");
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false, // always headed: watch execution, and finish by hand if needed
    viewport: { width: 1440, height: 900 },
    args,
    ignoreDefaultArgs: hideAutomation ? ["--enable-automation"] : undefined,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

/** True when the dedicated profile has never been logged in. */
function profileIsEmpty(profileDir = PROFILE_DIR) {
  return !fs.existsSync(path.join(profileDir, "Default", "Network", "Cookies"));
}

/**
 * Halt conditions. Any one of these ends the run — no retries, no backoff.
 * Retrying into a bot check is how an account gets flagged.
 */
const APPLY_FORM_SELECTOR = '[data-hook="apply-modal"], form[action*="applications"]';

async function checkStopConditions(page, { host = "joinhandshake.com", allowApplyForm = false } = {}) {
  const url = page.url();
  if (!new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(url)) return `redirected off ${host} -> ${url}`;
  if (/\/login|\/access\b|\/users\/sign_in|sso|shibboleth/i.test(url)) return "forced re-login";
  const body = (await page.textContent("body").catch(() => "")) || "";
  if (/unusual activity|are you a robot|verify you are human|rate limit/i.test(body))
    return "bot-check or rate-limit interstitial";
  if (!allowApplyForm && (await page.$(APPLY_FORM_SELECTOR)))
    return "an application form is open - a read-only script must never reach one";
  return null;
}

async function halt(page, reason, runsDir = RUNS_DIR) {
  fs.mkdirSync(runsDir, { recursive: true });
  const shot = path.join(runsDir, `halt_${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  console.error(`\nHALT: ${reason}`);
  console.error(`screenshot: ${shot}`);
  console.error("Not retrying. Report error before running again.");
}

const argOf = (args, name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};





// ---------------------------------------------------------------------------
// Role rules.
//
//   1. No unpaid jobs. The worked example is School's "FA 26 KIN 481 Resume
//      Assignment" (Unpaid) - a course assignment posted as a job, which is not
//      employment at all.
//   2. No tutoring jobs, UNLESS the role is assisting a School teacher. So
//      ExampleTutoring "Virtual Tutor: Grades 3-8" is out, while a School teaching
//      assistant, research assistant, lab assistant or SI leader is in - even
//      though that work also involves teaching students.
//
// Both are applied at CARD level, before any detail page is opened, so a
// rejected job costs zero page loads.
// ---------------------------------------------------------------------------

/** Explicitly unpaid. Absent pay is NOT the same thing - see classifyRole. */
const UNPAID_RE = /\bunpaid\b|\bvolunteer\b|\bno pay\b|\bnon[- ]?paid\b|^\s*\$?0(\.00)?\s*(\/|per)?/i;

// Part-time-only rule. FULLTIME_RE is matched against the
// employment type and title ONLY, never the description - a part-time posting
// that happens to mention "full-time staff" in its blurb is not a full-time job.
// PARTTIME_RE is the carve-out and IS matched against the description too, so
// any posting that offers part-time hours anywhere survives.
const FULLTIME_RE = /\bfull[- ]?time\b|\bfulltime\b|\bFT\b/i;
const PARTTIME_RE = /\bpart[- ]?time\b|\bparttime\b|\bPT\b|\bseasonal\b|\bstudent worker\b|\bintern(ship)?\b/i;

// skip clinical / direct-care roles; edit or remove for healthcare applicants
//
// Matched against the TITLE and employment type ONLY, deliberately. The rule is
// about the WORK being clinical, not about the employer being in healthcare: a
// retirement community also hires several unrelated roles,
// and matching the description would throw all of those away too. A clinical
// role says so in its title.
//
// "Resident Assistant" is left out on purpose - at School that is a dorm job.
const HEALTHCARE_RE =
  /\bC\.?N\.?A\.?\b|\bcertified nursing assistant\b|\bnurs(?:e|es|ing)\b|\bRN\b|\bLPN\b|\bBSN\b|\bmed(?:ication)? aide\b|\bcare ?giver\b|\bhome health\b|\bhealth aide\b|\bHHA\b|\bpatient care\b|\bmedical assistant\b|\bphlebotom\w*|\bhospice\b|\bdirect support professional\b|\bDSP\b|\bpersonal care (?:aide|assistant|attendant)\b|\bclinical\b|\bdementia\b|\bassisted living\b/i;

/** Tutoring-shaped work. */
const TUTORING_RE =
  /\btutor(?:s|ing|ed|ial)?\b|\btest prep\b|\b(?:sat|act|gre|gmat|lsat|mcat)\s*prep\b|\bexam prep\b|\bhomework help\b|\bacademic coach(?:ing)?\b/i;

/** School as the employer. */
const SCHOOL_EMPLOYER_RE = new RegExp(`\b${profile.identity.school.toLowerCase()}\b`, "i");

/**
 * The exception to the tutoring ban: assisting a School teacher.
 * Covers the several names School uses for the same thing.
 */
const SCHOOL_ASSISTANT_RE =
  /\b(?:teaching|research|lab(?:oratory)?|course|instructional|graduate|undergraduate|learning|faculty|classroom|studio)\s+assistant\b|\bassistant\s+to\s+(?:a\s+|the\s+)?(?:professor|instructor|faculty|teacher)\b|\bT\.?A\.?\b|\bsupplemental instruction\b|\bSI leader\b|\bgrader\b|\bpreceptor\b/i;

/**
 * Decide whether a job survives the role rules.
 *
 * Checks the card's own fields first, then the description if one was fetched.
 *
 * Returns { verdict, note } where verdict is:
 *   ok           - keep it
 *   unpaid       - explicitly unpaid, drop
 *   tutoring     - tutoring and NOT a School assistantship, drop
 *   pay-unknown  - no pay printed at all. KEPT, but flagged: absent pay is not
 *                  evidence of unpaid, and dropping these would lose real jobs.
 */
function classifyRole({ role = "", employer = "", pay = "", employmentType = "", description = "" } = {}) {
  const roleText = `${role} ${employmentType}`.trim();
  const haystack = `${role} ${employmentType} ${description}`.trim();

  // 1. Unpaid. Pay is the authoritative field; the description is a backstop
  //    for "This is an unpaid position" where the card printed nothing.
  if (UNPAID_RE.test(pay) || (!pay && UNPAID_RE.test(description))) {
    return { verdict: "unpaid", note: `pay reads ${JSON.stringify(pay || "(none)")}` };
  }

  // 2. Tutoring, with the School-assistant carve-out.
  if (TUTORING_RE.test(haystack)) {
    const isSchool = SCHOOL_EMPLOYER_RE.test(employer) || SCHOOL_EMPLOYER_RE.test(description);
    const isAssistant = SCHOOL_ASSISTANT_RE.test(roleText) || SCHOOL_ASSISTANT_RE.test(description);
    if (isSchool && isAssistant) {
      return { verdict: "ok", note: "tutoring-adjacent but a School assistantship - kept" };
    }
    return {
      verdict: "tutoring",
      note: isSchool ? "School tutoring but not an assistantship" : "tutoring, not a School assistantship",
    };
  }

  // 3. Full-time filter for part-time only configuration.
  //
  //    The carve-out matters as much as the rule: a posting that offers BOTH
  //    stays. "CNA - Full-Time, Part Time" at Example Retirement Community is one job ad
  //    covering two shift patterns, and rejecting it would throw away a
  //    part-time job over a word in the title.
  if (FULLTIME_RE.test(roleText) && !PARTTIME_RE.test(haystack)) {
    return { verdict: "full-time", note: `employment type reads ${JSON.stringify(employmentType || role)}` };
  }

  // 4. Clinical / direct-care work - out of field. Title only; see HEALTHCARE_RE.
  if (HEALTHCARE_RE.test(roleText)) {
    return { verdict: "healthcare", note: `title reads ${JSON.stringify(role)} - clinical work, out of field` };
  }

  if (!pay) return { verdict: "pay-unknown", note: "no pay printed - kept, but check it" };

  return { verdict: "ok", note: "" };
}

// ---------------------------------------------------------------------------
// Scam / bad-faith posting rules.
//
// These patterns existed since the first version as KEYWORDS.redFlags, but
// nothing ever read them: extractSignals() dropped the hits into a CSV notes
// column and no job was ever rejected for one.
//
// Split into two severities on purpose:
//
//   HARD - the posting states something that disqualifies it outright. There is
//          no honest part-time student job that is commission-only, charges for
//          its own training, or asks for a bank routing number up front.
//
//   SOFT - suspicious, but with legitimate uses. NEVER auto-rejects. It is
//          surfaced next to the job so it can be judged, because the cost of
//          a false positive here is silently losing a real job and never
//          knowing - which is worse than showing him one bad row.
//
// "will train" / "no experience necessary" are deliberately in NEITHER list.
// See KEYWORDS.lowBarrier for why.
// ---------------------------------------------------------------------------

/**
 * Disqualifying on sight.
 *
 * Note that unpaid/volunteer are NOT here even though the original redFlags
 * list had them: classifyRole() owns that rule via UNPAID_RE, and duplicating
 * it here would report the same job under two different verdicts.
 */
const SCAM_HARD_RE = [
  /\b(?:commission[- ]only|100%\s*commission|straight commission)\b/i,
  /\b(?:door[- ]to[- ]door|cold call(?:ing)?)\b/i,
  /\b(?:must (?:recruit|purchase)|start[- ]?up (?:fee|cost)|registration fee|pay for (?:your own )?training|purchase (?:your own )?(?:kit|starter))\b/i,
  /\b(?:multi[- ]level|\bmlm\b|pyramid|independent contractor 1099 only)\b/i,
  // Solicitation, not mention. A bank teller job legitimately says "bank
  // account"; a scam asks you to SEND one. The verb is the whole signal.
  /\b(?:send|provide|share|submit|enter|give|email|text|need|require|verify|confirm)\b[^.]{0,40}\byour\b[^.]{0,25}\b(?:ssn|social security number|bank (?:account|routing)|routing number)\b/i,
  /\b(?:ssn|social security number|bank (?:account|routing) number|routing number)\b[^.]{0,40}\b(?:to (?:begin|start|apply|onboard)|before (?:you )?start|up front|upfront)\b/i,
  /\b(?:unlimited earning potential|be your own boss|financial freedom)\b/i,
];

/** Worth a second look, never an automatic drop. */
const SCAM_SOFT_RE = [
  /\b(?:quick|easy|fast)\s+(?:money|cash)\b/i,
  /\b(?:work from home|remote)\b[^.]{0,40}\b(?:no experience|any schedule|whenever you want)\b/i,
  /\b(?:daily|weekly)\s+(?:pay|cash)\b/i,
  /\b(?:text|whatsapp|telegram)\b[^.]{0,30}\b(?:to apply|for details|the number)\b/i,
  /\b(?:personal assistant|package (?:handler|forwarding)|mystery shopper|reshipp?ing)\b/i,
  // A 1099 student job means no withholding, no hourly floor, and no employer
  // paying half the payroll tax. Legitimate ones exist, so this only flags.
  /\b(?:independent contractor|1099)\b/i,
];

/**
 * Decide whether a posting is disqualifying or merely worth flagging.
 *
 * Unlike classifyRole(), this runs AFTER the detail page is fetched, because
 * these phrases live in the description body and almost never in a job title.
 * That ordering means a scam costs one page load before it is caught - which is
 * the price of catching it at all.
 *
 * Returns { verdict, hard, soft, note } where verdict is:
 *   ok    - keep it (soft[] may still be non-empty; show them in output)
 *   scam  - drop it, hard[] says which rules fired
 */
function classifyScam({ role = "", employer = "", pay = "", description = "" } = {}) {
  const body = `${role} ${employer} ${description}`.replace(/\s+/g, " ").trim();
  const hits = (list) =>
    list.map((re) => (body.match(re) || [])[0]).filter(Boolean).map((h) => h.trim().slice(0, 40));

  const hard = hits(SCAM_HARD_RE);
  const soft = hits(SCAM_SOFT_RE);

  // Contract work with no rate printed is the combination that actually costs
  // a student money. Either alone is ordinary; together they are worth saying
  // out loud, so this upgrades the wording rather than adding a new rule.
  if (!pay && /\b(?:independent contractor|1099)\b/i.test(body)) {
    soft.push("1099 contract work with no pay rate stated");
  }

  if (hard.length) {
    return { verdict: "scam", hard, soft, note: `disqualifying: ${hard.join(" / ")}` };
  }
  return { verdict: "ok", hard, soft, note: soft.length ? `check: ${soft.join(" / ")}` : "" };
}


// ---------------------------------------------------------------------------
// Description keywords.
//
// Handshake hides most of a job description behind a "Show more" button, so the
// scan only sees the first 150-800 characters. The original single regex
// (/team|department|division/) found ZERO hits across 24 jobs. These patterns
// are the replacement: a wide net cast over the short preview, grouped by what
// the hit is actually FOR.
//
// Nothing here is a guarantee the word appears - it is a list of what plausibly
// shows up in an opening paragraph. Misses are expected and fine; the point is
// that a hit is worth something.
// ---------------------------------------------------------------------------

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const certKeywords = Array.isArray(profile.certification_keywords) ? profile.certification_keywords : [];
const CERTIFICATION_RE = certKeywords.length > 0
  ? new RegExp(`\\b(?:${certKeywords.map(escapeRegex).join("|")})\\b`, "i")
  : /$^/;

const KEYWORDS = {
  // Step 6 needs a human to email. These are the phrasings that name one, or
  // name the team a search can be pointed at.
  contact: [
    // "Reports to the Department Director" - the prefix is case-insensitive but
    // the captured name must still start with a capital.
    /[Rr]eports?\s+(?:directly\s+)?to\s+(?:the\s+)?([A-Z][A-Za-z&'-]*(?:\s+[A-Z][A-Za-z&'-]*){0,4})/,
    /(?:[Ss]upervis(?:or|ed by)|[Mm]anager|[Cc]oordinator|[Dd]irector|[Pp]rincipal [Ii]nvestigator|[Hh]ead [Cc]oach)\s*[:\-]\s*([A-Z][A-Za-z&'-]*(?:\s+[A-Z][A-Za-z&'-]*){0,3})/,
    /(?:[Cc]ontact|[Ii]nquiries)\s+(?:to|at|:)\s*([A-Z][\w.&@-]*(?:\s+[A-Z][\w.&@-]*){0,3})/,
    /\b(?:hiring manager|search committee|hiring team)\b/i,
    /\b(?:[Dd]epartment|[Dd]ept\.?|[Dd]ivision|[Oo]ffice|[Pp]rogram|[Cc]ent(?:er|re)|[Uu]nit|[Bb]ranch|[Tt]eam|[Ll]ab(?:oratory)?|[Cc]linic|[Ll]ibrary|[Ss]tudio)\s+of\s+([A-Z][A-Za-z&'-]*(?:\s+(?:of|and|the|[A-Z][A-Za-z&'-]*)){0,4})/,
    // Capitalised words IMMEDIATELY before the noun, max four, so a whole
    // sentence cannot be swallowed ("The Afterschool Youth Leader supports our
    // Program Department" must yield "Program", not the whole clause).
    /\b([A-Z][A-Za-z&-]*(?:\s+[A-Z][A-Za-z&-]*){0,3})\s+(?:Department|Division|Office|Program|Center|Centre|Team|Unit|Lab|Laboratory)\b/,
  ],

  // Does it fit around class? 10-15 hrs/week is the target.
  schedule: [
    /\b(\d{1,2}\s*(?:-|to|–)\s*\d{1,2})\s*(?:hours?|hrs?)\s*(?:per|a|\/)\s*week/i,
    /\b(?:up to|about|approximately|around)\s+(\d{1,2})\s*(?:hours?|hrs?)/i,
    /\b(?:flexible|set|fixed|rotating|variable)\s+(?:schedule|hours|shifts)\b/i,
    /\b(?:mornings?|afternoons?|evenings?|nights?|weekends?|weekdays?|saturdays?|sundays?)\b/i,
    /\b(?:shift|shifts|part[- ]time|seasonal|temporary|semester|academic year|school year|summer)\b/i,
    /\b(?:work[- ]study|federal work study|fws)\b/i,
    /\b(?:start(?:ing|s)?\s+(?:date|immediately|asap|as soon as possible))\b/i,
  ],

  // Things that gate an application, or pre-requisite requirements.
  requirements: [
    CERTIFICATION_RE,
    /\b(?:driver'?s?\s+licen[cs]e|valid licen[cs]e|reliable transportation|own vehicle)\b/i,
    /\b(?:background check|drug screen|fingerprint|tb test|clearance)\b/i,
    /\b(?:must be|required to be|currently)\s+(?:a\s+)?(?:enrolled|student|18|21)\b/i,
    /\b(?:servsafe|food handler|osha|forklift|notary)\b/i,
    /\b(?:bilingual|spanish|asl)\b/i,
  ],

  // Signals it is genuinely student-friendly.
  //
  // "no experience necessary" / "will train" / "training provided" USED to sit
  // in this group and count as a plus. They are not a plus - they are the most
  // common phrasing in a real student job AND in a fake one, so reading them as
  // reassurance is exactly backwards. They moved to lowBarrier below.
  studentFit: [
    /\b(?:students? (?:are )?(?:encouraged|welcome)|current students?|undergraduate|school|student|on[- ]campus)\b/i,
    /\b(?:walk(?:ing)? distance|on the bus route|near campus|close to campus)\b/i,
    /\b(?:work[- ]study|federal work study|fws)\b/i,
  ],

  // NEUTRAL. Reported, scored neither way.
  //
  // For part-time work: nearly every job that SHOULD
  // apply to says "will train". This group exists so those words stop counting
  // as a point in the job's favour - not so they start counting against it.
  lowBarrier: [
    /\b(?:no experience (?:necessary|required)|will train|training provided|entry[- ]level)\b/i,
  ],

  // Enforced by classifyScam(). Defined above so both can share them.
  redFlags: SCAM_HARD_RE,
  softFlags: SCAM_SOFT_RE,
};

/**
 * Run every keyword group over a description and return what stuck.
 *
 * Capturing groups are returned as values (that is the team/manager name Step 6
 * wants); pattern-only matches are returned as the matched text.
 */
function extractSignals(text) {
  const body = (text || "").replace(/\s+/g, " ").trim();
  const out = {};
  if (!body) return out;

  for (const [group, patterns] of Object.entries(KEYWORDS)) {
    const hits = [];
    for (const re of patterns) {
      const m = body.match(re);
      if (!m) continue;
      const v = (m[1] || m[0] || "").trim();
      if (v && !hits.includes(v)) hits.push(v.slice(0, 60));
    }
    if (hits.length) out[group] = hits;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commute rule.
//
//   "The job has to be within 15 minutes or 10 miles of <Your City>."
//
// A distant role is the worked example of what this
// rule exists to reject: a strong skills match at ~25 miles / ~30 minutes, which
// is not a job you can hold between classes.
//
// Handshake's own location filter has a radius slider (1-100 miles, defaults to
// 50), but a result card only prints its FIRST city plus a "+ N" count, so a
// server-side radius cannot be verified from the results. This table is the
// authority; the slider is at best a pre-narrowing.
//
// Distances are approximate road miles from downtown <Your City>. Anything not
// listed is treated as FAR, which is the safe default: it under-includes rather
// than selecting distant locations.
// ---------------------------------------------------------------------------

const userCity = profile.identity?.local_address?.city;
const HOME = userCity ? `${userCity}, ${profile.identity?.local_address?.state || ""}` : "";
const DEFAULT_RADIUS_MILES = profile.location?.default_radius_miles ?? 10;
const MAX_MILES = DEFAULT_RADIUS_MILES;
const MAX_MINUTES = 15;

/** Approximate road miles from local city. */
const COMMUTE_MILES = {
  ...(userCity ? { [userCity.toLowerCase()]: 0 } : {}),
  ...(profile.location?.commute_miles || {}),
};

/**
 * Classify a Handshake card's location string.
 *
 * Real examples this has to survive:
 *   "<Your City>, <ST>"              -> near
 *   "Distant City, <ST> + 1"         -> far, but the "+ 1" is unknown
 *   "Remote"                          -> remote
 *   "Remote or Northern Region, <ST>" -> remote
 *   "Springfield, <ST> + 3"           -> far
 *
 * Returns one of:
 *   near    - inside the rule, apply to it
 *   remote  - no commute at all, so the rule's intent is satisfied
 *   maybe   - the printed city is far but the card hides other locations
 *             behind "+ N", one of which could be local. Needs a human look.
 *   far     - outside the rule
 */
function classifyLocation(raw) {
  const text = (raw || "").trim();
  if (!text) return { verdict: "maybe", miles: null, note: "no location on the card" };

  const lower = text.toLowerCase();
  const hiddenCount = Number((text.match(/\+\s*(\d+)/) || [])[1] || 0);

  // A city name anywhere in the string counts - "Remote or <Your City>, <ST>"
  // should read as near, not merely remote.
  for (const [town, miles] of Object.entries(COMMUTE_MILES)) {
    if (lower.includes(town) && miles <= MAX_MILES) {
      return {
        verdict: "near",
        miles,
        note: miles > MAX_MILES ? `${miles} mi - over ${MAX_MILES} but inside ${MAX_MINUTES} min` : `${miles} mi`,
      };
    }
  }

  if (/\bremote\b|\bvirtual\b|\bwork from home\b/.test(lower)) {
    return { verdict: "remote", miles: 0, note: "remote - no commute" };
  }

  for (const [town, miles] of Object.entries(COMMUTE_MILES)) {
    if (lower.includes(town) && miles > MAX_MILES) {
      return { verdict: hiddenCount ? "maybe" : "far", miles, note: `${town} is ~${miles} mi` };
    }
  }

  if (hiddenCount) {
    return {
      verdict: "maybe",
      miles: null,
      note: `shows a distant city plus ${hiddenCount} more - one could be local`,
    };
  }

  return { verdict: "far", miles: null, note: "not a known local town" };
}

// ---------------------------------------------------------------------------
// Handshake job-search page mechanics.
//
// All of this was established by probing the live page and is
// shared by capture_dom.js and handshake_scan.js so the two cannot drift.
//
//   - URL query params are IGNORED on load. Navigating to ?employmentTypes[]=2
//     leaves every box unticked. (Handshake does write them into the URL after
//     you apply filters, which makes them look like they work. They don't.)
//   - The checkboxes are in the DOM but invisible until "Filters" is clicked.
//   - Their `id`s are per-render UUIDs and their classes are styled-components
//     hashes (sc-xxxxx). Select on name+value and nothing else.
//   - Ticking a box moves the result count but NOT the list. The list only
//     re-fetches when the panel's Apply (type=submit) is clicked.
//   - Escape discards the whole selection.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Location filter.
//
// The search defaults to a FIFTY MILE radius, which is why distant cities
// kept arriving and being thrown away by
// classifyLocation() one card at a time. Anchoring the search to <Your City>
// and narrowing the radius does that filtering server-side instead: on the
// first live test it took the board from 30,652 results to 51.
//
// Mechanics:
//
//   - The panel button's text is exactly "Location", but Playwright's
//     `text-is("Location")` does NOT match it. Walk the DOM and compare
//     textContent yourself.
//   - The city box is `input[aria-label="Location"]`, placeholder "Search by
//     city, state, or zip code". It is a typeahead: you must click a
//     `[role="option"]`, not just type and press Enter.
//   - Match the option text EXACTLY. "<Your City>, Louisiana, United States"
//     is offered right below your state's one.
//   - The radius is an `input[type="range"]`, min 1, max 100, ONE MILE PER
//     STEP, default 50. Assigning .value through the native setter moves the
//     thumb but the applied filter stays at 50mi - it must be driven with real
//     key events (Home, then ArrowRight). Give each press ~150ms and then wait
//     ~3s: the value commits on a debounce, and reading the URL before that
//     shows the OLD distance.
// ---------------------------------------------------------------------------

/** The exact typeahead option for home. Not just "<Your City>". */
const HOME_LOCATION_OPTION = profile.location?.handshake_location_option
  || (userCity ? `${userCity}, ${profile.identity?.local_address?.state_name || profile.identity?.local_address?.state || ""}, United States` : "");

/**
 * Anchor the search to a city and narrow the radius.
 *
 * Returns { ok, before, after, radius, distance } where `distance` is read back
 * out of the URL, which is the only place Handshake states what it actually
 * applied. A caller that gets ok:false should carry on with an unanchored
 * search rather than abort - a wider search still respects classifyLocation().
 */
async function applyLocation(page, opts = {}) {
  const {
    option = HOME_LOCATION_OPTION,
    query = userCity || "",
    radiusMiles = 10,
    log = console.log,
  } = opts;

  const before = await readCount(page);

  const opened = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const b = [...document.querySelectorAll("button")].filter(vis)
      .find((x) => (x.textContent || "").replace(/\s+/g, " ").trim() === "Location");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!opened) return { ok: false, why: "no Location button on the page" };
  await page.waitForTimeout(1500);

  const box = page.locator('input[aria-label="Location"]');
  if (!(await box.count().catch(() => 0))) return { ok: false, why: "no Location input" };
  await box.first().click();
  await box.first().fill("");
  await box.first().type(query, { delay: 80 });
  await page.waitForTimeout(2500);

  const picked = await page.evaluate((want) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const o = [...document.querySelectorAll('[role="option"]')].filter(vis)
      .find((x) => (x.textContent || "").replace(/\s+/g, " ").trim() === want);
    if (!o) return false;
    o.click();
    return true;
  }, option);
  if (!picked) return { ok: false, why: `typeahead never offered "${option}"` };
  await page.waitForTimeout(2500);
  log(`  location : ${option}`);

  // Stepping needs a real pause per press: at 150ms inputValue() reports values
  // the widget has not committed, the loop exits early, and the search ends up
  // at 3mi when 10 was asked for. Step, let it settle, then CHECK the URL - the
  // URL is the only statement of what was actually applied - and correct once.
  const readDistance = () => {
    const m = decodeURIComponent(page.url()).match(/"distance":"(\d+)mi"/);
    return m ? Number(m[1]) : null;
  };

  let radius = null;
  const slider = page.locator('input[type="range"]').first();
  if (await slider.count().catch(() => 0)) {
    for (let pass = 0; pass < 2; pass++) {
      await slider.focus();
      if (pass === 0) {
        await page.keyboard.press("Home");
        await page.waitForTimeout(500);
      }
      let v = Number(await slider.inputValue());
      let guard = 0;
      while (v < radiusMiles && guard++ < 120) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(250);
        v = Number(await slider.inputValue());
      }
      while (v > radiusMiles && guard++ < 240) {
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(250);
        v = Number(await slider.inputValue());
      }
      radius = v;
      await page.waitForTimeout(3000); // commits on a debounce
      if (readDistance() === radiusMiles) break;
    }
  }

  const distance = readDistance();
  if (distance !== null) log(`  radius   : ${distance}mi`);
  if (distance !== null && distance !== radiusMiles) {
    log(`  !! asked for ${radiusMiles}mi but Handshake applied ${distance}mi`);
  }

  return { ok: true, before, after: await readCount(page), radius, distance };
}

/** Filter name -> the checkbox's stable name/value pair. */
const FILTERS = {
  "full-time": { name: "employmentTypes", value: "1", label: "Full-Time" },
  "part-time": { name: "employmentTypes", value: "2", label: "Part-Time" },
  job: { name: "jobType", value: "9", label: "Job" },
  internship: { name: "jobType", value: "3", label: "Internship" },
  "on-campus": { name: "jobType", value: "6", label: "On Campus Student Employment" },
};

/**
 * Part-Time filter configuration.
 *
 * Read the history before changing this, because the obvious edit is a trap.
 *
 * The ORIGINAL default was ["part-time", "job", "on-campus"], and it was
 * destructive: within 15 miles it cut the board from 57 jobs to 9, losing every
 * School student-worker role, the grocery-pharmacy jobs, Example Park and
 * City of <Your City>.
 *
 * The damage came from the two jobType boxes, NOT from part-time. `jobType`
 * and `employmentTypes` are orthogonal facets: ticking "Job" and "On Campus
 * Student Employment" excluded everything Handshake files under any other
 * jobType - internships above all. "Part-Time" is an employmentTypes value and
 * narrows on hours instead.
 *
 * So this is ["part-time"] alone. Do NOT re-add "job" or "on-campus".
 *
 * Known cost: a role posted as Full-Time disappears even when the employer
 * would take a student part-time, and an internship not tagged Part-Time drops
 * out too. Example Jewelry ($20-30/hr) is posted Full-Time and is exactly that case.
 * Run with `--filters ""` for an unfiltered sweep when a search looks thin.
 */
const DEFAULT_FILTERS = ["part-time"];

/**
 * Handshake is client-rendered: domcontentloaded fires against an empty shell.
 * Wait for text, not for a load event.
 */
async function settle(page, { minChars = 400, timeout = 25000, idle = 3000 } = {}) {
  // Rendered text FIRST. This is the condition that actually matters and it
  // resolves in a second or two.
  await page
    .waitForFunction((n) => document.body && document.body.innerText.trim().length > n, minChars, { timeout })
    .catch(() => {});
  // Then a SHORT networkidle budget to let late content land. Handshake keeps
  // analytics sockets open and never truly goes idle, so a long timeout here
  // is pure dead time - it cost ~25s per page on a 24-page scan before this
  // was reordered.
  await page.waitForLoadState("networkidle", { timeout: idle }).catch(() => {});
  return page.evaluate(() => (document.body ? document.body.innerText.trim().length : 0)).catch(() => 0);
}

const readCount = (page) =>
  page
    .evaluate(() => {
      const el = document.querySelector('[data-hook="results-count"]');
      return el ? el.textContent.trim() : null;
    })
    .catch(() => null);

const topCardIds = (page, n = 5) =>
  page
    .evaluate(
      (k) =>
        [...document.querySelectorAll('[data-hook^="job-result-card |"]')]
          .slice(0, k)
          .map((c) => (c.getAttribute("data-hook") || "").split("|").pop().trim()),
      n
    )
    .catch(() => []);

async function countStable(page, { tries = 12, gap = 1500 } = {}) {
  let last = await readCount(page);
  let same = 0;
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(gap);
    const now = await readCount(page);
    if (now === last) {
      if (++same >= 2) break;
    } else {
      same = 0;
      last = now;
    }
  }
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return last;
}

const panelOpen = (page) =>
  page
    .evaluate(() => {
      const el = document.querySelector('input[name="employmentTypes"][value="2"]');
      if (!el) return false;
      const lab = document.querySelector(`label[for="${el.id}"]`);
      const r = (lab || el).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .catch(() => false);

async function openFilterPanel(page) {
  if (await panelOpen(page)) return true;
  // The trigger is a plain button reading "Filters" - no data-hook, no aria-label.
  await page.getByRole("button", { name: /^filters$/i }).first().click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return panelOpen(page);
}

/**
 * Tick the requested filters and commit them.
 *
 * > DANGER: the filter panel's submit button reads "Apply". Job cards on the
 * > same page carry "Apply externally" buttons that start a real application.
 * > The click below is scoped to the filter <form> AND requires an exact-text
 * > match, and it refuses to click when the match is ambiguous. Never loosen
 * > this to a page-wide text search.
 */
async function applyFilters(page, keys, { log = console.log } = {}) {
  if (!keys || !keys.length) {
    const c = await readCount(page);
    return { applied: [], before: c, after: c, listChanged: false };
  }

  const before = await readCount(page);
  if (!(await openFilterPanel(page))) {
    log("  could not open the Filters panel - leaving the search unfiltered");
    return { applied: [], before, after: before, failed: true, listChanged: false };
  }

  const applied = [];
  for (const k of keys) {
    const f = FILTERS[k];
    if (!f) continue;
    const r = await page.evaluate((spec) => {
      const el = document.querySelector(`input[name="${spec.name}"][value="${spec.value}"]`);
      if (!el) return "missing";
      if (el.checked) return "already";
      const lab = document.querySelector(`label[for="${el.id}"]`);
      (lab || el).click();
      return "clicked";
    }, f);
    log(`  ${f.label.padEnd(30)} ${r}`);
    if (r !== "missing") applied.push(k);
    await page.waitForTimeout(900);
  }

  const form = page.locator('[data-hook="job-search-form-advanced-filters"]');
  const applyBtn = form.getByRole("button", { name: "Apply", exact: true });

  const n = await applyBtn.count();
  if (n !== 1) {
    log(`  !! expected exactly 1 filter Apply button, found ${n} - NOT clicking anything`);
    return { applied, before, after: await readCount(page), failed: true, listChanged: false };
  }
  const btnText = (await applyBtn.innerText().catch(() => "")).trim();
  if (btnText !== "Apply") {
    log(`  !! filter apply button reads ${JSON.stringify(btnText)}, refusing to click`);
    return { applied, before, after: await readCount(page), failed: true, listChanged: false };
  }

  const idsBefore = await topCardIds(page);
  log("  clicking the filter panel's Apply (scoped to the filter form)");
  await applyBtn.click({ timeout: 10000 });

  const listChanged = await page
    .waitForFunction(
      (b) => {
        const now = [...document.querySelectorAll('[data-hook^="job-result-card |"]')]
          .slice(0, b.length)
          .map((c) => (c.getAttribute("data-hook") || "").split("|").pop().trim());
        return now.length > 0 && now.join(",") !== b.join(",");
      },
      idsBefore,
      { timeout: 30000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!listChanged) log("  !! the card list never changed after Apply - treat this run as suspect");

  const after = await countStable(page);
  const confirmed = await page.evaluate(() =>
    [...document.querySelectorAll('input[name="employmentTypes"],input[name="jobType"]')]
      .filter((i) => i.checked)
      .map((i) => `${i.name}=${i.value}`)
  );

  return { applied, before, after, confirmed, listChanged };
}

/**
 * Pull the structured fields off every result card.
 *
 * The cards carry everything the CSV needs - employer, role, pay, employment
 * type, location, age - so the scan does not have to open a detail page just
 * to learn them. Detail pages are worth opening only for the description.
 *
 * Runs inside the page, so it must not close over anything.
 */
function EXTRACT_CARDS() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  return [...document.querySelectorAll('[data-hook^="job-result-card |"]')].map((card) => {
    const id = (card.getAttribute("data-hook") || "").split("|").pop().trim();

    // The avatar's alt text is the employer name, and it is the only place it
    // appears without styled-components classes wrapped around it.
    const avatar = card.querySelector("img.rosetta-entity-avatar");
    let employer = clean(avatar && avatar.getAttribute("alt"));

    // The card's region is aria-labelledby the title element's id.
    const region = card.querySelector("[aria-labelledby]");
    const titleId = region && region.getAttribute("aria-labelledby");
    const titleEl = titleId ? card.querySelector(`[id="${CSS.escape(titleId)}"]`) : null;
    const role = clean(titleEl && titleEl.textContent);

    // Pay and employment type sit in the block right after the title, inside
    // the same parent. Positional, because there is no hook for it.
    let pay = "";
    let employmentType = "";
    const sib = titleEl && titleEl.nextElementSibling;
    if (sib) {
      const parts = clean(sib.textContent).split("\u00b7").map((p) => p.replace(/\s+/g, " ").trim());
      pay = parts[0] || "";
      employmentType = parts[1] || "";
    }

    const footer = card.querySelector('[data-hook="job-result-card-footer"]');
    const foot = footer
      ? [...footer.querySelectorAll("span")].map((s) => clean(s.textContent)).filter((t) => t && t !== "\u2219")
      : [];

    if (!employer) {
      const sp = region && region.querySelector("span");
      employer = clean(sp && sp.textContent);
    }

    return {
      id,
      employer,
      role,
      pay,
      employmentType,
      location: foot[0] || "",
      posted: foot[1] || "",
      tags: [...card.querySelectorAll(".rosetta-tag-text")].map((t) => clean(t.textContent)),
      url: location.origin + "/jobs/" + id,
    };
  });
}

const extractCards = (page) => page.evaluate(EXTRACT_CARDS);

/**
 * Advance to the next page of results.
 *
 * The pagination nav is data-hook="job-search-pagination"; the control is a
 * button with aria-label "next page". Success is judged by the card ids
 * changing, never by the click resolving - the click resolves either way.
 *
 * Returns true if a genuinely new page of cards rendered.
 */
async function nextPage(page, { timeout = 30000 } = {}) {
  const before = await topCardIds(page);
  if (!before.length) return false;

  const btn = page.locator('[data-hook="job-search-pagination"] button[aria-label="next page"]');
  if (!(await btn.count())) return false;
  if (await btn.first().isDisabled().catch(() => false)) return false;

  await btn.first().click({ timeout: 10000 }).catch(() => {});

  const changed = await page
    .waitForFunction(
      (b) => {
        const now = [...document.querySelectorAll('[data-hook^="job-result-card |"]')]
          .slice(0, b.length)
          .map((c) => (c.getAttribute("data-hook") || "").split("|").pop().trim());
        return now.length > 0 && now.join(",") !== b.join(",");
      },
      before,
      { timeout }
    )
    .then(() => true)
    .catch(() => false);

  if (changed) await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  return changed;
}

module.exports = {
  APP_HOME, PROFILE_DIR, REPO_ROOT, RUNS_DIR,
  requirePlaywright, launchBrowser, profileIsEmpty,
  checkStopConditions, halt, APPLY_FORM_SELECTOR,
  rand, sleep, pause, argOf,
  FILTERS, DEFAULT_FILTERS, settle, readCount, topCardIds, countStable,
  applyLocation, HOME_LOCATION_OPTION,
  panelOpen, openFilterPanel, applyFilters, EXTRACT_CARDS, extractCards,
  HOME, MAX_MILES, MAX_MINUTES, COMMUTE_MILES, classifyLocation,
  KEYWORDS, extractSignals, nextPage,
  UNPAID_RE, TUTORING_RE, FULLTIME_RE, PARTTIME_RE, HEALTHCARE_RE, SCHOOL_EMPLOYER_RE, SCHOOL_ASSISTANT_RE, classifyRole,
  SCAM_HARD_RE, SCAM_SOFT_RE, classifyScam,
};
