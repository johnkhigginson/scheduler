// Checks the create page's slot and date logic in wwwroot/slots.js under node. e2e.sh runs it with
// TZ=America/Denver so the weekday checks cross a DST change. Prints the same PASS and FAIL lines.
'use strict';

var Slots = require('../wwwroot/slots.js');

var failed = 0;
function is(name, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log('  PASS  ' + name);
  else { failed++; console.log('  FAIL  ' + name + '   (expected ' + e + ', got ' + a + ')'); }
}

function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

var MON = 1, SAT = 6, SUN = 0, FRI = 5;
var everyDay = { days: 'all', start: '09:00', end: '17:00', minutes: 60 };
var weekend = { days: [SAT, SUN], start: '10:00', end: '14:00', minutes: 60 };

is('one every day window gives its own slots',
  Slots.slotsForDow([everyDay], MON),
  ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
is('a window for certain days replaces the every day hours on those days',
  Slots.slotsForDow([everyDay, weekend], SAT), ['10:00', '11:00', '12:00', '13:00']);
is('days the second window does not name keep the every day hours',
  Slots.slotsForDow([everyDay, weekend], MON).length, 8);
is('it still replaces when the every day window is listed second',
  Slots.slotsForDow([weekend, everyDay], SUN), ['10:00', '11:00', '12:00', '13:00']);
is('two windows naming the same day are both offered on it',
  Slots.slotsForDow([everyDay, { days: [SAT], start: '10:00', end: '12:00', minutes: 60 },
    { days: [SAT], start: '15:00', end: '17:00', minutes: 60 }], SAT),
  ['10:00', '11:00', '15:00', '16:00']);
is('a day only a specific window names has no slots on other days',
  Slots.slotsForDow([weekend], MON), []);
is('a slot has to finish before closing time',
  Slots.windowSlots({ days: 'all', start: '09:00', end: '10:30', minutes: 60 }), ['09:00']);

function fridays(y, m, d) {
  return Slots.nextWeekdays(new Date(y, m - 1, d), FRI, 4).map(iso);
}
is('next 4 Fridays counts today when today is a Friday',
  fridays(2026, 10, 23), ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13']);
is('next 4 Fridays starts at the coming Friday otherwise',
  fridays(2026, 10, 24), ['2026-10-30', '2026-11-06', '2026-11-13', '2026-11-20']);
is('next 4 Fridays from a Thursday starts the next day',
  fridays(2026, 12, 31), ['2027-01-01', '2027-01-08', '2027-01-15', '2027-01-22']);
is('next 4 Fridays are all Fridays across a DST change',
  Slots.nextWeekdays(new Date(2026, 9, 26), FRI, 4).map(function (d) { return d.getDay(); }),
  [FRI, FRI, FRI, FRI]);

process.exit(failed ? 1 : 0);
