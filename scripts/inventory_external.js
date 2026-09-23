/**
 * inventory_external.js - open external application forms and write down EXACTLY
 * what they ask, without filling or submitting anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * `apply_batch.js --external-only` reports gaps as short labels scraped mid-run
 * ("countryunited states", "statein"). That is enough to know a run stalled and
 * useless for asking a precise question. This opens the same pages and
 * dumps every field with its real label, type, required flag and - for selects -
 * the actual option list, so the follow-up question can be
 * "city or county?" instead of "what about county?".
 *
 * WHAT IT WILL NOT DO
 * -------------------
 *   - Fill anything. It reads the DOM and leaves the form untouched.
 *   - Click Submit, Apply, Next Step, or any button at all.
 *   - Touch Handshake. It works from URLs already discovered, so it can never
 *     spend an "Apply externally" mark.
 *
 * IT LEAVES CHROME OPEN when done. --hold 0 exits immediately instead.
 *
 * USAGE
 *   node scripts/inventory_external.js                     # every target below
 *   node scripts/inventory_external.js --only example-corp
 *   node scripts/inventory_external.js --hold 0            # dump and exit
 */
const fs = require("fs");
const path = require("path");
const { launchBrowser, settle, argOf, RUNS_DIR } = require(path.join(__dirname, "lib.js"));

/** URLs discovered by external run. No Handshake round trip. */
const TARGETS = [
  { id: "example-corp", employer: "Example Corp", ats: "Paylocity", url: "https://example-ats.com/job/123" },
  { id: "example-group", employer: "Example Group", ats: "unknown", url: "https://example.com/careers" },
];

/**
 * Read every answerable control on the page.
 *
 * Label resolution walks the same ladder FILL_SCREENING uses, and for the same
 * reason: a field's OWN label only, never a sweep of preceding siblings. The
 * sweep is what once matched an availability radio to a location answer.
 */
const DUMP_FIELDS = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };

  const labelFor = (el) => {
    const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (byFor && byFor.innerText.trim()) return byFor.innerText.trim();
    const ariaBy = el.getAttribute("aria-labelledby");
    if (ariaBy) {
      const t = ariaBy.split(/\s+/).map((i) => document.getElementById(i)).filter(Boolean)
        .map((n) => n.innerText.trim()).join(" ").trim();
      if (t) return t;
    }
    const wrap = el.closest("label");
    if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return ph.trim();
    // ONE nearest preceding text block, never a multi-sibling sweep.
    let n = el.parentElement;
    for (let d = 0; d < 3 && n; d++, n = n.parentElement) {
      const t = Array.from(n.childNodes)
        .filter((x) => x.nodeType === 3).map((x) => x.textContent.trim())
        .filter(Boolean).join(" ");
      if (t) return t;
    }
    return "";
  };

  const out = [];
  const radioSeen = new Set();
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const type = (el.type || el.tagName).toLowerCase();
    if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;
    if (!vis(el)) continue;

    if (type === "radio") {
      if (!el.name || radioSeen.has(el.name)) continue;
      radioSeen.add(el.name);
      const group = Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`));
      out.push({
        kind: "radio", name: el.name, label: labelFor(el),
        required: group.some((g) => g.required || g.getAttribute("aria-required") === "true"),
        options: group.map((g) => labelFor(g) || g.value).filter(Boolean),
      });
      continue;
    }

    const label = labelFor(el);
    const rec = {
      kind: type, name: el.name || el.id || "", label,
      required: !!(el.required || el.getAttribute("aria-required") === "true" || /\(required\)|\*\s*$/i.test(label)),
      filled: !!(el.value && String(el.value).trim()),
    };
    if (el.tagName.toLowerCase() === "select") {
      rec.options = Array.from(el.options).map((o) => o.text.trim()).filter((t) => t && t !== "--");
    }
    out.push(rec);
  }
  return { url: location.href, title: document.title, fields: out };
};

async function main() {
  const args = process.argv.slice(2);
  const only = (argOf(args, "--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const hold = Number(argOf(args, "--hold", "45"));
  const targets = only.length ? TARGETS.filter((t) => only.includes(t.id)) : TARGETS;

  const { ctx, page } = await launchBrowser();
  const report = [];

  for (const t of targets) {
    console.log("\n" + "-".repeat(62));
    console.log(`${t.employer} (${t.ats})`);
    console.log(t.url);
    try {
      await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await settle(page);
      const dump = await page.evaluate(DUMP_FIELDS);
      const shot = path.join(RUNS_DIR, `inv_${t.id}_${new Date().toISOString().slice(0, 10)}.png`);
      await page.screenshot({ path: shot, fullPage: true });

      const answerable = dump.fields.filter((f) => f.kind !== "checkbox" || f.required);
      console.log(`  landed: ${dump.url}`);
      console.log(`  ${dump.fields.length} field(s), ${dump.fields.filter((f) => f.required).length} required`);
      for (const f of answerable) {
        const req = f.required ? "REQUIRED" : "optional";
        const opts = f.options && f.options.length ? `  [${f.options.slice(0, 8).join(" | ")}${f.options.length > 8 ? " ..." : ""}]` : "";
        console.log(`    - (${f.kind}, ${req}) ${f.label || "(no label)"}${opts}`);
      }
      report.push({ ...t, landed: dump.url, pageTitle: dump.title, screenshot: shot, fields: dump.fields });
    } catch (e) {
      console.log(`  FAILED: ${e.message.split("\n")[0]}`);
      report.push({ ...t, error: e.message.split("\n")[0] });
    }
  }

  const outFile = path.join(RUNS_DIR, `inventory_${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outFile}`);

  if (hold > 0) {
    console.log(`\nChrome stays open for ${hold} min. Nothing was filled or submitted.`);
    await page.waitForTimeout(hold * 60 * 1000);
  }
  await ctx.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
