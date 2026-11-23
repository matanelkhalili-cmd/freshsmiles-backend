(function () {
  var host = document.getElementById('rateWidget');
  if (!host) return;
  var H = 'font-family:Fraunces,serif;font-weight:500;font-size:26px;margin:0 0 10px;';
  var P = 'color:#4B5D55;font-size:15px;line-height:1.6;margin:0 0 14px;';
  host.innerHTML =
    '<div style="background:#fff;border:1px solid #DCE4DF;border-radius:24px;padding:40px 28px;max-width:640px;margin:0 auto 32px;text-align:center;color:#14261F;">' +
      '<div id="rwAsk"><h2 style="' + H + '">How was your visit?</h2>' +
        '<p style="' + P + '">Tap a star to rate your experience at Fresh Smiles Dental.</p>' +
        '<div id="rwStars" style="display:flex;justify-content:center;gap:6px;"></div></div>' +
      '<div id="rwHigh" style="display:none;"><h2 style="' + H + '">Thank you!</h2>' +
        '<p id="rwHighMsg" style="' + P + '">We\'re so glad you had a great visit. Taking you to Google so you can share it…</p></div>' +
      '<div id="rwLow" style="display:none;"><h2 style="' + H + '">Okay, we\'ll let them know.</h2>' +
        '<p style="' + P + '">Thank you for telling us. If you\'d like to share what happened, we\'ll read every word.</p>' +
        '<textarea id="rwComment" placeholder="Optional: what could we have done better? Include your name and number if you\'d like us to reach out." style="width:100%;min-height:100px;border:1.5px solid #DCE4DF;border-radius:10px;padding:11px;font:inherit;box-sizing:border-box;margin-bottom:12px;"></textarea>' +
        '<button id="rwSend" type="button" style="background:#D9A441;color:#3A2A08;border:none;border-radius:10px;font:600 15px Inter,sans-serif;padding:12px 22px;cursor:pointer;">Send</button></div>' +
      '<div id="rwDone" style="display:none;"><h2 style="' + H + '">Thank you.</h2>' +
        '<p style="' + P + '">Your feedback has been shared with the team.</p></div>' +
      '<div id="rwErr" style="display:none;"><h2 style="' + H + '">Something went wrong</h2>' +
        '<p style="' + P + '">Please call us at (718) 382-8000.</p></div>' +
    '</div>';

  var $ = function (id) { return document.getElementById(id); };
  function show(id) {
    ['rwAsk', 'rwHigh', 'rwLow', 'rwDone', 'rwErr'].forEach(function (x) { $(x).style.display = (x === id) ? 'block' : 'none'; });
  }

  var stars = $('rwStars');
  var token = null;
  var busy = false;
  function paint(n) {
    Array.prototype.forEach.call(stars.children, function (s, i) { s.style.color = i < n ? '#D9A441' : '#DCE4DF'; });
  }
  for (var i = 1; i <= 5; i++) {
    (function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = '★';
      b.setAttribute('aria-label', n + ' stars');
      b.style.cssText = 'font-size:48px;line-height:1;background:none;border:none;cursor:pointer;color:#DCE4DF;padding:2px;';
      b.onmouseenter = function () { paint(n); };
      b.onclick = function () { rate(n); };
      stars.appendChild(b);
    })(i);
  }
  stars.onmouseleave = function () { paint(0); };

  function rate(n) {
    if (busy) return;
    busy = true;
    fetch('/api/review-public', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: n }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { busy = false; return show('rwErr'); }
        if (j.high) {
          show('rwHigh');
          if (j.redirect) { setTimeout(function () { location.href = j.redirect; }, 1200); }
          else { $('rwHighMsg').textContent = 'We\'re so glad you had a great visit. Thank you!'; }
        } else {
          token = j.token;
          show('rwLow');
        }
      })
      .catch(function () { busy = false; show('rwErr'); });
  }

  $('rwSend').onclick = function () {
    var c = $('rwComment').value.trim();
    if (!c || !token) return show('rwDone');
    fetch('/api/review/' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment: c }) })
      .then(function () { show('rwDone'); })
      .catch(function () { show('rwDone'); });
  };
})();
