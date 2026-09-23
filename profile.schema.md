# Profile Schema

This document outlines the schema for `profile.json` and related files.

## profile.json

| Field | Description | Example | Required? |
|-------|-------------|---------|-----------|
| `identity.legal_name` | Full legal name | John Doe | Yes |
| `identity.preferred_name` | Preferred name | Johnny | Yes |
| `identity.email` | Primary contact email | email@example.com | Yes |
| `identity.school_email` | University email address (not used on forms) | jdoe@university.edu | Optional |
| `identity.phone` | Phone number | 555-0100 | Yes |
| `identity.school_student_id` | Student ID number | 00123456 | Optional |
| `identity.local_address.street` | Street address | 123 Main St | Yes |
| `identity.local_address.city` | City | Anytown | Yes |
| `identity.local_address.state` | State (2-letter) | ST | Yes |
| `identity.local_address.zip` | Zip code | 12345 | Yes |
| `identity.local_address.county` | County | Example County | Optional |
| `identity.school` | University name | University of XYZ | Yes |
| `identity.linkedin` | LinkedIn Profile URL | https://linkedin.com/in/johndoe | Optional |
| `location.commute_miles` | Map of lowercase town names to commute distance in miles | `{ "<nearby town>": 5 }` | Optional |
| `location.default_radius_miles` | Default search radius in miles | `10` | Optional |
| `location.handshake_location_option` | Exact Handshake location typeahead text (defaults to "City, State, United States") | `Springfield, Illinois, United States` | Optional |
| `platforms.handshake.base_url` | Handshake School URL | https://SCHOOL.joinhandshake.com | Yes |
| `academic.major` | Major/field of study | Computer Science | Yes |
| `academic.expected_graduation` | Expected graduation month/year | May 2028 | Yes |
| `work_basics.authorized_to_work_us` | Authorized to work in the US | `true` | Yes |
| `documents.resume_docx_master` | Path to master resume .docx (relative to repo root) | resumes/Resume.docx | One of resume_docx_master/resume_pdf required |
| `documents.resume_pdf` | Path to resume .pdf (relative to repo root) | resumes/Resume.pdf | One of resume_docx_master/resume_pdf required |
| `documents.cover_letter_docx` | Path to cover letter template .docx | documents/Cover Letter Template.docx | Optional |
| `work_history` | Array of past employment. Each entry: `employer`, `title`, `location`, `start`, `end`, `supervisor_name`, `supervisor_phone`, `reason_for_leaving`, `may_contact` (bool), plus optional `employer_address` object (`street`,`city`,`state`,`zip`,`county`) | [{ "employer": "..." }] | Optional |
| `references` | Array of references | [{ "name": "..." }] | Optional |
| `academic.school` | University name | Example University | Yes |
| `academic.minor` | Minor/secondary field of study | <Example Minor> | Optional |
| `academic.class_standing` | Current class standing | Junior | Optional |
| `academic.enrolled_since` | Start date of enrollment | 2024-08 | Optional |
| `academic.gpa` | Current GPA | 4.0 | Optional |
| `academic.list_gpa_on_applications` | Whether to list GPA on applications | true | Optional |
| `academic.honors` | Array of academic honors | ["Dean List"] | Optional |
| `availability.semester` | Target semester for availability | Fall YYYY | Optional |
| `availability.classes` | Array of class schedules | [{ "course": "..." }] | Optional |
| `availability.free_blocks` | Map of weekdays to arrays of start/end time blocks | { "Monday": [["08:00", "09:00"]] } | Optional |
| `availability.best_shift_blocks` | Array of text descriptions of best availability | ["Friday mornings"] | Optional |
| `availability.cover_letter_sentence` | Sentence summarizing availability for cover letters | I am available all day Friday. | Optional |
| `availability.max_hours_per_week` | Maximum work hours per week | 15 | Optional |
| `availability.preferred_hours_per_week` | Preferred work hours per week | 10-15 | Optional |
| `availability.earliest_start_date` | Earliest possible start date | immediately | Optional |
| `availability.hard_blackouts` | Array of strict blackout dates/times | [] | Optional |
| `work_basics.requires_sponsorship` | Requires visa sponsorship | false | Yes |
| `work_basics.has_reliable_transportation` | Has reliable transportation | true | Optional |
| `work_basics.has_car` | Has a personal car | true | Optional |
| `work_basics.minimum_hourly_rate` | Minimum acceptable hourly rate | null | Optional |
| `certifications` | Array of certifications | [{ "name": "..." }] | Optional |
| `skills` | Object containing arrays of skills by category | { "programming": ["..."] } | Optional |
| `work_history[].ending_pay_rate` | Ending pay rate for the job | $20.00/hr | Optional |
| `work_history[].duties` | Array of job duties | ["Duty 1", "Duty 2"] | Optional |
| `work_history[].employer_address.street` | Employer street address | 123 Work St | Optional |
| `work_history[].employer_address.city` | Employer city | Worktown | Optional |
| `work_history[].employer_address.state` | Employer state | NY | Optional |
| `work_history[].employer_address.zip` | Employer zip code | 12345 | Optional |
| `work_history[].employer_address.county` | Employer county | Work County | Optional |
| `work_history[].supervisor_email` | Supervisor email address | boss@example.com | Optional |
| `work_history[].supervisor_title` | Supervisor job title | Manager | Optional |
| `projects` | Array of notable projects | [{ "name": "..." }] | Optional |
| `campus_involvement` | Array of campus activities | [{ "org": "..." }] | Optional |
| `documents.cover_letter_md` | Path to cover letter template .md | documents/Cover_Letter_Template.md | Optional |
| `documents.generated_letters_dir` | Directory for generated letters | generated/ | Optional |
| `never_stored` | List of sensitive fields that are never stored | ["SSN"] | Optional |

Any required field left as `""` or as an unfilled `<...>` placeholder causes `npm run check` to fail. Any other field left as an unfilled `<...>` placeholder prints a warning but does not fail the check.

## profile_private.json

| Field | Description | Example | Required? |
|-------|-------------|---------|-----------|
| `date_of_birth` | Date of birth | 2000-01-01 | Optional |
| `permanent_address`| Permanent address | { "street": "..." } | Optional |
| `school_student_id` | Student ID (legacy location; prefer `identity.school_student_id` in profile.json) | 00123456 | Optional |
| `accounts` | ATS portal credentials keyed by site name | { "workday": { "username": "...", "password": "..." } } | Optional |

## screening_answers.json

Answers to common application questions.

| Field | Description | Example | Required? |
|-------|-------------|---------|-----------|
| `work_authorization` | US work auth | true | Optional |
| `sponsorship` | Requires visa sponsorship | false | Optional |

