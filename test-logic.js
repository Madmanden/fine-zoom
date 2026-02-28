const {
  ZOOM_MIN,
  ZOOM_MAX,
  DEFAULT_LEVEL,
  STEP_MIN,
  STEP_MAX,
  DEFAULT_ZOOM_STEP,
  DEFAULT_FINE_ZOOM_STEP
} = require('./shared/constants.js');
const { isDomainExcluded, normalizeMethod, accumulateCtrlWheelSteps } = require('./shared/utils.js');

function testDomainExclusion() {
  console.log('Testing domain exclusion...');
  const excluded = ['example.com', 'test.org'];
  
  const cases = [
    { domain: 'example.com', expected: true },
    { domain: 'sub.example.com', expected: true },
    { domain: 'another.com', expected: false },
    { domain: 'test.org', expected: true },
    { domain: 'nottest.org', expected: false },
    { domain: 'org', expected: false },
    { domain: 'EXAMPLE.COM', expected: true }
  ];

  cases.forEach(c => {
    const result = isDomainExcluded(c.domain, excluded);
    if (result !== c.expected) {
      throw new Error(`Failed domain exclusion test for ${c.domain}: expected ${c.expected}, got ${result}`);
    }
  });

  const newlineConfig = 'example.com\nfoo.dev';
  if (!isDomainExcluded('sub.foo.dev', newlineConfig)) {
    throw new Error('Failed domain exclusion for newline string config');
  }

  if (isDomainExcluded('example.com', null)) {
    throw new Error('Domain exclusion should ignore invalid config types');
  }

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

function testCtrlWheelAccumulation() {
  console.log('Testing Ctrl+Wheel accumulation...');
  const threshold = 100;

  let state = { accumulator: 0, steps: 0 };
  state = accumulateCtrlWheelSteps({
    accumulator: state.accumulator,
    deltaY: -120,
    deltaMode: 0,
    viewportHeight: 900,
    threshold
  });

  if (state.steps !== 1) {
    throw new Error(`Expected 1 zoom-in step for -120px wheel delta, got ${state.steps}`);
  }

  state = accumulateCtrlWheelSteps({
    accumulator: state.accumulator,
    deltaY: 240,
    deltaMode: 0,
    viewportHeight: 900,
    threshold
  });

  if (state.steps !== -2) {
    throw new Error(`Expected -2 zoom-out steps for 240px wheel delta, got ${state.steps}`);
  }

  const lineMode = accumulateCtrlWheelSteps({
    accumulator: 0,
    deltaY: -6,
    deltaMode: 1,
    viewportHeight: 900,
    threshold
  });
  if (lineMode.steps !== 0) {
    throw new Error(`Expected 0 steps for 6 lines (-96px), got ${lineMode.steps}`);
  }

  const pageMode = accumulateCtrlWheelSteps({
    accumulator: 0,
    deltaY: -1,
    deltaMode: 2,
    viewportHeight: 900,
    threshold
  });
  if (pageMode.steps !== 9) {
    throw new Error(`Expected 9 steps for one page delta at 900px viewport, got ${pageMode.steps}`);
  }

  console.log('✅ Ctrl+Wheel accumulation tests passed');
}

function testConstants() {
  console.log('Testing constants...');
  if (ZOOM_MIN !== 0.5 || ZOOM_MAX !== 3.0) {
    throw new Error('Constants are incorrect');
  }
  if (DEFAULT_LEVEL !== 1.0) {
    throw new Error('DEFAULT_LEVEL is incorrect');
  }
  if (STEP_MIN !== 0.01 || STEP_MAX !== 0.5) {
    throw new Error('Step limits are incorrect');
  }
  if (DEFAULT_ZOOM_STEP !== 0.05 || DEFAULT_FINE_ZOOM_STEP !== 0.01) {
    throw new Error('Default step constants are incorrect');
  }
  console.log('✅ Constants tests passed');
}

try {
  testDomainExclusion();
  testMethodNormalization();
  testCtrlWheelAccumulation();
  testConstants();
  console.log('\nAll tests passed successfully!');
} catch (error) {
  console.error('\n❌ Tests failed:');
  console.error(error.message);
  process.exit(1);
}
