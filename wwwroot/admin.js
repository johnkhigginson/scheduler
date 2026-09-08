(function () {
  'use strict';

  var KEY_STORE = 'site-admin-key';
  var siteKey = null;

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private mode */ }
    return null;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function notice(message, kind) {
    var box = document.getElementById('notice');
    if (!message) { box.hidden = true; return; }
    box.className = 'notice ' + (kind || 'info');
    box.textContent = message;
    box.hidden = false;
  }

  // The key travels in a header, never in the URL, so it stays out of access logs and history.
  async function api(path, method) {
    var res = await fetch('/api/site' + path, {
      method: method || 'GET',
      headers: { 'X-Site-Key': siteKey }
    });
    if (res.status === 403) throw new Error('That key was not accepted.');
    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
    return data;
  }

  function when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined,
      { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function onDate(iso) {
    var p = iso.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2])
      .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function atTime(hhmm) {
    if (!hhmm) return 'All day';
    var p = hhmm.split(':');
    var hour = +p[0];
    return (hour % 12 || 12) + ':' + p[1] + ' ' + (hour >= 12 ? 'PM' : 'AM');
  }

  // ---------- overview ----------

  function renderStats(data) {
    var polls = data.polls;
    var totals = polls.reduce(function (acc, p) {
      acc.participants += p.participants;
      acc.answers += p.answers;
      acc.comments += p.comments;
      acc.options += p.options;
      if (p.closed) acc.closed++;
      return acc;
    }, { participants: 0, answers: 0, comments: 0, options: 0, closed: 0 });

    var stats = [
      ['Polls', data.total],
      ['Open', data.total - totals.closed],
      ['Date options', totals.options],
      ['People', totals.participants],
      ['Answers', totals.answers],
      ['Comments', totals.comments]
    ];

    var row = document.getElementById('stats');
    row.textContent = '';
    stats.forEach(function (pair) {
      var card = el('div', 'stat');
      card.appendChild(el('span', 'stat-n', String(pair[1])));
      card.appendChild(el('span', 'stat-l', pair[0]));
      row.appendChild(card);
    });
  }

  function renderPolls(data) {
    var list = document.getElementById('poll-list');
    list.textContent = '';

    if (!data.polls.length) {
      list.appendChild(el('p', 'muted', 'No polls on this server yet.'));
      return;
    }

    data.polls.forEach(function (p) {
      var row = el('button', 'poll-row');
      row.type = 'button';

      var main = el('div', 'poll-row-main');
      var title = el('div', 'poll-row-title');
      title.appendChild(el('strong', null, p.title));
      if (p.closed) title.appendChild(el('span', 'tag closed', p.closedByDeadline ? 'Expired' : 'Closed'));
      if (p.allowMaybe) title.appendChild(el('span', 'tag', 'Maybe on'));
      main.appendChild(title);

      main.appendChild(el('div', 'poll-row-meta',
        (p.organizerName ? p.organizerName + '  ·  ' : '') + when(p.createdUtc)));
      row.appendChild(main);

      var counts = el('div', 'poll-row-counts');
      counts.appendChild(el('span', null, p.participants + (p.participants === 1 ? ' person' : ' people')));
      counts.appendChild(el('span', null, p.options + (p.options === 1 ? ' date' : ' dates')));
      counts.appendChild(el('span', null, p.answers + (p.answers === 1 ? ' answer' : ' answers')));
      if (p.comments) counts.appendChild(el('span', null, p.comments + (p.comments === 1 ? ' comment' : ' comments')));
      row.appendChild(counts);

      row.addEventListener('click', function () { openDetail(p.publicId); });
      list.appendChild(row);
    });
  }

  // ---------- one poll ----------

  async function openDetail(publicId) {
    var card = document.getElementById('detail');
    card.textContent = '';
    card.hidden = false;
    card.appendChild(el('p', 'muted', 'Loading...'));

    var poll;
    try {
      poll = await api('/polls/' + publicId);
    } catch (err) {
      card.textContent = '';
      card.appendChild(el('p', 'warn', err.message));
      return;
    }

    card.textContent = '';
    card.appendChild(el('h2', null, 'Poll detail'));
    card.appendChild(el('h1', null, poll.title));

    var meta = el('p', 'muted');
    meta.textContent = [
      poll.organizerName ? 'Organized by ' + poll.organizerName : null,
      'Created ' + when(poll.createdUtc),
      poll.timeZone || 'no timezone recorded',
      poll.closed ? 'Closed' : 'Open',
      poll.deadlineUtc ? 'Deadline ' + when(poll.deadlineUtc) : null
    ].filter(Boolean).join('  ·  ');
    card.appendChild(meta);

    if (poll.description) {
      var desc = el('p', null, poll.description);
      desc.style.whiteSpace = 'pre-wrap';
      card.appendChild(desc);
    }

    // Links, including the organizer link. This is the only place it can be recovered.
    var links = el('div', 'field');
    links.appendChild(el('label', null, 'Share link'));
    links.appendChild(readonlyBox(location.origin + '/p/' + poll.publicId));
    links.appendChild(el('label', null, 'Organizer link, treat as a secret'));
    links.appendChild(readonlyBox(location.origin + '/p/' + poll.publicId + '#a=' + poll.adminId));
    card.appendChild(links);

    // Responses as a grid: one row per person, one column per option.
    card.appendChild(el('h2', null, 'Responses'));
    if (!poll.participants.length) {
      card.appendChild(el('p', 'muted', 'Nobody has answered yet.'));
    } else {
      card.appendChild(responseTable(poll));
    }

    if (poll.comments.length) {
      card.appendChild(el('h2', null, 'Comments'));
      poll.comments.forEach(function (c) {
        var wrap = el('div', 'comment');
        var head = el('div', 'meta');
        head.appendChild(el('b', null, c.name));
        head.appendChild(document.createTextNode('  ' + when(c.createdUtc)));
        wrap.appendChild(head);
        wrap.appendChild(el('div', 'body', c.text));
        card.appendChild(wrap);
      });
    }

    var actions = el('div', 'actions');
    var open = el('a', null);
    open.href = '/p/' + poll.publicId + '#a=' + poll.adminId;
    open.appendChild(el('button', 'primary', 'Open as organizer'));
    actions.appendChild(open);

    var remove = el('button', 'danger', 'Delete this poll');
    remove.addEventListener('click', async function () {
      if (!confirm('Delete "' + poll.title + '" and every answer in it? This cannot be undone.')) return;
      try {
        await api('/polls/' + poll.publicId, 'DELETE');
        card.hidden = true;
        notice('Poll deleted.', 'ok');
        await load();
      } catch (err) {
        notice(err.message, 'error');
      }
    });
    actions.appendChild(remove);
    card.appendChild(actions);

    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function readonlyBox(value) {
    var wrap = el('div', 'share');
    var input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.value = value;
    var copy = el('button', null, 'Copy');
    copy.addEventListener('click', function () {
      input.select();
      var original = copy.textContent;
      function done(label, hold) {
        copy.textContent = label;
        setTimeout(function () { copy.textContent = original; }, hold);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(
          function () { done('Copied', 1400); },
          function () { done('Press Ctrl C', 2600); });
      } else {
        done('Press Ctrl C', 2600);
      }
    });
    wrap.appendChild(input);
    wrap.appendChild(copy);
    return wrap;
  }

  function responseTable(poll) {
    var MARK = { yes: '✓', maybe: '?', no: '✕' };
    var wrap = el('div', 'grid-wrap');
    var table = el('table', 'grid');

    var thead = document.createElement('thead');
    var head = document.createElement('tr');
    head.appendChild(el('th', 'name-col', 'Person'));
    poll.options.forEach(function (o) {
      var th = el('th');
      th.scope = 'col';
      th.appendChild(el('span', 'col-date', onDate(o.date)));
      th.appendChild(el('span', 'col-time', atTime(o.time)));
      head.appendChild(th);
    });
    thead.appendChild(head);
    table.appendChild(thead);

    var body = document.createElement('tbody');
    poll.participants.forEach(function (p) {
      var tr = document.createElement('tr');
      var name = el('th', 'name-col', p.name);
      name.scope = 'row';
      tr.appendChild(name);
      poll.options.forEach(function (o) {
        var vote = p.votes[o.id] || null;
        var td = document.createElement('td');
        var pill = el('span', 'pill ' + (vote || 'none'), vote ? MARK[vote] : '·');
        pill.setAttribute('role', 'img');
        pill.setAttribute('aria-label', vote ? vote : 'no answer');
        td.appendChild(pill);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);

    wrap.appendChild(table);
    return wrap;
  }

  // ---------- gate ----------

  async function load() {
    var data = await api('/overview');
    renderStats(data);
    renderPolls(data);
  }

  async function unlock(key) {
    siteKey = key;
    try {
      await load();
      store(KEY_STORE, key);
      document.getElementById('gate').hidden = true;
      document.getElementById('dash').hidden = false;
      document.getElementById('lock').hidden = false;
      return true;
    } catch (err) {
      siteKey = null;
      var box = document.getElementById('gate-error');
      box.textContent = err.message;
      box.hidden = false;
      return false;
    }
  }

  document.getElementById('unlock').addEventListener('click', function () {
    var value = document.getElementById('key').value.trim();
    if (!value) return;
    unlock(value);
  });

  document.getElementById('key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('unlock').click();
  });

  document.getElementById('lock').addEventListener('click', function (e) {
    e.preventDefault();
    store(KEY_STORE, null);
    location.reload();
  });

  var saved = store(KEY_STORE);
  if (saved) unlock(saved);
})();
