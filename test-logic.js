const { ZOOM_MIN, ZOOM_MAX, DEFAULT_LEVEL } = require('./shared/constants.js');

// Mock chrome for testing if needed, but we're testing pure logic here
const isDomainExcluded = (domain, excludedSites) => {
  return excludedSites.some(site => domain === site || domain.endsWith('.' + site));
};

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
  testConstants();
  console.log('\nAll tests passed successfully!');
} catch (error) {
  console.error('\n❌ Tests failed:');
  console.error(error.message);
  process.exit(1);
}
