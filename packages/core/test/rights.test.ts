import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RIGHTS_CONTENT_VERSION, RIGHTS_LAST_REVIEWED, RIGHTS_NEEDS_COUNSEL_REVIEW, buildCancelPlan, createManualItem, type TrackedItem } from '../src/index.ts';

describe('cancellation rights review metadata', () => {
  const base = createManualItem({ name: 'Somebrand', amountCents: 999, cadence: 'monthly', date: '2026-10-20', isTrial: false }, 'x', '2026-10-03T15:00:00Z');

  it('is not marked as counsel-reviewed until someone actually reviews it', () => {
    assert.equal(RIGHTS_LAST_REVIEWED, null);
    assert.equal(RIGHTS_NEEDS_COUNSEL_REVIEW, true);
    assert.match(RIGHTS_CONTENT_VERSION, /\S/);
  });

  it('travels with every kind of cancel plan', () => {
    const rails: TrackedItem['rail'][] = ['card', 'paypal', 'app_store', 'google_play'];
    const plans = [...rails.map((rail) => buildCancelPlan({ ...base, rail }, 'NY')), buildCancelPlan({ ...base, merchantId: 'netflix' })];
    for (const plan of plans) {
      assert.equal(plan.rightsLastReviewed, RIGHTS_LAST_REVIEWED, plan.method);
      assert.equal(plan.rightsNeedCounselReview, RIGHTS_NEEDS_COUNSEL_REVIEW, plan.method);
      assert.equal(plan.rightsContentVersion, RIGHTS_CONTENT_VERSION, plan.method);
    }
    assert.deepEqual(new Set(plans.map((p) => p.method)), new Set(['guide_only', 'paypal', 'app_store', 'google_play', 'deep_link']));
  });
});
