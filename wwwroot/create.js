(function () {
  'use strict';

  var MAX_OPTIONS = 300;  // Must match Api.MaxOptions. The server truncates quietly past this.
  var MAX_SLOTS_PER_DAY = 48;   // 15 minute slots across a 12 hour day

  var DURATIONS = [
    [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'],
    [90, '1 hour 30'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours']
  ];

  var DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

  var optionsEl = document.getElementById('options');
  var errorEl = document.getElementById('error');
  var gridEl = document.getElementById('cal-grid');
  var labelEl = document.getElementById('cal-label');
  var countEl = document.getElementById('picked-count');
  var summaryEl = document.getElementById('slot-summary');
  var windowsEl = document.getElementById('windows');

  var days = {};
  var dows = {};
  var dropped = {};   // "iso|HH:mm" for individual slots switched off

  // A window is a set of opening hours and which weekdays it covers. One window covering every day
  // is the common case. A second window is what lets Saturday run different hours to a weekday.
  var windows = [{ days: 'all', start: '09:00', end: '17:00', minutes: 60 }];

  var view = new Date();
  view.setDate(1);

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function fromIso(iso) {
    var p = iso.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function todayIso() { return isoDate(new Date()); }
  function chosen() { return Object.keys(days).sort(); }

  /// Times are stored as 24 hour HH:mm but never shown that way.
  function prettyTime(hhmm) {
    var p = hhmm.split(':');
    var hour = +p[0];
    return (hour % 12 || 12) + ':' + p[1] + ' ' + (hour >= 12 ? 'PM' : 'AM');
  }

  function longLabel(iso) {
    return fromIso(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
    if (message) errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------- times ----------

  function timeMode() {
    var checked = document.querySelector('input[name=timemode]:checked');
    return checked ? checked.value : 'allday';
  }

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

  /// Every slot offered on one date, merged across whichever windows cover that weekday.
  function slotsForDay(iso) {
    if (timeMode() !== 'window') return [null];

    var dow = fromIso(iso).getDay();
    var seen = {};
    windows.forEach(function (w) {
      if (!windowCovers(w, dow)) return;
      windowSlots(w).forEach(function (t) { seen[t] = true; });
    });
    return Object.keys(seen).sort();
  }

  function buildOptions() {
    var out = [];
    chosen().forEach(function (iso) {
      slotsForDay(iso).forEach(function (time) {
        if (time === null) { out.push({ date: iso, time: null }); return; }
        if (!dropped[iso + '|' + time]) out.push({ date: iso, time: time });
      });
    });
    return out;
  }

  /// Chosen days that no window covers. They would silently vanish from the poll.
  function uncoveredDays() {
    if (timeMode() !== 'window') return [];
    return chosen().filter(function (iso) { return slotsForDay(iso).length === 0; });
  }

  // ---------- window editor ----------

  function renderWindows() {
    windowsEl.textContent = '';

    windows.forEach(function (w, index) {
      var card = el('div', 'window');

      var dayRow = el('div', 'window-days');
      dayRow.setAttribute('role', 'group');
      dayRow.setAttribute('aria-label', 'Days this window applies to');

      var every = el('button', w.days === 'all' ? 'on' : null, 'Every day');
      every.type = 'button';
      every.setAttribute('aria-pressed', w.days === 'all' ? 'true' : 'false');
      every.addEventListener('click', function () { holdStill(function () { w.days = 'all'; redraw(); }); });
      dayRow.appendChild(every);

      DOW_ORDER.forEach(function (dow) {
        var on = w.days !== 'all' && w.days.indexOf(dow) !== -1;
        var button = el('button', on ? 'on' : null, DOW_NAMES[dow]);
        button.type = 'button';
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.addEventListener('click', function () {
          if (w.days === 'all') w.days = [dow];
          else if (w.days.indexOf(dow) === -1) w.days = w.days.concat([dow]);
          else w.days = w.days.filter(function (d) { return d !== dow; });
          // An empty selection would silently cover nothing, so fall back to every day.
          if (w.days.length === 0) w.days = 'all';
          holdStill(redraw);
        });
        dayRow.appendChild(button);
      });
      card.appendChild(dayRow);

      var fields = el('div', 'slot-fields');
      fields.appendChild(timeField('Starts', w.start, function (v) { w.start = v; softRefresh(); }));
      fields.appendChild(timeField('Ends', w.end, function (v) { w.end = v; softRefresh(); }));

      var lengthField = el('div', 'field');
      var lengthLabel = el('label', null, 'Each slot');
      var select = document.createElement('select');
      DURATIONS.forEach(function (pair) {
        var opt = document.createElement('option');
        opt.value = String(pair[0]);
        opt.textContent = pair[1];
        if (pair[0] === w.minutes) opt.selected = true;
        select.appendChild(opt);
      });
      var selectId = 'win-minutes-' + index;
      select.id = selectId;
      lengthLabel.setAttribute('for', selectId);
      select.addEventListener('change', function () { w.minutes = +select.value; softRefresh(); });
      lengthField.appendChild(lengthLabel);
      lengthField.appendChild(select);
      fields.appendChild(lengthField);
      card.appendChild(fields);

      var slots = windowSlots(w);
      var note = el('div', 'window-note');
      note.textContent = slots.length
        ? slots.length + ' slot' + (slots.length === 1 ? '' : 's') + ' a day, ' +
          prettyTime(slots[0]) + ' to ' + prettyTime(fromMinutes(toMinutes(slots[slots.length - 1]) + w.minutes))
        : 'This window does not fit a single slot.';
      if (!slots.length) note.classList.add('bad');
      card.appendChild(note);

      if (windows.length > 1) {
        var remove = el('button', 'link', 'Remove this window');
        remove.type = 'button';
        remove.addEventListener('click', function () { holdStill(function () { windows.splice(index, 1); redraw(); }); });
        card.appendChild(remove);
      }

      windowsEl.appendChild(card);
    });
  }

  function timeField(labelText, value, onChange) {
    var field = el('div', 'field');
    var input = document.createElement('input');
    input.type = 'time';
    input.step = '900';
    input.value = value;
    var id = 'time-' + labelText.toLowerCase() + '-' + Math.round(Math.random() * 1e6);
    input.id = id;
    var label = el('label', null, labelText);
    label.setAttribute('for', id);
    input.addEventListener('input', function () { onChange(input.value); });
    field.appendChild(label);
    field.appendChild(input);
    return field;
  }

  document.getElementById('add-window').addEventListener('click', function () {
    windows.push({ days: [6, 0], start: '10:00', end: '14:00', minutes: 60 });
    redraw();
  });

  document.querySelectorAll('input[name=timemode]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      document.getElementById('window-fields').hidden = timeMode() !== 'window';
      redraw();
    });
  });

  // ---------- selection ----------

  function toggleDay(iso) {
    if (iso in days) delete days[iso]; else days[iso] = true;
  }

  function redraw() {
    renderCal();
    if (timeMode() === 'window') renderWindows();
    renderPicked();
  }

  /*
    Changing an opening time changes how many slots each chosen day has, which changes the height
    of the chosen day list. That list sits above the time controls, so the control being edited
    slid up or down the screen on every keystroke. Measuring one fixed point before and after and
    scrolling by the difference keeps the page still under the cursor.
  */
  function holdStill(fn) {
    var before = windowsEl.getBoundingClientRect().top;
    fn();
    var after = windowsEl.getBoundingClientRect().top;
    if (after !== before) window.scrollBy(0, after - before);
  }

  /// Updates the text a window derives from its own values without rebuilding its inputs, which
  /// would throw away focus and the caret position mid edit.
  function updateWindowNotes() {
    windows.forEach(function (w, index) {
      var card = windowsEl.children[index];
      if (!card) return;
      var note = card.querySelector('.window-note');
      if (!note) return;

      var slots = windowSlots(w);
      note.textContent = slots.length
        ? slots.length + ' slot' + (slots.length === 1 ? '' : 's') + ' a day, ' +
          prettyTime(slots[0]) + ' to ' +
          prettyTime(fromMinutes(toMinutes(slots[slots.length - 1]) + w.minutes))
        : 'This window does not fit a single slot.';
      note.classList.toggle('bad', !slots.length);
    });
  }

  /// For value edits: refresh what is derived, leave the controls alone, hold the page still.
  function softRefresh() {
    holdStill(function () {
      updateWindowNotes();
      renderPicked();
    });
  }

  // ---------- calendar ----------

  function renderCal() {
    labelEl.textContent = MONTHS[view.getMonth()] + ' ' + view.getFullYear();
    gridEl.textContent = '';

    var start = new Date(view.getFullYear(), view.getMonth(), 1).getDay();
    var count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    var today = todayIso();

    for (var blank = 0; blank < start; blank++) gridEl.appendChild(document.createElement('span'));

    for (var day = 1; day <= count; day++) {
      var date = new Date(view.getFullYear(), view.getMonth(), day);
      var iso = isoDate(date);
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'cal-day' + (iso in days ? ' on' : '') +
        (iso === today ? ' today' : '') + (iso < today ? ' past' : '');
      button.textContent = String(day);
      button.setAttribute('data-iso', iso);
      button.setAttribute('aria-pressed', iso in days ? 'true' : 'false');
      button.setAttribute('aria-label', date.toLocaleDateString(undefined,
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));
      gridEl.appendChild(button);
    }
  }

  var anchor = null;

  /*
    Click toggles one day. Shift click selects the run between the last day clicked and this one.

    There was a drag to sweep gesture here and it was removed: any stray pointer movement while the
    button was down painted a whole week at once, and undoing it meant clicking each day off again.
  */
  gridEl.addEventListener('click', function (e) {
    var day = e.target.closest('.cal-day');
    if (!day) return;
    var iso = day.getAttribute('data-iso');

    if (e.shiftKey && anchor) {
      var from = anchor < iso ? anchor : iso;
      var to = anchor < iso ? iso : anchor;
      var cursor = fromIso(from);
      var last = fromIso(to);
      var guard = 0;
      // Shift click always adds, so it can never wipe a selection by accident.
      while (cursor <= last && guard++ < 400) {
        days[isoDate(cursor)] = true;
        cursor.setDate(cursor.getDate() + 1);
      }
    } else {
      toggleDay(iso);
    }

    anchor = iso;
    redraw();
  });

  document.getElementById('cal-prev').addEventListener('click', function () {
    view.setMonth(view.getMonth() - 1); renderCal();
  });
  document.getElementById('cal-next').addEventListener('click', function () {
    view.setMonth(view.getMonth() + 1); renderCal();
  });

  // ---------- chosen days ----------

  function renderPicked() {
    var list = chosen();
    var total = buildOptions().length;
    var uncovered = uncoveredDays();

    countEl.textContent = list.length
      ? list.length + (list.length === 1 ? ' day chosen' : ' days chosen')
      : 'No days chosen yet';

    if (timeMode() === 'window') {
      var parts = [];
      if (list.length) parts.push(total + ' option' + (total === 1 ? '' : 's') + ' in total');
      if (total > MAX_OPTIONS) parts.push('that is over the limit of ' + MAX_OPTIONS);
      if (uncovered.length) {
        parts.push(uncovered.length + ' chosen ' + (uncovered.length === 1 ? 'day has' : 'days have') +
          ' no window and will be left out');
      }
      summaryEl.textContent = parts.join('. ') + (parts.length ? '.' : '');
    } else {
      summaryEl.textContent = '';
    }

    optionsEl.textContent = '';

    if (!list.length) {
      optionsEl.appendChild(el('p', 'muted', 'Pick days from the calendar, or use a shortcut above.'));
      return;
    }

    list.forEach(function (iso) {
      var slots = slotsForDay(iso);
      var block = el('div', 'day-block');

      var head = el('div', 'day-head');
      head.appendChild(el('strong', null, longLabel(iso)));

      var remove = el('button', 'link remove');
      remove.type = 'button';
      remove.innerHTML = '&times;';
      remove.setAttribute('aria-label', 'Remove ' + longLabel(iso));
      remove.addEventListener('click', function () { delete days[iso]; redraw(); });
      head.appendChild(remove);
      block.appendChild(head);

      if (timeMode() !== 'window') {
        block.appendChild(el('span', 'muted', 'All day'));
      } else if (!slots.length) {
        block.appendChild(el('span', 'warn', 'No time window covers this day'));
      } else {
        var chips = el('div', 'chips');
        slots.forEach(function (time) {
          var key = iso + '|' + time;
          // Strikethrough alone was too weak to scan for among forty chips, so state gets its own
          // leading mark as well.
          var chip = el('button', 'chip' + (dropped[key] ? ' off' : ''));
          chip.type = 'button';
          chip.appendChild(el('span', 'chip-mark', dropped[key] ? '✕' : '✓'));
          chip.appendChild(document.createTextNode(prettyTime(time)));
          chip.setAttribute('aria-pressed', dropped[key] ? 'false' : 'true');
          chip.setAttribute('aria-label', prettyTime(time) + ' on ' + longLabel(iso) +
            (dropped[key] ? ', excluded' : ', included'));
          chip.addEventListener('click', function () {
            if (dropped[key]) delete dropped[key]; else dropped[key] = true;
            renderPicked();
          });
          chips.appendChild(chip);
        });
        block.appendChild(chips);
      }

      optionsEl.appendChild(block);
    });
  }

  // ---------- shortcuts ----------

  function nextDow(target) {
    var d = new Date();
    d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7 || 7));
    return d;
  }

  var PRESETS = {
    days7: function () {
      var d = new Date();
      for (var i = 0; i < 7; i++) { d.setDate(d.getDate() + 1); days[isoDate(d)] = true; }
    },
    weekdays: function () {
      var monday = nextDow(1);
      for (var i = 0; i < 5; i++) {
        days[isoDate(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))] = true;
      }
    },
    month: function () {
      var d = nextDow(5);
      var month = d.getMonth();
      while (d.getMonth() === month) { days[isoDate(d)] = true; d.setDate(d.getDate() + 7); }
    }
  };

  document.querySelectorAll('[data-preset]').forEach(function (button) {
    button.addEventListener('click', function () {
      PRESETS[button.getAttribute('data-preset')]();
      var first = chosen()[0];
      if (first) { view = fromIso(first); view.setDate(1); }
      redraw();
    });
  });

  document.querySelectorAll('[data-dow]').forEach(function (button) {
    button.addEventListener('click', function () {
      var n = button.getAttribute('data-dow');
      if (dows[n]) delete dows[n]; else dows[n] = true;
      button.classList.toggle('on', !!dows[n]);
      button.setAttribute('aria-pressed', dows[n] ? 'true' : 'false');
    });
  });

  document.getElementById('apply-dows').addEventListener('click', function () {
    var picked = Object.keys(dows);
    if (!picked.length) { showError('Choose at least one weekday first.'); return; }

    var from = document.getElementById('range-from').value;
    var to = document.getElementById('range-to').value;
    if (!from || !to) { showError('Set both ends of the date range.'); return; }
    if (to < from) { showError('The range ends before it starts.'); return; }

    showError('');
    var cursor = fromIso(from);
    var last = fromIso(to);
    var guard = 0;
    while (cursor <= last && guard++ < 400) {
      if (dows[String(cursor.getDay())]) days[isoDate(cursor)] = true;
      cursor.setDate(cursor.getDate() + 1);
    }
    var first = chosen()[0];
    if (first) { view = fromIso(first); view.setDate(1); }
    redraw();
  });

  document.getElementById('clear-dates').addEventListener('click', function () {
    // One mis-click used to wipe a selection built up across several months, with no way back.
    var count = chosen().length;
    if (count > 5 && !confirm('Remove all ' + count + ' chosen days?')) return;
    days = {};
    dropped = {};
    redraw();
  });

  // ---------- saving the organizer link ----------
  // The organizer link exists nowhere else. Losing it means losing the poll, so copying it is a
  // real step here rather than a suggestion.

  var created = false;
  var linksSaved = false;

  function markSaved() { linksSaved = true; document.getElementById('unsaved-warning').hidden = true; }

  function linksText(title, publicUrl, adminUrl) {
    return 'Scheduler poll: ' + title + '\n\n' +
      'Share this link with everyone:\n' + publicUrl + '\n\n' +
      'Organizer link, keep this private. It is the only way back into the controls:\n' + adminUrl + '\n';
  }

  window.addEventListener('beforeunload', function (e) {
    if (!created || linksSaved) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Copying the organizer link counts as saving it.
  document.addEventListener('click', function (e) {
    var target = e.target.closest('[data-copy]');
    if (target && target.getAttribute('data-copy') === 'admin-link') markSaved();
  });

  // ---------- submit ----------

  document.getElementById('create').addEventListener('click', async function (e) {
    var button = e.currentTarget;
    showError('');

    var title = document.getElementById('title').value.trim();
    if (!title) { showError('Give the poll a title.'); return; }
    if (!chosen().length) { showError('Pick at least one day.'); return; }

    var options = buildOptions();
    if (!options.length) {
      showError(timeMode() === 'window'
        ? 'No time slots fit those windows. Check the opening and closing times.'
        : 'Pick at least one day.');
      return;
    }
    if (options.length > MAX_OPTIONS) {
      showError('That comes to ' + options.length + ' options, and the limit is ' + MAX_OPTIONS +
        '. Use fewer days, shorter windows or longer slots.');
      return;
    }

    var uncovered = uncoveredDays();
    if (uncovered.length && !confirm(
      uncovered.length + ' chosen ' + (uncovered.length === 1 ? 'day has' : 'days have') +
      ' no time window and will not appear in the poll. Create it anyway?')) return;

    var deadlineValue = document.getElementById('deadline').value;
    var deadline = null;
    if (deadlineValue) {
      var parsed = new Date(deadlineValue);
      if (isNaN(parsed.getTime())) { showError('That deadline is not a valid date and time.'); return; }
      if (parsed.getTime() <= Date.now()) { showError('The deadline has to be in the future.'); return; }
      deadline = parsed.toISOString();
    }

    var timeZone = null;
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (err) { /* older browser */ }

    button.disabled = true;
    try {
      var res = await fetch('/api/polls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          description: document.getElementById('description').value.trim() || null,
          organizerName: document.getElementById('organizer').value.trim() || null,
          options: options,
          timeZone: timeZone,
          deadline: deadline,
          allowMaybe: document.getElementById('allow-maybe').checked
        })
      });
      var data = await res.json();
      if (!res.ok) { showError(data.error || 'Something went wrong.'); return; }

      var base = location.origin + '/p/' + data.publicId;
      var adminUrl = base + '#a=' + data.adminId;
      document.getElementById('public-link').value = base;
      // The admin token lives in the fragment so it never reaches the server logs or a Referer header.
      document.getElementById('admin-link').value = adminUrl;
      document.getElementById('open-admin').href = adminUrl;
      document.getElementById('form-card').hidden = true;
      document.getElementById('done-card').hidden = false;

      created = true;
      // A tab left on this screen holds the only copy of an unrecoverable link, so say so in the
      // one place that survives being buried behind twenty other tabs.
      document.title = 'Save your organizer link | Scheduler';

      var body = linksText(title, base, adminUrl);
      document.getElementById('email-links').href = 'mailto:?subject=' +
        encodeURIComponent('Scheduler poll: ' + title) + '&body=' + encodeURIComponent(body);
      document.getElementById('email-links').addEventListener('click', markSaved);

      document.getElementById('save-links').addEventListener('click', function () {
        var blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = (title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'poll') + '-links.txt';
        document.body.appendChild(link);
        link.click();
        setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 0);
        markSaved();
      });

      document.getElementById('done-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError('Could not reach the server. Try again.');
    } finally {
      button.disabled = false;
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

  (function seedRange() {
    var today = new Date();
    var later = new Date();
    later.setDate(later.getDate() + 28);
    document.getElementById('range-from').value = isoDate(today);
    document.getElementById('range-to').value = isoDate(later);
  })();

  redraw();
})();
