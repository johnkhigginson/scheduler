(function () {
  'use strict';

  var PUBLIC_ID = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  var MARK = { yes: '✓', maybe: '?', no: '✕' };
  // The marks are glyphs, so every cell also carries a spoken label.
  var SAID = { yes: 'Yes', maybe: 'Maybe', no: 'No' };
  var DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var poll = null;
  var editing = null; // { id: 'new' | participantId, name, votes }
  var freshIds = {};  // rows that arrived since the last refresh, highlighted briefly

  // ---------- local secrets ----------
  // Admin and edit tokens live in localStorage on the device that owns them.
  // The admin token arrives in the URL fragment so it never hits the server logs.

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private mode, tokens just will not persist */ }
    return null;
  }

  function captureAdminToken() {
    var match = /(?:^|[#&])a=([A-Za-z0-9]+)/.exec(location.hash);
    if (match) {
      store('admin:' + PUBLIC_ID, match[1]);
      history.replaceState(null, '', location.pathname);
    }
    return store('admin:' + PUBLIC_ID);
  }

  var adminToken = captureAdminToken();

  function mine() {
    var raw = store('me:' + PUBLIC_ID);
    return raw ? JSON.parse(raw) : null;
  }

  function commentTokens() {
    var raw = store('comments:' + PUBLIC_ID);
    return raw ? JSON.parse(raw) : {};
  }

  // ---------- api ----------

  async function api(method, path, body, editToken) {
    var headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (adminToken) headers['X-Admin-Token'] = adminToken;
    if (editToken) headers['X-Edit-Token'] = editToken;

    var res = await fetch('/api' + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    });

    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
    return data;
  }

  // ---------- formatting ----------

  function parseDate(iso) {
    var parts = iso.split('-');
    return new Date(+parts[0], +parts[1] - 1, +parts[2]);
  }

  function formatTime(hhmm) {
    if (!hhmm) return 'All day';
    var parts = hhmm.split(':');
    var hour = +parts[0];
    var suffix = hour >= 12 ? 'PM' : 'AM';
    var display = hour % 12 || 12;
    return display + ':' + parts[1] + ' ' + suffix;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // Inline messages instead of alert(). A native dialog blocks the tab, ignores the page's design
  // and on mobile appears with the site's domain in a way that reads like a scam prompt.
  var noticeTimer = null;

  function notice(message, kind) {
    var box = document.getElementById('notice');
    clearTimeout(noticeTimer);
    if (!message) { box.hidden = true; return; }
    box.className = 'notice ' + (kind || 'info');
    box.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (kind === 'ok') noticeTimer = setTimeout(function () { box.hidden = true; }, 4000);
  }

  function relative(date) {
    var ms = date.getTime() - Date.now();
    if (ms <= 0) return 'now';
    var mins = Math.round(ms / 60000);
    if (mins < 60) return 'in ' + mins + ' minute' + (mins === 1 ? '' : 's');
    var hours = Math.round(mins / 60);
    if (hours < 48) return 'in ' + hours + ' hour' + (hours === 1 ? '' : 's');
    return 'in ' + Math.round(hours / 24) + ' days';
  }

  // ---------- calendar export ----------

  function icsEscape(text) {
    return String(text)
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  // RFC 5545 caps a content line at 75 octets. Continuation lines begin with one space.
  function fold(line) {
    var out = [];
    while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
    out.push(line);
    return out.join('\r\n');
  }

  function utcStamp(d) {
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }

  function localStamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' +
      pad(d.getHours()) + pad(d.getMinutes()) + '00';
  }

  function icsFor(winners) {
    var now = utcStamp(new Date());
    var url = location.origin + '/p/' + poll.publicId;
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Scheduler//EN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];

    winners.forEach(function (row) {
      var option = row.option;
      var compact = option.date.replace(/-/g, '');

      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + poll.publicId + '-' + option.id + '@scheduler');
      lines.push('DTSTAMP:' + now);

      if (option.time) {
        // Floating local time on purpose. The stored time is a naive wall clock in whatever zone
        // the organizer was in, so pinning it to UTC would move the meeting for everybody else.
        var start = parseDate(option.date);
        var hm = option.time.split(':');
        start.setHours(+hm[0], +hm[1], 0, 0);
        lines.push('DTSTART:' + localStamp(start));
        lines.push('DTEND:' + localStamp(new Date(start.getTime() + 3600000)));
      } else {
        var next = parseDate(option.date);
        next.setDate(next.getDate() + 1);
        lines.push('DTSTART;VALUE=DATE:' + compact);
        lines.push('DTEND;VALUE=DATE:' + localStamp(next).slice(0, 8));
      }

      lines.push('SUMMARY:' + icsEscape(poll.title));
      var description = 'Poll: ' + url +
        (poll.organizerName ? '\nOrganized by ' + poll.organizerName : '') +
        (poll.timeZone && option.time ? '\nTime as entered in ' + poll.timeZone : '');
      lines.push('DESCRIPTION:' + icsEscape(description));
      lines.push('URL:' + url);
      lines.push('END:VEVENT');
    });

    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  function downloadIcs(winners) {
    var blob = new Blob([icsFor(winners)], { type: 'text/calendar;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = (poll.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'poll') + '.ics';
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 0);
  }

  // ---------- tallies ----------

  function tallies() {
    return poll.options.map(function (option) {
      var yes = 0, maybe = 0, no = 0;
      poll.participants.forEach(function (p) {
        var vote = p.votes[option.id];
        if (vote === 'yes') yes++;
        else if (vote === 'maybe') maybe++;
        else if (vote === 'no') no++;
      });
      return { option: option, yes: yes, maybe: maybe, no: no, score: yes * 2 + maybe };
    });
  }

  function bestIds(rows) {
    var best = 0;
    rows.forEach(function (r) { if (r.score > best) best = r.score; });
    if (!best) return {};
    var map = {};
    rows.forEach(function (r) { if (r.score === best) map[r.option.id] = true; });
    return map;
  }

  // ---------- render ----------

  function render() {
    document.getElementById('title').textContent = poll.title;
    document.title = poll.title + ' | Scheduler';

    var organizer = document.getElementById('organizer');
    organizer.textContent = poll.organizerName ? 'Organized by ' + poll.organizerName : '';
    organizer.hidden = !poll.organizerName;

    var description = document.getElementById('description');
    description.textContent = poll.description || '';
    description.hidden = !poll.description;

    document.getElementById('closed-banner').hidden = !poll.closed;
    document.getElementById('share-link').value = location.origin + '/p/' + poll.publicId;

    var adminCard = document.getElementById('admin-card');
    adminCard.hidden = !poll.isAdmin;
    if (poll.isAdmin) {
      renderAdmin();
      // Keeps the home page list of this device's polls named and dated, including polls that
      // were remembered before that list existed.
      store('poll:' + PUBLIC_ID, JSON.stringify({ title: poll.title, created: poll.createdUtc }));
    }

    renderNotes();
    renderGrid();
    renderEditor();
    renderActions();
    renderComments();

    document.getElementById('status').hidden = true;
    document.getElementById('poll').hidden = false;
  }

  // A wrong date used to mean deleting the poll and losing every vote with it, so the organizer
  // can now add and remove dates in place.
  function renderAdmin() {
    document.getElementById('toggle-closed').textContent = poll.closed ? 'Reopen voting' : 'Close voting';
    document.getElementById('admin-allow-maybe').checked = !!poll.allowMaybe;

    var list = document.getElementById('admin-options');
    list.textContent = '';

    // Grouped by day. One row per option meant a poll built from time slots produced a list
    // hundreds of rows long here, for what is a rarely used panel.
    var groups = [];
    poll.options.forEach(function (option) {
      var last = groups[groups.length - 1];
      if (last && last.date === option.date) last.options.push(option);
      else groups.push({ date: option.date, options: [option] });
    });

    groups.forEach(function (group) {
      var date = parseDate(group.date);
      var row = el('div', 'admin-option');
      row.appendChild(el('span', 'admin-option-date',
        date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })));

      var chips = el('div', 'chips');
      group.options.forEach(function (option) {
        var label = option.time ? formatTime(option.time) : 'All day';
        var chip = el('button', 'chip removable', label);
        chip.type = 'button';
        chip.appendChild(el('span', 'chip-x', '×'));
        chip.setAttribute('aria-label', 'Remove ' + label + ' on ' + spokenDate(date));
        chip.addEventListener('click', function () { removeOption(option); });
        chips.appendChild(chip);
      });

      row.appendChild(chips);
      list.appendChild(row);
    });
  }

  async function removeOption(option) {
    var answered = poll.participants.filter(function (p) { return p.votes[option.id]; }).length;
    if (!confirm(answered
      ? 'Removing this date also deletes ' + answered + ' answer' + (answered === 1 ? '' : 's') +
        ' already given on it. Continue?'
      : 'Remove this date from the poll?')) return;

    try {
      await api('DELETE', '/polls/' + PUBLIC_ID + '/options/' + option.id);
      await load();
      notice('Date removed.', 'ok');
    } catch (err) {
      notice(err.message, 'error');
    }
  }

  document.getElementById('add-option').addEventListener('click', async function () {
    var dateEl = document.getElementById('new-option-date');
    var timeEl = document.getElementById('new-option-time');
    if (!dateEl.value) { notice('Pick a date to add.', 'error'); return; }

    try {
      await api('POST', '/polls/' + PUBLIC_ID + '/options',
        { options: [{ date: dateEl.value, time: timeEl.value || null }] });
      dateEl.value = '';
      timeEl.value = '';
      await load();
      notice('Date added.', 'ok');
    } catch (err) {
      notice(err.message, 'error');
    }
  });

  document.getElementById('admin-allow-maybe').addEventListener('change', async function (e) {
    var wanted = e.target.checked;
    var existing = poll.participants.filter(function (p) {
      return Object.keys(p.votes).some(function (k) { return p.votes[k] === 'maybe'; });
    }).length;

    if (!wanted && existing && !confirm(
      existing + ' ' + (existing === 1 ? 'person has' : 'people have') + ' already answered maybe. ' +
      'Those answers stay on the board but nobody can pick maybe again. Continue?')) {
      e.target.checked = true;
      return;
    }

    try {
      await api('PATCH', '/polls/' + PUBLIC_ID, { allowMaybe: wanted });
      await load();
      notice(wanted ? 'Maybe is now offered.' : 'Maybe is switched off.', 'ok');
    } catch (err) {
      notice(err.message, 'error');
      e.target.checked = !wanted;
    }
  });

  function renderNotes() {
    document.getElementById('legend-maybe').hidden = !maybeInPlay();

    // Option times are naive wall clock strings. Saying which zone they were entered in is the
    // honest fix. Converting them would be a guess, because no offset was ever recorded.
    var tzNote = document.getElementById('tz-note');
    var timed = poll.options.some(function (o) { return !!o.time; });
    if (timed && poll.timeZone) {
      var here = null;
      try { here = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* older browser */ }
      tzNote.textContent = 'Times are shown as the organizer entered them, in ' + poll.timeZone + '.' +
        (here && here !== poll.timeZone ? ' Your device is in ' + here + ', so convert before you commit.' : '');
      tzNote.hidden = false;
    } else if (timed) {
      // Saying nothing here hid the ambiguity in exactly the case where it mattered most: times
      // exist, but nothing records which clock they belong to.
      tzNote.textContent = 'Times are shown as the organizer entered them. Their timezone was not ' +
        'recorded, so check with them if you are somewhere else.';
      tzNote.hidden = false;
    } else {
      tzNote.hidden = true;
    }

    var deadlineNote = document.getElementById('deadline-note');
    if (poll.deadlineUtc) {
      var when = new Date(poll.deadlineUtc);
      deadlineNote.textContent = poll.closedByDeadline
        ? 'Voting closed automatically on ' + when.toLocaleString() + '.'
        : 'Voting closes ' + when.toLocaleString() + ', ' + relative(when) + '.';
      deadlineNote.hidden = false;
    } else {
      deadlineNote.hidden = true;
    }
  }

  function renderGrid() {
    var rows = tallies();
    var best = bestIds(rows);

    var dayRow = document.getElementById('head-days');
    var head = document.getElementById('head-row');
    dayRow.textContent = '';
    head.textContent = '';

    // Consecutive options on the same date become one spanning header. With generated slots a
    // single day owns a dozen columns, and repeating the date above every one of them is what
    // made a wide grid unreadable.
    var groups = [];
    poll.options.forEach(function (option) {
      var last = groups[groups.length - 1];
      if (last && last.date === option.date) last.options.push(option);
      else groups.push({ date: option.date, options: [option] });
    });

    var grouped = groups.some(function (g) { return g.options.length > 1; });
    dayRow.hidden = !grouped;

    // First column of each day, so the boundary can be drawn down the whole table. Only useful
    // when a day owns several columns; otherwise every column would get a divider.
    var dayStart = {};
    if (grouped) {
      groups.forEach(function (group) { dayStart[group.options[0].id] = true; });
    }

    if (grouped) {
      dayRow.appendChild(el('th', 'name-col'));
      groups.forEach(function (group) {
        var date = parseDate(group.date);
        var th = el('th', 'day-group');
        th.colSpan = group.options.length;
        th.scope = 'colgroup';
        th.appendChild(el('span', 'col-dow', date.toLocaleDateString(undefined, { weekday: 'short' })));
        th.appendChild(el('span', 'col-date',
          date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
        dayRow.appendChild(th);
      });
    }

    head.appendChild(el('th', 'name-col', 'Participant'));
    poll.options.forEach(function (option) {
      var date = parseDate(option.date);
      var th = el('th', (best[option.id] ? 'best' : '') + (dayStart[option.id] ? ' daystart' : ''));
      th.scope = 'col';
      if (!grouped) {
        th.appendChild(el('span', 'col-dow', date.toLocaleDateString(undefined, { weekday: 'short' })));
        th.appendChild(el('span', 'col-date',
          date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
      }
      th.appendChild(el('span', 'col-time', formatTime(option.time)));
      head.appendChild(th);
    });

    var body = document.getElementById('body-rows');
    body.textContent = '';
    var bodyFrag = document.createDocumentFragment();
    var me = mine();

    poll.participants.forEach(function (participant) {
      var rowClass = (me && me.id === participant.id ? 'mine ' : '') +
        (freshIds[participant.id] ? 'fresh' : '');
      var tr = el('tr', rowClass.trim());
      // A row header, so a screen reader announces whose row a cell belongs to.
      var nameCell = el('th', 'name-col');
      nameCell.scope = 'row';
      nameCell.appendChild(document.createTextNode(participant.name));

      if ((me && me.id === participant.id) || poll.isAdmin) {
        var tools = el('span', 'row-tools');
        var edit = el('button', 'link', 'Edit');
        edit.addEventListener('click', function () { startEdit(participant); });
        var remove = el('button', 'link', 'Delete');
        remove.addEventListener('click', function () { deleteParticipant(participant); });
        tools.appendChild(edit);
        tools.appendChild(remove);
        nameCell.appendChild(tools);
      }
      tr.appendChild(nameCell);

      poll.options.forEach(function (option) {
        var vote = participant.votes[option.id] || null;
        var td = el('td', (best[option.id] ? 'best' : '') + (dayStart[option.id] ? ' daystart' : ''));
        var pill = el('span', 'pill ' + (vote || 'none'), vote ? MARK[vote] : '·');
        pill.setAttribute('role', 'img');
        pill.setAttribute('aria-label', vote ? SAID[vote] : 'No answer');
        td.appendChild(pill);
        tr.appendChild(td);
      });
      bodyFrag.appendChild(tr);
    });

    body.appendChild(bodyFrag);

    if (!poll.participants.length) {
      var empty = el('tr');
      var cell = el('td', 'muted', 'Nobody has voted yet. Be the first.');
      cell.colSpan = poll.options.length + 1;
      empty.appendChild(cell);
      body.appendChild(empty);
    }

    var tally = document.getElementById('tally-row');
    tally.textContent = '';
    var tallyHead = el('th', 'name-col', maybeInPlay() ? 'Yes / Maybe' : 'Yes');
    tallyHead.scope = 'row';
    tally.appendChild(tallyHead);
    rows.forEach(function (row) {
      var td = el('td', (best[row.option.id] ? 'best' : '') + (dayStart[row.option.id] ? ' daystart' : ''));
      td.appendChild(document.createTextNode(String(row.yes)));
      // Only where there is actually a maybe. Printing "0 maybe" under every column repeated the
      // word a dozen times and buried the counts that matter.
      if (maybeInPlay() && row.maybe > 0) td.appendChild(el('span', 'tally-sub', row.maybe + ' maybe'));
      tally.appendChild(td);
    });

    renderWinner(rows, best);
  }

  var MAX_WINNERS_LISTED = 3;

  function optionLabel(option) {
    return parseDate(option.date).toLocaleDateString(undefined,
      { weekday: 'long', month: 'long', day: 'numeric' }) +
      (option.time ? ' at ' + formatTime(option.time) : '');
  }

  function calendarButton(banner, winners, label) {
    var download = el('button', null, label);
    download.style.marginLeft = '12px';
    download.addEventListener('click', function () { downloadIcs(winners); });
    banner.appendChild(download);
  }

  /*
    Early on, before anyone disagrees, every option is tied. Listing all of them produced a wall of
    eighty dates that said nothing, so past a handful this summarises instead: how many are tied,
    what they are tied on, and the one date worth acting on.
  */
  function renderWinner(rows, best) {
    var banner = document.getElementById('winner');
    banner.textContent = '';
    var winners = rows.filter(function (r) { return best[r.option.id]; });

    if (!winners.length || !poll.participants.length) { banner.hidden = true; return; }

    var people = poll.participants.length;
    // One phrase that reads correctly both in brackets and after "tied on".
    var score = maybeInPlay()
      ? winners[0].yes + ' yes and ' + winners[0].maybe + ' maybe of ' + people
      : winners[0].yes + ' of ' + people + ' yes';

    if (winners.length > MAX_WINNERS_LISTED) {
      banner.appendChild(el('strong', null, 'No clear winner yet.'));
      banner.appendChild(document.createTextNode(
        winners.length === poll.options.length
          ? ' Every option has the same answers so far (' + score + '). Earliest is '
          : ' ' + winners.length + ' options are tied on ' + score + '. Earliest is '));
      banner.appendChild(el('strong', null, optionLabel(winners[0].option)));
      banner.appendChild(document.createTextNode('.'));
      calendarButton(banner, [winners[0]], 'Add the earliest');
      banner.hidden = false;
      return;
    }

    banner.appendChild(document.createTextNode(winners.length > 1 ? 'Tied at the top: ' : 'Best so far: '));
    banner.appendChild(el('strong', null,
      winners.map(function (r) { return optionLabel(r.option); }).join('  /  ')));
    banner.appendChild(document.createTextNode('  (' + score + ')'));
    calendarButton(banner, winners,
      winners.length === 1 ? 'Add to calendar' : 'Add all ' + winners.length + ' to calendar');
    banner.hidden = false;
  }

  // One tap, one answer. The old grid cell cycled yes to maybe to no to clear on repeated clicks,
  // which is invisible unless you already know it is there, and fiddly on a phone.
  /// What a voter can pick. Strictly what the organizer offers right now.
  function answers() { return poll.allowMaybe ? ['yes', 'maybe', 'no'] : ['yes', 'no']; }

  /*
    What the results have to explain, which is not the same thing. Maybe can be switched off after
    answers were already given, and those answers stay and keep counting toward the score. Hiding
    the legend and the tally line in that state left a mark on screen with nothing accounting for
    it, and a score nobody could reconcile.
  */
  function maybeInPlay() {
    return poll.allowMaybe || poll.participants.some(function (p) {
      return Object.keys(p.votes).some(function (id) { return p.votes[id] === 'maybe'; });
    });
  }

  // Bulk answering, shaped as one sentence: set ANSWER for DAYS at TIME. That covers the things
  // people actually ask for, such as yes to every weekday at 9am, without a separate control for
  // each of them.
  var qf = { answer: 'yes', days: 'all', time: 'any' };

  function pollWeekdays() {
    var seen = {};
    poll.options.forEach(function (o) { seen[parseDate(o.date).getDay()] = true; });
    return [1, 2, 3, 4, 5, 6, 0].filter(function (d) { return seen[d]; });
  }

  function pollTimes() {
    var seen = {};
    poll.options.forEach(function (o) { if (o.time) seen[o.time] = true; });
    return Object.keys(seen).sort();
  }

  function qfMatches(option) {
    if (qf.days !== 'all' && parseDate(option.date).getDay() !== qf.days) return false;
    if (qf.time !== 'any' && option.time !== qf.time) return false;
    return true;
  }

  function renderQuickFill() {
    var box = document.getElementById('quickfill');
    box.textContent = '';

    var weekdays = pollWeekdays();
    var times = pollTimes();

    var line = el('div', 'qf-line');
    line.appendChild(el('span', 'qf-word', 'Set'));

    var answerGroup = el('div', 'seg');
    answerGroup.setAttribute('role', 'group');
    answerGroup.setAttribute('aria-label', 'Answer to apply');
    answers().concat(['clear']).forEach(function (value) {
      var on = qf.answer === value;
      var button = el('button', 'seg-item ' + value + (on ? ' on' : ''),
        value === 'clear' ? 'No answer' : SAID[value]);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.addEventListener('click', function () { qf.answer = value; renderQuickFill(); });
      answerGroup.appendChild(button);
    });
    line.appendChild(answerGroup);

    line.appendChild(el('span', 'qf-word', 'for'));

    var dayGroup = el('div', 'seg');
    dayGroup.setAttribute('role', 'group');
    dayGroup.setAttribute('aria-label', 'Days to apply it to');
    var everyDay = el('button', 'seg-item' + (qf.days === 'all' ? ' on' : ''), 'Every day');
    everyDay.setAttribute('aria-pressed', qf.days === 'all' ? 'true' : 'false');
    everyDay.addEventListener('click', function () { qf.days = 'all'; renderQuickFill(); });
    dayGroup.appendChild(everyDay);

    weekdays.forEach(function (dow) {
      var on = qf.days === dow;
      var button = el('button', 'seg-item' + (on ? ' on' : ''), DOW_SHORT[dow]);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.addEventListener('click', function () { qf.days = dow; renderQuickFill(); });
      dayGroup.appendChild(button);
    });
    line.appendChild(dayGroup);

    if (times.length) {
      line.appendChild(el('span', 'qf-word', 'at'));
      var select = document.createElement('select');
      select.className = 'qf-time';
      select.setAttribute('aria-label', 'Time to apply it to');
      var any = document.createElement('option');
      any.value = 'any';
      any.textContent = 'any time';
      select.appendChild(any);
      times.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t;
        opt.textContent = formatTime(t);
        select.appendChild(opt);
      });
      select.value = qf.time;
      select.addEventListener('change', function () { qf.time = select.value; renderQuickFill(); });
      line.appendChild(select);
    }

    var apply = el('button', 'primary qf-apply', 'Apply');
    apply.addEventListener('click', function () {
      if (!editing) return;
      poll.options.forEach(function (option) {
        if (!qfMatches(option)) return;
        if (qf.answer === 'clear') delete editing.votes[option.id];
        else editing.votes[option.id] = qf.answer;
      });
      renderEditor();
    });
    line.appendChild(apply);

    box.appendChild(line);

    var count = poll.options.filter(qfMatches).length;
    box.appendChild(el('p', 'qf-count',
      count === poll.options.length
        ? 'Applies to all ' + count + ' options'
        : 'Applies to ' + count + ' of ' + poll.options.length + ' options'));
  }

  function renderEditor() {
    var panel = document.getElementById('vote-editor');
    if (!editing) { panel.hidden = true; return; }

    document.getElementById('vote-editor-title').textContent =
      editing.id === 'new' ? 'Add your availability' : 'Edit your availability';

    var nameInput = document.getElementById('vote-name');
    if (nameInput.value !== (editing.name || '')) nameInput.value = editing.name || '';

    renderQuickFill();

    var list = document.getElementById('vote-list');
    list.textContent = '';

    // Built in a fragment and attached once. Appending three hundred rows one at a time made
    // opening the editor on a large poll take most of a second.
    var frag = document.createDocumentFragment();

    // One card per day. At three hundred options the day boundary is the only thing keeping this
    // readable, so it is a card edge rather than a heading in the flow.
    var groups = [];
    poll.options.forEach(function (option) {
      var last = groups[groups.length - 1];
      if (last && last.date === option.date) last.options.push(option);
      else groups.push({ date: option.date, options: [option] });
    });

    groups.forEach(function (group) {
      var date = parseDate(group.date);
      var answered = group.options.filter(function (o) { return editing.votes[o.id]; }).length;
      var card = el('section', 'day-card' + (answered === group.options.length ? ' done' : ''));

      var head = el('div', 'day-card-head');
      var title = el('div', 'day-card-title');
      title.appendChild(el('strong', null, date.toLocaleDateString(undefined, { weekday: 'long' })));
      title.appendChild(el('span', 'day-card-date',
        date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })));
      head.appendChild(title);

      // Only worth showing progress when a day holds more than one thing to answer.
      if (group.options.length > 1) {
        head.appendChild(el('span', 'day-card-count', answered + ' of ' + group.options.length));
      }

      // The common case is that a whole day works or does not.
      var quick = el('div', 'day-card-quick');
      answers().forEach(function (value) {
        var button = el('button', 'seg-item ' + value, SAID[value]);
        button.setAttribute('aria-label', SAID[value] + ' for every time on ' + spokenDate(date));
        button.addEventListener('click', function () {
          group.options.forEach(function (o) { editing.votes[o.id] = value; });
          renderEditor();
        });
        quick.appendChild(button);
      });
      head.appendChild(quick);
      card.appendChild(head);

      group.options.forEach(function (option) { card.appendChild(voteRow(option, date)); });
      frag.appendChild(card);
    });

    list.appendChild(frag);
    panel.hidden = false;
  }

  function spokenDate(date) {
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function voteRow(option, date) {
    var spoken = spokenDate(date) + (option.time ? ' at ' + formatTime(option.time) : '');

    var row = el('div', 'vote-row');
    var when = el('div', 'vote-when');
    when.appendChild(el('strong', null, option.time ? formatTime(option.time) : 'All day'));
    row.appendChild(when);

    var group = el('div', 'choices');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', spoken);

    var buttons = [];
    function paint() {
      buttons.forEach(function (entry) {
        var on = editing.votes[option.id] === entry.value;
        entry.node.className = 'choice ' + entry.value + (on ? ' on' : '');
        entry.node.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      row.classList.toggle('answered', !!editing.votes[option.id]);
    }

    answers().forEach(function (value) {
      var button = el('button', 'choice ' + value, SAID[value]);
      button.setAttribute('aria-label', SAID[value] + ' for ' + spoken);
      button.addEventListener('click', function () {
        // Tapping the answer you already gave clears it, so there is a way back to no answer.
        if (editing.votes[option.id] === value) delete editing.votes[option.id];
        else editing.votes[option.id] = value;
        paint();
        // The day header shows a count and a done state, so it has to follow the row.
        refreshDayHead(row);
      });
      buttons.push({ value: value, node: button });
      group.appendChild(button);
    });

    paint();
    row.appendChild(group);
    return row;
  }

  /// Keeps one day's header in step with its rows without rebuilding the whole editor, which would
  /// lose the scroll position halfway down a long poll.
  function refreshDayHead(row) {
    var card = row.closest('.day-card');
    if (!card) return;
    var rows = card.querySelectorAll('.vote-row');
    var answered = card.querySelectorAll('.vote-row.answered').length;
    var count = card.querySelector('.day-card-count');
    if (count) count.textContent = answered + ' of ' + rows.length;
    card.classList.toggle('done', answered === rows.length);
  }

  function openEditor(participant) {
    editing = participant
      ? { id: participant.id, name: participant.name, votes: Object.assign({}, participant.votes) }
      : { id: 'new', name: '', votes: {} };
    renderEditor();
    renderActions();
    document.getElementById('vote-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Focus follows the panel whether adding or editing, otherwise a keyboard user is left behind
    // where the button used to be.
    setTimeout(function () { document.getElementById('vote-name').focus(); }, 250);
  }

  function closeEditor() {
    editing = null;
    renderEditor();
    renderActions();
  }

  document.getElementById('vote-name').addEventListener('input', function (e) {
    if (editing) editing.name = e.target.value;
  });

  document.getElementById('vote-save').addEventListener('click', saveEdit);
  document.getElementById('vote-cancel').addEventListener('click', closeEditor);

  function renderActions() {
    var actions = document.getElementById('grid-actions');
    actions.textContent = '';

    // While the editor is open it owns the save and cancel buttons, so nothing goes here.
    if (editing) return;

    if (poll.closed && !poll.isAdmin) {
      actions.appendChild(el('span', 'muted', 'Voting is closed.'));
      return;
    }

    var me = mine();
    var existing = me && poll.participants.filter(function (p) { return p.id === me.id; })[0];

    if (existing) {
      var edit = el('button', 'primary', 'Edit my availability');
      edit.addEventListener('click', function () { openEditor(existing); });
      actions.appendChild(edit);
    } else {
      var add = el('button', 'primary', 'Add my availability');
      add.addEventListener('click', function () { openEditor(null); });
      actions.appendChild(add);
    }
  }

  function renderComments() {
    var list = document.getElementById('comments');
    list.textContent = '';
    var tokens = commentTokens();

    if (!poll.comments.length) {
      list.appendChild(el('p', 'muted', 'No comments yet.'));
      return;
    }

    poll.comments.forEach(function (comment) {
      var wrap = el('div', 'comment');
      var meta = el('div', 'meta');
      meta.appendChild(el('b', null, comment.name));
      meta.appendChild(document.createTextNode('  ' + new Date(comment.createdUtc).toLocaleString()));

      var body = el('div', 'body', comment.text);

      if (tokens[comment.id] || poll.isAdmin) {
        var edit = el('button', 'link', 'Edit');
        edit.addEventListener('click', function () { editComment(comment, tokens[comment.id], body); });
        meta.appendChild(edit);

        var remove = el('button', 'link', 'Delete');
        remove.addEventListener('click', function () { deleteComment(comment, tokens[comment.id]); });
        meta.appendChild(remove);
      }

      wrap.appendChild(meta);
      wrap.appendChild(body);
      list.appendChild(wrap);
    });
  }

  // ---------- actions ----------

  function startEdit(participant) { openEditor(participant); }

  async function saveEdit() {
    var name = (editing.name || '').trim();
    if (!name) {
      notice('Enter your name first.', 'error');
      document.getElementById('vote-name').focus();
      return;
    }

    // Nothing acknowledged the tap before, so on a slow connection the natural move was to press
    // Save again.
    var button = document.getElementById('vote-save');
    var label = button.textContent;
    button.disabled = true;
    button.textContent = 'Saving...';

    try {
      if (editing.id === 'new') {
        var created = await api('POST', '/polls/' + PUBLIC_ID + '/participants',
          { name: name, votes: editing.votes });
        store('me:' + PUBLIC_ID, JSON.stringify({ id: created.id, token: created.editToken }));
      } else {
        var me = mine();
        var token = me && me.id === editing.id ? me.token : null;
        await api('PUT', '/polls/' + PUBLIC_ID + '/participants/' + editing.id,
          { name: name, votes: editing.votes }, token);
      }
      editing = null;
      await load();
      notice('Saved. Your availability is on the board.', 'ok');
    } catch (err) {
      notice(err.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  async function deleteParticipant(participant) {
    if (!confirm('Remove ' + participant.name + ' from this poll?')) return;
    var me = mine();
    var token = me && me.id === participant.id ? me.token : null;
    try {
      await api('DELETE', '/polls/' + PUBLIC_ID + '/participants/' + participant.id, null, token);
      if (me && me.id === participant.id) store('me:' + PUBLIC_ID, null);
      await load();
    } catch (err) {
      notice(err.message, 'error');
    }
  }

  // Fixing a typo used to mean deleting the comment and reposting it at the bottom of the thread.
  function editComment(comment, token, bodyEl) {
    var area = document.createElement('textarea');
    area.value = comment.text;
    area.maxLength = 2000;

    var save = el('button', 'primary', 'Save');
    var cancel = el('button', null, 'Cancel');
    var actions = el('div', 'actions');
    actions.appendChild(save);
    actions.appendChild(cancel);

    bodyEl.textContent = '';
    bodyEl.appendChild(area);
    bodyEl.appendChild(actions);
    area.focus();

    cancel.addEventListener('click', renderComments);

    save.addEventListener('click', async function () {
      var text = area.value.trim();
      if (!text) { notice('A comment cannot be empty.', 'error'); return; }
      save.disabled = true;
      try {
        await api('PUT', '/polls/' + PUBLIC_ID + '/comments/' + comment.id, { text: text }, token);
        await load();
        notice('Comment updated.', 'ok');
      } catch (err) {
        notice(err.message, 'error');
        save.disabled = false;
      }
    });
  }

  async function deleteComment(comment, token) {
    if (!confirm('Delete this comment?')) return;
    try {
      await api('DELETE', '/polls/' + PUBLIC_ID + '/comments/' + comment.id, null, token);
      var tokens = commentTokens();
      delete tokens[comment.id];
      store('comments:' + PUBLIC_ID, JSON.stringify(tokens));
      await load();
    } catch (err) {
      notice(err.message, 'error');
    }
  }

  document.getElementById('add-comment').addEventListener('click', async function (e) {
    var nameEl = document.getElementById('comment-name');
    var textEl = document.getElementById('comment-text');
    var name = nameEl.value.trim();
    var text = textEl.value.trim();
    if (!name || !text) { notice('Name and comment are both required.', 'error'); return; }

    e.currentTarget.disabled = true;
    try {
      var created = await api('POST', '/polls/' + PUBLIC_ID + '/comments', { name: name, text: text });
      var tokens = commentTokens();
      tokens[created.id] = created.editToken;
      store('comments:' + PUBLIC_ID, JSON.stringify(tokens));
      textEl.value = '';
      await load();
    } catch (err) {
      notice(err.message, 'error');
    } finally {
      e.currentTarget.disabled = false;
    }
  });

  document.getElementById('toggle-closed').addEventListener('click', async function () {
    try {
      var body = { closed: !poll.closed };
      // Reopening a poll that ran out of time has to drop the deadline as well, otherwise the
      // deadline closes it again on the very next read and the button looks broken.
      if (poll.closed && poll.closedByDeadline) body.deadline = '';
      await api('PATCH', '/polls/' + PUBLIC_ID, body);
      await load();
    } catch (err) {
      notice(err.message, 'error');
    }
  });

  document.getElementById('delete-poll').addEventListener('click', async function () {
    if (!confirm('Delete this poll and every vote in it? This cannot be undone.')) return;
    try {
      await api('DELETE', '/polls/' + PUBLIC_ID);
      store('admin:' + PUBLIC_ID, null);
      store('poll:' + PUBLIC_ID, null);
      store('me:' + PUBLIC_ID, null);
      location.href = '/';
    } catch (err) {
      notice(err.message, 'error');
    }
  });

  document.addEventListener('click', function (e) {
    var target = e.target.closest('[data-copy]');
    if (!target) return;
    var input = document.getElementById(target.getAttribute('data-copy'));
    input.select();

    // The success path used to be the only path. Where the clipboard API is blocked or denied the
    // button did nothing at all and said nothing, on the one control standing between the organizer
    // and a link they cannot recover.
    var original = target.textContent;
    function done(label, hold) {
      target.textContent = label;
      setTimeout(function () { target.textContent = original; }, hold);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(
        function () { done('Copied', 1400); },
        function () { done('Press Ctrl C', 2600); });
    } else {
      done('Press Ctrl C', 2600);
    }
  });

  var knownVoters = null;

  async function load() {
    try {
      poll = await api('GET', '/polls/' + PUBLIC_ID);

      // The page refreshes itself every 20 seconds. A row used to appear mid-read with nothing
      // saying why, at the exact moment the tally shifts under a decision.
      var me = mine();
      freshIds = {};
      var ids = poll.participants.map(function (p) { return p.id; });

      if (knownVoters) {
        var fresh = poll.participants.filter(function (p) {
          return knownVoters.indexOf(p.id) === -1 && !(me && me.id === p.id);
        });
        fresh.forEach(function (p) { freshIds[p.id] = true; });
        if (fresh.length) {
          notice(fresh.map(function (p) { return p.name; }).join(', ') + ' just voted.', 'ok');
        }
      }
      knownVoters = ids;

      render();
    } catch (err) {
      var status = document.getElementById('status');
      status.className = 'notice error';
      status.textContent = 'That poll does not exist, or it was deleted.';
      status.hidden = false;
    }
  }

  load();

  // Light polling so a row someone else adds shows up without a manual refresh.
  setInterval(function () { if (!editing && !document.hidden) load(); }, 20000);
})();
