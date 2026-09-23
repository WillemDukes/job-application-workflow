/**
 * browser_setup.js — one-time login into the dedicated automation profile.
 *
 * Run this ONCE. It opens a Chrome window using a profile that belongs to the
 * automation and nothing else, parks it on Handshake, and waits while you
 * logs in through School SSO by hand. Chrome stores the session in that profile
 * the same way it would in any other, so every later script just finds it
 * already logged in.
 *
 * Your normal Chrome can stay open the whole time. Nothing here reads, copies,
 * or writes your real profile. No password is ever typed by a script.
 *
 * Usage:
 *   node browser_setup.js
 *   node browser_setup.js --url https://jobs.school.edu    (log into Page Up too)
 *   node browser_setup.js --stealth-login               (see below)
 *   node browser_setup.js --wait-minutes 15             (default 10)
 *
 * There is nothing to press. It polls the window and exits once you land on a
 * logged-in page, so it can be run from Claude's own shell without opening a
 * terminal for you to deal with.
 *
 * --stealth-login adds --disable-blink-features=AutomationControlled, which
 * flips navigator.webdriver to false. Use it only if Okta/Duo verification
 * fails without it. It applies to THIS script only - the scan and prep scripts
 * never conceal themselves.
 */

const { launchBrowser, profileIsEmpty, PROFILE_DIR, argOf } = require("./lib");

const DEFAULT_URL = `${profile.platforms.handshake.base_url || "https://SCHOOL.joinhandshake.com"}/`;

(async () => {
  const args = process.argv.slice(2);
  const url = argOf(args, "--url", DEFAULT_URL);
  const hideAutomation = args.includes("--stealth-login");
  const fresh = profileIsEmpty();

  console.log("");
  console.log("Automation Chrome profile");
  console.log("  location : " + PROFILE_DIR);
  console.log("  state    : " + (fresh ? "new - you'll need to log in" : "existing - checking session"));
  console.log("  webdriver: " + (hideAutomation ? "hidden (--stealth-login)" : "visible (default)"));
  console.log("");

  const { ctx, page } = await launchBrowser({ hideAutomation });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    console.error("could not reach " + url + ": " + e.message);
  }

  console.log("A Chrome window is open. In THAT window:");
  console.log("  1. Log in (School SSO, Duo, the whole thing).");
  console.log("  2. Land on the logged-in home page.");
  console.log("");
  console.log("That's it - no Enter to press, no terminal to come back to. This");
  console.log("script watches the window and finishes on its own once you're in.");
  console.log("");
  console.log("Leave the window alone otherwise - don't browse anywhere else in it.");
  console.log("");

  // Poll for a logged-in URL instead of blocking on stdin to avoid requiring extra terminal windows.
  const LOGIN_RE = /\/login|\/access\b|\/users\/sign_in|sso|shibboleth|okta|duosecurity/i;
  const deadlineMs = Number(argOf(args, "--wait-minutes", "10")) * 60 * 1000;
  const started = Date.now();
  let settledFor = 0;

  while (Date.now() - started < deadlineMs) {
    await new Promise((r) => setTimeout(r, 3000));
    let here = "";
    try {
      here = page.url();
    } catch (_) {
      console.log("\n  the Chrome window was closed - nothing saved.");
      process.exit(1);
    }
    if (!LOGIN_RE.test(here)) {
      // Require it to hold for two consecutive checks; SSO bounces through
      // several non-login redirects on the way.
      if (++settledFor >= 2) break;
    } else {
      settledFor = 0;
    }
    const secs = Math.round((Date.now() - started) / 1000);
    if (secs % 30 < 3) console.log(`  ...still waiting (${secs}s) - currently on ${here.slice(0, 70)}`);
  }

  const webdriver = await page.evaluate(() => navigator.webdriver).catch(() => "unknown");
  const finalUrl = page.url();
  const body = (await page.textContent("body").catch(() => "")) || "";
  const looksLoggedIn = !/\/login|\/access\b|\/users\/sign_in|sso|shibboleth/i.test(finalUrl);

  console.log("");
  console.log("  ended on : " + finalUrl);
  console.log("  webdriver: " + webdriver);
  console.log("  verdict  : " + (looksLoggedIn ? "looks logged in" : "STILL ON A LOGIN PAGE - session not saved"));
  if (!looksLoggedIn) {
    console.log("");
    console.log("  Re-run this script and finish the login before pressing Enter.");
    if (!hideAutomation) {
      console.log("");
      console.log("  If Okta/Duo verification itself failed rather than you running out");
      console.log("  of time, navigator.webdriver=true is the usual reason. Retry with:");
      console.log("    node browser_setup.js --stealth-login");
    }
  } else {
    console.log("");
    console.log("  Session saved. Next: node capture_dom.js");
  }
  if (/sign in|log in/i.test(body.slice(0, 2000)) && looksLoggedIn) {
    console.log("  (heads up: the page still mentions signing in - worth a second look)");
  }

  await ctx.close();
  process.exit(0);
})();
