const { ZOOM_MIN, ZOOM_MAX, DEFAULT_LEVEL } = require('./shared/constants.js');
const { isDomainExcluded, normalizeMethod } = require('./shared/utils.js');

function testDomainExclusion() {
  console.log('Testing domain exclusion...');
  const excluded = ['example.com', 'test.org'];
  
  const cases = [
    { domain: 'example.com', expected: true },
    { domain: 'sub.example.com', expected: true },
    { domain: 'another.com', expected: false },
    { domain: 'test.org', expected: true },
    { domain: 'nottest.org', expected: false },
    { domain: 'org', expected: false }
  ];

  cases.forEach(c => {
    const result = isDomainExcluded(c.domain, excluded);
    if (result !== c.expected) {
      throw new Error(`Failed domain exclusion test for ${c.domain}: expected ${c.expected}, got ${result}`);
    }
  });
  console.log('✅ Domain exclusion tests passed');
}

function testMethodNormalization() {
  console.log('Testing method normalization...');
  const fallback = 'browser-zoom';
  const cases = [
    { method: 'browser-zoom', expected: 'browser-zoom' },
    { method: 'font-size', expected: 'font-size' },
    { method: 'css-zoom', expected: 'css-zoom' },
    { method: 'transform', expected: 'browser-zoom' },
    { method: 'invalid-method', expected: fallback },
    { method: undefined, expected: fallback }
  ];

  cases.forEach(({ method, expected }) => {
    const result = normalizeMethod(method, fallback);
    if (result !== expected) {
      throw new Error(`Failed method normalization for ${String(method)}: expected ${expected}, got ${result}`);
    }
  });
  console.log('✅ Method normalization tests passed');
}

function testConstants() {
  console.log('Testing constants...');
  if (ZOOM_MIN !== 0.5 || ZOOM_MAX !== 3.0) {
    throw new Error('Constants are incorrect');
  }
  if (DEFAULT_LEVEL !== 1.0) {
    throw new Error('DEFAULT_LEVEL is incorrect');
  }
  console.log('✅ Constants tests passed');
}

try {
  testDomainExclusion();
  testMethodNormalization();
  testConstants();
  console.log('\nAll tests passed successfully!');
} catch (error) {
  console.error('\n❌ Tests failed:');
  console.error(error.message);
  process.exit(1);
}
