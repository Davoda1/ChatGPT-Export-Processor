'use strict';
const {setTimeout: nextTimerTurn} = require('node:timers/promises');

async function exitAfterReady(app, code) {
  // Electron can resolve ready before its native message loop installs normal
  // exit handling. Enter a timer turn before exiting, including for short CLI
  // commands: https://github.com/electron/electron/issues/55011
  await app.whenReady();
  await nextTimerTurn(0);
  app.exit(code);
}

module.exports = {exitAfterReady};
