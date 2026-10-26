# CLAUDE.md

Project context for Claude Code. Read this before changing anything.

## What this is

A date poll. Someone creates a poll with candidate dates, shares a link, everyone marks yes or no
on each one, and the column with the best score highlights itself. Accounts exist but are optional
and gate nothing.

Owner: John Higginson. Personal side project, not client work.

Live at https://scheduler.sdw.dev. The user facing name is Scheduler; every internal name is still
`DraftPoll`, including the namespace, assembly, systemd unit, deploy path and Mongo database.
Renaming those means a service rename and a database migration for no user visible gain.

## Stack

- ASP.NET Core 10 minimal API, C#, nullable enabled
- MongoDB via the official `MongoDB.Driver`
- Front end is plain HTML, CSS and ES5-flavoured vanilla JS served from `wwwroot`
- No npm, no bundler, no build step for the front end. Keep it that way unless John asks otherwise.

## Layout

```
DraftPoll.csproj
Program.cs               endpoint definitions, top level statements
Api.cs                   validation, auth, response shaping, option parsing, rate limit keys
Auth.cs                  users, sign in links, sessions. Tokens stored as hashes
Mailer.cs                the two emails this app sends (sign in link, poll links), through Postmark
Site.cs                  product name, canonical origin, support email placeholder, per poll share tags
Models.cs                Mongo documents, request records, id generator
PollStore.cs             Mongo collection access, index setup, every write
appsettings.json         local defaults, connection string is overridden in Production
wwwroot/index.html       create a poll
wwwroot/create.js        calendar, weekday ranges, time windows, presets
wwwroot/slots.js         slot generation and weekday dates, DOM free so node can test it
wwwroot/poll.html        vote, comment, organizer controls
wwwroot/poll.js
wwwroot/zones.js         converts option times between zones with Intl, DOM free so node can test it
wwwroot/admin.html       every poll and its responses, behind one key
wwwroot/signin.html      ask for a sign in link
wwwroot/my.html          polls belonging to the signed in account
wwwroot/app.css          all styling, CSS variables at the top
wwwroot/site.js          SITE_NAME, the product name for copy built in script. Load it first
wwwroot/privacy.html     privacy page at /privacy. Keep it true to what the code stores
wwwroot/terms.html       terms page at /terms
wwwroot/*-alternative.html  Doodle, When2meet, Framadate, Rallly, StrawPoll and Crab Fit comparison
                         pages. Competitor facts are dated October 2026 and were checked on the
                         competitor's own site; every Scheduler claim must be true of the code
wwwroot/*-date-poll.html, *-scheduler.html, meeting-poll.html, volunteer-meeting-poll.html
                         use case pages, one per kind of group, each with its own setup steps.
                         Visible FAQ and FAQPage JSON-LD carry the same text
wwwroot/how-it-works.html  walkthrough of every step. No HowTo markup, Google dropped it
wwwroot/use-cases.html   hub linking every use case and, under #compare, every comparison. The
                         footer's "Use cases" and "Compare" links point here
wwwroot/404.html         served by the fallback for unknown non API GETs
wwwroot/robots.txt       keeps crawlers off /p/ and private routes, lets link preview bots in
wwwroot/sitemap.xml      static, list every indexable page here
wwwroot/og.png           1200x630 share image; favicon.ico, favicon.svg, apple-touch-icon.png
tests/e2e.sh             307 checks, run against a throwaway database
tests/*.test.js          slots.js and zones.js under node. e2e.sh runs them and counts their checks
deploy/                  systemd unit, Caddy block, bootstrap script
tools/rebrand.sh         rewrites the product name in the static pages, site.js, Site.Name and tests
.github/workflows/       build and test, then test and deploy
```

## Data model

One document per poll in the `polls` collection. Participants and comments are embedded arrays, not
separate collections. A poll is small and always read whole, so embedding is the right call and
avoids joins entirely.

```
Poll
  PublicId      14 chars, in the shareable URL
  AdminId       24 chars, secret, unique index
  OwnerEmail    the signed in account that made it, or null for an anonymous poll
  Title, Description, OrganizerName, Closed
  AllowMaybe    off by default
  TimeZone      IANA zone the organizer was in, display only
  DeadlineUtc   when voting closes on its own, or null
  Options[]     { Id, Date "yyyy-MM-dd", Time "HH:mm" or null }
  Participants[]{ Id, Name, EditToken, Votes { optionId: "yes"|"maybe"|"no" }, timestamps }
  Comments[]    { Id, Name, Text, EditToken, CreatedUtc }
```

Unique indexes on `PublicId` and `AdminId` are created at startup in `PollStore`.

## Accounts and admin, both optional additions

Accounts never gate anything. A poll made with no account behaves exactly as it always has, and a
test asserts it. `Poll.OwnerEmail` is null for those.

Auth lives in `Auth.cs`: users, sign in links and sessions. Tokens are stored as SHA-256 hashes,
never raw. Sending is in `Mailer.cs`, two message types, no SDK. The poll links email
(`POST /api/polls/{id}/email-links`, organizer token in the body) must never store or log the
address it sends to.

The browser remembers organizer links as `admin:{publicId}` holding the bare token, which `poll.js`
and the claim on `/my` both read, plus `poll:{publicId}` holding `{ title, created }` for the home
page list. Do not change the `admin:` format.

The admin area is one key in `Admin__Key`, compared in constant time, sent in a header. Unset means
off, not open. It can read every poll on the server, so treat that key as a password.

## Rules that are load bearing

1. **Dates are strings, never `DateTime`.** `Date` is `yyyy-MM-dd` and `Time` is a separate optional
   `HH:mm`. Do not "improve" this into a `DateTime`. The moment a date option round trips through a
   timezone it lands on the wrong day for somebody. `DeadlineUtc` is a real instant, which is why it
   is the one `DateTime` here.
   The poll page shows timed options on the voter's clock by converting through `zones.js` at display
   time only, with a switch back to the organizer's zone. All day options never move.
2. **Never write a poll back whole.** Every write uses a targeted operator: `$push`, `$pull`, or a
   positional `$set`. Replacing the document loses concurrent edits, and did: ten simultaneous rows
   once persisted four, with all ten callers getting 200.
3. **The driver maps a member named `Id` onto `_id`, including inside embedded documents.** A hand
   written array filter like `"Participants.$[row].Id"` therefore matches nothing, and the update
   silently succeeds while changing not one field. Use the positional `$` with a typed `ElemMatch`.
4. **Conditions that guard a write belong in the update filter**, not in a check against a copy read
   moments earlier. Closed, the deadline and the array caps are all enforced in the filter.
5. **Secrets never appear in a GET response.** `Api.Shape` is the only projection sent to clients and
   it deliberately omits `AdminId` and every `EditToken`. If you add a field to `Poll`, decide
   consciously whether it belongs in `Shape`.
6. **The admin token travels in the URL fragment**, `/p/{publicId}#a={adminId}`. Fragments are not
   sent to the server, so it stays out of access logs and `Referer` headers. Never move it into the
   query string or a path segment.
7. **Tokens are compared with `CryptographicOperations.FixedTimeEquals`**, padded to a fixed width so
   length does not leak. Do not replace this with `==`.
8. **All user text is rendered with `textContent`, never `innerHTML`.** The one `innerHTML` is in
   `create.js` and only for a static template string with no user data in it.
9. **Votes are sanitized server side.** `Api.SanitizeVotes` drops unknown option ids, anything that is
   not yes, maybe or no, and maybe on a poll that did not enable it.
10. **Times are stored as 24 hour `HH:mm` and never displayed that way.** Use `formatTime` or
    `prettyTime`. The only place 24 hour reaches output is the calendar export, where the file
    format requires it.
11. **Every input type needs adding to the three control rules in `app.css`.** They are keyed to
    explicit `input[type=...]` selectors, so a type nobody listed renders as raw browser chrome
    beside styled fields. That has already happened twice, with `datetime-local` and `password`.
12. **`[hidden]` is enforced in CSS.** The attribute only carries `display:none` from the user agent
    sheet, so any class setting `display` beats it. That is how a legend stayed on screen for a poll
    that did not offer maybe. Twelve elements are toggled with `hidden`.

## Pages, share tags and the support email

`/p/{publicId}` is `poll.html` with the block between `<!-- share tags -->` markers replaced per
poll by `Site.ShareTags`, from a projected read of title and description only. Every user value is
HTML encoded there. Keep the markers or startup throws.

Routing runs after static files (`app.UseRouting()` in `Program.cs`) so the catch all 404 page does
not shadow `/` and real files. API and `/auth` paths keep their bare 404.

A new indexable page is a plain file in `wwwroot` and needs four more edits: its slug in the clean
URL list in `Program.cs`, a `<url>` in `sitemap.xml`, the matching slug list in `tests/e2e.sh`, and a
link from `use-cases.html` if it is a use case or comparison. Copy the head, header and footer of an
existing page so the canonical, share tags and footer match.

There is no support email yet. `Site.SupportEmail` in `Site.cs` is the one placeholder, marked
`TODO(john)`, and nothing renders it. Pages point people at GitHub issues instead. Never put any
other address on the site.

Poll pages show voters one "Made with Scheduler" line, `#made-with` in `poll.html`. `poll.js`
copies it beside the confirmation after a vote, so hiding that one element hides both.

When the privacy page and the code disagree, the code is right and the page is a bug.

## Rebrand checklist

The product name is changing, so it lives in as few places as possible. Running
`tools/rebrand.sh Scheduler "New Name"` covers the first three. The rest are by hand.

1. `Site.Name` in `Site.cs`: per poll page titles, share tags, and both emails in `Mailer.cs`.
2. `SITE_NAME` in `wwwroot/site.js`: the tab title and links text after creating a poll, the poll
   page tab title, and the calendar export `PRODID`. Any new script copy uses it too.
3. Static pages, every `wwwroot/*.html`: titles, share tags, JSON-LD, wordmark, footer, and the copy
   on the privacy, terms, how it works, use case and comparison pages. They are rewritten in place
   rather than filled in at startup, so they stay plain files with their normal ETags. Reread the
   comparison and use case pages after: an "a" or "an" before the name may need to change. Also
   `tests/e2e.sh` and the `README.md` title.
4. `og.png` draws the name as text in the image. It needs a new image at 1200x630.
5. `favicon.svg`, `favicon.ico` and `apple-touch-icon.png` carry only the calendar mark, no name. They
   change only if the mark does.
6. The domain is a separate decision: `Site.Origin`, canonical links, `sitemap.xml`, `robots.txt`,
   `og.png`, the e2e checks, `Postmark:From` and the Caddy block all name `scheduler.sdw.dev` or
   `sdw.dev`. So does the GitHub link in every footer.
7. Deliberately unchanged: every internal `DraftPoll` name, and the `@scheduler` suffix on calendar
   export UIDs, so an event exported before the rebrand still matches one exported after it.

## Testing

`tests/e2e.sh` runs against a throwaway database, never production. Both workflows run it against a
`mongo:7` service container and the deploy job will not start unless it passes.

**Assert that a write persisted, not that it returned 200.** An update matching a document but no
array element returns 200 and changes nothing; a suite checking only status codes passed that bug.

Give each section its own `X-Forwarded-For`. The create limiter allows 10 an hour and one run makes
more than that in total, so shared addresses make a later section fail on 429 instead of on the
behaviour under test.

## Known gaps, deliberately left

- **No poll expiry.** A TTL index on `CreatedUtc` would clean up abandoned polls.
- **Static assets are not fingerprinted.** They are served `no-cache` so the browser revalidates
  against the ETag. Correct, at the cost of a round trip. Fingerprinting needs a build step.
- **No HSTS.** A year long commitment cached by browsers, so it is John's call.

Do not silently fix these as part of an unrelated task. Raise them, then fix them on purpose.

## Local development

```
docker compose up -d      # Mongo on 27017
dotnet run
```

Connection string resolution order: `ConnectionStrings:Mongo` from config, then the `MONGO_URL`
environment variable, then `mongodb://localhost:27017`. Database name comes from `Mongo:Database`
and defaults to `draftpoll`.

`/healthz` pings Mongo and returns 503 if it cannot reach it. The deploy workflow checks it.

## Conventions John cares about

- No em dashes anywhere. Not in code, comments, docs, or commit messages. Use commas, colons,
  parentheses, or a sentence break.
- No AI or Claude attribution in commit messages, PR descriptions, or any generated content.
- Commit messages: imperative mood, one line, body only when the why is not obvious.
- Comments explain why, not what. If a line needs a comment to say what it does, rewrite the line.
- Match the existing style. Four space indents in C#, two in JS, CSS and YAML.
