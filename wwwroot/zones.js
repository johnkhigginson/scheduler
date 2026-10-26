/*
  Moves a poll time between time zones. Option times are wall clock strings in the organizer's zone
  (Poll.TimeZone), so showing one in another zone means finding the instant it names there first.
  Everything goes through Intl, which knows each zone's DST rules, rather than a fixed offset. It
  also formats instants such as the deadline, so they follow the same clock as the options.
  No DOM in here, so tests/zones.test.js runs it under node. In the browser it is the global Zones.
*/
(function (root) {
  'use strict';

  var formatters = {};

  function valid(zone) {
    if (!zone) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch (e) { return false; }
  }

  /// The date and time on the wall in zone at an instant, as "yyyy-MM-dd" and "HH:mm".
  function wallClock(ms, zone) {
    var f = formatters[zone] || (formatters[zone] = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }));
    var p = {};
    f.formatToParts(new Date(ms)).forEach(function (part) { p[part.type] = part.value; });
    return { date: p.year + '-' + p.month + '-' + p.day, time: p.hour + ':' + p.minute };
  }

  function utcOf(date, time) {
    var d = date.split('-'), t = time.split(':');
    return Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0], +t[1]);
  }

  /// How far zone's wall clock runs ahead of UTC at an instant, in milliseconds.
  function offsetAt(ms, zone) {
    var w = wallClock(ms, zone);
    return utcOf(w.date, w.time) - Math.floor(ms / 60000) * 60000;
  }

  /*
    The instant a wall clock date and time in zone refers to. The offset depends on the instant,
    which is what is being found, so the second pass corrects a first guess taken from the wrong
    side of a DST change. A time skipped by the spring change comes out an hour early, and one
    repeated by the autumn change resolves to its first occurrence.
  */
  function instantOf(date, time, zone) {
    var asUtc = utcOf(date, time);
    return asUtc - offsetAt(asUtc - offsetAt(asUtc, zone), zone);
  }

  /// A wall clock date and time in one zone, as it reads in another.
  function convert(date, time, from, to) {
    return wallClock(instantOf(date, time, from), to);
  }

  /// An instant such as the deadline or a comment's time, on zone's clock and without seconds.
  /// An undefined zone means the device's own, and an undefined locale the browser's.
  function formatInstant(ms, zone, locale) {
    return new Date(ms).toLocaleString(locale, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: zone
    });
  }

  var api = {
    valid: valid, wallClock: wallClock, instantOf: instantOf, convert: convert,
    formatInstant: formatInstant
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Zones = api;
})(this);
