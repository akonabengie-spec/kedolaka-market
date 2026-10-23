(function () {
  'use strict';

  const launchScreen = document.getElementById('appLaunchScreen');
  if (!launchScreen) return;

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (!isStandalone || !isMobile) {
    launchScreen.remove();
    return;
  }

  const progress = launchScreen.querySelector('[role="progressbar"]');
  const startedAt = Date.now();
  let value = 6;
  let finished = false;
  launchScreen.hidden = false;
  launchScreen.setAttribute('aria-hidden', 'false');

  function updateProgress(nextValue) {
    value = nextValue;
    progress.setAttribute('aria-valuenow', String(Math.round(value)));
    progress.firstElementChild.style.setProperty('--launch-progress', value + '%');
  }

  const progressTimer = window.setInterval(function () {
    if (value >= 90) return;
    updateProgress(Math.min(90, value + Math.max(0.5, (90 - value) * 0.035)));
  }, 100);

  function finish() {
    if (finished) return;
    finished = true;
    window.clearInterval(progressTimer);
    updateProgress(100);
    launchScreen.classList.add('is-leaving');
    window.setTimeout(function () {
      launchScreen.remove();
    }, 200);
  }

  function finishWhenVisible() {
    const remaining = Math.max(0, 450 - (Date.now() - startedAt));
    window.setTimeout(finish, remaining);
  }

  window.addEventListener('marketplace:ready', finishWhenVisible, { once: true });
  window.setTimeout(finish, 2500);
})();
