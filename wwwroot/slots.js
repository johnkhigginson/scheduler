/*
  Slot and date arithmetic for the create page, kept apart from create.js so tests/slots.test.js can
  run it under node. Nothing in here touches the DOM. In the browser it is the global Slots.
*/
(function (root) {
  'use strict';

  var MAX_SLOTS_PER_DAY = 48;   // 15 minute slots across a 12 hour day

  function toMinutes(hhmm) {
    if (!hhmm) return null;
    var p = hhmm.split(':');
    return (+p[0]) * 60 + (+p[1]);
  }

  function fromMinutes(m) {
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  /// Slot starts inside one window, every one long enough to finish before closing time.
  function windowSlots(w) {
    var start = toMinutes(w.start);
    var end = toMinutes(w.end);
    if (start === null || end === null || !w.minutes || end <= start) return [];

    var out = [];
    for (var m = start; m + w.minutes <= end && out.length < MAX_SLOTS_PER_DAY; m += w.minutes) {
      out.push(fromMinutes(m));
    }
    return out;
  }

  function windowCovers(w, dow) {
    return w.days === 'all' || w.days.indexOf(dow) !== -1;
  }

  /*
    Every slot offered on one weekday. A window for certain days replaces the every day hours on
    those days. Merging them instead meant a 10 to 2 Saturday window still offered the 9 to 5
    weekday slots on Saturday, which is the opposite of why anyone adds one.
  */
  function slotsForDow(windows, dow) {
    var specific = windows.filter(function (w) { return w.days !== 'all' && windowCovers(w, dow); });
    var applied = specific.length ? specific : windows.filter(function (w) { return w.days === 'all'; });

    var seen = {};
    applied.forEach(function (w) {
      windowSlots(w).forEach(function (t) { seen[t] = true; });
    });
    return Object.keys(seen).sort();
  }

  /// The next count dates falling on dow, counting from today when today is one.
  function nextWeekdays(today, dow, count) {
    var offset = (dow - today.getDay() + 7) % 7;
    var out = [];
    for (var i = 0; i < count; i++) {
      // Built from parts rather than by adding milliseconds, so a DST change cannot shift the day.
      out.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset + i * 7));
    }
    return out;
  }

  var api = {
    toMinutes: toMinutes,
    fromMinutes: fromMinutes,
    windowSlots: windowSlots,
    slotsForDow: slotsForDow,
    nextWeekdays: nextWeekdays
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Slots = api;
})(this);
