const fs = require('node:fs');
const path = require('node:path');
const { describe } = require('node:test');

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

for (const file of files) {
  describe(file, () => {
    require(path.join(__dirname, file));
  });
}
