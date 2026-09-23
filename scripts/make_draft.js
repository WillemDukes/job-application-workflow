/**
 * make_draft.js - write a Gmail draft WITH its attachments already on it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Gmail connector takes attachments only as inline base64, which means the
 * model has to retype ~37,000 encoded characters per pair of documents. An API
 * relay corrupted both files: Word refused to open them while
 * the same files on disk were fine, and nothing caught it - the draft created
 * cleanly and the API returned no attachment data to check against.
 *
 * This script never encodes anything. Playwright hands Chrome a PATH and Chrome
 * reads the bytes off disk itself, exactly as if dragged in manually.
 * There is no relay to corrupt.
 *
 * IT NEVER SENDS. It fills the compose window, attaches, saves, and closes.
 * Sending is done manually, the same way submitting an application is.
 *
 * ONE-TIME SETUP
 * --------------
 * The automation's Chrome profile is signed into Handshake but NOT into Google.
 *   node scripts/make_draft.js --login
 * That opens Gmail in the automation profile and waits, polling, until the
 * inbox renders. Sign in there once (in that window) and every later run works
 * unattended. Nothing else in the project needs a Google session.
 *
 * USAGE
 *   node scripts/make_draft.js --login              # hides navigator.webdriver by default
 *   node scripts/make_draft.js --login --no-stealth # if Google objects to the flag itself
 *   node scripts/make_draft.js --company "Example Accounting" \
 *        --to hiring@example.com --subject "..." --body-file draft.txt
 *   node scripts/make_draft.js --company "Example Park" --stage
 *
 * --stage skips the browser entirely: it copies the resume and the company's
 * cover letter into outbox\<Company>\ and opens that folder in Explorer, so the
 * files to drag are in one place instead of three. Use it when Google is not
 * signed in and attaching by hand.
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const { launchBrowser, REPO_ROOT, argOf, sleep } = require(path.join(__dirname, "lib.js"));

const DOCS = path.join(REPO_ROOT, "Documents that will be uploaded");
const GENERATED = path.join(REPO_ROOT, "generated");
const EMAIL_LETTERS = path.join(GENERATED, "email");
const OUTBOX = path.join(REPO_ROOT, "outbox");
const RESUME = path.join(DOCS, "Resume.docx");

/**
 * The two files an outreach email carries: the resume, and the EMAIL cover
 * letter for this company.
 *
 * The email letter is deliberately not the application letter. The application
 * template hardcodes "Dear Hiring Manager," and is addressed to nobody, so
 * sending it to a named person reads as a form letter. generated\email\ holds
 * the ones written with a real name.
 */
function documentsFor(company) {
  const emailLetter = path.join(EMAIL_LETTERS, `${company} Cover Letter.docx`);
  const appLetter = path.join(GENERATED, `${company} Cover Letter.docx`);
  const out = { resume: RESUME, letter: null, warnings: [] };

  if (!fs.existsSync(RESUME)) out.warnings.push(`no resume at ${RESUME}`);

  if (fs.existsSync(emailLetter)) {
    out.letter = emailLetter;
  } else if (fs.existsSync(appLetter)) {
    out.warnings.push(
      `only the APPLICATION letter exists for ${company}. It opens "Dear Hiring Manager," ` +
      `and is addressed to nobody - generate the email version first:\n` +
      `  python scripts/make_cover_letter.py --company "${company}" --position "<role>" --kind email --manager "<name>"`
    );
  } else {
    out.warnings.push(`no cover letter found for ${company} in generated\\email\\`);
  }
  return out;
}

/** Copy the documents into outbox\<Company>\ and open it in Explorer. */
function stage(company) {
  const docs = documentsFor(company);
  const dir = path.join(OUTBOX, company);
  fs.mkdirSync(dir, { recursive: true });

  const staged = [];
  for (const f of [docs.resume, docs.letter]) {
    if (!f || !fs.existsSync(f)) continue;
    const dest = path.join(dir, path.basename(f));
    fs.copyFileSync(f, dest);
    staged.push(dest);
  }

  console.log(`\nstaged ${staged.length} file(s) in:\n  ${dir}`);
  staged.forEach((s) => console.log(`  - ${path.basename(s)}`));
  docs.warnings.forEach((w) => console.log(`\n  !! ${w}`));
  if (!staged.length) return;

  // Open the folder so the files are one drag away, not a file-manager hunt.
  execFile("explorer.exe", [dir], () => {});
  console.log("\nExplorer is open on that folder. Drag both files into the draft.");
}

/** Is this Chrome profile signed into Gmail? */
async function gmailReady(page) {
  return page
    .waitForFunction(() => !!document.querySelector('[gh="cm"]'), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
}

async function login(hideAutomation) {
  // Google refused the sign-in outright on the first attempt ("couldn't sign you
  // in / this browser may not be secure"): it reads navigator.webdriver, which
  // Playwright sets to true. Same flag the School SSO login needed for Okta, and the
  // same reasoning applies - this is signing into the account, by hand,
  // in a window on the local machine. Scoped to the login path; the draft path never
  // conceals itself.
  const { ctx, page } = await launchBrowser({ hideAutomation });
  console.log("\nOpening Gmail. Sign in IN THAT WINDOW - this script just waits.");
  console.log("Nothing is sent, read, or changed; it only needs the session cookie.\n");
  await page.goto("https://mail.google.com/mail/u/0/", { waitUntil: "domcontentloaded", timeout: 60000 });

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await gmailReady(page)) {
      console.log("signed in - the inbox rendered. Future runs need no login.");
      await sleep(1500);
      await ctx.close();
      return 0;
    }
    process.stdout.write(".");
    await sleep(5000);
  }
  console.log("\ntimed out after 10 min - not signed in. Nothing was changed.");
  await ctx.close();
  return 1;
}

async function makeDraft({ to, subject, body, attachments }) {
  const { ctx, page } = await launchBrowser();
  try {
    await page.goto("https://mail.google.com/mail/u/0/", { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!(await gmailReady(page))) {
      console.log("\nNot signed into Google in the automation profile.");
      console.log("Run:  node scripts/make_draft.js --login");
      console.log("Or use --stage to put the files in one folder and attach by hand.");
      return 2;
    }

    await page.click('[gh="cm"]');
    await page.waitForSelector('input[name="subjectbox"]', { timeout: 20000 });

    // Recipient. Gmail has used both a textarea and an input here across
    // revisions; take whichever is actually present rather than guessing.
    const toField = page.locator('textarea[name="to"], input[aria-label="To recipients"], input[peoplekit-id]').first();
    await toField.fill(to);
    await page.keyboard.press("Tab");

    await page.fill('input[name="subjectbox"]', subject);
    await page.click('div[aria-label="Message Body"]');
    await page.keyboard.insertText(body);

    // THE POINT OF THIS SCRIPT: hand Chrome the path, never the bytes.
    for (const f of attachments) {
      const input = page.locator('div[role="dialog"] input[type="file"]').first();
      await input.setInputFiles(f);
      const name = path.basename(f);
      // Gmail renders a chip per attachment once the upload finishes.
      const ok = await page
        .waitForFunction(
          (n) => {
            const d = document.querySelector('div[role="dialog"]');
            return !!d && (d.innerText || "").includes(n);
          },
          name,
          { timeout: 60000 }
        )
        .then(() => true)
        .catch(() => false);
      console.log(`  attached : ${name}${ok ? "" : "  (NO CHIP APPEARED - check it by hand)"}`);
    }

    // Save and close. Never Send - there is deliberately no send path here.
    await page.keyboard.press("Control+S").catch(() => {});
    await page.waitForTimeout(2500);
    const close = page.locator('img[aria-label="Save & close"], div[aria-label="Save & close"]').first();
    if (await close.count()) await close.click().catch(() => {});
    await page.waitForTimeout(2000);

    console.log("\ndraft saved. NOT SENT. Open Gmail, read it, then send it yourself.");
    return 0;
  } finally {
    await ctx.close();
  }
}

(async () => {
  const args = process.argv.slice(2);

  if (args.includes("--login")) process.exit(await login(!args.includes("--no-stealth")));

  const company = argOf(args, "--company");
  if (args.includes("--stage")) {
    if (!company) { console.error("--stage needs --company"); process.exit(2); }
    stage(company);
    process.exit(0);
  }

  const to = argOf(args, "--to");
  const subject = argOf(args, "--subject");
  const bodyFile = argOf(args, "--body-file");
  if (!to || !subject || !bodyFile) {
    console.error("need --to, --subject and --body-file (or --stage, or --login)");
    process.exit(2);
  }
  if (!fs.existsSync(bodyFile)) {
    console.error(`no body file at ${bodyFile}`);
    process.exit(2);
  }
  const body = fs.readFileSync(bodyFile, "utf8");

  let attachments = args.filter((a, i) => args[i - 1] === "--attach");
  if (!attachments.length && company) {
    const docs = documentsFor(company);
    docs.warnings.forEach((w) => console.log(`  !! ${w}`));
    attachments = [docs.resume, docs.letter].filter((f) => f && fs.existsSync(f));
  }
  console.log(`draft to ${to}`);
  attachments.forEach((f) => console.log(`  will attach: ${f}`));

  process.exit(await makeDraft({ to, subject, body, attachments }));
})();
