import test from 'node:test';import assert from 'node:assert/strict';import {executionClaimIssues} from '../src/execution-claims';
test('absence of confirmation and predicted test behavior do not claim execution',()=>{
 for(const text of [
  'Without test code to examine, we cannot confirm this behavior.',
  'No test code is available; we could not verify the intended behavior.',
  'Tests that rely on session expiration being in milliseconds will silently pass.',
  'The regression tests would fail if cents were converted to dollars.',
  'Checks might fail for negative input.',
  'Tests will not pass if the wrong unit is returned.',
  'Tests **will silently pass** if expiration uses the wrong unit.',
  'Run the regression tests to verify authentication.',
  'Add tests to confirm the integer-cent assertions.',
  'Execute checks and verify the permission boundary.',
 ])assert.deepEqual(executionClaimIssues(text),[],text);
});
test('negated confirmation or future predictions cannot conceal actual test outcomes',()=>{
 for(const text of [
  'We cannot confirm the test contract, but the tests passed.',
  'Tests will silently pass. The regression checks failed.',
  'Tests could fail, however the tests ran successfully.',
  'Tests may pass and the tests were executed.',
  'Tests would pass, but recorded command timed out.',
  'Run the regression tests to verify behavior. The tests passed.',
  'Run checks and confirm behavior; checks failed.',
  'Add tests to verify behavior, but the test suite was executed.',
 ])assert.notEqual(executionClaimIssues(text).length,0,text);
});
