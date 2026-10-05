const fs = require('fs');
const path = require('path');
const os = require('os');

// 优先使用 Playwright 下载的原生架构 headless shell（CI/容器内可能是 arm64）
function findPlaywrightChrome() {
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(root)) return '';
  for (const dir of fs.readdirSync(root)) {
    const candidate = path.join(root, dir, fs.readdirSync(path.join(root, dir)).find((d) => d.startsWith('chrome-headless-shell-linux')) || '', 'chrome-headless-shell');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function findPuppeteerChrome() {
  const root = path.join(os.homedir(), '.cache/puppeteer/chrome');
  if (!fs.existsSync(root)) return '';
  for (const dir of fs.readdirSync(root)) {
    const stack = [path.join(root, dir)];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === 'chrome' || entry.name === 'Google Chrome for Testing') return full;
      }
    }
  }
  return '';
}

// 本地解包的 arm64 依赖（apt download + dpkg-deb -x，免 root）
const localLibDirs = ['/tmp/chromelibs/root/usr/lib/aarch64-linux-gnu', '/tmp/chromelibs/root/lib/aarch64-linux-gnu'].filter((d) => fs.existsSync(d));
if (localLibDirs.length) {
  process.env.LD_LIBRARY_PATH = [...localLibDirs, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':');
}

process.env.CHROME_BIN = findPlaywrightChrome() || findPuppeteerChrome() || 'google-chrome';

module.exports = function (config) {
  config.set({
    basePath: '',
    frameworks: ['jasmine', '@angular-devkit/build-angular'],
    plugins: [
      require('karma-jasmine'),
      require('karma-chrome-launcher'),
      require('karma-jasmine-html-reporter'),
      require('@angular-devkit/build-angular/plugins/karma'),
    ],
    reporters: ['progress'],
    browsers: ['ChromeHeadlessNoSandbox'],
    customLaunchers: {
      ChromeHeadlessNoSandbox: {
        base: 'ChromeHeadless',
        flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      },
    },
    singleRun: true,
    restartOnFileChange: false,
  });
};
