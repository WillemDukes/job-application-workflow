/**
 * handshake_scan.js — READ-ONLY Handshake job discovery.
 *
 * Browses search results and job detail pages, appends new rows to
 * applications.csv with status "found". It NEVER opens an application form
 * and NEVER submits anything.
 *
 * Session comes from the dedicated automation profile (see lib.js). Run
 * browser_setup.js once before the first scan. profile_clone.ps1 is retired.
 *
 * SELECTORS ARE REAL.
 * The mechanics they depend on live in lib.js (FILTERS, applyFilters,
 * EXTRACT_CARDS) so this script and capture_dom.js cannot drift apart.
 *
 * The important structural fact: the result cards already carry employer,
 * role, pay, employment type, location and age. The job DETAIL page carries
 * almost nothing selectable — everything is inside one `job-details-page` div
 * with styled-components class names. So the cards are the source of truth for
 * the CSV, and detail pages are opened only for the description, which Step 6
 * needs for its team/department keyword. `--no-detail` skips them entirely and
 * makes the scan a single page load.
 *
 * COMMUTE RULE (configure in profile.json location.*): a job must be within 15 minutes or 10
 * miles of your home city (profile.identity.local_address.city). A distant role is the worked
 * example of what this rejects - a strong skills match at ~25 miles. The table
 * lives in lib.js as classifyLocation.
 *
 * Cards are classified near / remote / maybe / far. `near` and `remote` are
 * kept by default; `maybe` (a distant city plus a "+ N" the card won't show) is
 * reported separately for a human to check; `far` is dropped.
 *
 * ROLE RULES, applied at card level before any detail page
 * is opened, so a rejected job costs zero page loads:
 *   - NO UNPAID JOBS. Worked example: School's "FA 26 KIN 481 Resume Assignment"
 *     (Unpaid) - a course assignment posted as a job.
 *   - NO TUTORING, unless it is assisting a School teacher. So ExampleTutoring "Virtual
 *     Tutor: Grades 3-8" is out; a School teaching/research/lab assistant, grader
 *     or SI leader is in.
 * Both live in lib.js as classifyRole(). `--allow-unpaid` and `--allow-tutoring`
 * exist for one-off overrides and are OFF by default.
 *
 * TARGET: find 10 qualifying jobs and present them. The
 * scan pages through results until it has that many, rather than stopping at
 * whatever page one happened to contain.
 *
 * Usage:
 *   node handshake_scan.js --dry-run                 # parse and print, write nothing
 *   node handshake_scan.js                           # append new rows to applications.csv
 *   node handshake_scan.js --filters ""             # unfiltered (default: part-time)
 *   node handshake_scan.js --no-detail               # cards only, no detail pages
 *   node handshake_scan.js --max 10                  # fewer detail pages than the cap
 *   node handshake_scan.js --want 10                 # how many qualifying jobs to find
 *   node handshake_scan.js --locations all           # ignore the commute rule
 *   node handshake_scan.js --allow-unpaid            # override: keep unpaid jobs
 *   node handshake_scan.js --allow-tutoring          # override: keep tutoring jobs
 *   node handshake_scan.js --allow-scam              # override: keep flagged scam jobs
 *   node handshake_scan.js --radius 25               # miles from your home city (profile.identity.local_address.city) (default 10)
 *   node handshake_scan.js --no-location             # do not anchor to a city at all
 *   node handshake_scan.js --native-only             # only jobs applyable ON Handshake
 *   node handshake_scan.js --max-pages 5             # result pages to page through
 *   node handshake_scan.js --url "<search url>"
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  launchBrowser, profileIsEmpty, checkStopConditions, halt,
  REPO_ROOT, RUNS_DIR, pause, argOf,
  FILTERS, DEFAULT_FILTERS, settle, applyFilters, applyLocation, HOME_LOCATION_OPTION, extractCards,
  classifyLocation, classifyRole, classifyScam, extractSignals, nextPage, HOME, MAX_MILES, MAX_MINUTES,
} = require("./lib");

// ---------------------------------------------------------------------------
// Caps. These keep the account safe; do not raise them casually.
// ---------------------------------------------------------------------------
// Raised from 25. The local board is ~57 jobs and a single employer alone
// posts ~18 near-identical School student-worker roles, all of them external.
// At 25 the budget was spent on those before reaching Example Park and the
// other native-apply jobs further down the list.
const MAX_JOB_PAGES = 60;
const MAX_RESULT_PAGES = 5;
const DEFAULT_WANT = 10;

const DEFAULT_SEARCH_URL = `${profile.platforms.handshake.base_url || "https://SCHOOL.joinhandshake.com"}/job-search`;

const appKey = (employer, role, url) =>
  crypto.createHash("sha256").update(`${employer}|${role}|${url}`).digest("hex").slice(0, 16);

function csvEscape(v) {
  const s = (v ?? "").toString().replace(/\r?\n/g, " ").trim();
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function readExistingKeys(csvPath) {
  if (!fs.existsSync(csvPath)) return new Set();
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).slice(1);
  return new Set(lines.filter(Boolean).map((l) => l.split(",")[0]));
}

/** One run per day, per Application_Workflow.md Step 0. */
function alreadyRanToday(csvPath, today) {
  if (!fs.existsSync(csvPath)) return false;
  return fs
    .readFileSync(csvPath, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .some((l) => l.split(",")[1] === today);
}

/**
 * The job description, read out of the detail page.
 *
 * There is no data-hook for it. The page is a stack of h3 sections ("At a
 * glance", "Job description", "What they're looking for", ...) inside
 * [data-hook="job-details-page"], so slice the text between two of them.
 */
function EXTRACT_DETAIL() {
  const root = document.querySelector('[data-hook="job-details-page"]');
  if (!root) return { ok: false, description: "", employer: "", role: "" };

  const text = root.innerText || "";
  const start = text.indexOf("Job description");
  const endMarkers = ["What they're looking for", "What your school says", "What this job offers", "About the employer"];
  let end = text.length;
  for (const m of endMarkers) {
    const i = text.indexOf(m, start + 1);
    if (i > start && i < end) end = i;
  }

  // Which apply route this job offers. "Apply" is a Handshake-native form;
  // "Apply externally" hands off to the employer's own site. Read here because
  // the detail page is already open - it costs nothing extra.
  const labels = [...root.querySelectorAll("button")]
    .map((b) => (b.getAttribute("aria-label") || b.textContent || "").replace(/\s+/g, " ").trim());
  const applyType = labels.some((l) => l === "Apply")
    ? "native"
    : labels.some((l) => /^Apply externally$/i.test(l))
    ? "external"
    : "none";

  const h1 = root.querySelector("h1");
  return {
    ok: true,
    applyType,
    role: h1 ? (h1.textContent || "").trim() : "",
    employer: "",
    description: start >= 0 ? text.slice(start + "Job description".length, end).replace(/\s+/g, " ").trim() : "",
  };
}

/**
 * Click the description's "Show more" and wait for the text to grow.
 *
 * Handshake ships the description collapsed to a 150-800 character preview.
 * Every phrase-based rule downstream - the scam check, the team/department
 * keyword Step 6 wants - was reading that stub, so most of them found nothing.
 * Measured on three live pages: 485->2024, 661->3445, 284->3307.
 *
 * SAFETY. The same [data-hook="job-details-page"] container holds TWO buttons
 * whose text and aria-label are both exactly "Apply", plus a second unlabelled
 * button whose text is "More". So this matches on aria-label STARTING WITH
 * "Show more" and nothing else, and skips any label mentioning apply. Do not
 * loosen this to a text match - "More" would hit the wrong button, and the
 * wrong button here starts a real job application.
 *
 * Fails soft: a job with no expander is still worth scanning collapsed.
 */
async function expandDescription(page) {
  const btns = page.locator('[data-hook="job-details-page"] button[aria-label^="Show more"]');
  const n = await btns.count().catch(() => 0);
  let clicked = 0;
  for (let i = 0; i < n; i++) {
    const label = (await btns.nth(i).getAttribute("aria-label").catch(() => "")) || "";
    if (/\bapply\b/i.test(label)) continue;
    const ok = await btns.nth(i).click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (ok) clicked++;
  }
  if (clicked) await page.waitForTimeout(1000);
  return clicked;
}

/** Flatten extractSignals() output into one short CSV-safe notes string. */
function signalsNote(sig) {
  return Object.entries(sig)
    .map(([k, v]) => `${k}: ${v.slice(0, 3).join(" / ")}`)
    .join("; ");
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
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const noDetail = args.includes("--no-detail");
  const searchUrl = argOf(args, "--url", DEFAULT_SEARCH_URL);
  const outCsv = argOf(args, "--out", path.join(REPO_ROOT, "applications.csv"));
  const maxPages = Math.min(Number(argOf(args, "--max", MAX_JOB_PAGES)) || MAX_JOB_PAGES, MAX_JOB_PAGES);
  const want = Number(argOf(args, "--want", DEFAULT_WANT)) || DEFAULT_WANT;
  const maxResultPages = Math.min(Number(argOf(args, "--max-pages", MAX_RESULT_PAGES)) || MAX_RESULT_PAGES, MAX_RESULT_PAGES);
  const locMode = argOf(args, "--locations", "near,remote");
  const allowUnpaid = args.includes("--allow-unpaid");
  const allowTutoring = args.includes("--allow-tutoring");
  const allowFullTime = args.includes("--allow-full-time");
  const allowHealthcare = args.includes("--allow-healthcare");
  const allowScam = args.includes("--allow-scam");
  const radiusMiles = Number(argOf(args, "--radius", "15"));
  const nearCity = argOf(args, "--near", HOME_LOCATION_OPTION);
  const noLocation = args.includes("--no-location");
  const nativeOnly = args.includes("--native-only");
  const keepVerdicts = locMode === "all" ? null : locMode.split(",").map((v) => v.trim().toLowerCase());

  const rawFilters = argOf(args, "--filters", DEFAULT_FILTERS.join(","));
  const filters =
    rawFilters === "none" ? [] : rawFilters.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = filters.filter((f) => !FILTERS[f]);
  if (unknown.length) {
    console.error(`unknown filter(s): ${unknown.join(", ")}`);
    console.error(`known: ${Object.keys(FILTERS).join(", ")} (or "none")`);
    process.exit(2);
  }

  if (profileIsEmpty()) {
    console.error("\nNo automation session yet. Run:  node browser_setup.js\n");
    process.exit(2);
  }

  const today = new Date().toISOString().slice(0, 10);
  if (!dryRun && !force && alreadyRanToday(outCsv, today)) {
    console.error(`A scan already ran today (${today}). One run per day - see Step 0.`);
    console.error("Use --force if you really mean it.");
    process.exit(1);
  }

  const existing = readExistingKeys(outCsv);
  console.log(`${existing.size} existing rows in applications.csv`);
  const { ctx, page } = await launchBrowser();
  browserCtx = ctx;
  browserCtx = ctx;

  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle(page);
    await page
      .waitForFunction(() => document.querySelectorAll('[data-hook^="job-result-card |"]').length > 0, { timeout: 25000 })
      .catch(() => {});
    await pause();

    let stop = await checkStopConditions(page);
    if (stop) {
      await halt(page, stop);
      await ctx.close();
      process.exit(1);
    }

    console.log(`\napplying filters: ${filters.join(", ") || "(none)"}`);
    const f = await applyFilters(page, filters);
    console.log(`  results: ${f.before} -> ${f.after}`);
    if (f.confirmed && f.confirmed.length) console.log(`  ticked : ${f.confirmed.join(", ")}`);
    if (filters.length && !f.listChanged) {
      console.log("  !! the list never refreshed - refusing to write rows from a stale page");
      if (!dryRun) {
        await ctx.close();
        process.exit(1);
      }
    }

    // Anchor to a city AFTER the checkboxes, so the radius applies to the
    // filtered set. Handshake defaults to 50mi, which is five times the commute
    // rule and is why distant cities kept reaching classifyLocation() at all.
    if (!noLocation) {
      console.log(`
anchoring the search to a city (default 50mi is too wide)`);
      const loc = await applyLocation(page, { option: nearCity, radiusMiles });
      if (!loc.ok) {
        console.log(`  !! location filter failed (${loc.why}) - carrying on unanchored`);
      } else {
        console.log(`  results: ${loc.before} -> ${loc.after}`);
      }
    }

    stop = await checkStopConditions(page);
    if (stop) {
      await halt(page, stop);
      await ctx.close();
      process.exit(1);
    }

    // ---- collect across result pages until we have `want` qualifying jobs ----
    if (keepVerdicts) {
      console.log(`\ncommute rule: within ${MAX_MINUTES} min or ${MAX_MILES} mi of ${HOME}`);
      console.log(`  keeping: ${keepVerdicts.join(", ")}  (want ${want})`);
    } else {
      console.log("\ncommute rule: DISABLED (--locations all)");
    }

    console.log(`role rules: unpaid ${allowUnpaid ? "ALLOWED (--allow-unpaid)" : "excluded"}, ` +
                `tutoring ${allowTutoring ? "ALLOWED (--allow-tutoring)" : "excluded unless a School assistantship"}, ` +
                `full-time ${allowFullTime ? "ALLOWED (--allow-full-time)" : "excluded unless it also offers part-time"}, ` +
                `healthcare ${allowHealthcare ? "ALLOWED (--allow-healthcare)" : "excluded (clinical titles only)"}`);
    console.log(`scam rules: ${allowScam ? "ALLOWED (--allow-scam)" : "disqualifying phrases excluded"}` +
                `, checked against the expanded description`);

    const fresh = [];
    const setAside = { maybe: [], far: [], unpaid: [], tutoring: [], fullTime: [], healthcare: [], scam: [], external: [], dup: 0 };
    let seenCards = 0;
    let pageNo = 1;

    while (pageNo <= maxResultPages) {
      const cards = await extractCards(page);
      if (!cards.length) {
        console.log(`  page ${pageNo}: zero cards - selectors may have drifted`);
        break;
      }
      seenCards += cards.length;

      const badOnes = cards.filter((c) => !c.employer || !c.role);
      if (badOnes.length) console.log(`  page ${pageNo}: ${badOnes.length} card(s) missing employer/role`);

      for (const c of cards) {
        const key = appKey(c.employer, c.role, c.url);
        if (existing.has(key)) {
          setAside.dup++;
          continue;
        }
        existing.add(key);

        const loc = classifyLocation(c.location);
        const rol = classifyRole(c);
        const row = { ...c, key, loc, rol };

        // Role rules first - they are absolute, and a rejected card should not
        // even be counted against the location buckets.
        if (rol.verdict === "unpaid" && !allowUnpaid) {
          setAside.unpaid.push(row);
          continue;
        }
        if (rol.verdict === "tutoring" && !allowTutoring) {
          setAside.tutoring.push(row);
          continue;
        }
        // Both of these were computed by classifyRole and then thrown away:
        // the full-time verdict never had a handler
        // here, so "only part-time" was enforced nowhere and full-time jobs
        // kept reaching the results. Found while adding the healthcare rule.
        if (rol.verdict === "full-time" && !allowFullTime) {
          setAside.fullTime.push(row);
          continue;
        }
        if (rol.verdict === "healthcare" && !allowHealthcare) {
          setAside.healthcare.push(row);
          continue;
        }

        if (!keepVerdicts || keepVerdicts.includes(loc.verdict)) fresh.push(row);
        else if (loc.verdict === "maybe") setAside.maybe.push(row);
        else setAside.far.push(row);
      }

      console.log(
        `  page ${pageNo}: ${cards.length} cards -> ${fresh.length} qualifying so far ` +
          `(${setAside.maybe.length} maybe, ${setAside.far.length} too far, ` +
          `${setAside.unpaid.length} unpaid, ${setAside.tutoring.length} tutoring, ` +
          `${setAside.fullTime.length} full-time, ${setAside.healthcare.length} healthcare, ${setAside.dup} dup)`
      );

      if (fresh.length >= want) break;
      if (pageNo >= maxResultPages) break;

      await pause();
      const moved = await nextPage(page);
      if (!moved) {
        console.log("  no further pages");
        break;
      }
      pageNo++;

      const s2 = await checkStopConditions(page);
      if (s2) {
        await halt(page, s2);
        break;
      }
    }

    console.log(`\nscanned ${seenCards} cards across ${pageNo} page(s)`);
    if (fresh.length < want) {
      console.log(`  only ${fresh.length} of the requested ${want} qualify - widen the filters or the radius`);
    }
    if (!fresh.length) {
      await ctx.close();
      process.exit(0);
    }
    fresh.length = Math.min(fresh.length, want);

    const rows = [];
    const budget = noDetail ? 0 : Math.min(fresh.length, maxPages);
    if (noDetail) console.log("\n--no-detail: not opening any job pages");
    else console.log(`\nopening up to ${budget} job detail pages for descriptions (cap ${MAX_JOB_PAGES})`);

    for (let i = 0; i < fresh.length; i++) {
      const c = fresh[i];
      let description = "";

      if (i < budget) {
        await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await settle(page);
        await pause();

        stop = await checkStopConditions(page);
        if (stop) {
          await halt(page, stop);
          break;
        }

        const collapsed = await page.evaluate(EXTRACT_DETAIL).catch(() => null);
        const grew = await expandDescription(page).catch(() => 0);
        const d = grew ? await page.evaluate(EXTRACT_DETAIL).catch(() => collapsed) : collapsed;
        if (!d || !d.ok) {
          console.log(`  [${i + 1}/${fresh.length}] detail page did not render: ${c.url}`);
        } else {
          description = d.description;
          c.applyType = d.applyType || "?";
          // The card and the detail page should agree. When they don't, the
          // card extractor has drifted and the row is not trustworthy.
          if (d.role && c.role && d.role.trim() !== c.role.trim()) {
            console.log(`  [${i + 1}/${fresh.length}] title mismatch: card="${c.role}" detail="${d.role}"`);
          }
        }
      }

      // Scam rules run HERE, not at card level: these phrases live in the
      // description body, so they are unreadable until the page is open and
      // expanded. Costs one page load per scam caught.
      const scam = classifyScam({ role: c.role, employer: c.employer, pay: c.pay, description });
      if (scam.verdict === "scam" && !allowScam) {
        setAside.scam.push({ ...c, scam });
        console.log(`  [${i + 1}/${fresh.length}] x ${c.employer} | ${c.role} | ${scam.note}`);
        continue;
      }

      // No detail page opened means applyType is unknown. Under --native-only an
      // unknown must be SKIPPED, not kept: letting it through silently logged 5
      // external jobs as if they had passed the check.
      if (nativeOnly && c.applyType !== "native") {
        setAside.external.push(c);
        console.log(`  [${i + 1}/${fresh.length}] - ${c.employer} | ${c.role} | applies ${c.applyType || "unknown (no detail page opened)"}, skipped`);
        continue;
      }

      const signals = extractSignals(description);
      rows.push({ ...c, description, signals, signalsNote: signalsNote(signals), scam });
      console.log(
        `  [${i + 1}/${fresh.length}] + ${c.employer} | ${c.role} | ${c.pay || "no pay"} | ` +
          `${c.location} [${c.loc.verdict}${c.loc.miles != null ? " " + c.loc.miles + "mi" : ""}]` +
          (c.applyType ? ` | apply:${c.applyType}` : "") +
          (Object.keys(signals).length ? ` | ${Object.keys(signals).join(",")}` : "")
      );
    }

    if (rows.length && !dryRun) {
      const lines = rows.map((r) =>
        [
          r.key, today, "", r.employer, r.role, "handshake", r.url, r.location, r.pay,
          "found", "", "", "", "", "", "",
          [r.employmentType && `type: ${r.employmentType}`, r.posted && `posted: ${r.posted}`,
           `commute: ${r.loc.verdict} (${r.loc.note})`,
           r.rol.note && `role: ${r.rol.note}`,
           r.tags && r.tags.length && `tags: ${r.tags.join("/")}`,
           r.applyType && `apply: ${r.applyType}`,
           r.scam && r.scam.soft.length && `check: ${r.scam.soft.join(" / ")}`,
           r.signalsNote]
            .filter(Boolean).join("; "),
        ].map(csvEscape).join(",")
      );
      fs.appendFileSync(outCsv, lines.join("\n") + "\n", "utf8");
      console.log(`\nappended ${rows.length} rows to ${outCsv}`);
    } else if (dryRun) {
      console.log(`\ndry run: ${rows.length} new rows parsed, NOTHING written`);
      console.log("");
      rows.forEach((r, i) =>
        console.log(
          `${String(i + 1).padStart(3)}. ${(r.employer || "?").slice(0, 30).padEnd(30)} | ` +
            `${(r.role || "?").slice(0, 40).padEnd(40)} | ${(r.pay || "no pay listed").padEnd(17)} | ` +
            `${(r.loc.verdict + (r.loc.miles != null ? " " + r.loc.miles + "mi" : "")).padEnd(11)} | ${r.location}` +
            (r.scam && r.scam.soft.length ? `
      ^ worth a look before applying: ${r.scam.soft.join(" / ")}` : "")
        )
      );
    } else {
      console.log("\nno new jobs");
    }

    if (setAside.maybe.length) {
      console.log(`\n${setAside.maybe.length} job(s) NOT included - the card hides locations behind "+ N":`);
      setAside.maybe.forEach((r) =>
        console.log(`   ? ${r.employer.slice(0, 30).padEnd(30)} | ${r.role.slice(0, 40).padEnd(40)} | ${r.location}`)
      );
      console.log("   Open one if the role is worth it - a hidden location could be local.");
    }
    if (setAside.far.length) {
      console.log(`\n${setAside.far.length} job(s) dropped as too far from ${HOME}.`);
    }
    if (setAside.unpaid.length) {
      console.log(`
${setAside.unpaid.length} unpaid job(s) dropped:`);
      setAside.unpaid.forEach((r) =>
        console.log(`   x ${r.employer.slice(0, 30).padEnd(30)} | ${r.role.slice(0, 40).padEnd(40)} | ${r.rol.note}`)
      );
    }
    if (setAside.scam.length) {
      console.log(`
${setAside.scam.length} job(s) dropped on disqualifying phrases in the description:`);
      setAside.scam.forEach((r) =>
        console.log(`   x ${r.employer.slice(0, 30).padEnd(30)} | ${r.role.slice(0, 40).padEnd(40)} | ${r.scam.note}`)
      );
      console.log("   --allow-scam keeps these if one looks like a false positive.");
    }
    if (setAside.fullTime.length) {
      console.log(`
${setAside.fullTime.length} full-time job(s) dropped (a posting offering part-time hours too is kept):`);
      setAside.fullTime.forEach((r) =>
        console.log(`   x ${r.employer.slice(0, 30).padEnd(30)} | ${r.role.slice(0, 40).padEnd(40)} | ${r.rol.note}`)
      );
      console.log("   --allow-full-time keeps these.");
    }
    if (setAside.healthcare.length) {
      console.log(`
${setAside.healthcare.length} clinical/direct-care job(s) dropped as out of field:`);
      setAside.healthcare.forEach((r) =>
        console.log(`   x ${r.employer.slice(0, 30).padEnd(30)} | ${r.role.slice(0, 40).padEnd(40)} | ${r.rol.note}`)
      );
      console.log("   --allow-healthcare keeps these. Non-clinical jobs at healthcare employers are NOT dropped.");
    }
    if (setAside.tutoring.length) {
      console.log(`
${setAside.tutoring.length} tutoring job(s) dropped (School assistantships are kept):`);
      setAside.tutoring.forEach((r) =>
        console.log(`   x ${r.employer.slice(0, 30).padEnd(30)} | ${r.role.slice(0, 40).padEnd(40)} | ${r.rol.note}`)
      );
    }

    console.log("\nread-only scan complete. zero applications submitted.");
  } catch (e) {
    await halt(page, `unexpected error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    process.exit(process.exitCode || 0);
  }
})();
