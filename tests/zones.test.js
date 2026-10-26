// Checks the poll page's time zone conversion in wwwroot/zones.js under node, including both sides
// of a DST change and the week each autumn when Europe and the US are an hour out of step.
'use strict';

var Zones = require('../wwwroot/zones.js');

var failed = 0;
function is(name, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log('  PASS  ' + name);
  else { failed++; console.log('  FAIL  ' + name + '   (expected ' + e + ', got ' + a + ')'); }
}

function at(date, time) { return { date: date, time: time }; }
var DEN = 'America/Denver';

is('Denver evening reads two hours later in New York',
  Zones.convert('2026-11-05', '18:00', DEN, 'America/New_York'), at('2026-11-05', '20:00'));
is('a late Denver slot lands on the next day in London',
  Zones.convert('2026-11-05', '23:30', DEN, 'Europe/London'), at('2026-11-06', '06:30'));
is('Denver is six hours behind UTC before its DST ends',
  Zones.convert('2026-10-31', '18:00', DEN, 'UTC'), at('2026-11-01', '00:00'));
is('and seven hours behind after',
  Zones.convert('2026-11-02', '18:00', DEN, 'UTC'), at('2026-11-03', '01:00'));
is('London is seven hours ahead of Denver while both are on summer time',
  Zones.convert('2026-10-21', '09:00', DEN, 'Europe/London'), at('2026-10-21', '16:00'));
is('and six hours in the week only Europe has changed',
  Zones.convert('2026-10-28', '09:00', DEN, 'Europe/London'), at('2026-10-28', '15:00'));
is('a half hour zone keeps its half hour',
  Zones.convert('2026-11-05', '09:00', DEN, 'Asia/Kolkata'), at('2026-11-05', '21:30'));
is('a southern summer time converts back across the date line',
  Zones.convert('2026-11-05', '09:00', 'Australia/Sydney', DEN), at('2026-11-04', '15:00'));
is('an hour repeated in autumn resolves to its first occurrence',
  Zones.convert('2026-11-01', '01:30', DEN, 'UTC'), at('2026-11-01', '07:30'));
is('converting to the same zone changes nothing',
  Zones.convert('2026-03-08', '09:15', DEN, DEN), at('2026-03-08', '09:15'));
is('a real zone is valid', Zones.valid('Europe/Berlin'), true);
is('a made up zone is not', Zones.valid('Not/AZone'), false);

// 2026-11-01 07:30:45 UTC, the first 01:30 of that night in Denver, with seconds that must not show.
var COMMENTED = Date.UTC(2026, 10, 1, 7, 30, 45);
function shown(zone) { return Zones.formatInstant(COMMENTED, zone, 'en-US'); }
is('an instant shows no seconds', /\d:\d\d:\d\d/.test(shown(DEN)), false);
is('an instant reads on the voter clock', /7:30/.test(shown('UTC')), true);
is('and on the organizer clock when switched', /1:30/.test(shown(DEN)), true);
is('an instant names its zone', /MDT/.test(shown(DEN)), true);
is('an instant keeps its date across midnight', /Oct 31/.test(shown('Pacific/Honolulu')), true);

process.exit(failed ? 1 : 0);
