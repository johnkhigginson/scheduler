(function () {
  'use strict';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function show(id, on) {
    var node = document.getElementById(id);
    if (node) node.hidden = !on;
  }

  function notice(message, kind) {
    var box = document.getElementById('notice');
    if (!box) return;
    if (!message) { box.hidden = true; return; }
    box.className = 'notice ' + (kind || 'info');
    box.textContent = message;
    box.hidden = false;
  }

  async function api(path, method, body) {
    var res = await fetch('/api/auth' + path, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401) return null;
    if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
    return data;
  }

  function when(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---------- sign in page ----------

  if (document.getElementById('send')) {
    if (/[?&]expired=1/.test(location.search)) show('expired', true);

    var emailInput = document.getElementById('email');
    var sendButton = document.getElementById('send');

    async function request() {
      var value = emailInput.value.trim();
      var error = document.getElementById('error');
      error.hidden = true;

      if (!value || value.indexOf('@') < 1) {
        error.textContent = 'Enter an email address.';
        error.hidden = false;
        emailInput.focus();
        return;
      }

      sendButton.disabled = true;
      var label = sendButton.textContent;
      sendButton.textContent = 'Sending...';

      try {
        var result = await api('/request', 'POST', { email: value });
        document.getElementById('sent-to').textContent = 'We sent a sign in link to ' + value + '.';
        show('ask', false);
        show('sent', true);
        document.getElementById('signin-title').textContent = 'Check your email';
        // sent:false means the server could not hand the mail to Postmark. Saying so beats letting
        // someone wait for an email that was never sent.
        if (result && result.sent === false) {
          document.getElementById('sent-to').textContent =
            'Could not send to ' + value + '. The mail service refused it, so nothing arrived.';
        }
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        sendButton.disabled = false;
        sendButton.textContent = label;
      }
    }

    sendButton.addEventListener('click', request);
    emailInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') request(); });

    var again = document.getElementById('again');
    if (again) again.addEventListener('click', function () {
      show('sent', false);
      show('ask', true);
      document.getElementById('signin-title').textContent = 'Sign in';
    });
  }

  // ---------- my polls page ----------

  if (document.getElementById('dash')) {
    /*
      Polls made before signing in are only provable by the organizer tokens this browser kept in
      localStorage. Handing those to the server on arrival is what makes an account useful straight
      away rather than only for polls made from now on.
    */
    function localAdminIds() {
      var ids = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var key = localStorage.key(i);
          if (key && key.indexOf('admin:') === 0) ids.push(localStorage.getItem(key));
        }
      } catch (e) { /* private mode */ }
      return ids.filter(Boolean);
    }

    function renderPolls(data) {
      document.getElementById('who').textContent = 'Signed in as ' + data.email + '.';
      var list = document.getElementById('poll-list');
      list.textContent = '';

      if (!data.polls.length) {
        list.appendChild(el('p', 'muted',
          'Nothing here yet. Polls you create while signed in will appear, and any made earlier in this browser are added automatically.'));
        return;
      }

      data.polls.forEach(function (p) {
        var row = el('a', 'poll-row');
        row.href = '/p/' + p.publicId + '#a=' + p.adminId;

        var main = el('div', 'poll-row-main');
        var title = el('div', 'poll-row-title');
        title.appendChild(el('strong', null, p.title));
        if (p.closed) title.appendChild(el('span', 'tag closed', 'Closed'));
        main.appendChild(title);
        main.appendChild(el('div', 'poll-row-meta', when(p.createdUtc)));
        row.appendChild(main);

        var counts = el('div', 'poll-row-counts');
        counts.appendChild(el('span', null, p.participants + (p.participants === 1 ? ' person' : ' people')));
        counts.appendChild(el('span', null, p.options + (p.options === 1 ? ' date' : ' dates')));
        row.appendChild(counts);

        list.appendChild(row);
      });
    }

    (async function () {
      var me = await api('/me');
      if (!me || !me.signedIn) { show('signed-out', true); return; }

      var ids = localAdminIds();
      if (ids.length) {
        try {
          var claimed = await api('/claim', 'POST', { adminIds: ids });
          if (claimed && claimed.claimed > 0) {
            notice('Added ' + claimed.claimed + ' poll' + (claimed.claimed === 1 ? '' : 's') +
              ' you made in this browser.', 'ok');
          }
        } catch (e) { /* claiming is a convenience, never block the page on it */ }
      }

      var data = await api('/polls');
      if (!data) { show('signed-out', true); return; }
      renderPolls(data);
      show('dash-head', true);
      show('dash', true);
    })();

    document.getElementById('signout').addEventListener('click', async function () {
      await api('/signout', 'POST');
      location.href = '/';
    });
  }

  // ---------- header state, on every page that loads this ----------

  (async function () {
    var nav = document.querySelector('.site-nav');
    if (!nav || document.getElementById('send')) return;

    var me = await api('/me');
    var link = el('a', null, me && me.signedIn ? 'My polls' : 'Sign in');
    link.href = me && me.signedIn ? '/my' : '/signin';
    nav.appendChild(link);
  })();
})();
