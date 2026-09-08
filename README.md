# Scheduler

A date poll. Create a poll, share one link, everyone marks yes or no, the best column highlights
itself. An account is optional and only keeps a list of the polls you made.

ASP.NET Core 10 minimal API, MongoDB, vanilla JS front end. No build step, no npm.

Live at https://scheduler.sdw.dev

The internal name is still `DraftPoll`: the namespace, the assembly, the systemd unit, the deploy
path and the Mongo database. Only the user facing name changed.

## Run it locally

1. Start Mongo:

   ```
   docker compose up -d
   ```

2. Run the app:

   ```
   dotnet run
   ```

3. Open the URL the console prints, usually `http://localhost:5000`.

## MongoDB Atlas instead of Docker

Free M0 works fine, and is what production uses. Set the connection string with either
`ConnectionStrings__Mongo` or the `MONGO_URL` environment variable. Database name defaults to
`draftpoll`, override with `Mongo__Database`. Do not commit the connection string.

## Choosing dates

Days and times are separate steps, because one day can carry many slots.

Pick days from the calendar (click to toggle, shift click for a run), from a shortcut, or by
repeating weekdays across a date range. Then either leave them all day, or define time windows: an
opening time, a closing time and a slot length. Every window names the weekdays it covers, so
weekdays can run 9 to 5 while Saturday runs 10 to 2. Slots from every window covering a day are
merged and de-duplicated.

A poll holds at most 300 options. The create page refuses to submit over that rather than letting
the server truncate silently.

## How the links work

| Link | Who gets it | What it does |
|---|---|---|
| `/p/{publicId}` | everyone | View, add a row, vote, comment |
| `/p/{publicId}#a={adminId}` | organizer only | Everything above, plus edit dates, close voting, delete |

The admin token sits in the URL fragment on purpose. Fragments are never sent to the server, so the
secret stays out of access logs and `Referer` headers. The browser stores it in `localStorage` the
first time and strips it from the address bar.

**The organizer link cannot be recovered.** It is not stored anywhere else and is not tied to an
account. The success screen offers a download and a mailto, and warns before the tab is closed with
it unsaved.

Each person who adds a row gets a one time edit token, also in `localStorage`. That is what lets
them come back and change their own row without an account, and it is why editing only works from
the browser that voted. The poll page says so at the point of voting.

## API

| Method | Route | Auth |
|---|---|---|
| POST | `/api/polls` | none |
| GET | `/api/polls/{publicId}` | none |
| GET | `/api/admin/{adminId}` | admin token in path |
| POST | `/api/polls/{id}/participants` | none |
| PUT | `/api/polls/{id}/participants/{pid}` | `X-Edit-Token` or `X-Admin-Token` |
| DELETE | `/api/polls/{id}/participants/{pid}` | `X-Edit-Token` or `X-Admin-Token` |
| POST | `/api/polls/{id}/comments` | none |
| PUT | `/api/polls/{id}/comments/{cid}` | `X-Edit-Token` or `X-Admin-Token` |
| DELETE | `/api/polls/{id}/comments/{cid}` | `X-Edit-Token` or `X-Admin-Token` |
| POST | `/api/polls/{id}/options` | `X-Admin-Token` |
| DELETE | `/api/polls/{id}/options/{optionId}` | `X-Admin-Token` |
| PATCH | `/api/polls/{id}` | `X-Admin-Token` |
| DELETE | `/api/polls/{id}` | `X-Admin-Token` |

Best-date scoring is `yes * 2 + maybe`. Ties are shown as ties. Maybe is off by default; the server
drops a maybe vote on a poll that did not enable it.

Write endpoints are rate limited per IP: 30 a minute for ordinary writes, 10 an hour for creating
polls. The app reads the real client address from `X-Forwarded-For`, which only works because
`UseForwardedHeaders` runs before the limiter.

## Tests

```
BASE_URL=http://127.0.0.1:5099 bash tests/e2e.sh
```

102 checks. Point it at a throwaway database, never production; it creates and deletes real polls.
Both workflows run it against a `mongo:7` service container, and the deploy job will not start
unless it passes.

## Accounts

Optional throughout. Creating a poll and voting work with no account, which is the point of the
product and is covered by a test.

Signing in is a link by email, no password. The link expires in 15 minutes and is deleted when it
is redeemed, which is what makes it single use. Sign in links and sessions are stored as SHA-256
hashes rather than as the value handed to the browser, so a dump of that collection grants nobody a
session. Mongo removes expired rows through a TTL index.

Signing in also claims any poll whose organizer token that browser already holds and that nobody
owns yet, so an account is useful immediately rather than only for polls made from then on.

Configure with `Postmark__Token` and `Postmark__From`. An unset token disables sending rather than
failing, so the app still runs locally without credentials. The From address has to be a verified
sender signature on that Postmark server or Postmark refuses the send outright.

## Admin area

`/admin`, opened with a single key from `Admin__Key`. An unset key leaves it switched off rather
than open, because that one key can read every poll on the server. The key travels in a header, so
it never lands in an access log or browser history.

It lists every poll with its responses, and deliberately shows organizer links: they cannot be
recovered any other way, and handing one back is most of the point of having the area at all.

## Deployment

systemd behind Caddy on Ubuntu, deployed by GitHub Actions on every push to `main`. See `deploy/`
for the unit file, the Caddy block and the bootstrap script.

## Still open

- **No poll expiry.** A TTL index on `CreatedUtc` would clean up abandoned polls.
- **No HSTS.** A year long commitment cached by browsers, so it is a decision rather than an
  oversight.
- **Static assets have no fingerprint.** They are served `no-cache`, so the browser revalidates with
  the ETag and always gets current files at the cost of a 304. Fingerprinted filenames would avoid
  the round trip but need a build step, which this front end deliberately does not have.

## License

MIT. See [LICENSE](LICENSE).
