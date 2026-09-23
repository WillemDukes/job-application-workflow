/**
 * widgets.js - drive the form controls that are not real form controls.
 *
 * FILL_SCREENING works by setting an element's value and firing input/change.
 * That is enough for <input>, <textarea> and <select>, and useless for the two
 * widget libraries Paylocity's application is built from:
 *
 *   1. react-widgets DropdownList - a <div role="combobox" class="rw-dropdownlist">
 *      showing "--". There is no value to set. It opens a listbox on click and
 *      the choice is a click on an option.
 *
 *   2. A typeahead <input aria-autocomplete="list"> inside .pcty-input-select.
 *      It looks like a text box, but the React component ignores a
 *      programmatically-set value: the selection only registers when an option
 *      from its dropdown is clicked.
 *
 * Both were reported as "a REQUIRED field has no saved answer" on every run
 * against applicant portals, which is most of what kept those applications
 * from ever being completable.
 *
 * Block-awareness is carried through from apply_core's idea of blocks, because
 * these widgets repeat per work-history entry exactly like the text fields do.
 * The values happen to coincide - local address is in <Your State> and <Employer>
 * is in <Your State> - but this must not RELY on that coincidence, so a
 * work-history widget is only touched when its block names a known employer.
 */

/**
 * Tag every widget on the page and describe it. Serialised into the browser.
 */
function TAG_WIDGETS() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const low = (s) => norm(s).toLowerCase();

  const BLOCK_WORK = /^(work history|employment history|employer)\b/;
  const BLOCK_EDU = /^(education|school)\b/;
  const blockOf = (el) => {
    let n = el && el.parentElement;
    for (let hops = 0; n && hops < 14; hops++, n = n.parentElement) {
      const t = low(n.innerText || "");
      if (BLOCK_WORK.test(t) || BLOCK_EDU.test(t)) {
        const vals = [...n.querySelectorAll("input,textarea,select")]
          .map((i) => low(i.value)).filter(Boolean).join(" ");
        return { kind: BLOCK_WORK.test(t) ? "work" : "education", text: (t + " " + vals).slice(0, 4000) };
      }
    }
    return { kind: "", text: "" };
  };

  const labelFor = (el) => {
    // react-widgets puts the question in data-for; otherwise walk to the
    // .form-group and read its <label>.
    const df = el.getAttribute && el.getAttribute("data-for");
    if (norm(df)) return norm(df);
    if (el.id) {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (l && norm(l.textContent)) return norm(l.textContent);
    }
    let n = el.parentElement;
    for (let h = 0; n && h < 6; h++, n = n.parentElement) {
      const l = n.querySelector && n.querySelector("label");
      if (l && norm(l.textContent) && norm(l.textContent).length < 160) return norm(l.textContent);
    }
    return "";
  };

  const out = [];
  let n = 0;

  // 1. react-widgets dropdown lists.
  for (const el of [...document.querySelectorAll('[role="combobox"].rw-dropdownlist, .rw-dropdownlist[role="combobox"]')].filter(vis)) {
    const shown = norm((el.querySelector(".rw-input") || {}).textContent || "");
    const b = blockOf(el);
    el.setAttribute("data-wd-w", String(n));
    out.push({ n, kind: "dropdown", label: labelFor(el), current: shown, blockKind: b.kind, blockText: b.text.slice(0, 600) });
    n++;
  }

  // 2. typeahead inputs. Their selected value is NOT input.value - it lives in
  // a sibling .input-select-input-single-value div, so reading .value made an
  // already-answered field look empty and invited a pointless refill.
  const singleValueOf = (el) => {
    let sv = null, n2 = el;
    for (let h = 0; n2 && h < 4 && !sv; h++, n2 = n2.parentElement) {
      sv = n2.querySelector && n2.querySelector(".input-select-input-single-value");
    }
    return sv ? norm(sv.textContent) : "";
  };
  for (const el of [...document.querySelectorAll('input[aria-autocomplete="list"]')].filter(vis)) {
    const b = blockOf(el);
    el.setAttribute("data-wd-w", String(n));
    out.push({
      n, kind: "typeahead", label: labelFor(el),
      current: norm(el.value) || singleValueOf(el),
      blockKind: b.kind, blockText: b.text.slice(0, 600),
    });
    n++;
  }

  // 3. SuccessFactors "paginated picklist" comboboxes - the widget behind
  // every SF dropdown on the form (Country, State/Province, Preferred
  // Language, opt-in-to-text, worked-before, 18-or-older, authorized-to-work,
  // and the EEO demographic questions Gender/Ethnicity/Race/Veteran
  // Status/Disability). `<input role="combobox"
  // placeholder="No Selection">` that opens a `<ul role="listbox"><li
  // role="option">` list on click - a real value lives in the input's OWN
  // .value (unlike react-widgets' div-based widget above), and there is no
  // <select> anywhere for FILL_SCREENING's native select handling to find.
  // aria-label carries the exact question text ("Gender:", "Race:",
  // "Disability?", ...) - used directly rather than labelFor()'s DOM-walk,
  // because SF's own <label for=""> is empty.
  //
  // Selector matches on the CLASS alone, not `[role="combobox"]` -
  // SuccessFactors does not always stamp that role at page-load:
  // Country's input had it, the otherwise byte-identical State/Province
  // input did not (both share the same rcmpaginatedselectinput class).
  // Requiring the role silently dropped State/Province from every widget
  // pass, which is why it was never clicked and never appeared in any run's
  // widget list even though it visibly showed "Indiana".
  for (const el of [...document.querySelectorAll('input.rcmpaginatedselectinput')].filter(vis)) {
    const b = blockOf(el);
    el.setAttribute("data-wd-w", String(n));
    out.push({
      n, kind: "sfpicklist", label: norm(el.getAttribute("aria-label")) || labelFor(el),
      current: norm(el.value),
      blockKind: b.kind, blockText: b.text.slice(0, 600),
    });
    n++;
  }

  return out;
}

/**
 * Decide what a widget should say, or null to leave it alone.
 *
 * `known` maps an employer name to its address facts, so a work-history widget
 * is only answered when its block actually names that employer.
 *
 * `demo` carries the voluntary EEO demographic answers (gender/ethnicity/
 * race/veteran/disability), read out of screening_answers.json by the
 * caller - see apply_watch.js's `demo` build. Empty ({}) unless
 * --demographics is passed for this run, same opt-in every other caller of
 * this module already respects.
 */
function wantFor(w, personal, known, demo, answers = []) {
  const label = (w.label || "").toLowerCase();

  // SuccessFactors' own paginated-select comboboxes are answered
  // straight out of screening_answers.json's `match` tokens - the SAME
  // word-boundary, longest-token-wins rule FILL_SCREENING's own pick() uses
  // for free text - rather than a value hardcoded in this file. This is what
  // lets "State/Province:" resolve to the full state NAME (the
  // `address.state_province` entry, token "state/province" - 15 chars) over
  // the generic `address.state` entry (token "state" - 5 chars, answer "IN")
  // used everywhere else on this page: a plain abbreviation was being
  // clicked against option text "Indiana", never matched, and the field was
  // silently left unfilled. It is also what supplies Preferred Language,
  // opt-in-to-text, worked-before, 18-or-older, authorized-to-work, and the
  // EEO fields, none of which had (or need) a bespoke mapping below.
  // Scoped to sfpicklist and to the applicant's own (non-block) fields -
  // work/education blocks keep their existing, block-aware handling further
  // down, unchanged.
  if (w.kind === "sfpicklist" && w.blockKind === "" && answers.length) {
    const norm2 = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const isWord = (ch) => /[a-z0-9]/.test(ch);
    const containsWord = (hay, needle) => {
      if (!needle) return false;
      let i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1) {
        const before = i === 0 ? " " : hay[i - 1];
        const after = i + needle.length >= hay.length ? " " : hay[i + needle.length];
        if (!isWord(before) && !isWord(after)) return true;
        i += 1;
      }
      return false;
    };
    let best = null, bestLen = 0;
    for (const a of answers) {
      for (const m of a.match || []) {
        const t = norm2(m);
        if (t && containsWord(label, t) && t.length > bestLen) { best = a; bestLen = t.length; }
      }
    }
    if (best) return Array.isArray(best.answer) ? best.answer[0] : String(best.answer);
  }

  // NO trailing \b on these. Paylocity renders the label and its current
  // display value glued together with no separator - the country box is
  // labelled "CountryUnited States" and the state box "StateIN". A \bcountry\b
  // test fails on both, which is why every run since the first reported
  // 'a REQUIRED field has no saved answer: "countryunited states"'.
  const field =
    /(^|\s)country/.test(label) ? "country" :
    /(^|\s)state(?!ment)/.test(label) ? "state" :
    /(^|\s)county/.test(label) ? "county" :
    /(^|\s)(zip|postal)/.test(label) ? "zip" :
    /address line 1|street address|(^|\s)street/.test(label) ? "street" :
    /(^|\s)city/.test(label) ? "city" :
    /sms|text you/.test(label) ? "sms" :
    /did you graduate/.test(label) ? "graduated" :
    /school type/.test(label) ? "school_type" :
    // SuccessFactors EEO demographics - anchored exact-ish, not a bare
    // \bcountains\b test, so "race" cannot fire on some unrelated label that
    // merely contains the substring (there is no other field on this form
    // that would, but the anchor costs nothing and matches the ^gender:?$
    // shape aria-label actually renders).
    /^gender:?$/.test(label) ? "gender" :
    /^ethnicity:?$/.test(label) ? "ethnicity" :
    /^race:?$/.test(label) ? "race" :
    /^veteran status:?$/.test(label) ? "veteran" :
    /^disability\??:?$/.test(label) ? "disability" :
    null;
  if (!field) return null;

  // Voluntary EEO fields answer straight from `demo` - never from
  // personal/known, and never guessed when `demo` has no entry (when
  // --demographics is not passed, or screening_answers.json has no rule yet).
  if (["gender", "ethnicity", "race", "veteran", "disability"].includes(field)) {
    return (demo && demo[field]) || null;
  }

  // The SMS dropdown's own options are "--", "Yes*" and "No" - that trailing
  // "*" is Paylocity's OWN option text (the
  // rendered <li> reads "Yes*", not "Yes"), not a marker this script adds. A
  // log line reading "= Yes*" is reporting exactly what the widget shows, and
  // agrees() below treats "Yes*" as agreeing with the wanted "Yes" (prefix
  // match), so returning the plain "Yes" here is correct - do not add the
  // asterisk here or the exact-match branch in driveWidgets would stop
  // matching it.
  if (field === "sms") return "Yes";

  if (w.blockKind === "work") {
    const hit = Object.keys(known).find((emp) => w.blockText.includes(emp.toLowerCase()));
    // An unrecognised employer block is left blank on purpose. Guessing an
    // address here writes a real, wrong address onto a real application.
    if (!hit) return null;
    return known[hit][field] || null;
  }
  if (w.blockKind === "education") return null;  // handled as text fields
  return personal[field] || null;
}

// Deliberately strict, and shared between the "should I overwrite this?" gate
// below and the post-click "did it actually commit?" check further down - a
// widget rendering "Indiana" for a wanted "IN" must not be treated as
// DIFFERENT (and re-clicked for no reason) by one check while the other
// accepts it as equal. The alias list covers US state abbreviations and
// the country name only, so nothing outside it gets loosened.
const ALIAS = {
  al: ["alabama"], "alabama": ["al"],
  ak: ["alaska"], "alaska": ["ak"],
  az: ["arizona"], "arizona": ["az"],
  ar: ["arkansas"], "arkansas": ["ar"],
  ca: ["california"], "california": ["ca"],
  co: ["colorado"], "colorado": ["co"],
  ct: ["connecticut"], "connecticut": ["ct"],
  de: ["delaware"], "delaware": ["de"],
  dc: ["district of columbia"], "district of columbia": ["dc"],
  fl: ["florida"], "florida": ["fl"],
  ga: ["georgia"], "georgia": ["ga"],
  hi: ["hawaii"], "hawaii": ["hi"],
  id: ["idaho"], "idaho": ["id"],
  il: ["illinois"], "illinois": ["il"],
  in: ["indiana"], "indiana": ["in"],
  ia: ["iowa"], "iowa": ["ia"],
  ks: ["kansas"], "kansas": ["ks"],
  ky: ["kentucky"], "kentucky": ["ky"],
  la: ["louisiana"], "louisiana": ["la"],
  me: ["maine"], "maine": ["me"],
  md: ["maryland"], "maryland": ["md"],
  ma: ["massachusetts"], "massachusetts": ["ma"],
  mi: ["michigan"], "michigan": ["mi"],
  mn: ["minnesota"], "minnesota": ["mn"],
  ms: ["mississippi"], "mississippi": ["ms"],
  mo: ["missouri"], "missouri": ["mo"],
  mt: ["montana"], "montana": ["mt"],
  ne: ["nebraska"], "nebraska": ["ne"],
  nv: ["nevada"], "nevada": ["nv"],
  nh: ["new hampshire"], "new hampshire": ["nh"],
  nj: ["new jersey"], "new jersey": ["nj"],
  nm: ["new mexico"], "new mexico": ["nm"],
  ny: ["new york"], "new york": ["ny"],
  nc: ["north carolina"], "north carolina": ["nc"],
  nd: ["north dakota"], "north dakota": ["nd"],
  oh: ["ohio"], "ohio": ["oh"],
  ok: ["oklahoma"], "oklahoma": ["ok"],
  or: ["oregon"], "oregon": ["or"],
  pa: ["pennsylvania"], "pennsylvania": ["pa"],
  ri: ["rhode island"], "rhode island": ["ri"],
  sc: ["south carolina"], "south carolina": ["sc"],
  sd: ["south dakota"], "south dakota": ["sd"],
  tn: ["tennessee"], "tennessee": ["tn"],
  tx: ["texas"], "texas": ["tx"],
  ut: ["utah"], "utah": ["ut"],
  vt: ["vermont"], "vermont": ["vt"],
  va: ["virginia"], "virginia": ["va"],
  wa: ["washington"], "washington": ["wa"],
  wv: ["west virginia"], "west virginia": ["wv"],
  wi: ["wisconsin"], "wisconsin": ["wi"],
  wy: ["wyoming"], "wyoming": ["wy"],
  "united states": ["usa", "us", "united states of america"],
};
const agrees = (got, wanted) => {
  if (!got) return false;
  const a = String(got).toLowerCase(), b = String(wanted).toLowerCase();
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  return (ALIAS[b] || []).some((x) => a === x || a.startsWith(x));
};

/**
 * After a "street" widget (an Address Line 1 typeahead) commits, Address
 * Line 2 next to it sometimes still holds THAT SAME street - Paylocity's
 * resume parser occasionally puts the street in Line 2 and a city/state
 * guess in Line 1, so once Line 1 is corrected, Line 2 is left duplicating
 * it. Cleared only when Line 2's value is an exact match for the street just
 * written - never touched for any other reason.
 */
async function clearAddressLine2IfDuplicate(el, street, log) {
  const cleared = await el.evaluate((line1, streetVal) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    let line2 = null;
    if (line1.id && /-address-1$/i.test(line1.id)) {
      line2 = document.getElementById(line1.id.replace(/-address-1$/i, "-address-2"));
    }
    if (!line2) {
      const box = line1.closest("div") && line1.closest("div").parentElement;
      if (box) {
        line2 = [...box.querySelectorAll("input,textarea")].find((c) => {
          if (c === line1) return false;
          const lab = (c.getAttribute("data-for") || c.placeholder || c.id || "").toLowerCase();
          return /address line ?2/.test(lab);
        }) || null;
      }
    }
    if (!line2) return null;
    const cur = norm(line2.value);
    if (!cur || cur !== norm(streetVal)) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (setter && setter.set) setter.set.call(line2, "");
    line2.dispatchEvent(new Event("input", { bubbles: true }));
    line2.dispatchEvent(new Event("change", { bubbles: true }));
    return { id: line2.id, hadValue: cur };
  }, street).catch(() => null);
  if (cleared) log(`  override : Address Line 2 (auto-cleared - held the street) : "${cleared.hadValue}" -> ""`);
}

/** Read a widget's CURRENT displayed value back out of the page. Shared by
 * the fill loop and the stabilisation pass below, so both trust the DOM in
 * exactly the same way. */
const readWidgetValue = (el) => el.evaluate((e) => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  let t = norm(e.value !== undefined ? e.value : "");
  if (!t) {
    let sv = null, n = e;
    for (let h = 0; n && h < 4 && !sv; h++, n = n.parentElement) {
      sv = n.querySelector && n.querySelector(".input-select-input-single-value");
    }
    if (sv) t = norm(sv.textContent);
  }
  if (!t) t = norm((e.querySelector && (e.querySelector(".rw-input") || {}).textContent) || "");
  if (!t) t = norm(e.getAttribute("aria-activedescendant") ? (document.getElementById(e.getAttribute("aria-activedescendant")) || {}).textContent : "");
  return t && t !== "--" ? t : null;
}).catch(() => null);

/**
 * Fill the widgets. Returns { filled: [], skipped: [] }.
 */
async function driveWidgets(page, { personal, known, demo = {}, answers = [], log = () => {} } = {}) {
  const widgets = await page.evaluate(TAG_WIDGETS).catch(() => []);
  // Dropdown-shaped widgets (react-widgets' SMS opt-in, and SuccessFactors'
  // "sfpicklist" EEO combobox) go LAST. Paylocity
  // keeps SMS's selection purely in local component state (no backing hidden
  // input/select at all), and some later async event on the page - most
  // likely the resume-parse population still finishing its work - can
  // silently reset that state well after this script verified the click
  // committed. The longer SMS sits idle while 10+ other widgets get
  // clicked/typed into, the more exposure it has to that reset. Filling it
  // LAST instead of first shrinks that window to (almost) nothing. No such
  // reset has been observed on the SF picklists, but there is no cost to
  // ordering them the same way.
  const isDropdownLike = (k) => k === "dropdown" || k === "sfpicklist";
  widgets.sort((a, b) => (isDropdownLike(a.kind) ? 1 : 0) - (isDropdownLike(b.kind) ? 1 : 0));
  const filled = [], skipped = [];
  // Every widget this pass believed it committed, so it can be RE-CHECKED
  // once more after everything else on the page has settled - see the
  // stabilisation pass at the end of this function.
  const settledEntries = [];

  for (const w of widgets) {
    const want = wantFor(w, personal, known, demo, answers);
    const has = w.current && w.current !== "--" && w.current !== "";
    // Leaving an already-populated field alone is the right default, EXCEPT
    // where the existing text is Paylocity's resume-parse guess and we hold
    // the authoritative value: profile.json for a work-history block (its
    // Address Line 1 comes through as "<City, ST>" - a city in a street box)
    // and screening_answers/profile.json identity for the applicant's OWN
    // fields (Address Line 1 came through as "Springfield" - a city, not a
    // street). Education blocks are left alone - handled as text fields, and
    // there is no authoritative source for a widget there. Overwrite only
    // when the value actually differs (agrees() is alias-aware, so "Indiana"
    // is not re-clicked just because the wanted answer is written "IN").
    const mayOverwrite = has && want && (w.blockKind === "work" || w.blockKind === "") &&
      !agrees(w.current, want);
    if (has && !mayOverwrite) {
      skipped.push(`${w.label}: already "${w.current}"`);
      log(`  wskip    : ${w.label} - already "${w.current}"`);
      // Address Line 2 is checked even when Line 1 needed no click this
      // round: Paylocity's resume parser can re-populate Line 2 with the
      // street on a fresh page load while leaving an already-correct Line 1
      // untouched, so the clear cannot be
      // conditioned on Line 1 having just been overwritten.
      if (want && agrees(w.current, want) && /address line 1|street address|(^|\s)street/i.test(w.label || "")) {
        const el0 = page.locator(`[data-wd-w="${w.n}"]`).first();
        await clearAddressLine2IfDuplicate(el0, w.current, log);
      }
      continue;
    }
    if (mayOverwrite) log(`  wfix     : ${w.label} - replacing "${w.current}" with "${want}"`);
    if (!want) {
      // Logged, not silent. An earlier version dropped these on the floor,
      // which made "1 of 15 set" impossible to diagnose.
      skipped.push(`${w.label}: no rule`);
      log(`  wskip    : [${w.kind}/${w.blockKind || "personal"}] ${w.label.slice(0, 60)} - no rule`);
      continue;
    }

    const el = page.locator(`[data-wd-w="${w.n}"]`).first();
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      
      let picked = null;
      if (w.kind === "dropdown" || w.kind === "sfpicklist") {
        const picker = el.locator('.rw-widget-picker, .rw-input').first();
        // SuccessFactors' picklist has no such child - it's a plain <input>
        // and the click target IS the element itself, same as the "else"
        // branch below already does for react-widgets when it has no picker.
        const clickOnce = async () => {
          if (await picker.count().catch(() => 0) > 0) {
            await picker.click({ timeout: 5000 }).catch(() => {});
          } else {
            await el.click({ force: true, timeout: 5000 }).catch(async () => { await el.focus({ timeout: 3000 }).catch(() => {}); });
          }
        };
        await clickOnce();
        await page.waitForTimeout(1100);

        // SuccessFactors' own picklist fetches its option list on open and
        // does not always respond to the very first click:
        // Ethnicity/Disability opened first try, Race/Veteran
        // Status needed a second or third. A single click here silently left
        // the list closed and the field unmatched. Cheap to retry: a widget
        // whose list already opened costs nothing extra, since the count
        // check below exits the loop immediately.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (await page.locator('[role="option"], .rw-list-option').count().catch(() => 0) > 0) break;
          await clickOnce();
          await page.waitForTimeout(900);
        }

        // Paginated SF picklists (Country ~195 options, Preferred Language
        // dozens) render only a window of their list, so the wanted option is
        // usually NOT present to click and the keyboard fallback below then
        // commits whatever happens to be highlighted ("Aruba" for "United
        // States"). These comboboxes are text inputs that FILTER their list on
        // type - type the wanted value to narrow the list to it, then match.
        // Scoped to sfpicklist so react-widgets DropdownList (no filter input)
        // is untouched.
        if (w.kind === "sfpicklist") {
          await el.focus({ timeout: 3000 }).catch(() => {});
          await el.evaluate((e) => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            if (set) set.call(e, "");
            e.dispatchEvent(new Event("input", { bubbles: true }));
          }).catch(() => {});
          await page.keyboard.type(String(want), { delay: 45 });
          await page.waitForTimeout(1300);
        }

        const opts = page.locator('[role="option"], .rw-list-option');
        if (await opts.count().catch(()=>0) > 0) {
          // want is untrusted-ish free text (an address token, a state name) -
          // it must be escaped before going into a RegExp, or a value carrying
          // regex metacharacters (parens, a period in an abbreviation) either
          // throws or silently matches the wrong thing.
          const esc = String(want).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const exactOpt = opts.filter({ hasText: new RegExp(`^${esc}$`, 'i') }).first();
          if (await exactOpt.count().catch(()=>0) > 0) {
            await exactOpt.click({ timeout: 3000 }).catch(()=>{});
            picked = want;
          } else {
            // Anchored to the START of the option, not a bare substring: "IN"
            // as a plain hasText string matches "ILLINOIS" too (contains "IN"),
            // which put the wrong state on a real application.
            const startOpt = opts.filter({ hasText: new RegExp(`^${esc}`, 'i') }).first();
            if (await startOpt.count().catch(()=>0) > 0) {
              await startOpt.click({ timeout: 3000 }).catch(()=>{});
              picked = want;
            }
          }
        }
      } else if (w.kind === "typeahead") {
        await el.click({ force: true, timeout: 5000 }).catch(async () => { await el.focus({ timeout: 3000 }).catch(() => {}); });
        await el.evaluate((e) => {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          if (set) set.call(e, "");
          e.dispatchEvent(new Event("input", { bubbles: true }));
        }).catch(() => {});
        await page.keyboard.type(want, { delay: 45 });
        await page.waitForTimeout(1100);

        picked = await page.evaluate(({ wanted, loose }) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const w_ = wanted.toLowerCase();
          const opts = [...document.querySelectorAll('[role="option"], .rw-list-option')].filter(vis);
          let target =
            opts.find((o) => norm(o.textContent).toLowerCase() === w_) ||
            opts.find((o) => norm(o.textContent).toLowerCase().startsWith(w_));
          if (!target && loose) {
            const parts = w_.split(/\s+/);
            const num = parts[0], word = parts[1] || "";
            if (/^\d+$/.test(num) && word) {
              target = opts.find((o) => {
                const t = norm(o.textContent).toLowerCase();
                return t.startsWith(num + " ") && t.includes(word);
              });
            }
          }
          if (!target) return null;
          const label = norm(target.textContent);
          for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
            target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
          return label;
        }, { wanted: String(want), loose: /address|street/i.test(w.label || "") }).catch(() => null);
      }

      const readBack = () => readWidgetValue(el);

      let actual = await readBack();

      if (isDropdownLike(w.kind) && (!actual || !actual.toLowerCase().startsWith(String(want).toLowerCase()))) {
        // Fall back to keyboard
        await el.focus({ timeout: 3000 }).catch(() => {});
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press("ArrowDown", { delay: 100 });
          await page.waitForTimeout(100);
          actual = await readBack();
          if (actual && actual.toLowerCase().startsWith(String(want).toLowerCase())) {
            await page.keyboard.press("Enter");
            break;
          }
        }
      }

      await page.waitForTimeout(300);
      actual = await readBack();
      // agrees() is the module-level helper (shared with the overwrite gate
      // above). A false negative just leaves the field blank and reports it;
      // a false positive leaves a wrong answer on a real application.

      // `picked` is just the OPTION's own label text at click time, not proof the
      // click stuck - the SMS dropdown reported "Yes" here on every run while the
      // widget's own display still read "--", because this path trusted the
      // option text instead of reading the widget back. Read back for real.
      let settled = null;
      if (picked) {
        await page.waitForTimeout(400);
        const got = await readBack();
        if (agrees(got, want)) settled = got;
        else log(`  wnocommit: ${w.label.slice(0, 40)} - click matched "${picked}" but widget still shows "${got || "--"}", retrying with Enter`);
      }
      if (!settled) {
        // Enter commits the HIGHLIGHTED entry, which is not necessarily the one
        // we asked for: on an unfiltered state list it committed "AK" when the
        // answer was IN, putting Alaska on a real application. So the value is
        // read back and must AGREE with what was wanted; anything else is wiped
        // and reported as a failure rather than left on the form.
        await page.keyboard.press("Enter").catch(() => {});
        await page.waitForTimeout(500);
        const got = await readBack();
        if (agrees(got, want)) {
          settled = got;
        } else if (got) {
          log(`  wwrong   : ${w.label.slice(0, 40)} committed "${got}" but wanted "${want}" - clearing it`);
          await el.evaluate((e) => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
            if (set && set.set && e.value !== undefined) {
              set.set.call(e, "");
              e.dispatchEvent(new Event("input", { bubbles: true }));
              e.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }).catch(() => {});
          skipped.push(`${w.label}: committed the wrong value "${got}", cleared`);
        }
      }
      // Even the option-click path is verified - a menu can reorder under us.
      if (settled && !agrees(settled, want)) {
        log(`  wwrong   : ${w.label.slice(0, 40)} shows "${settled}", wanted "${want}"`);
        skipped.push(`${w.label}: shows "${settled}", wanted "${want}"`);
        settled = null;
      }

      if (settled) {
        const filledStr = `${w.label} = ${settled}`;
        filled.push(filledStr);
        log(`  widget   : ${w.label} = ${settled}`);
        if (/address line 1|street address|(^|\s)street/i.test(w.label || "")) {
          await clearAddressLine2IfDuplicate(el, settled, log);
        }
        // Tracked for the stabilisation pass below - `want`, not `settled`,
        // is what a re-check compares against (settled is just what the
        // widget happened to show at THIS instant, e.g. "Yes*").
        settledEntries.push({ n: w.n, label: w.label, kind: w.kind, want, filledStr });
      } else {
        skipped.push(`${w.label}: no option matching "${want}"`);
        log(`  widget   : ${w.label} - no option matching "${want}"`);
        await page.keyboard.press("Escape").catch(() => {});
      }
      await page.waitForTimeout(300);
    } catch (e) {
      const why = String(e.message || e).split("\n")[0];
      skipped.push(`${w.label}: ${why}`);
      log(`  wfail    : ${w.label.slice(0, 50)} - ${why.slice(0, 90)}`);
    }
  }

  // Stabilisation pass. Paylocity does async work of its own after a widget
  // is clicked (the resume-parse population in particular can keep running
  // for a while after this script's own wait windows), and that can silently
  // reset a widget's LOCAL react-widgets state back to "--" AFTER this loop
  // already verified the click committed. The SMS
  // dropdown logged "widget : ... = Yes*" and then read back empty about a
  // second later, at the baseline snapshot. Re-read everything this pass
  // believed it filled, once more, and re-drive anything that reverted -
  // and if it still cannot be made to stick, take the false claim OUT of
  // `filled` rather than report success that did not happen.
  if (settledEntries.length) {
    await page.waitForTimeout(900);
    for (const entry of settledEntries) {
      const el = page.locator(`[data-wd-w="${entry.n}"]`).first();
      const now = await readWidgetValue(el);
      if (agrees(now, entry.want)) continue;  // still holds - nothing to do

      log(`  wreverted: ${entry.label.slice(0, 50)} - was set, now reads "${now || "--"}" - re-filling`);
      try {
        if (entry.kind === "dropdown" || entry.kind === "sfpicklist") {
          const picker = el.locator(".rw-widget-picker, .rw-input").first();
          if (await picker.count().catch(() => 0) > 0) await picker.click({ timeout: 5000 }).catch(() => {});
          else await el.click({ force: true, timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(900);
          const esc = String(entry.want).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const opts = page.locator('[role="option"], .rw-list-option');
          const opt = opts.filter({ hasText: new RegExp(`^${esc}`, "i") }).first();
          if (await opt.count().catch(() => 0) > 0) await opt.click({ timeout: 3000 }).catch(() => {});
        } else if (entry.kind === "typeahead") {
          await el.click({ force: true, timeout: 5000 }).catch(() => {});
          await page.keyboard.type(String(entry.want), { delay: 45 });
          await page.waitForTimeout(900);
          await page.keyboard.press("Enter").catch(() => {});
        }
      } catch { /* fall through to the re-check below either way */ }

      await page.waitForTimeout(500);
      const after = await readWidgetValue(el);
      if (agrees(after, entry.want)) {
        log(`  widget   : ${entry.label} = ${after} (re-settled after reverting)`);
        const idx = filled.indexOf(entry.filledStr);
        if (idx >= 0) filled[idx] = `${entry.label} = ${after}`;
      } else {
        const idx = filled.indexOf(entry.filledStr);
        if (idx >= 0) filled.splice(idx, 1);
        skipped.push(`${entry.label}: reverted after being set and could not be re-filled`);
        log(`  widget   : ${entry.label} - reverted after being set, could not be re-filled`);
      }
    }
  }

  return { filled, skipped, seen: widgets.length };
}

module.exports = { TAG_WIDGETS, driveWidgets, wantFor };
