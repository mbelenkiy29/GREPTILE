import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsPeriod} from '../src/analytics-period';
test('analytics date periods use inclusive UTC days including a leap year',()=>{
 assert.deepEqual(analyticsPeriod('2026-10-04','2026-10-04'),{since:Date.UTC(2026,9,4),until:Date.UTC(2026,9,5)-1});
 assert.deepEqual(analyticsPeriod('2024-01-01','2024-12-31'),{since:Date.UTC(2024,0,1),until:Date.UTC(2025,0,1)-1});
});
test('analytics rejects rolled dates, malformed dates, reversed and oversized periods',()=>{
 for(const date of ['2026-02-30','2026-13-01','2026-1-1','2026-10-04T00:00:00Z','not-a-date',''])assert.ok('error' in analyticsPeriod(date,'2026-10-04'));
 assert.deepEqual(analyticsPeriod('2026-10-04','2026-10-03'),{error:'Through must be on or after From.'});
 assert.deepEqual(analyticsPeriod('2024-01-01','2025-01-01'),{error:'Choose a period of at most one year.'});
 assert.ok('error' in analyticsPeriod('2026-01-01','2026-02-30'));
});
