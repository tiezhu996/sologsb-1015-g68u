process.env.CHROME_BIN =
  process.env.CHROME_BIN ||
  require('child_process')
    .execSync('ls /home/node/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome 2>/dev/null || true')
    .toString()
    .trim()
    .split('\n')[0];

module.exports = function (config) {
  config.set({
    customLaunchers: {
      ChromeHeadlessCI: {
        base: 'ChromeHeadless',
        flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      },
    },
    browsers: ['ChromeHeadlessCI'],
    singleRun: true,
  });
};
