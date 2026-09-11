(function () {
  var trip = new URLSearchParams(window.location.search).get('trip');
  var link = document.getElementById('back-link');
  if (link && trip && /^[A-Za-z0-9_-]{16,128}$/.test(trip)) {
    link.href = '/shared/' + encodeURIComponent(trip);
    link.textContent = '← 返回行程';
  }
}());

