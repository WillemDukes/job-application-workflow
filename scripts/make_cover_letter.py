"""
make_cover_letter.py - copy a cover-letter template and tailor it to one lead.

THE TEMPLATES ARE NEVER EDITED. This script copies one and fills the copy.
Standing rule: "use the template and don't edit it. Every
time you write a custom cover letter you will copy the template and then rewrite
so it is specific to each job."

There are TWO templates, and they are not interchangeable:

  application  "cover_letter_application.docx"
               Attached to a job application - Handshake, or an employer portal.
               It says "Dear Hiring Manager," in the body, so it has NO
               [HIRING MANAGER NAME] placeholder and needs no name.
               Placeholders: [TODAY'S DATE] [POSITION] [COMPANY]

  email        "cover_letter_email.docx"
               Sent to a NAMED hiring manager. It opens "Dear [HIRING MANAGER
               NAME]," so --manager is REQUIRED.
               Placeholders: [TODAY'S DATE] [POSITION] [COMPANY] [HIRING MANAGER NAME]

Picking the wrong one is a real mistake in both directions: an application
letter emailed to a person is impersonal, and an email letter attached to an
application arrives addressed to nobody. So --kind defaults to `application`
(the common case) and `email` refuses to run without a name.

Rules this script enforces, because a bracket that survives into a sent letter
is worse than no letter at all:

  - It refuses to write if any `[UPPERCASE` bracket remains.
  - It refuses to overwrite an existing letter unless you pass --force.

Output is named `<Company> Cover Letter.docx`.
The filename matters because Handshake and the employer's inbox both show it to
the EMPLOYER. Two earlier defaults were worse: the raw 16-character app_key, and
then a long "${profile.identity.legal_name} - Cover Letter - <Company> (email)" form that was
too complex.

Application letters land in `generated\\`, email letters in `generated\\email\\`.
They have to be separated, because under one flat naming rule both kinds produce
the same filename for the same company, and they are NOT interchangeable - one
opens "Dear Hiring Manager," and the other "Dear <name>,".

Usage:
    python make_cover_letter.py --position "Park Ranger I" --company "Example Park"
        -> generated\\Example Park Cover Letter.docx
    python make_cover_letter.py --position "Park Ranger I" --company "Example Park" \\
        --kind email --manager "Jane Doe"
    python make_cover_letter.py --position "..." --company "..." --key <app_key>
"""

import argparse
import datetime
import pathlib
import re
import shutil
import sys
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
GENERATED = REPO / "generated"
# Email letters live one level down so that `<Company> Cover Letter.docx` can be
# the name for BOTH kinds without one clobbering the other.
GENERATED_EMAIL = GENERATED / "email"

# Every uploaded document lives in one folder, so the
# templates, resume and portfolio now live together here rather than
# loose in the repo root.
DOCS = REPO / "documents"

TEMPLATES = {
    "application": DOCS / "cover_letter_application.docx",
    "email": DOCS / "cover_letter_email.docx",
}

# The XML parts Word may put visible body text into.
TEXT_PARTS = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")

# Tolerant of a straight or curly apostrophe in [TODAY'S DATE].
DATE_RE = re.compile(r"\[TODAY.S DATE\]")

# Anything still looking like a placeholder after the swap.
LEFTOVER_RE = re.compile(r"\[[A-Z]")


def safe_name(s: str) -> str:
    """A filename an employer can read, with the characters Windows rejects gone."""
    out = "".join(c for c in s if c.isalnum() or c in " -_&,.").strip()
    return re.sub(r"\s+", " ", out) or "Employer"


def fill_xml(xml: str, position: str, company: str, manager: str, date: str) -> str:
    xml = DATE_RE.sub(date, xml)
    if manager:
        xml = xml.replace("[HIRING MANAGER NAME]", manager)
    xml = xml.replace("[POSITION]", position)
    xml = xml.replace("[COMPANY]", company)
    return xml


def visible_text(xml: str) -> str:
    """Rough body text, only good enough for the leftover-bracket check."""
    return re.sub(r"<[^>]+>", "", xml.replace("</w:p>", "\n"))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--position", required=True)
    p.add_argument("--company", required=True)
    p.add_argument("--kind", choices=sorted(TEMPLATES), default="application",
                   help="application (attached to a job application) or email (sent to a named person)")
    p.add_argument("--manager", default=None, help="required for --kind email")
    p.add_argument("--key", default=None, help="app_key, recorded in the run output only")
    p.add_argument("--date", default=None)
    p.add_argument("--out", default=None)
    p.add_argument("--force", action="store_true")
    a = p.parse_args()

    template = TEMPLATES[a.kind]
    if not template.exists():
        print(f"template missing: {template}", file=sys.stderr)
        return 2

    # The email template opens "Dear [HIRING MANAGER NAME],". Without a name the
    # leftover-bracket check would catch it anyway, but failing here says why.
    if a.kind == "email" and not a.manager:
        print("--kind email needs --manager: that template is addressed to a named person.",
              file=sys.stderr)
        print("For a letter attached to an application, use --kind application (the default).",
              file=sys.stderr)
        return 2
    if a.kind == "application" and a.manager:
        print("note: --manager is ignored for --kind application; that template already "
              'reads "Dear Hiring Manager,"')

    date = a.date or f"{datetime.date.today():%B %d, %Y}".replace(" 0", " ")
    outdir = GENERATED_EMAIL if a.kind == "email" else GENERATED
    out = pathlib.Path(a.out) if a.out else outdir / f"{safe_name(a.company)} Cover Letter.docx"

    if out.exists() and not a.force:
        print(f"already generated, leaving it alone: {out}")
        print("pass --force only if you actually want it rewritten.")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".docx.tmp")

    src = zipfile.ZipFile(template)
    swapped = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if TEXT_PARTS.match(item.filename):
                xml = data.decode("utf8")
                new = fill_xml(xml, a.position, a.company, a.manager or "", date)
                if new != xml:
                    swapped += 1
                    left = LEFTOVER_RE.search(visible_text(new))
                    if left:
                        tmp.unlink(missing_ok=True)
                        print(
                            f"REFUSING TO WRITE: a placeholder survived in {item.filename} "
                            f"near {visible_text(new)[max(0, left.start()-40):left.start()+40]!r}",
                            file=sys.stderr,
                        )
                        return 1
                data = new.encode("utf8")
            dst.writestr(item, data)
    src.close()

    if not swapped:
        tmp.unlink(missing_ok=True)
        print("REFUSING TO WRITE: no placeholder was replaced - is this the right template?",
              file=sys.stderr)
        return 1

    shutil.move(str(tmp), str(out))
    print(f"wrote {out}")
    print(f"  template : {template.name}")
    print(f"  position : {a.position}")
    print(f"  company  : {a.company}")
    if a.kind == "email":
        print(f"  manager  : {a.manager}")
    print(f"  date     : {date}")
    if a.key:
        print(f"  key      : {a.key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
