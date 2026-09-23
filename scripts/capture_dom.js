/**
 * capture_dom.js — READ-ONLY. Harvest the real Handshake DOM so the selectors
 * in handshake_scan.js and prep_apply.js can stop being guesses.
 *
 * It opens exactly two pages and never touches an application form.
 *
 * FULLY AUTOMATED. It clicks the Filters panel open and ticks the boxes
 * itself.
 *
 * Filter mechanics:
 *   - URL query params DO NOT WORK. Navigating to ?employmentTypes[]=2 leaves
 *     every checkbox unticked and the result count unchanged (30,334). The SPA
 *     does not hydrate filters from the query string. Don't try it again.
 *   - The checkboxes exist in the DOM but are invisible until the "Filters"
 *     button is clicked.
 *   - The inputs carry stable name/value pairs. Their `id`s are per-render
 *     UUIDs and their classes are styled-components hashes (sc-xxxxx) — both
 *     change constantly. Select on name+value, nothing else.
 *   - Ticking a box updates the result count LIVE, but that count is only a
 *     preview: the card list does not re-fetch until the panel's Apply button
 *     (a type=submit at the bottom of the filter form) is clicked. Ticking
 *     three filters moved the count 30,334 -> 4,009 while the 25 rendered
 *     cards stayed byte-identical, 24 of them internships. Pressing Escape
 *     dismisses the panel and throws the selection away.
 *
 * > DANGER: the filter panel's button reads "Apply", and job cards on the same
 * > page carry "Apply externally" buttons. These are not the same thing and
 * > clicking the wrong one starts a job application. The apply step below is
 * > scoped to the filter <form> AND requires an exact-text match on "Apply",
 * > and it refuses to click anything else. Never loosen this to a page-wide
 * > text search.
 *
 * Usage:
 *   node capture_dom.js                          (default: part-time)
 *   node capture_dom.js --filters part-time,job,on-campus
 *   node capture_dom.js --filters none           (capture the unfiltered feed)
 *   node capture_dom.js --manual                 (old behaviour: you set them, press Enter)
 *   node capture_dom.js --url ${profile.platforms.handshake.base_url || "https://SCHOOL.joinhandshake.com"}/job-search
 */

const fs = require("fs");
const path = require("path");
const {
  launchBrowser, profileIsEmpty, checkStopConditions, halt, RUNS_DIR, pause, argOf,
  FILTERS, DEFAULT_FILTERS, settle, applyFilters,
} = require("./lib");

const DEFAULT_URL = `${profile.platforms.handshake.base_url || "https://SCHOOL.joinhandshake.com"}/job-search`;

// FILTERS, settle(), applyFilters() and the Apply-button safety rules now live
// in lib.js, shared with handshake_scan.js so the two cannot drift apart.

const waitForEnter = () =>
  new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });

/**
 * A structural summary small enough to paste into a chat, unlike the raw HTML.
 * data-hook is Handshake's own stable test-attribute convention, so those are
 * the selectors worth having.
 */
async function describe(page) {
  return await page.evaluate(() => {
    const tally = (attr) => {
      const out = {};
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        const v = el.getAttribute(attr);
        if (!out[v]) {
          out[v] = {
            count: 0,
            tag: el.tagName.toLowerCase(),
            sample: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90),
          };
        }
        out[v].count++;
      }
      return out;
    };

    /**
     * Job result cards are NOT anchors to /jobs/<id>. A card is a div carrying
     * data-hook="job-result-card | <id>", and the clickable element inside it
     * points at /job-search/<id>. Scraping a[href*="/jobs/"] found 7 links on
     * a page holding 25 jobs — and those 7 came from the sidebar.
     */
    const cards = [...document.querySelectorAll('[data-hook^="job-result-card |"]')].map((c) => {
      const id = (c.getAttribute("data-hook") || "").split("|").pop().trim();
      const a = c.querySelector("a[href]");
      const footer = c.querySelector('[data-hook="job-result-card-footer"]');
      const footText = footer
        ? [...footer.querySelectorAll("span")].map((s) => (s.textContent || "").trim()).filter((t) => t && t !== "∙")
        : [];
      return {
        id,
        href: a ? a.getAttribute("href") : null,
        // the anchor's aria-label is the whole card in one string:
        // "<employer> <role> <pay> · <type> <tags> <location> <age>"
        ariaLabel: a ? a.getAttribute("aria-label") : null,
        location: footText[0] || null,
        posted: footText[1] || null,
        tags: [...c.querySelectorAll(".rosetta-tag-text")].map((t) => (t.textContent || "").trim()),
      };
    });

    const links = [...document.querySelectorAll('a[href*="/jobs/"]')]
      .map((a) => a.href)
      .filter((h, i, arr) => arr.indexOf(h) === i);

    const txt = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || "").trim() : null;
    };

    return {
      url: location.href,
      title: document.title,
      dataHook: tally("data-hook"),
      dataTestId: tally("data-testid"),
      headings: [...document.querySelectorAll("h1,h2,h3")]
        .map((h) => h.tagName.toLowerCase() + ": " + (h.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90))
        .filter(Boolean)
        .slice(0, 40),
      cards,
      cardCount: cards.length,
      jobUrls: cards.map((c) => location.origin + "/jobs/" + c.id),
      resultsCount: txt('[data-hook="results-count"]'),
      checkedFilters: [...document.querySelectorAll('input[name="employmentTypes"],input[name="jobType"]')]
        .filter((i) => i.checked)
        .map((i) => `${i.name}=${i.value} (${i.getAttribute("label")})`),
      jobLinks: links.slice(0, 40),
      jobLinkCount: links.length,
      bodyChars: document.body.innerText.length,
    };
  });
}

async function capture(page, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const html = await page.content();
  fs.writeFileSync(path.join(dir, `${name}.html`), html, "utf8");
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false }).catch(() => {});
  const desc = await describe(page);
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(desc, null, 2), "utf8");
  console.log(`  saved ${name}.html (${Math.round(html.length / 1024)} KB), ${name}.png, ${name}.json`);
  return desc;
}

(async () => {
  const args = process.argv.slice(2);
  const startUrl = argOf(args, "--url", DEFAULT_URL);
  const manual = args.includes("--manual");
  const raw = argOf(args, "--filters", DEFAULT_FILTERS.join(","));
  const keys =
    raw === "none"
      ? []
      : raw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);

  const unknown = keys.filter((k) => !FILTERS[k]);
  if (unknown.length) {
    console.error(`unknown filter(s): ${unknown.join(", ")}`);
    console.error(`known: ${Object.keys(FILTERS).join(", ")} (or "none")`);
    process.exit(2);
  }

  if (profileIsEmpty()) {
    console.error("\nThe automation Chrome profile has no session yet.");
    console.error("Run this first:  node browser_setup.js\n");
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(RUNS_DIR, `capture_${stamp}`);

  const { ctx, page } = await launchBrowser();

  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
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

    if (manual) {
      console.log("\n--manual: set the filters yourself in the Chrome window, then press Enter here.\n");
      await waitForEnter();
    } else {
      console.log(`\napplying filters: ${keys.length ? keys.join(", ") : "(none)"}`);
      const r = await applyFilters(page, keys);
      console.log(`  results: ${r.before} -> ${r.after}`);
      if (r.confirmed && r.confirmed.length) console.log(`  ticked : ${r.confirmed.join(", ")}`);
      console.log(`  list refreshed: ${r.listChanged ? "yes" : "NO - suspect"}`);
    }

    stop = await checkStopConditions(page);
    if (stop) {
      await halt(page, stop);
      await ctx.close();
      process.exit(1);
    }

    console.log("\ncapturing results page...");
    await settle(page);
    const results = await capture(page, dir, "results");
    console.log(`  url        : ${results.url}`);
    console.log(`  job cards  : ${results.cardCount}`);
    console.log(`  results say: ${results.resultsCount || "(none)"}`);
    console.log(`  filters    : ${results.checkedFilters.join(", ") || "(none set)"}`);
    console.log(`  data-hooks : ${Object.keys(results.dataHook).length}`);

    // A filterless capture looks like a success and produces selectors tuned
    // to the wrong page. Say so loudly.
    if (keys.length && !results.checkedFilters.length) {
      console.log("\n  !! Filters were requested but NONE are ticked. This is the unfiltered");
      console.log("  !! feed. Do not write selectors from it.");
    }

    if (!results.cardCount) {
      console.log("\nNo job cards found. The card markup has probably changed shape again.");
      await ctx.close();
      process.exit(0);
    }

    console.log(`\nopening one job detail page: ${results.jobUrls[0]}`);
    console.log("Read-only. This script has no code path that opens an application.\n");

    await page.goto(results.jobUrls[0], { waitUntil: "domcontentloaded", timeout: 60000 });
    const detailChars = await settle(page);
    console.log(`  rendered text: ${detailChars} chars`);
    await pause();

    stop = await checkStopConditions(page);
    if (stop) {
      await halt(page, stop);
      await ctx.close();
      process.exit(1);
    }

    console.log("capturing detail page...");
    const detail = await capture(page, dir, "detail");
    console.log(`  url        : ${detail.url}`);
    console.log(`  body chars : ${detail.bodyChars}`);
    console.log(`  data-hooks : ${Object.keys(detail.dataHook).length}`);
    if (!detail.bodyChars) {
      console.log("\n  !! The detail page captured EMPTY. Do not write detail-page");
      console.log("  !! selectors from this file.");
    }

    console.log("\n" + "=".repeat(64));
    console.log("DONE - 2 pages opened, 0 applications touched, 0 rows written");
    console.log("=".repeat(64));
    console.log(`Everything landed in: ${dir}\n`);
  } catch (e) {
    await halt(page, `unexpected error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    // process.stdin.resume() keeps the event loop alive forever, so without
    // this the script hangs after printing DONE.
    process.stdin.pause();
    process.exit(process.exitCode || 0);
  }
})();
