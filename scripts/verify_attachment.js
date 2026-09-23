/**
 * verify_attachment.js - prove a Gmail draft's attachment is byte-identical to
 * the file on disk.
 *
 * WHY THIS IS NOT DONE IN THE CHAT
 * -------------------------------
 * The Gmail connector accepts attachments only as inline base64, which means the
 * model retypes ~20,000 characters per file. Previously that relay corrupted
 * two documents and NOTHING caught it - the draft created cleanly and the API
 * returns no attachment bytes to compare against. Reading the draft back through
 * the same chat channel does not fix it either: the check would run through the
 * very relay it is meant to audit.
 *
 * So the bytes come back through the browser instead. Playwright downloads the
 * attachment straight to disk, and the hash comparison happens locally. No model
 * relay on the verification path.
 *
 * READ-ONLY. It opens a draft and downloads a file. It never sends, edits or
 * deletes anything - there is no code here that could.
 *
 * USAGE
 *   node scripts/verify_attachment.js --subject "Park Ranger I application" \
 *        --expect "Documents that will be uploaded/Resume.docx"
 *   (--expect may be repeated; each is matched by basename.)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { launchBrowser, REPO_ROOT, argOf, sleep } = require(path.join(__dirname, "lib.js"));

const OUT = path.join(REPO_ROOT, "runs", "attachment_check");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  const args = process.argv.slice(2);
  const subject = argOf(args, "--subject");
  const expects = args.filter((a, i) => args[i - 1] === "--expect");
  if (!subject || !expects.length) {
    console.error('need --subject "..." and at least one --expect <path>');
    process.exit(2);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const { ctx, page } = await launchBrowser();

  try {
    await page.goto("https://mail.google.com/mail/u/0/#drafts", { waitUntil: "domcontentloaded", timeout: 60000 });
    const ready = await page
      .waitForFunction(() => !!document.querySelector('[gh="cm"]'), null, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      console.error("not signed into Gmail in the automation profile - run: node scripts/make_draft.js --login");
      process.exit(2);
    }

    await sleep(2500);
    // Open the draft by its subject text.
    const row = page.locator(`tr:has-text(${JSON.stringify(subject)})`).first();
    if (!(await row.count())) {
      console.error(`no draft found whose row contains: ${subject}`);
      process.exit(1);
    }
    await row.click();
    await sleep(4000);

    let pass = 0, fail = 0;
    for (const want of expects) {
      const base = path.basename(want);
      const onDisk = path.isAbsolute(want) ? want : path.join(REPO_ROOT, want);
      if (!fs.existsSync(onDisk)) {
        console.log(`SKIP  ${base} - no such file on disk: ${onDisk}`);
        fail++;
        continue;
      }

      // Gmail exposes a download control per attachment chip. Hover the chip
      // first: the button only renders on hover in the compose/draft view.
      const chip = page.locator(`[aria-label*=${JSON.stringify(base)}], div:has-text(${JSON.stringify(base)})`).last();
      await chip.hover().catch(() => {});
      await sleep(800);

      const dl = page.locator('[aria-label^="Download"], [data-tooltip^="Download"]').first();
      if (!(await dl.count())) {
        console.log(`FAIL  ${base} - no download control found next to the attachment`);
        fail++;
        continue;
      }

      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
        dl.click().catch(() => {}),
      ]);
      if (!download) {
        console.log(`FAIL  ${base} - the download never started`);
        fail++;
        continue;
      }

      const saved = path.join(OUT, base);
      await download.saveAs(saved);

      const a = sha(fs.readFileSync(onDisk));
      const b = sha(fs.readFileSync(saved));
      const sizeA = fs.statSync(onDisk).size;
      const sizeB = fs.statSync(saved).size;
      console.log(`${a === b ? "MATCH" : "MISMATCH"}  ${base}`);
      console.log(`   disk  : ${sizeA} bytes  ${a}`);
      console.log(`   gmail : ${sizeB} bytes  ${b}`);
      a === b ? pass++ : fail++;
    }

    console.log(`\n${pass} matched, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  } finally {
    await ctx.close();
  }
})();
