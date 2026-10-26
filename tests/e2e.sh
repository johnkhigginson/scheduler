#!/usr/bin/env bash
#
# End to end suite. Point it at a running instance backed by a throwaway database:
#
#   BASE_URL=http://127.0.0.1:5099 tests/e2e.sh
#
# It creates and deletes real polls, so never aim it at production.
# Each virtual client gets its own X-Forwarded-For so the per IP rate limiter does not
# interfere with the behaviour actually under test.
B=${BASE_URL:-http://127.0.0.1:5099}
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); printf "  PASS  %s\n" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf "  FAIL  %s   (%s)\n" "$1" "$2"; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected $3, got $2"; }

# $1 method, $2 path, $3 body ('' for none), $4.. extra headers
code() {
  local m=$1 p=$2 b=$3; shift 3
  if [ -z "$b" ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X "$m" "$B$p" "$@"
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X "$m" "$B$p" \
      -H 'Content-Type: application/json' -d "$b" "$@"
  fi
}
body() {
  local m=$1 p=$2 b=$3; shift 3
  if [ -z "$b" ]; then curl -s --max-time 15 -X "$m" "$B$p" "$@"
  else curl -s --max-time 15 -X "$m" "$B$p" -H 'Content-Type: application/json' -d "$b" "$@"; fi
}
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

# Fresh client addresses per run. The create limiter is a 1 hour window, so reusing fixed
# addresses makes the second run of the day fail on 429 instead of on the behaviour under test.
R1=$((RANDOM % 250 + 1)); R2=$((RANDOM % 250 + 1))
IP1="-H X-Forwarded-For:10.$R1.$R2.11"
IP2="-H X-Forwarded-For:10.$R1.$R2.22"
IP3="-H X-Forwarded-For:10.$R1.$R2.33"
IP4="-H X-Forwarded-For:10.$R1.$R2.44"
# Each section that creates polls needs its own address: the create limiter allows 10 an
# hour, and one run now makes more than that in total.
IP5="-H X-Forwarded-For:10.$R1.$R2.55"
IP6="-H X-Forwarded-For:10.$R1.$R2.66"
IP7="-H X-Forwarded-For:10.$R1.$R2.77"
# The email links limiter allows 5 an hour, so that section gets an address nothing else uses.
IP8="-H X-Forwarded-For:10.$R1.$R2.88"

echo "== validation on create =="
is "reject poll with no title" "$(code POST /api/polls '{"Options":[{"Date":"2027-01-05"}]}' $IP1)" 400
is "reject poll with no dates" "$(code POST /api/polls '{"Title":"x"}' $IP1)" 400
is "reject poll with only invalid dates" "$(code POST /api/polls '{"Title":"x","Options":[{"Date":"not-a-date"},{"Date":"2027-13-45"}]}' $IP1)" 400
is "reject whitespace only title" "$(code POST /api/polls '{"Title":"   ","Options":[{"Date":"2027-01-05"}]}' $IP1)" 400

echo
echo "== create and read =="
R=$(body POST /api/polls '{"Title":"E2E poll","Description":"desc","OrganizerName":"Org","Options":[{"Date":"2027-01-05","Time":"18:00"},{"Date":"2027-01-06"},{"Date":"2027-01-05","Time":"18:00"}]}' $IP1)
PUB=$(echo "$R" | jget "['publicId']"); ADM=$(echo "$R" | jget "['adminId']")
[ -n "$PUB" ] && ok "create returns publicId" || bad "create returns publicId" "empty"
[ ${#PUB} -eq 14 ] && ok "publicId is 14 chars" || bad "publicId is 14 chars" "${#PUB}"
[ ${#ADM} -eq 24 ] && ok "adminId is 24 chars" || bad "adminId is 24 chars" "${#ADM}"

G=$(body GET "/api/polls/$PUB" '' $IP1)
is "duplicate date option deduped" "$(echo "$G" | jget "['options'].__len__()")" 2
echo "$G" | grep -qiE '"adminId"|"editToken"' && bad "GET hides secrets" "leaked" || ok "GET hides secrets"
is "GET unknown poll is 404" "$(code GET /api/polls/doesnotexist00 '' $IP1)" 404
is "admin token resolves to poll" "$(body GET "/api/admin/$ADM" '' $IP1 | jget "['publicId']")" "$PUB"
is "unknown admin token is 404" "$(code GET /api/admin/nope '' $IP1)" 404

OPT1=$(echo "$G" | jget "['options'][0]['id']")
OPT2=$(echo "$G" | jget "['options'][1]['id']")

echo
echo "== participants and vote sanitizing =="
P1=$(body POST "/api/polls/$PUB/participants" "{\"Name\":\"Alice\",\"Votes\":{\"$OPT1\":\"yes\",\"$OPT2\":\"maybe\",\"bogus\":\"yes\"}}" $IP1)
A_ID=$(echo "$P1" | jget "['id']"); A_TOK=$(echo "$P1" | jget "['editToken']")
[ -n "$A_TOK" ] && ok "participant returns edit token" || bad "participant returns edit token" "empty"
V=$(body GET "/api/polls/$PUB" '' $IP1 | jget "['participants'][0]['votes']")
echo "$V" | grep -q bogus && bad "unknown option id dropped" "kept" || ok "unknown option id dropped"

P2=$(body POST "/api/polls/$PUB/participants" "{\"Name\":\"Bob\",\"Votes\":{\"$OPT1\":\"BANANA\",\"$OPT2\":\"NO\"}}" $IP2)
B_ID=$(echo "$P2" | jget "['id']"); B_TOK=$(echo "$P2" | jget "['editToken']")
V2=$(body GET "/api/polls/$PUB" '' $IP1 | jget "['participants'][1]['votes']")
echo "$V2" | grep -q BANANA && bad "invalid vote value dropped" "kept" || ok "invalid vote value dropped"
echo "$V2" | grep -q "'no'" && ok "uppercase vote normalised to lowercase" || bad "uppercase vote normalised" "$V2"

echo
echo "== ownership rules =="
is "edit row with no token is 403" "$(code PUT "/api/polls/$PUB/participants/$A_ID" '{"Name":"Hacker"}' $IP2)" 403
is "edit row with wrong token is 403" "$(code PUT "/api/polls/$PUB/participants/$A_ID" '{"Name":"Hacker"}' $IP2 -H "X-Edit-Token: $B_TOK")" 403
is "edit row with own token works" "$(code PUT "/api/polls/$PUB/participants/$A_ID" "{\"Name\":\"Alice R\",\"Votes\":{\"$OPT1\":\"no\"}}" $IP1 -H "X-Edit-Token: $A_TOK")" 200
# A 200 is not proof. An update that matches the document but no array element returns 200 and
# changes nothing, so assert the value actually landed.
is "edited name actually persisted" "$(body GET "/api/polls/$PUB" '' $IP1 | jget "['participants'][0]['name']")" "Alice R"
is "edited vote actually persisted" "$(body GET "/api/polls/$PUB" '' $IP1 | jget "['participants'][0]['votes']['$OPT1']")" "no"
is "admin can edit any row" "$(code PUT "/api/polls/$PUB/participants/$B_ID" '{"Name":"Bob by admin"}' $IP3 -H "X-Admin-Token: $ADM")" 200
is "admin edit actually persisted" "$(body GET "/api/polls/$PUB" '' $IP1 | jget "['participants'][1]['name']")" "Bob by admin"
is "delete row with no token is 403" "$(code DELETE "/api/polls/$PUB/participants/$A_ID" '' $IP2)" 403
is "edit unknown row is 404" "$(code PUT "/api/polls/$PUB/participants/nope" '{"Name":"x"}' $IP1 -H "X-Edit-Token: $A_TOK")" 404

echo
echo "== comments =="
C=$(body POST "/api/polls/$PUB/comments" '{"Name":"Alice","Text":"first"}' $IP1)
C_ID=$(echo "$C" | jget "['id']"); C_TOK=$(echo "$C" | jget "['editToken']")
is "comment requires name and text" "$(code POST "/api/polls/$PUB/comments" '{"Name":"only name"}' $IP1)" 400
is "delete comment with no token is 403" "$(code DELETE "/api/polls/$PUB/comments/$C_ID" '' $IP2)" 403
is "delete comment with own token works" "$(code DELETE "/api/polls/$PUB/comments/$C_ID" '' $IP1 -H "X-Edit-Token: $C_TOK")" 200
is "comment actually removed" "$(body GET "/api/polls/$PUB" '' $IP1 | jget "['comments'].__len__()")" 0

echo
echo "== admin controls =="
is "non admin cannot patch" "$(code PATCH "/api/polls/$PUB" '{"Title":"Hijacked"}' $IP2)" 403
is "non admin cannot delete poll" "$(code DELETE "/api/polls/$PUB" '' $IP2)" 403
is "admin can retitle" "$(code PATCH "/api/polls/$PUB" '{"Title":"Renamed"}' $IP3 -H "X-Admin-Token: $ADM")" 200
is "retitle actually persisted" "$(body GET "/api/polls/$PUB" '' $IP1 | jget "['title']")" "Renamed"
is "admin can close voting" "$(code PATCH "/api/polls/$PUB" '{"Closed":true}' $IP3 -H "X-Admin-Token: $ADM")" 200
is "closed flag actually persisted" "$(body GET "/api/polls/$PUB" '' $IP1 | jget "['closed']")" "True"
is "closed poll rejects new row" "$(code POST "/api/polls/$PUB/participants" '{"Name":"Late"}' $IP2)" 400
is "closed poll rejects row edit" "$(code PUT "/api/polls/$PUB/participants/$B_ID" '{"Name":"Late edit"}' $IP2 -H "X-Edit-Token: $B_TOK")" 400
is "admin can still add when closed" "$(code POST "/api/polls/$PUB/participants" '{"Name":"Admin row"}' $IP3 -H "X-Admin-Token: $ADM")" 200
is "comments still allowed when closed" "$(code POST "/api/polls/$PUB/comments" '{"Name":"A","Text":"still open?"}' $IP1)" 200
is "admin can reopen" "$(code PATCH "/api/polls/$PUB" '{"Closed":false}' $IP3 -H "X-Admin-Token: $ADM")" 200

echo
echo "== hostile input =="
X=$(body POST /api/polls '{"Title":"<script>alert(1)</script>","OrganizerName":"<img src=x onerror=alert(1)>","Options":[{"Date":"2027-02-01"}]}' $IP6)
XPUB=$(echo "$X" | jget "['publicId']"); XADM=$(echo "$X" | jget "['adminId']")
# System.Text.Json escapes < > and & to < style sequences on the wire, so compare the parsed
# value rather than the raw body. The point is that the text round trips without being mangled.
is "markup round trips intact" "$(body GET "/api/polls/$XPUB" '' $IP6 | jget "['title']")" '<script>alert(1)</script>'
# The API does not HTML escape values, and does not need to. What makes that safe is the JSON
# content type plus the client rendering every user value with textContent. Assert the content
# type here, since that is the half of the contract the server actually owns.
is "response is json content type" \
  "$(curl -s -o /dev/null -w '%{content_type}' --max-time 15 "$B/api/polls/$XPUB" | cut -d';' -f1)" \
  "application/json"
LONG=$(python3 -c "print('z'*400)")
Y=$(body POST /api/polls "{\"Title\":\"$LONG\",\"Options\":[{\"Date\":\"2027-02-02\"}]}" $IP6)
YPUB=$(echo "$Y" | jget "['publicId']"); YADM=$(echo "$Y" | jget "['adminId']")
is "title truncated to 120" "$(body GET "/api/polls/$YPUB" '' $IP6 | jget "['title'].__len__()")" 120
U=$(body POST /api/polls '{"Title":"Ünïcode ok 🎉","Options":[{"Date":"2027-02-03"}]}' $IP6)
UPUB=$(echo "$U" | jget "['publicId']"); UADM=$(echo "$U" | jget "['adminId']")
is "unicode and emoji survive" "$(body GET "/api/polls/$UPUB" '' $IP6 | jget "['title']")" "Ünïcode ok 🎉"
is "malformed json is 400" "$(code POST /api/polls '{"Title":' $IP6)" 400

echo
echo "== maybe is opt in =="
M1=$(body POST /api/polls '{"Title":"no maybe","Options":[{"Date":"2027-07-01"},{"Date":"2027-07-02"}]}' $IP5)
MPUB=$(echo "$M1" | jget "['publicId']"); MADM=$(echo "$M1" | jget "['adminId']")
is "maybe is off by default" "$(body GET "/api/polls/$MPUB" '' $IP5 | jget "['allowMaybe']")" "False"
MOPT=$(body GET "/api/polls/$MPUB" '' $IP5 | jget "['options'][0]['id']")
body POST "/api/polls/$MPUB/participants" "{\"Name\":\"Sneaky\",\"Votes\":{\"$MOPT\":\"maybe\"}}" $IP2 >/dev/null
is "maybe is dropped when not enabled" \
  "$(body GET "/api/polls/$MPUB" '' $IP5 | jget ".get('participants')[0]['votes'].get('$MOPT')")" "None"

M2=$(body POST /api/polls '{"Title":"with maybe","Options":[{"Date":"2027-07-03"}],"AllowMaybe":true}' $IP5)
YPUB2=$(echo "$M2" | jget "['publicId']"); YADM2=$(echo "$M2" | jget "['adminId']")
is "maybe can be enabled" "$(body GET "/api/polls/$YPUB2" '' $IP5 | jget "['allowMaybe']")" "True"
YOPT2=$(body GET "/api/polls/$YPUB2" '' $IP5 | jget "['options'][0]['id']")
body POST "/api/polls/$YPUB2/participants" "{\"Name\":\"Unsure\",\"Votes\":{\"$YOPT2\":\"maybe\"}}" $IP2 >/dev/null
is "maybe is kept when enabled" \
  "$(body GET "/api/polls/$YPUB2" '' $IP5 | jget "['participants'][0]['votes']['$YOPT2']")" "maybe"

# Slot generation multiplies days by times, so the ceiling matters. 320 requested, 300 allowed.
MANY=$(python3 -c "
import json
opts=[{'Date':'2027-08-%02d'%(d+1),'Time':'%02d:%02d'%(9+m//4, (m%4)*15)}
      for d in range(20) for m in range(16)]
print(json.dumps({'Title':'over the cap','Options':opts}))")
CAPRES=$(body POST /api/polls "$MANY" $IP5)
CAPPUB=$(echo "$CAPRES" | jget "['publicId']"); CAPADM=$(echo "$CAPRES" | jget "['adminId']")
is "options are capped at 300" "$(body GET "/api/polls/$CAPPUB" '' $IP5 | jget "['options'].__len__()")" 300
# A poll this size has to stay comfortably inside Mongo's 16 MB document limit.
is "a 300 option poll still accepts a vote" "$(code POST "/api/polls/$CAPPUB/participants" '{"Name":"Big"}' $IP2)" 200

for pair in "$MPUB:$MADM" "$YPUB2:$YADM2" "$CAPPUB:$CAPADM"; do
  code DELETE "/api/polls/${pair%%:*}" '' $IP3 -H "X-Admin-Token: ${pair##*:}" >/dev/null
done

echo
echo "== timezone and deadline =="
TZ1=$(body POST /api/polls '{"Title":"tz","Options":[{"Date":"2027-04-01","Time":"18:00"}],"TimeZone":"America/Denver"}' $IP4)
TZPUB=$(echo "$TZ1" | jget "['publicId']"); TZADM=$(echo "$TZ1" | jget "['adminId']")
is "timezone is stored and returned" "$(body GET "/api/polls/$TZPUB" '' $IP4 | jget "['timeZone']")" "America/Denver"

TZ2=$(body POST /api/polls '{"Title":"bad tz","Options":[{"Date":"2027-04-02"}],"TimeZone":"Not/ARealZone"}' $IP4)
BADPUB=$(echo "$TZ2" | jget "['publicId']"); BADADM=$(echo "$TZ2" | jget "['adminId']")
is "unrecognised timezone is dropped" "$(body GET "/api/polls/$BADPUB" '' $IP4 | jget ".get('timeZone')")" "None"

FUTURE=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
F1=$(body POST /api/polls "{\"Title\":\"future\",\"Options\":[{\"Date\":\"2027-04-04\"}],\"Deadline\":\"$FUTURE\"}" $IP4)
FPUB=$(echo "$F1" | jget "['publicId']"); FADM=$(echo "$F1" | jget "['adminId']")
is "future deadline leaves the poll open" "$(body GET "/api/polls/$FPUB" '' $IP4 | jget "['closed']")" "False"
is "future deadline is returned" "$(body GET "/api/polls/$FPUB" '' $IP4 | jget ".get('deadlineUtc') is not None")" "True"
is "open poll still accepts a vote" "$(code POST "/api/polls/$FPUB/participants" '{"Name":"in time"}' $IP2)" 200

P1P=$(body POST /api/polls '{"Title":"expired","Options":[{"Date":"2027-04-03"}],"Deadline":"2020-01-01T00:00:00Z"}' $IP4)
PPUB=$(echo "$P1P" | jget "['publicId']"); PADM=$(echo "$P1P" | jget "['adminId']")
is "past deadline reports closed" "$(body GET "/api/polls/$PPUB" '' $IP4 | jget "['closed']")" "True"
is "past deadline is flagged as automatic" "$(body GET "/api/polls/$PPUB" '' $IP4 | jget "['closedByDeadline']")" "True"
is "expired poll refuses a new row" "$(code POST "/api/polls/$PPUB/participants" '{"Name":"too late"}' $IP2)" 400
is "expired poll still accepts admin rows" "$(code POST "/api/polls/$PPUB/participants" '{"Name":"organizer"}' $IP3 -H "X-Admin-Token: $PADM")" 200
is "garbage deadline is ignored not treated as expired" \
  "$(body POST /api/polls '{"Title":"junk deadline","Options":[{"Date":"2027-04-09"}],"Deadline":"whenever"}' $IP4 | jget "['publicId'].__len__()")" 14

# Reopening an expired poll must drop the deadline, or it closes again on the next read.
code PATCH "/api/polls/$PPUB" '{"Closed":false,"Deadline":""}' $IP3 -H "X-Admin-Token: $PADM" >/dev/null
is "clearing the deadline reopens the poll" "$(body GET "/api/polls/$PPUB" '' $IP4 | jget "['closed']")" "False"
is "cleared deadline is gone" "$(body GET "/api/polls/$PPUB" '' $IP4 | jget ".get('deadlineUtc')")" "None"

for pair in "$TZPUB:$TZADM" "$BADPUB:$BADADM" "$FPUB:$FADM" "$PPUB:$PADM"; do
  code DELETE "/api/polls/${pair%%:*}" '' $IP3 -H "X-Admin-Token: ${pair##*:}" >/dev/null
done

echo
echo "== organizer can edit the poll's dates =="
E1=$(body POST /api/polls '{"Title":"editable","Options":[{"Date":"2027-09-01"},{"Date":"2027-09-02"}]}' $IP5)
EPUB=$(echo "$E1" | jget "['publicId']"); EADM=$(echo "$E1" | jget "['adminId']")
EOPT=$(body GET "/api/polls/$EPUB" '' $IP5 | jget "['options'][0]['id']")

# Someone votes on the date that is about to be removed.
EP=$(body POST "/api/polls/$EPUB/participants" "{\"Name\":\"Voter\",\"Votes\":{\"$EOPT\":\"yes\"}}" $IP2)
is "non admin cannot add a date" "$(code POST "/api/polls/$EPUB/options" '{"Options":[{"Date":"2027-09-09"}]}' $IP2)" 403
is "non admin cannot remove a date" "$(code DELETE "/api/polls/$EPUB/options/$EOPT" '' $IP2)" 403
is "admin can add a date" "$(code POST "/api/polls/$EPUB/options" '{"Options":[{"Date":"2027-09-03","Time":"14:00"}]}' $IP3 -H "X-Admin-Token: $EADM")" 200
is "the added date is there" "$(body GET "/api/polls/$EPUB" '' $IP5 | jget "['options'].__len__()")" 3
is "adding the same date again is refused" "$(code POST "/api/polls/$EPUB/options" '{"Options":[{"Date":"2027-09-03","Time":"14:00"}]}' $IP3 -H "X-Admin-Token: $EADM")" 400
# A date added later has to sort into place. Left at the end of the array it makes the results grid
# draw the same day as two separate header groups.
code POST "/api/polls/$EPUB/options" '{"Options":[{"Date":"2027-08-01"}]}' $IP3 -H "X-Admin-Token: $EADM" >/dev/null
is "a date added later sorts into place" \
  "$(body GET "/api/polls/$EPUB" '' $IP5 | jget "['options'][0]['date']")" "2027-08-01"
is "each date appears in exactly one run" \
  "$(body GET "/api/polls/$EPUB" '' $IP5 | python3 -c "
import sys,json
dates=[o['date'] for o in json.load(sys.stdin)['options']]
runs=[]
for d in dates:
    if not runs or runs[-1]!=d: runs.append(d)
print('yes' if len(runs)==len(set(runs)) else 'no')")" "yes"

is "admin can remove a date" "$(code DELETE "/api/polls/$EPUB/options/$EOPT" '' $IP3 -H "X-Admin-Token: $EADM")" 200
# Started with 2, added 2027-09-03 and 2027-08-01, removed one, so 3 remain.
is "the removed date is gone" "$(body GET "/api/polls/$EPUB" '' $IP5 | jget "['options'].__len__()")" 3
# The vote on that date has to go with it, or every participant keeps a key for a date that is gone.
is "votes on the removed date are cleaned up" \
  "$(body GET "/api/polls/$EPUB" '' $IP5 | jget ".get('participants')[0]['votes'].get('$EOPT')")" "None"

echo
echo "== organizer can change the maybe setting later =="
is "maybe starts off" "$(body GET "/api/polls/$EPUB" '' $IP5 | jget "['allowMaybe']")" "False"
is "admin can switch maybe on" "$(code PATCH "/api/polls/$EPUB" '{"AllowMaybe":true}' $IP3 -H "X-Admin-Token: $EADM")" 200
is "maybe is now on" "$(body GET "/api/polls/$EPUB" '' $IP5 | jget "['allowMaybe']")" "True"

echo
echo "== comments can be edited =="
EC=$(body POST "/api/polls/$EPUB/comments" '{"Name":"Ann","Text":"frist"}' $IP2)
EC_ID=$(echo "$EC" | jget "['id']"); EC_TOK=$(echo "$EC" | jget "['editToken']")
is "editing without a token is refused" "$(code PUT "/api/polls/$EPUB/comments/$EC_ID" '{"Text":"hijack"}' $IP1)" 403
is "author can edit their comment" "$(code PUT "/api/polls/$EPUB/comments/$EC_ID" '{"Text":"first, sorry"}' $IP2 -H "X-Edit-Token: $EC_TOK")" 200
is "the edit actually persisted" "$(body GET "/api/polls/$EPUB" '' $IP5 | jget "['comments'][0]['text']")" "first, sorry"
is "an empty comment is refused" "$(code PUT "/api/polls/$EPUB/comments/$EC_ID" '{"Text":"   "}' $IP2 -H "X-Edit-Token: $EC_TOK")" 400
is "admin can edit any comment" "$(code PUT "/api/polls/$EPUB/comments/$EC_ID" '{"Text":"tidied"}' $IP3 -H "X-Admin-Token: $EADM")" 200

code DELETE "/api/polls/$EPUB" '' $IP3 -H "X-Admin-Token: $EADM" >/dev/null

echo
echo "== admin area is shut without the key =="
# The suite does not know the real key, which is the point: every route must refuse without it.
is "overview refuses with no key" "$(code GET /api/site/overview '' $IP1)" 403
is "overview refuses a wrong key" "$(code GET /api/site/overview '' $IP1 -H 'X-Site-Key: not-the-key')" 403
is "poll detail refuses with no key" "$(code GET "/api/site/polls/$EPUB" '' $IP1)" 403
is "poll detail refuses a wrong key" "$(code GET "/api/site/polls/$EPUB" '' $IP1 -H 'X-Site-Key: not-the-key')" 403
is "admin delete refuses with no key" "$(code DELETE "/api/site/polls/$EPUB" '' $IP1)" 403
# A poll's own organizer token must not open the site wide admin area.
is "a poll organizer token is not a site key" \
  "$(code GET /api/site/overview '' $IP1 -H "X-Site-Key: $EADM")" 403
is "the admin page itself still loads" "$(code GET /admin '' $IP1)" 200

echo
echo "== accounts are optional and gated =="
is "an anonymous poll still works" "$(code POST /api/polls '{"Title":"anon","Options":[{"Date":"2027-06-01"}]}' $IP6)" 200
is "not signed in reports so" "$(body GET /api/auth/me '' $IP1 | jget "['signedIn']")" "False"
is "my polls needs a session" "$(code GET /api/auth/polls '' $IP1)" 401
is "claiming needs a session" "$(code POST /api/auth/claim '{"AdminIds":["whatever"]}' $IP1)" 401
is "a junk email is refused" "$(code POST /api/auth/request '{"Email":"not-an-email"}' $IP1)" 400
is "an empty email is refused" "$(code POST /api/auth/request '{"Email":"   "}' $IP1)" 400
is "an email with two at signs is refused" "$(code POST /api/auth/request '{"Email":"a@b@c.com"}' $IP1)" 400
is "a domain with no dot is refused" "$(code POST /api/auth/request '{"Email":"someone@localhost"}' $IP1)" 400
# A made up verify token must not mint a session, it must bounce back to the sign in page.
is "a bogus sign in link is rejected" \
  "$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 15 "$B/auth/verify?t=totallymadeup" $IP1 | grep -c 'signin?expired=1')" 1
is "the sign in page loads" "$(code GET /signin '' $IP1)" 200
is "the my polls page loads" "$(code GET /my '' $IP1)" 200

echo
echo "== site pages, search and share tags =="
ctype() { curl -s -o /dev/null -w '%{content_type}' --max-time 15 "$B$1" $IP7 | cut -d';' -f1; }
is "privacy page loads" "$(code GET /privacy '' $IP7)" 200
body GET /privacy '' $IP7 | grep -q 'Last updated' && ok "privacy page has a date" || bad "privacy page has a date" "missing"
is "terms page loads" "$(code GET /terms '' $IP7)" 200
ROBOTS=$(body GET /robots.txt '' $IP7)
echo "$ROBOTS" | grep -q '^Sitemap: https://scheduler.sdw.dev/sitemap.xml' && ok "robots names the sitemap" || bad "robots names the sitemap" "missing"
echo "$ROBOTS" | grep -q '^Disallow: /p/' && ok "robots keeps crawlers off polls" || bad "robots keeps crawlers off polls" "missing"
body GET /sitemap.xml '' $IP7 | grep -q '<loc>https://scheduler.sdw.dev/privacy</loc>' \
  && ok "sitemap lists the privacy page" || bad "sitemap lists the privacy page" "missing"
is "share image is served" "$(code GET /og.png '' $IP7)" 200
is "share image is a png" "$(ctype /og.png)" "image/png"
is "favicon is served" "$(code GET /favicon.ico '' $IP7)" 200
is "touch icon is served" "$(code GET /apple-touch-icon.png '' $IP7)" 200

HOME_HTML=$(body GET / '' $IP7)
HOME_TITLE=$(echo "$HOME_HTML" | sed -n 's:.*<title>\(.*\)</title>.*:\1:p' | head -1)
[ -n "$HOME_TITLE" ] && [ "$HOME_TITLE" != "Scheduler" ] && ok "home has a descriptive title" || bad "home has a descriptive title" "$HOME_TITLE"
echo "$HOME_HTML" | grep -q 'og:image" content="https://scheduler.sdw.dev/og.png"' && ok "home has a share image" || bad "home has a share image" "missing"
echo "$HOME_HTML" | grep -q '"@type": "WebApplication"' && ok "home has structured data" || bad "home has structured data" "missing"

# The title carries markup on purpose: it has to come back encoded, never as live tags.
SH=$(body POST /api/polls '{"Title":"Tom & Jerry <b>night</b>","Description":"Snacks \"provided\"","Options":[{"Date":"2027-05-01"}]}' $IP7)
SHPUB=$(echo "$SH" | jget "['publicId']"); SHADM=$(echo "$SH" | jget "['adminId']")
PAGE=$(body GET "/p/$SHPUB" '' $IP7)
echo "$PAGE" | grep -qF '<meta property="og:title" content="Tom &amp; Jerry &lt;b&gt;night&lt;/b&gt;">' \
  && ok "poll page share title is the encoded poll title" || bad "poll page share title is the encoded poll title" "not found"
echo "$PAGE" | grep -qF '<title>Tom &amp; Jerry &lt;b&gt;night&lt;/b&gt; | Scheduler</title>' \
  && ok "poll page title is the encoded poll title" || bad "poll page title is the encoded poll title" "not found"
echo "$PAGE" | grep -qF 'content="Snacks &quot;provided&quot;"' && ok "poll description is encoded in the preview" || bad "poll description is encoded in the preview" "not found"
echo "$PAGE" | grep -q '<b>night' && bad "no raw markup on the poll page" "found" || ok "no raw markup on the poll page"
echo "$PAGE" | grep -qF '<meta name="robots" content="noindex, nofollow">' && ok "poll page is noindex" || bad "poll page is noindex" "missing"
echo "$PAGE" | grep -qF "$SHADM" && bad "poll page never carries the organizer token" "leaked" || ok "poll page never carries the organizer token"
is "unknown poll page still loads" "$(code GET /p/doesnotexist00 '' $IP7)" 200
body GET /p/doesnotexist00 '' $IP7 | grep -qF '<meta property="og:title" content="A date poll on Scheduler">' \
  && ok "unknown poll gets generic share tags" || bad "unknown poll gets generic share tags" "missing"
code DELETE "/api/polls/$SHPUB" '' $IP3 -H "X-Admin-Token: $SHADM" >/dev/null

is "unknown page is 404" "$(code GET /no-such-page '' $IP7)" 404
is "unknown page is html" "$(ctype /no-such-page)" "text/html"
body GET /no-such-page '' $IP7 | grep -q 'Page not found' && ok "unknown page says so" || bad "unknown page says so" "missing"
is "unknown api route is still a bare 404" "$(code GET /api/no-such-route '' $IP7)" 404
[ -z "$(body GET /api/no-such-route '' $IP7)" ] && ok "unknown api route has no html body" || bad "unknown api route has no html body" "got a body"

echo
echo "== email me my links =="
EL=$(body POST /api/polls '{"Title":"links by mail","Options":[{"Date":"2027-05-02"}]}' $IP7)
ELPUB=$(echo "$EL" | jget "['publicId']"); ELADM=$(echo "$EL" | jget "['adminId']")
is "a wrong organizer token is refused" \
  "$(code POST "/api/polls/$ELPUB/email-links" '{"AdminId":"not-the-token","Email":"someone@example.org"}' $IP8)" 403
is "no organizer token is refused" \
  "$(code POST "/api/polls/$ELPUB/email-links" '{"Email":"someone@example.org"}' $IP8)" 403
is "a junk address is refused" \
  "$(code POST "/api/polls/$ELPUB/email-links" "{\"AdminId\":\"$ELADM\",\"Email\":\"nope\"}" $IP8)" 400
# The suite runs with no Postmark token, so the right answer is a clean "not sent", not an error.
is "with email off the send reports not sent" \
  "$(body POST "/api/polls/$ELPUB/email-links" "{\"AdminId\":\"$ELADM\",\"Email\":\"someone@example.org\"}" $IP8 | jget "['sent']")" "False"
body GET "/api/polls/$ELPUB" '' $IP7 | grep -q 'someone@example.org' && bad "the address is not stored on the poll" "found" || ok "the address is not stored on the poll"
code POST "/api/polls/$ELPUB/email-links" "{\"AdminId\":\"$ELADM\",\"Email\":\"someone@example.org\"}" $IP8 >/dev/null
is "email links is rate limited" \
  "$(code POST "/api/polls/$ELPUB/email-links" "{\"AdminId\":\"$ELADM\",\"Email\":\"someone@example.org\"}" $IP8)" 429
is "email links for an unknown poll is 404" \
  "$(code POST /api/polls/doesnotexist00/email-links '{"AdminId":"x","Email":"someone@example.org"}' $IP7)" 404
code DELETE "/api/polls/$ELPUB" '' $IP3 -H "X-Admin-Token: $ELADM" >/dev/null

echo
echo "== concurrency =="
# Whole document replacement used to lose concurrent writes: every request read the poll, edited
# its own copy and wrote the whole thing back, so simultaneous voters silently overwrote each
# other while all receiving 200. These two checks are the regression guard for that.
CR=$(body POST /api/polls '{"Title":"concurrency","Options":[{"Date":"2027-03-01"}]}' $IP4)
CPUB=$(echo "$CR" | jget "['publicId']"); CADM=$(echo "$CR" | jget "['adminId']")
COPT=$(body GET "/api/polls/$CPUB" '' $IP4 | jget "['options'][0]['id']")
TMP=$(mktemp -d)
for i in $(seq 1 15); do
  ( curl -s --max-time 25 -X POST "$B/api/polls/$CPUB/participants" -H 'Content-Type: application/json' \
      -H "X-Forwarded-For: 172.31.$((RANDOM % 250 + 1)).$i" -d "{\"Name\":\"c$i\"}" > "$TMP/$i.json" ) &
done
wait 2>/dev/null
is "15 simultaneous rows all persist" "$(body GET "/api/polls/$CPUB" '' $IP4 | jget "['participants'].__len__()")" 15

for i in $(seq 1 15); do
  ID=$(python3 -c "import json;print(json.load(open('$TMP/$i.json'))['id'])" 2>/dev/null)
  TOK=$(python3 -c "import json;print(json.load(open('$TMP/$i.json'))['editToken'])" 2>/dev/null)
  [ -n "$ID" ] && ( curl -s -o /dev/null --max-time 25 -X PUT "$B/api/polls/$CPUB/participants/$ID" \
      -H 'Content-Type: application/json' -H "X-Edit-Token: $TOK" \
      -H "X-Forwarded-For: 172.30.$((RANDOM % 250 + 1)).$i" -d "{\"Votes\":{\"$COPT\":\"yes\"}}" ) &
done
wait 2>/dev/null
is "15 simultaneous votes all record" "$(body GET "/api/polls/$CPUB" '' $IP4 | python3 -c "
import sys,json
rows=json.load(sys.stdin)['participants']
print(sum(1 for r in rows if r['votes'].get('$COPT')=='yes'))")" 15
rm -rf "$TMP"
code DELETE "/api/polls/$CPUB" '' $IP3 -H "X-Admin-Token: $CADM" >/dev/null

echo
echo "== cleanup =="
for pair in "$PUB:$ADM" "$XPUB:$XADM" "$YPUB:$YADM" "$UPUB:$UADM"; do
  p=${pair%%:*}; a=${pair##*:}
  [ -n "$p" ] && code DELETE "/api/polls/$p" '' $IP3 -H "X-Admin-Token: $a" >/dev/null
done
is "deleted poll is gone" "$(code GET "/api/polls/$PUB" '' $IP1)" 404

echo
echo "================================"
echo "  PASSED: $PASS    FAILED: $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ]
